let stats = null, pot = null, charts = {};
const msState = { Turno: [], Zona: [], Hub: [] };
const msOptionsCache = { Turno: '', Zona: '', Hub: '' };
const MS_KEYS = ['Turno', 'Zona', 'Hub'];

// Estação é o "contexto" do painel (fica no header, não nos filtros): '' = todas.
const state = { estacao: '', estacoes: [], dateBounds: null };
const rankSort = { zona: 'atraso', hub: 'atraso' };
const rankExpanded = { zona: false, hub: false };
const RANK_LIMIT = 12;
// Granularidade do gráfico de % POT: null = automática (dia até 31 dias, senão semana).
let potGran = null;

if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// localStorage pode lançar (aba anônima, site data bloqueado) — nunca é essencial.
function storeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignora */ } }

// ---------- Tema ----------

function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  storeSet('pot-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'dark' ? '☀ Claro' : '☾ Escuro';
  if (stats) renderAll(stats); // recoloca os gráficos com a paleta do novo tema
}

function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

// ---------- Carga ----------

// Cada clique em filtro agenda uma carga com debounce; se uma requisição antiga
// ainda estiver em voo, ela é abortada — só a resposta mais recente é renderizada.
let loadTimer = null, inflight = null, reqSeq = 0, firstLoad = true;

function scheduleLoad() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => loadPacked(false), 250);
}

function currentParams() {
  const params = new URLSearchParams();
  const from = document.getElementById('filterDataIni').value;
  const to = document.getElementById('filterDataFim').value;
  if (state.estacao) params.set('estacao', state.estacao);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (msState.Turno.length) params.set('turno', msState.Turno.join(','));
  if (msState.Zona.length) params.set('zona', msState.Zona.join(','));
  if (msState.Hub.length) params.set('hub', msState.Hub.join(','));
  return params;
}

// O recorte atual vai pra URL, então dá pra compartilhar o link de uma visão.
function syncUrl(params) {
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
}

function restoreFromUrl() {
  const q = new URLSearchParams(location.search);
  const split = v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);
  state.estacao = q.has('estacao') ? q.get('estacao') : (storeGet('pot-estacao') || '');
  document.getElementById('filterDataIni').value = q.get('from') || '';
  document.getElementById('filterDataFim').value = q.get('to') || '';
  msState.Turno = split(q.get('turno'));
  msState.Zona = split(q.get('zona'));
  msState.Hub = split(q.get('hub'));
}

function setLoading(on) {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = on;
  btn.textContent = on ? '⟳ Buscando...' : '⟳ Atualizar';
  if (firstLoad) {
    if (on) showLoader('Carregando resumo agregado...'); else hideLoader();
    return;
  }
  document.getElementById('progress').classList.toggle('active', on);
  document.getElementById('main').classList.toggle('is-loading', on);
}

async function loadPacked(force) {
  clearTimeout(loadTimer);
  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  const seq = ++reqSeq;
  setLoading(true);
  try {
    const params = currentParams();
    syncUrl(params);
    if (force) params.set('force', '1');

    const response = await fetch('/api/packed-summary' + (params.toString() ? '?' + params.toString() : ''), { signal: ctrl.signal });
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);

    document.getElementById('lastUpdate').textContent = payload.lastUpdate ? new Date(payload.lastUpdate).toLocaleString('pt-BR') : '—';

    if (!payload.stats) {
      setStatus('load', payload.notice || 'Sem dados disponíveis.');
      renderAll(null);
      return;
    }

    fillStations(payload.filterOptions.estacoes);
    if (state.estacao && !state.estacoes.includes(state.estacao)) {
      // Estação salva/compartilhada que não existe mais na base: volta pro consolidado.
      selectStation('');
      return;
    }

    pot = payload.pot || null;
    updateDateBounds(payload.dateBounds, pot && pot.dateBounds);
    fillMs('Turno', payload.filterOptions.turnos);
    fillMs('Zona', payload.filterOptions.zonas);
    fillMs('Hub', payload.filterOptions.hubs);
    renderChips();

    const range = payload.appliedRange || {};
    const rangeLabel = range.from && range.to
      ? (range.from === range.to ? fmtDate(range.from) : `${fmtDate(range.from)} a ${fmtDate(range.to)}`)
      : 'janela completa';
    const stationLabel = state.estacao ? splitStation(state.estacao).name : `${state.estacoes.length} estações`;
    setStatus('ok', `${payload.stats.total.toLocaleString('pt-BR')} pacotes · ${stationLabel} · ${rangeLabel}`);

    stats = payload.stats;
    renderAll(stats);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus('err', 'Erro ao carregar dados: ' + err.message);
  } finally {
    if (seq === reqSeq) {
      inflight = null;
      setLoading(false);
      firstLoad = false;
    }
  }
}

// ---------- Estação ----------

// "SoC_PE_Jaboatão dos Guararapes" → { meta: "SoC · PE", name: "Jaboatão dos Guararapes" }.
// Nomes fora do padrão TIPO_UF_NOME aparecem inteiros.
function splitStation(value) {
  const parts = String(value).split('_');
  if (parts.length < 3) return { meta: 'Estação', name: value };
  return { meta: `${parts[0]} · ${parts[1]}`, name: parts.slice(2).join(' ') };
}

function fillStations(values) {
  state.estacoes = values || [];
  updateStationLabel();
  renderStationList();
}

function updateStationLabel() {
  const meta = document.getElementById('stationMeta');
  const name = document.getElementById('stationName');
  if (!state.estacao) {
    meta.textContent = state.estacoes.length ? `Estação · ${state.estacoes.length} disponíveis` : 'Estação';
    name.textContent = 'Todas as estações';
  } else {
    const p = splitStation(state.estacao);
    meta.textContent = p.meta;
    name.textContent = p.name;
  }
}

function normalize(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

function renderStationList() {
  const q = normalize(document.getElementById('stationSearch').value.trim());
  const items = [{ value: '', name: 'Todas as estações', meta: 'Visão consolidada' }]
    .concat(state.estacoes.map(v => ({ value: v, ...splitStation(v) })))
    .filter(i => !q || normalize(`${i.name} ${i.meta} ${i.value}`).includes(q));
  const list = document.getElementById('stationList');
  list.innerHTML = items.length
    ? items.map(i => `
      <button type="button" role="option" class="station-opt${i.value === state.estacao ? ' active' : ''}" data-value="${escapeHtml(i.value)}" onclick="selectStation(this.dataset.value)">
        <span class="so-name">${escapeHtml(i.name)}</span>
        <span class="so-meta">${escapeHtml(i.meta)}</span>
      </button>`).join('')
    : '<p class="panel-empty">Nenhuma estação encontrada.</p>';
}

function toggleStation() {
  const el = document.getElementById('station');
  const isOpen = el.classList.contains('open');
  closePanels();
  if (!isOpen) {
    el.classList.add('open');
    const search = document.getElementById('stationSearch');
    search.value = '';
    renderStationList();
    search.focus();
  }
}

function stationSearchKey(e) {
  if (e.key !== 'Enter') return;
  const first = document.querySelector('#stationList .station-opt');
  if (first) selectStation(first.dataset.value);
}

function selectStation(value) {
  closePanels();
  if (value === state.estacao && !firstLoad) return;
  state.estacao = value;
  storeSet('pot-estacao', value);
  updateStationLabel();
  renderStationList();
  loadPacked(false);
}

// ---------- Multi-select (Turno / Zona / Hub) ----------

// O painel só é reconstruído quando as opções mudam — assim uma recarga não
// apaga a busca que o usuário está digitando nem fecha a lista.
function fillMs(key, values) {
  msState[key] = msState[key].filter(v => values.includes(v));
  const signature = values.join('\u0001');
  if (msOptionsCache[key] !== signature) {
    msOptionsCache[key] = signature;
    const panel = document.getElementById('ms' + key + 'Panel');
    const allLabel = key === 'Zona' ? 'Todas' : 'Todos';
    panel.innerHTML = `
      ${values.length > 6 ? `<input type="search" class="panel-search" placeholder="Buscar ${key.toLowerCase()}..." oninput="msFilter('${key}', this.value)">` : ''}
      <label class="ms-option all">
        <input type="checkbox" data-ms="${key}" data-all onchange="msToggleAll('${key}')">
        ${allLabel} <span class="ms-count">${values.length}</span>
      </label>
      <div class="ms-list">
        ${values.map(v => `
          <label class="ms-option" data-search="${escapeHtml(normalize(v))}">
            <input type="checkbox" data-ms="${key}" value="${escapeHtml(v)}" onchange="msToggleValue('${key}', this.value)">
            <span>${escapeHtml(v)}</span>
          </label>
        `).join('')}
        <p class="panel-empty" hidden>Nada encontrado.</p>
      </div>
    `;
  }
  msSyncChecks(key);
  msUpdateLabel(key);
}

function msFilter(key, query) {
  const q = normalize(query.trim());
  const panel = document.getElementById('ms' + key + 'Panel');
  let visible = 0;
  panel.querySelectorAll('.ms-list .ms-option').forEach(opt => {
    const show = !q || opt.dataset.search.includes(q);
    opt.hidden = !show;
    if (show) visible++;
  });
  panel.querySelector('.ms-list .panel-empty').hidden = visible > 0;
}

function msSyncChecks(key) {
  const panel = document.getElementById('ms' + key + 'Panel');
  const selected = msState[key];
  panel.querySelectorAll(`input[data-ms="${key}"]:not([data-all])`).forEach(cb => {
    cb.checked = selected.includes(cb.value);
  });
  const allCb = panel.querySelector(`input[data-ms="${key}"][data-all]`);
  if (allCb) allCb.checked = selected.length === 0;
}

function msUpdateLabel(key) {
  const btn = document.getElementById('ms' + key + 'Toggle');
  const selected = msState[key];
  const allLabel = key === 'Zona' ? 'Todas' : 'Todos';
  if (!selected.length) btn.textContent = allLabel;
  else if (selected.length === 1) btn.textContent = selected[0];
  else btn.textContent = `${selected.length} selecionados`;
  btn.classList.toggle('active', selected.length > 0);
}

function msChanged(key) {
  msSyncChecks(key);
  msUpdateLabel(key);
  renderChips();
  scheduleLoad();
}

function msToggleValue(key, value) {
  const idx = msState[key].indexOf(value);
  if (idx >= 0) msState[key].splice(idx, 1); else msState[key].push(value);
  msChanged(key);
}

function msToggleAll(key) {
  msState[key] = [];
  msChanged(key);
}

function closePanels() {
  document.querySelectorAll('.ms.open, .station.open').forEach(o => o.classList.remove('open'));
}

function toggleMs(id) {
  const el = document.getElementById(id);
  const isOpen = el.classList.contains('open');
  closePanels();
  if (!isOpen) {
    el.classList.add('open');
    const search = el.querySelector('.panel-search');
    if (search) search.focus();
  }
}

document.addEventListener('click', e => {
  document.querySelectorAll('.ms.open, .station.open').forEach(el => {
    if (!el.contains(e.target)) el.classList.remove('open');
  });
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanels(); });

// ---------- Período ----------

// Os presets usam o intervalo da aba "Packed on time" (a mais curta); os campos de
// data aceitam também o histórico mais longo da db_pot, que alimenta o % POT.
function updateDateBounds(bounds, potBounds) {
  state.dateBounds = bounds;
  const ini = document.getElementById('filterDataIni');
  const fim = document.getElementById('filterDataFim');
  const all = [bounds, potBounds].filter(Boolean);
  if (!all.length) { ini.removeAttribute('min'); ini.removeAttribute('max'); fim.removeAttribute('min'); fim.removeAttribute('max'); }
  else {
    ini.min = fim.min = all.map(b => b.min).sort()[0];
    ini.max = fim.max = all.map(b => b.max).sort().pop();
  }
  syncPresets();
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Presets contam a partir do último dia com dado na base (não de "hoje"), porque a
// planilha pode estar um dia atrás.
function presetRange(days) {
  const b = state.dateBounds;
  if (!days || !b) return { from: '', to: '' };
  const from = shiftDate(b.max, -(days - 1));
  return { from: from < b.min ? b.min : from, to: b.max };
}

function applyPreset(days) {
  const r = presetRange(days);
  document.getElementById('filterDataIni').value = r.from;
  document.getElementById('filterDataFim').value = r.to;
  onDateChange();
}

function onDateChange() {
  syncPresets();
  renderChips();
  scheduleLoad();
}

function syncPresets() {
  const from = document.getElementById('filterDataIni').value;
  const to = document.getElementById('filterDataFim').value;
  document.querySelectorAll('#datePresets button').forEach(btn => {
    const r = presetRange(+btn.dataset.preset);
    const isAll = +btn.dataset.preset === 0;
    btn.classList.toggle('active', isAll ? (!from && !to) : (r.from === from && r.to === to));
  });
}

// ---------- Filtros ativos ----------

function renderChips() {
  const chips = [];
  const from = document.getElementById('filterDataIni').value;
  const to = document.getElementById('filterDataFim').value;
  if (from || to) {
    const label = from && to && from === to ? fmtDate(from) : `${from ? fmtDate(from) : 'início'} – ${to ? fmtDate(to) : 'fim'}`;
    chips.push(`<button type="button" class="chip" onclick="applyPreset(0)"><span class="chip-k">Período</span>${label}<span class="chip-x">✕</span></button>`);
  }
  MS_KEYS.forEach(key => {
    const sel = msState[key];
    if (sel.length > 3) {
      chips.push(`<button type="button" class="chip" onclick="msToggleAll('${key}')"><span class="chip-k">${key}</span>${sel.length} selecionados<span class="chip-x">✕</span></button>`);
    } else {
      sel.forEach(v => chips.push(`<button type="button" class="chip" data-value="${escapeHtml(v)}" onclick="msToggleValue('${key}', this.dataset.value)"><span class="chip-k">${key}</span>${escapeHtml(v)}<span class="chip-x">✕</span></button>`));
    }
  });
  document.getElementById('activeChips').innerHTML = chips.join('');
  document.getElementById('btnClear').disabled = !chips.length;
}

function clearFilters() {
  document.getElementById('filterDataIni').value = '';
  document.getElementById('filterDataFim').value = '';
  MS_KEYS.forEach(key => {
    msState[key] = [];
    msSyncChecks(key);
    msUpdateLabel(key);
  });
  syncPresets();
  renderChips();
  loadPacked(false);
}

// ---------- Formatação ----------

function fmtMin(min) {
  if (min === null || min === undefined || isNaN(min)) return '—';
  const abs = Math.abs(min);
  if (abs < 60) return Math.round(min) + 'min';
  if (abs < 1440) return (min / 60).toFixed(1) + 'h';
  return (min / 1440).toFixed(1) + 'd';
}
function fmtH(h) {
  if (h === null || h === undefined || isNaN(h)) return '—';
  const abs = Math.abs(h);
  if (abs < 24) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
}
function fmtPct(v) { return v === null || v === undefined || isNaN(v) ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%'; }
function fmtInt(n) { return n === null || n === undefined ? '—' : n.toLocaleString('pt-BR'); }
function fmtDate(iso) { return iso.split('-').reverse().join('/'); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Render ----------

function renderAll(s) {
  renderPot(pot);
  renderKPIs(s);
  renderInsights(s);
  renderEstacaoSection(s);
  renderTrendChart(s);
  renderTurnoCharts(s);
  renderRanks(s);
}

function renderKPIs(s) {
  document.getElementById('kpiTotal').textContent = s ? s.total.toLocaleString('pt-BR') : '—';
  document.getElementById('kpiAvgAtraso').textContent = s ? fmtMin(s.avgAtrasoMin) : '—';
  document.getElementById('kpiAvgLead').textContent = s ? fmtH(s.avgLeadTimeH) : '—';
  document.getElementById('kpiAvgPacking').textContent = s ? fmtMin(s.avgMinPacking) : '—';
  document.getElementById('kpiAvgStage').textContent = s ? fmtMin(s.avgMinStageInbound) : '—';
}

function fmtDelta(value, base) {
  if (value === null || value === undefined || !base) return '';
  const delta = ((value - base) / base) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% vs. média geral`;
}

function renderInsights(s) {
  const container = document.getElementById('insightsList');
  if (!s || !s.total) {
    container.innerHTML = '<li>Sem dados para os filtros selecionados.</li>';
    return;
  }
  const items = [];
  const { topOfensorZona, topOfensorHub, topOfensorTurno } = s.insights;
  const overall = s.avgAtrasoMin;

  if (pot && !pot.error && pot.pct !== null) {
    items.push(`<strong>% POT de ${fmtPct(pot.pct)}</strong>: os ${fmtInt(pot.outTime)} pedidos Out time equivalem a <strong>${fmtPct(1 - pot.pct)}</strong> do On time. Outros ${fmtInt(pot.cptNa)} estão sem CPT e ficam fora da conta.`);
    const potEst = (pot.porEstacao || []).filter(e => e.pct !== null);
    if (!state.estacao && potEst.length > 1) {
      items.push(`Pior % POT entre as estações: <strong>${escapeHtml(splitStation(potEst[0].estacao).name)}</strong> com <strong>${fmtPct(potEst[0].pct)}</strong>.`);
    }
  }

  items.push(`<strong>${s.total.toLocaleString('pt-BR')}</strong> pacotes no período, com atraso médio geral de <strong>${fmtMin(overall)}</strong> e lead time médio de <strong>${fmtH(s.avgLeadTimeH)}</strong>.`);

  const estacoesComMedia = (s.porEstacao || []).filter(e => e.avgAtrasoMin !== null);
  if (!state.estacao && estacoesComMedia.length > 1) {
    const pior = estacoesComMedia[0];
    const delta = fmtDelta(pior.avgAtrasoMin, overall);
    items.push(`Entre as estações, <strong>${escapeHtml(splitStation(pior.estacao).name)}</strong> tem o maior atraso médio: <strong>${fmtMin(pior.avgAtrasoMin)}</strong>${delta ? ` (<strong>${delta}</strong>)` : ''}, com ${pior.shipments.toLocaleString('pt-BR')} pacotes.`);
  }

  const zonasComMedia = (s.porZona || []).filter(z => z.avgAtrasoMin !== null);
  const topZonas = zonasComMedia.slice(0, 3);
  if (topZonas.length) {
    const lista = topZonas.map(z => `${escapeHtml(z.zona)} (${fmtMin(z.avgAtrasoMin)})`).join(', ');
    const volumeTop = topZonas.reduce((sum, z) => sum + z.shipments, 0);
    const pctVolumeTop = s.total ? (volumeTop / s.total) * 100 : 0;
    items.push(`O atraso se concentra nas piores <strong>${topZonas.length}</strong> zona(s): <strong>${lista}</strong> — juntas somam <strong>${pctVolumeTop.toFixed(1)}%</strong> do volume total (${volumeTop.toLocaleString('pt-BR')} pacotes).`);
  }

  if (topOfensorZona) {
    const delta = fmtDelta(topOfensorZona.avgAtrasoMin, overall);
    items.push(`A zona <strong>${escapeHtml(topOfensorZona.zona)}</strong> é a pior isoladamente: <strong>${fmtMin(topOfensorZona.avgAtrasoMin)}</strong> de atraso médio${delta ? ` (<strong>${delta}</strong>)` : ''}, com ${topOfensorZona.shipments.toLocaleString('pt-BR')} pacotes.`);
  }
  if (topOfensorHub) {
    const delta = fmtDelta(topOfensorHub.avgAtrasoMin, overall);
    items.push(`O hub <strong>${escapeHtml(topOfensorHub.hub)}</strong> é o maior ofensor entre os hubs: <strong>${fmtMin(topOfensorHub.avgAtrasoMin)}</strong>${delta ? ` (<strong>${delta}</strong>)` : ''}.`);
  }
  if (topOfensorTurno) {
    const delta = fmtDelta(topOfensorTurno.avgAtrasoMin, overall);
    items.push(`O <strong>${escapeHtml(topOfensorTurno.turno)}</strong> concentra o maior atraso entre os turnos: <strong>${fmtMin(topOfensorTurno.avgAtrasoMin)}</strong>${delta ? ` (<strong>${delta}</strong>)` : ''}, com ${topOfensorTurno.shipments.toLocaleString('pt-BR')} pacotes.`);
  }

  if (overall) {
    const acimaMedia = zonasComMedia.filter(z => z.avgAtrasoMin > overall);
    const volumeAcima = acimaMedia.reduce((sum, z) => sum + z.shipments, 0);
    const pctAcima = s.total ? (volumeAcima / s.total) * 100 : 0;
    if (acimaMedia.length) {
      const espalhado = pctAcima > 50;
      items.push({
        warn: espalhado,
        html: `<strong>${acimaMedia.length}</strong> zona(s) com atraso acima da média concentram <strong>${pctAcima.toFixed(1)}%</strong> do volume total (${volumeAcima.toLocaleString('pt-BR')} pacotes) — ${espalhado ? 'o atraso está espalhado, não é um caso isolado.' : 'o problema tende a ficar concentrado nessas zonas específicas.'}`
      });
    }
  }

  if (s.porDia && s.porDia.length > 1) {
    const piorDia = s.porDia.filter(d => d.avgAtrasoMin !== null).reduce((max, d) => (!max || d.avgAtrasoMin > max.avgAtrasoMin ? d : max), null);
    if (piorDia) {
      items.push(`O pior dia do período foi <strong>${fmtDate(piorDia.data)}</strong>, com atraso médio de <strong>${fmtMin(piorDia.avgAtrasoMin)}</strong>.`);
    }
  }

  container.innerHTML = items.map(i => {
    const isObj = typeof i === 'object';
    return `<li${isObj && i.warn ? ' class="warn"' : ''}>${isObj ? i.html : i}</li>`;
  }).join('');
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

// Paleta mínima: uma única família de cor (laranja) por gráfico — nunca duas
// escalas no mesmo eixo, nunca uma cor por categoria arbitrária. Os tons de
// apoio (grid, tooltip, texto) trocam com o tema pra manter contraste.
const ORANGE = '#f97316';
function chartPalette() {
  const dark = currentTheme() === 'dark';
  return {
    orange: ORANGE,
    orangeFill: 'rgba(249,115,22,.14)',
    grid: dark ? '#1f1f1f' : '#ececea',
    tick: dark ? '#7a7a78' : '#8a8983',
    tooltipBg: dark ? '#0e0e0e' : '#ffffff',
    tooltipBorder: dark ? '#333333' : '#d4d3cf',
    tooltipTitle: dark ? '#f5f5f4' : '#171614',
    tooltipBody: dark ? '#b8b8b6' : '#4b4a46'
  };
}

function chartOpts(extra) {
  const p = chartPalette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: p.tooltipBg, borderColor: p.tooltipBorder, borderWidth: 1,
        titleColor: p.tooltipTitle, bodyColor: p.tooltipBody, padding: 10, cornerRadius: 6,
        titleFont: { family: 'Inter', size: 11 }, bodyFont: { family: 'JetBrains Mono', size: 11 }
      },
      datalabels: { display: false }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: p.tick, font: { size: 10, family: 'JetBrains Mono' } } },
      y: { grid: { color: p.grid }, border: { display: false }, ticks: { color: p.tick, font: { size: 10, family: 'JetBrains Mono' } } }
    },
    ...extra
  };
}

// ---------- % POT (aba db_pot) ----------

// A db_pot só tem dia × estação × status: os filtros de turno/zona/hub não se
// aplicam a ela — o cabeçalho da seção avisa quando algum estiver ativo.
function renderPot(p) {
  const err = document.getElementById('potError');
  err.hidden = !(p && p.error);
  if (p && p.error) err.textContent = 'Não foi possível ler a aba db_pot: ' + p.error;
  const ok = p && !p.error;

  document.getElementById('kpiPotPct').textContent = ok ? fmtPct(p.pct) : '—';
  document.getElementById('kpiPotOn').textContent = ok ? fmtInt(p.onTime) : '—';
  document.getElementById('kpiPotOut').textContent = ok ? fmtInt(p.outTime) : '—';
  document.getElementById('kpiPotCpt').textContent = ok ? fmtInt(p.cptNa) : '—';
  document.getElementById('kpiPotTotal').textContent = ok ? fmtInt(p.total) : '—';
  const share = v => (ok && p.total ? `${fmtPct(v / p.total)} do total` : '');
  document.getElementById('kpiPotOnSub').textContent = share(ok ? p.onTime : 0) || 'Pedidos no prazo';
  document.getElementById('kpiPotOutSub').textContent = share(ok ? p.outTime : 0) || 'Pedidos fora do prazo';
  document.getElementById('kpiPotCptSub').textContent = (share(ok ? p.cptNa : 0) || 'Sem CPT planejado') + ' · fora do cálculo do %';

  const dias = ok ? p.porDia : [];
  const range = dias.length ? (dias.length === 1 ? fmtDate(dias[0].periodo) : `${fmtDate(dias[0].periodo)} a ${fmtDate(dias[dias.length - 1].periodo)}`) : '';
  const ignored = MS_KEYS.some(k => msState[k].length) ? ' · não filtra por turno/zona/hub' : '';
  document.getElementById('potRange').textContent = range + ignored;

  const gran = potGran || (dias.length > 31 ? 'semana' : 'dia');
  document.querySelectorAll('#potGran button').forEach(b => b.classList.toggle('active', b.dataset.gran === gran));
  const serie = !ok ? [] : gran === 'mes' ? p.porMes : gran === 'semana' ? p.porSemana : p.porDia;
  const label = per => {
    if (gran === 'mes') { const [y, m] = per.split('-'); return `${m}/${y}`; }
    return (gran === 'semana' ? 'sem ' : '') + per.slice(5).split('-').reverse().join('/');
  };
  renderPotChart(serie, label);

  const estacoes = ok ? p.porEstacao || [] : [];
  const showEst = !state.estacao && estacoes.length > 1;
  document.getElementById('potEstacaoCard').hidden = !showEst;
  document.getElementById('potTrendCard').classList.toggle('full', !showEst);
  if (showEst) renderPotEstacoes(estacoes, p.pct);
}

function setPotGran(gran) {
  potGran = gran;
  renderPot(pot);
}

function renderPotChart(serie, label) {
  destroyChart('chartPot');
  const p = chartPalette();
  const base = chartOpts();
  charts.chartPot = new Chart(document.getElementById('chartPot'), {
    type: 'line',
    data: {
      labels: serie.map(d => label(d.periodo)),
      datasets: [{
        label: '% POT',
        data: serie.map(d => (d.pct === null ? null : +(d.pct * 100).toFixed(2))),
        borderColor: p.orange,
        backgroundColor: p.orangeFill,
        borderWidth: 2,
        fill: true,
        tension: .25,
        pointBackgroundColor: p.orange,
        pointBorderWidth: 0,
        pointRadius: serie.length > 60 ? 0 : 3,
        pointHoverRadius: 5
      }]
    },
    options: {
      ...base,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        ...base.plugins,
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: {
            label: ctx => `% POT: ${fmtPct(serie[ctx.dataIndex].pct)}`,
            afterLabel: ctx => {
              const d = serie[ctx.dataIndex];
              return [`On time: ${fmtInt(d.onTime)}`, `Out time: ${fmtInt(d.outTime)}`, `CPT n/a: ${fmtInt(d.cptNa)}`];
            }
          }
        }
      },
      scales: {
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, autoSkip: true, maxTicksLimit: 14, maxRotation: 0 } },
        y: { ...base.scales.y, beginAtZero: false, suggestedMax: 100, ticks: { ...base.scales.y.ticks, callback: v => v + '%' } }
      }
    }
  });
}

function renderPotEstacoes(rows, overall) {
  const max = Math.max(...rows.map(r => r.pct || 0), 0.0001);
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  document.getElementById('rankPotEstacao').innerHTML = `
    <div class="rank-row rank-head"><div></div><div>Estação</div><div class="rv">% POT</div><div class="rv">Pedidos · %</div></div>
    ${rows.map((r, i) => {
      const st = splitStation(r.estacao);
      return `
      <button type="button" class="rank-row clickable" data-value="${escapeHtml(r.estacao)}" onclick="selectStation(this.dataset.value)">
        <div class="rpos">${i + 1}</div>
        <div class="rmain">
          <div class="rn" title="${escapeHtml(r.estacao)}">${escapeHtml(st.name)}<span class="rsub">${escapeHtml(st.meta)}</span></div>
          <div class="rbar"><span style="width:${((r.pct || 0) / max) * 100}%"></span></div>
        </div>
        <div class="rv${overall !== null && r.pct < overall ? ' hot' : ''}">${fmtPct(r.pct)}</div>
        <div class="rv">${fmtInt(r.total)}<span class="rpct">${total ? fmtPct(r.total / total) : ''}</span></div>
      </button>`;
    }).join('')}`;
}

// Tendência é a única série contínua do painel — linha fina, ponto discreto,
// preenchimento suave só pra dar leitura de volume sem virar "área cheia".
function renderTrendChart(s) {
  destroyChart('chartTrend');
  const dias = s ? s.porDia : [];
  const p = chartPalette();
  charts.chartTrend = new Chart(document.getElementById('chartTrend'), {
    type: 'line',
    data: {
      labels: dias.map(d => d.data.slice(5).split('-').reverse().join('/')),
      datasets: [{
        label: 'Atraso médio (min)',
        data: dias.map(d => d.avgAtrasoMin === null ? null : +d.avgAtrasoMin.toFixed(1)),
        borderColor: p.orange,
        backgroundColor: p.orangeFill,
        borderWidth: 2,
        fill: true,
        tension: .25,
        pointBackgroundColor: p.orange,
        pointBorderWidth: 0,
        pointRadius: 3,
        pointHoverRadius: 5
      }]
    },
    options: chartOpts()
  });
}

// Duas métricas de escalas diferentes (volume de pacotes × atraso em minutos)
// nunca dividem o mesmo eixo — small multiples lado a lado em vez de eixo duplo.
function renderTurnoCharts(s) {
  destroyChart('chartTurnoVolume');
  destroyChart('chartTurnoAtraso');
  const turnos = s ? s.porTurno.slice().sort((a, b) => a.turno.localeCompare(b.turno)) : [];
  const p = chartPalette();

  charts.chartTurnoVolume = new Chart(document.getElementById('chartTurnoVolume'), {
    type: 'bar',
    data: { labels: turnos.map(t => t.turno), datasets: [{ data: turnos.map(t => t.shipments), backgroundColor: p.orange, borderRadius: 4, borderSkipped: false, maxBarThickness: 56 }] },
    options: chartOpts()
  });

  charts.chartTurnoAtraso = new Chart(document.getElementById('chartTurnoAtraso'), {
    type: 'bar',
    data: { labels: turnos.map(t => t.turno), datasets: [{ data: turnos.map(t => t.avgAtrasoMin), backgroundColor: p.orange, borderRadius: 4, borderSkipped: false, maxBarThickness: 56 }] },
    options: chartOpts()
  });
}

// Comparativo só aparece na visão consolidada; cada linha abre a estação.
function renderEstacaoSection(s) {
  const section = document.getElementById('estacaoSection');
  const rows = s ? s.porEstacao || [] : [];
  section.hidden = !!state.estacao || rows.length < 2;
  if (section.hidden) return;
  renderRankList('rankEstacao', rows, {
    label: r => splitStation(r.estacao).name,
    sub: r => splitStation(r.estacao).meta,
    onClick: r => r.estacao,
    total: s.total,
    overall: s.avgAtrasoMin
  });
}

function renderRanks(s) {
  ['zona', 'hub'].forEach(key => {
    document.querySelectorAll(`.seg[data-rank="${key}"] button`).forEach(b => b.classList.toggle('active', b.dataset.sort === rankSort[key]));
    const ranked = s ? (key === 'zona' ? s.porZona : s.porHub) : [];
    const sorted = rankSort[key] === 'volume' ? ranked.slice().sort((a, b) => b.shipments - a.shipments) : ranked;
    renderRankList(key === 'zona' ? 'rankZona' : 'rankHub', sorted, {
      label: r => r[key],
      sortBy: rankSort[key],
      total: s ? s.total : 0,
      overall: s ? s.avgAtrasoMin : null,
      limit: rankExpanded[key] ? Infinity : RANK_LIMIT,
      expandKey: key
    });
  });
}

function setRankSort(key, sort) {
  rankSort[key] = sort;
  if (stats) renderRanks(stats);
}

function toggleRankExpand(key) {
  rankExpanded[key] = !rankExpanded[key];
  if (stats) renderRanks(stats);
}

// Linhas acima da média geral ganham o valor de atraso em destaque — dá pra bater
// o olho no ranking e ver onde está o problema sem ler número por número.
function renderRankList(containerId, ranked, opts) {
  const container = document.getElementById(containerId);
  if (!ranked || !ranked.length) {
    container.innerHTML = '<p class="rank-empty">Sem dados para os filtros selecionados.</p>';
    return;
  }
  const limit = opts.limit || Infinity;
  const top = ranked.slice(0, limit);
  const metric = r => (opts.sortBy === 'volume' ? r.shipments : r.avgAtrasoMin || 0);
  const maxMetric = Math.max(...top.map(metric), 1);
  const rowsHtml = top.map((r, i) => {
    const above = opts.overall && r.avgAtrasoMin > opts.overall;
    const pct = opts.total ? (r.shipments / opts.total) * 100 : 0;
    const tag = opts.onClick ? 'button' : 'div';
    const click = opts.onClick ? ` type="button" data-value="${escapeHtml(opts.onClick(r))}" onclick="selectStation(this.dataset.value)"` : '';
    return `
    <${tag} class="rank-row${opts.onClick ? ' clickable' : ''}"${click}>
      <div class="rpos">${i + 1}</div>
      <div class="rmain">
        <div class="rn" title="${escapeHtml(opts.label(r))}">${escapeHtml(opts.label(r))}${opts.sub ? `<span class="rsub">${escapeHtml(opts.sub(r))}</span>` : ''}</div>
        <div class="rbar"><span style="width:${(metric(r) / maxMetric) * 100}%"></span></div>
      </div>
      <div class="rv${above ? ' hot' : ''}">${fmtMin(r.avgAtrasoMin)}</div>
      <div class="rv">${r.shipments.toLocaleString('pt-BR')}<span class="rpct">${pct.toFixed(1)}%</span></div>
    </${tag}>`;
  }).join('');
  const more = opts.expandKey && ranked.length > RANK_LIMIT
    ? `<button type="button" class="rank-more" onclick="toggleRankExpand('${opts.expandKey}')">${rankExpanded[opts.expandKey] ? 'Mostrar menos' : `Ver todos (${ranked.length})`}</button>`
    : '';
  container.innerHTML = `
    <div class="rank-row rank-head"><div></div><div>Nome</div><div class="rv">Atraso</div><div class="rv">Pacotes · %</div></div>
    ${rowsHtml}${more}`;
}

function setStatus(type, msg) {
  const bar = document.getElementById('statusBar'), text = document.getElementById('statusText');
  bar.className = 'status-bar';
  if (type === 'ok') bar.classList.add('status-ok');
  if (type === 'err') bar.classList.add('status-err');
  if (type === 'load') bar.classList.add('status-load');
  bar.querySelector('span').textContent = type === 'load' ? '⟳' : '●';
  text.textContent = msg;
}

function showLoader(msg) { document.getElementById('loaderMsg').textContent = msg; document.getElementById('loader').classList.add('active'); }
function hideLoader() { document.getElementById('loader').classList.remove('active'); }

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('themeToggle').textContent = currentTheme() === 'dark' ? '☀ Claro' : '☾ Escuro';
  restoreFromUrl();
  updateStationLabel();
  renderChips();
  loadPacked(false);
});
