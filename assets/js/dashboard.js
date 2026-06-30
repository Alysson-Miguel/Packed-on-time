let rawData = [], filteredData = [], charts = {};
let cacheDateBounds = null; // { min, max } — janela inteira disponível em cache no servidor
let fetchSeq = 0; // descarta respostas de buscas antigas que voltam depois de uma busca mais nova
let dataMode = 'aggregate'; // 'aggregate' = visão geral dos 10 dias (KPIs server-side, sem linha bruta) | 'rows' = data específica escolhida (linha a linha, drill-down/heatmap completos)

if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// ---------- Fetch ----------

// Mandar as ~250k linhas da janela de 10 dias pro navegador (~40MB) excede o limite
// de payload de resposta da Vercel (~4.5MB) e trava o painel. Por isso o painel tem
// dois modos:
//   - "aggregate": sem data selecionada, busca só os números prontos (/api/sheet-summary)
//     somados sobre os 10 dias inteiros — payload de poucos KB, mas sem linha a linha
//     (drill-down e mapa de calor usam endpoints próprios sob demanda nesse modo).
//   - "rows": com uma data/intervalo escolhido, busca as linhas daquele recorte
//     (/api/sheet-data, limitado a 20k linhas) e tudo roda local no navegador.

function loadMockData() {
  dataMode = 'rows';
  rawData = MOCK_ROWS.map(normalizeRow);
  cacheDateBounds = null;
  document.getElementById('liveDot').classList.add('mock');
  document.getElementById('liveLabel').textContent = 'Mock';
  document.getElementById('lastUpdate').textContent = new Date().toLocaleString('pt-BR');
  setStatus('load', 'Usando dados de exemplo (mock). Defina USE_MOCK=false em config.js para conectar à planilha real.');
  populateFilterOptions();
  applyFilters();
}

// Cada resposta do servidor vem limitada a ~20k linhas (limite de payload da
// Vercel). Quando o recorte pedido tem mais linhas que isso, busca as páginas
// seguintes (offset crescente) e junta tudo aqui antes de seguir — assim o
// painel sempre mostra o intervalo completo, nunca um recorte truncado.
async function fetchAllRows(seq, force, from, to) {
  let headers = [], allArrays = [], payload = null, offset = 0;
  for (;;) {
    const params = new URLSearchParams();
    if (force && offset === 0) params.set('force', '1');
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (offset) params.set('offset', String(offset));
    const response = await fetch('/api/sheet-data?' + params.toString());
    payload = await response.json();
    if (seq !== fetchSeq) return null; // resposta de uma busca antiga chegando atrasada — ignora
    if (payload.error) throw new Error(payload.error);

    headers = payload.headers || [];
    allArrays = allArrays.concat(payload.rows || []);
    if (!payload.truncated || !payload.rows || !payload.rows.length) break;
    offset = payload.nextOffset;
    showLoader(`Carregando ${allArrays.length.toLocaleString('pt-BR')} de ${payload.totalInRange.toLocaleString('pt-BR')} registros...`);
  }
  return { headers, arrays: allArrays, payload };
}

async function loadRows(force, from, to) {
  if (typeof USE_MOCK !== 'undefined' && USE_MOCK) { loadMockData(); return; }
  const seq = ++fetchSeq;
  dataMode = 'rows';
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true; btn.textContent = force ? '⟳ Buscando na planilha...' : '⟳ Buscando...';
  showLoader(force ? 'Buscando dados direto da planilha (pode levar até 30s)...' : 'Carregando dados...');
  try {
    const result = await fetchAllRows(seq, force, from, to);
    if (!result) return;
    const { headers, arrays, payload } = result;

    const rows = arraysToRows(headers, arrays);
    cacheDateBounds = payload.dateBounds || null;
    document.getElementById('liveDot').classList.remove('mock');
    document.getElementById('liveLabel').textContent = 'Live';
    document.getElementById('lastUpdate').textContent = payload.lastUpdate ? new Date(payload.lastUpdate).toLocaleString('pt-BR') : '—';

    const range = payload.appliedRange || {};
    const rangeLabel = range.from && range.to
      ? (range.from === range.to ? range.from.split('-').reverse().join('/') : `${range.from.split('-').reverse().join('/')} a ${range.to.split('-').reverse().join('/')}`)
      : 'recorte atual';

    const iniInput = document.getElementById('filterDataIni');
    const fimInput = document.getElementById('filterDataFim');
    if (!iniInput.value && !fimInput.value && range.from) {
      iniInput.value = range.from;
      fimInput.value = range.to;
    }
    setStatus(payload.notice ? 'load' : 'ok', payload.notice || `Conectado à planilha. ${rows.length.toLocaleString('pt-BR')} registros carregados (${rangeLabel}).`);

    rawData = rows.map(normalizeRow);
    populateFilterOptions();
    applyFilters();
  } catch (err) {
    if (seq !== fetchSeq) return;
    console.error(err);
    setStatus('err', 'Erro ao carregar dados: ' + err.message);
  } finally {
    if (seq === fetchSeq) {
      hideLoader();
      btn.disabled = false; btn.textContent = '⟳ Atualizar';
    }
  }
}

const EMPTY_STATS = {
  total: 0, avgDelayH: null, maxDelayH: null, avgCycleH: null,
  diagnostico: { 'Aguardando Stage': { count: 0, avg: null }, 'Stage': { count: 0, avg: null }, 'Packing': { count: 0, avg: null } },
  porTurno: [], porZona: [], histCiclo: [], histPacking: [], insights: {}
};

async function loadAggregate(force) {
  if (typeof USE_MOCK !== 'undefined' && USE_MOCK) { loadMockData(); return; }
  const seq = ++fetchSeq;
  dataMode = 'aggregate';
  rawData = []; filteredData = [];
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true; btn.textContent = force ? '⟳ Buscando na planilha...' : '⟳ Buscando...';
  showLoader(force ? 'Buscando dados direto da planilha (pode levar até 30s)...' : 'Carregando visão geral (10 dias)...');
  try {
    const turno = document.getElementById('filterTurno').value;
    const zona = document.getElementById('filterZona').value;
    const params = new URLSearchParams();
    if (force) params.set('force', '1');
    if (turno) params.set('turno', turno);
    if (zona) params.set('zona', zona);
    const qs = params.toString();
    const response = await fetch('/api/sheet-summary' + (qs ? '?' + qs : ''));
    const payload = await response.json();
    if (seq !== fetchSeq) return;
    if (payload.error) throw new Error(payload.error);

    cacheDateBounds = payload.dateBounds || null;
    document.getElementById('liveDot').classList.remove('mock');
    document.getElementById('liveLabel').textContent = 'Live';
    document.getElementById('lastUpdate').textContent = payload.lastUpdate ? new Date(payload.lastUpdate).toLocaleString('pt-BR') : '—';
    updateDateBounds();

    if (!payload.stats) {
      setStatus('load', payload.notice || 'Sem dados em cache ainda.');
      fillSelect('filterTurno', []);
      fillSelect('filterZona', []);
      renderAll(EMPTY_STATS);
      return;
    }

    const range = payload.appliedRange || {};
    const rangeLabel = range.from && range.to
      ? `${range.from.split('-').reverse().join('/')} a ${range.to.split('-').reverse().join('/')} — visão geral`
      : 'janela completa em cache';
    setStatus('ok', `Conectado à planilha. ${payload.stats.total.toLocaleString('pt-BR')} registros agregados (${rangeLabel}).`);

    fillSelect('filterTurno', payload.stats.porTurno.map(t => t.turno));
    fillSelect('filterZona', payload.stats.porZona.map(z => z.zona).slice().sort());

    renderAll(payload.stats);
  } catch (err) {
    if (seq !== fetchSeq) return;
    console.error(err);
    setStatus('err', 'Erro ao carregar dados: ' + err.message);
  } finally {
    if (seq === fetchSeq) {
      hideLoader();
      btn.disabled = false; btn.textContent = '⟳ Atualizar';
    }
  }
}

// Refaz a busca já considerando o modo atual (visão geral ou data específica).
function refreshData() {
  const dateFrom = document.getElementById('filterDataIni').value;
  const dateTo = document.getElementById('filterDataFim').value;
  if (dateFrom || dateTo) loadRows(true, dateFrom, dateTo);
  else loadAggregate(true);
}

// Chamado pelos inputs de data. Com os dois em branco, volta pra visão geral
// agregada dos 10 dias; com qualquer um preenchido, busca as linhas daquele recorte.
function onDateFilterChange() {
  const dateFrom = document.getElementById('filterDataIni').value;
  const dateTo = document.getElementById('filterDataFim').value;
  if (!dateFrom && !dateTo) loadAggregate(false);
  else loadRows(false, dateFrom, dateTo);
}

// Chamado pelos selects de turno/zona: no modo "rows" já tem as linhas localmente
// (só refiltra); no modo "aggregate" precisa pedir os números de novo no servidor.
function onCategoryFilterChange() {
  if (dataMode === 'rows') applyFilters();
  else loadAggregate(false);
}

function arraysToRows(headers, arrayRows) {
  return arrayRows.map(arr => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = arr[i] !== undefined ? arr[i] : ''; });
    return obj;
  });
}

// ---------- Normalização ----------

function parseDate(value) {
  if (!value) return null;
  // Hora/minuto/segundo sem zero à esquerda (ex: "2026-06-22 4:05:44") também é
  // válido — a planilha exporta assim quando a hora é menor que 10.
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function normalizeRow(r) {
  const received = parseDate(r.received_datetime);
  const packed = parseDate(r.packed_datetime);
  const cpt = parseDate(r.cpt_planejado);
  const stagingIn = parseDate(r.staging_in_datetime);
  return {
    br: r.br,
    toNumber: r.to_number,
    hub: r.hub_destino,
    received, packed, cpt,
    turno: r.turno_ofensor || 'Não informado',
    zona: (r.grupo_stage_inbound || 'Não informado').trim() || 'Não informado',
    stagingIn,
    detach: parseDate(r.detach_inbound_datetime),
    minPacking: toNumber(r.min_no_packing),
    horasStage: toNumber(r.horas_no_stage_inbound),
    totalCycle: toNumber(r.total_received_ate_packed_h),
    atrasoH: (packed && cpt) ? (packed.getTime() - cpt.getTime()) / 3600000 : null,
    esperaStage: (received && stagingIn) ? (stagingIn.getTime() - received.getTime()) / 3600000 : null
  };
}

// ---------- Filtros ----------

function populateFilterOptions() {
  const turnos = [...new Set(rawData.map(r => r.turno))].sort();
  const zonas = [...new Set(rawData.map(r => r.zona))].sort();
  fillSelect('filterTurno', turnos);
  fillSelect('filterZona', zonas);
  updateDateBounds();
}

function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Os limites min/max do seletor de data refletem a janela inteira disponível em
// cache no servidor (cacheDateBounds), não só o que está carregado agora.
function updateDateBounds() {
  const ini = document.getElementById('filterDataIni');
  const fim = document.getElementById('filterDataFim');

  if (cacheDateBounds) {
    ini.min = fim.min = cacheDateBounds.min;
    ini.max = fim.max = cacheDateBounds.max;
    return;
  }

  const dates = rawData.map(r => r.packed).filter(d => d);
  if (!dates.length) {
    ini.removeAttribute('min'); ini.removeAttribute('max');
    fim.removeAttribute('min'); fim.removeAttribute('max');
    return;
  }
  let minMs = dates[0].getTime(), maxMs = dates[0].getTime();
  for (const d of dates) {
    const t = d.getTime();
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  const minStr = toDateStr(new Date(minMs));
  const maxStr = toDateStr(new Date(maxMs));
  ini.min = fim.min = minStr;
  ini.max = fim.max = maxStr;
}

function fillSelect(id, values) {
  const sel = document.getElementById(id);
  const prev = sel.value;
  sel.innerHTML = '<option value="">Todos</option>';
  values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
  if (prev && values.includes(prev)) sel.value = prev;
}

function applyFilters() {
  const dateFrom = document.getElementById('filterDataIni').value;
  const dateTo = document.getElementById('filterDataFim').value;
  const turno = document.getElementById('filterTurno').value;
  const zona = document.getElementById('filterZona').value;

  filteredData = rawData.filter(r => {
    if (turno && r.turno !== turno) return false;
    if (zona && r.zona !== zona) return false;
    if (r.packed) {
      const dStr = toDateStr(r.packed);
      if (dateFrom && dStr < dateFrom) return false;
      if (dateTo && dStr > dateTo) return false;
    } else if (dateFrom || dateTo) {
      return false;
    }
    return true;
  });

  renderAll(computeStatsFromRows(filteredData));
}

function clearFilters() {
  document.getElementById('filterDataIni').value = '';
  document.getElementById('filterDataFim').value = '';
  document.getElementById('filterTurno').value = '';
  document.getElementById('filterZona').value = '';
  loadAggregate(false);
}

function renderAll(stats) {
  renderKPIs(stats);
  renderInsights(stats);
  renderDiagnostico(stats);
  renderTurnoChart(stats);
  renderZonaRanking(stats);
  renderHistogramFromBuckets('chartCiclo', stats.histCiclo);
  renderHistogramFromBuckets('chartPacking', stats.histPacking);
  renderDrilldown();
}

// ---------- Agregação client-side (modo "rows": filteredData já está no navegador) ----------

const CICLO_EDGES = [0, 12, 24, 48, 72];
const PACKING_EDGES = [0, 15, 30, 60, 120];

function bucketize(values, edges, unit) {
  return edges.map((e, i) => {
    const next = edges[i + 1];
    const label = next ? `${e}-${next}${unit}` : `${e}${unit}+`;
    const count = values.filter(v => v >= e && (next === undefined || v < next)).length;
    return { label, count };
  });
}

// Para cada pacote, aponta qual dos 3 processos consumiu mais tempo (o "gargalo" daquele pacote).
function classifyBottleneck(r) {
  const procs = [
    { label: 'Aguardando Stage', value: r.esperaStage },
    { label: 'Stage', value: r.horasStage },
    { label: 'Packing', value: r.minPacking !== null ? r.minPacking / 60 : null }
  ].filter(p => p.value !== null && !isNaN(p.value));
  if (!procs.length) return null;
  return procs.reduce((max, p) => (p.value > max.value ? p : max), procs[0]);
}

// Produz o mesmo formato de stats que o servidor devolve em /api/sheet-summary
// (ver api/_lib/metrics.js), só que a partir das linhas já carregadas localmente.
function computeStatsFromRows(rows) {
  const diag = { 'Aguardando Stage': { count: 0, sum: 0 }, 'Stage': { count: 0, sum: 0 }, 'Packing': { count: 0, sum: 0 } };
  const turnoCount = {}, zonaCount = {}, zonaHorasSum = {}, zonaHorasCount = {};
  let delaySum = 0, delayCount = 0, maxDelay = -Infinity;
  let cycleSum = 0, cycleCount = 0;
  let naoInformadoCount = 0;
  const cycleValues = [], packingValues = [];

  rows.forEach(r => {
    if (r.atrasoH !== null) {
      delaySum += r.atrasoH; delayCount++;
      if (r.atrasoH > maxDelay) maxDelay = r.atrasoH;
    }
    if (r.totalCycle !== null) { cycleSum += r.totalCycle; cycleCount++; cycleValues.push(r.totalCycle); }
    if (r.minPacking !== null) packingValues.push(r.minPacking);

    const b = classifyBottleneck(r);
    if (b) { diag[b.label].count++; diag[b.label].sum += b.value; }

    turnoCount[r.turno] = (turnoCount[r.turno] || 0) + 1;
    zonaCount[r.zona] = (zonaCount[r.zona] || 0) + 1;
    if (r.horasStage !== null) {
      zonaHorasSum[r.zona] = (zonaHorasSum[r.zona] || 0) + r.horasStage;
      zonaHorasCount[r.zona] = (zonaHorasCount[r.zona] || 0) + 1;
    }
    if (r.zona === 'Não informado') naoInformadoCount++;
  });

  const total = rows.length;
  const diagnostico = {};
  Object.keys(diag).forEach(label => {
    diagnostico[label] = { count: diag[label].count, avg: diag[label].count ? diag[label].sum / diag[label].count : null };
  });

  const porTurno = Object.keys(turnoCount).sort().map(t => ({ turno: t, count: turnoCount[t] }));
  const porZona = Object.keys(zonaCount)
    .map(z => ({ zona: z, count: zonaCount[z], avgHorasStage: zonaHorasCount[z] ? zonaHorasSum[z] / zonaHorasCount[z] : null }))
    .sort((a, b) => b.count - a.count);
  const turnoRanked = Object.entries(turnoCount).sort((a, b) => b[1] - a[1]);

  const avgDelayH = delayCount ? delaySum / delayCount : null;
  const maxDelayH = delayCount ? maxDelay : null;
  const avgCycleH = cycleCount ? cycleSum / cycleCount : null;

  const procStats = Object.entries(diagnostico).map(([label, g]) => ({ label, count: g.count, avg: g.avg }));
  const topProc = procStats.length ? procStats.reduce((max, s) => (s.count > max.count ? s : max), procStats[0]) : null;
  const naoInformadoPct = total ? (naoInformadoCount / total) * 100 : 0;
  const outlier = (delayCount && maxDelayH !== null && avgDelayH !== null && maxDelayH > avgDelayH * 3 && maxDelayH > 24)
    ? { maxAtraso: maxDelayH, avgAtraso: avgDelayH } : null;

  return {
    total,
    avgDelayH, maxDelayH, avgCycleH,
    diagnostico,
    porTurno,
    porZona,
    histCiclo: bucketize(cycleValues, CICLO_EDGES, 'h'),
    histPacking: bucketize(packingValues, PACKING_EDGES, 'min'),
    insights: {
      topProc: topProc && topProc.count ? topProc : null,
      topZona: porZona.length ? porZona[0] : null,
      naoInformadoPct,
      topTurno: turnoRanked.length ? { turno: turnoRanked[0][0], count: turnoRanked[0][1] } : null,
      outlier
    }
  };
}

// ---------- Insights Automáticos ----------

function renderInsights(stats) {
  const container = document.getElementById('insightsList');
  const total = stats.total;
  if (!total) {
    container.innerHTML = '<li>Sem dados para os filtros selecionados.</li>';
    return;
  }

  const items = [];
  const { topProc, topZona, naoInformadoPct, topTurno, outlier } = stats.insights;

  if (topProc) {
    items.push(`<strong>${fmtPct((topProc.count / total) * 100)}</strong> dos pacotes (${topProc.count.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}) tiveram seu maior tempo perdido no processo <strong>${topProc.label}</strong>, com média de ${fmtDuration(topProc.avg)} nessa etapa.`);
  }
  if (topZona) {
    items.push(`A zona <strong>${escapeHtml(topZona.zona)}</strong> concentra <strong>${fmtPct((topZona.count / total) * 100)}</strong> dos pacotes (${topZona.count.toLocaleString('pt-BR')}).`);
  }
  if (naoInformadoPct > 5) {
    items.push({ warn: true, html: `<strong>${fmtPct(naoInformadoPct)}</strong> dos pacotes não têm zona registrada — esses são pacotes sem endereçamento no Stage In (campo grupo_stage_inbound vazio), o que limita a análise por zona.` });
  }
  if (topTurno) {
    items.push(`O <strong>${escapeHtml(topTurno.turno)}</strong> concentra a maior parte dos atrasos: <strong>${fmtPct((topTurno.count / total) * 100)}</strong> (${topTurno.count.toLocaleString('pt-BR')} pacotes).`);
  }
  if (outlier) {
    items.push({ warn: true, html: `O pior caso individual chegou a <strong>${fmtDuration(outlier.maxAtraso)}</strong> de atraso — bem acima da média (${fmtDuration(outlier.avgAtraso)}). Parece ser uma exceção isolada, não o padrão do período.` });
  }

  container.innerHTML = items.map(i => {
    const isObj = typeof i === 'object';
    return `<li${isObj && i.warn ? ' class="warn"' : ''}>${isObj ? i.html : i}</li>`;
  }).join('');
}

// ---------- KPIs ----------

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
// Recebe uma duração em horas e escolhe a unidade mais legível: min (<1h), h (<24h) ou dias (>=24h).
function fmtDuration(hours) {
  if (hours === null || hours === undefined || isNaN(hours)) return '—';
  const abs = Math.abs(hours);
  if (abs < 1) return Math.round(hours * 60) + 'min';
  if (abs < 24) return hours.toFixed(1) + 'h';
  return (hours / 24).toFixed(1) + 'd';
}
function fmtPct(n) { return n === null || n === undefined ? '—' : n.toFixed(1) + '%'; }

function renderKPIs(stats) {
  document.getElementById('kpiTotal').textContent = stats.total.toLocaleString('pt-BR');
  document.getElementById('kpiAvgDelay').textContent = fmtDuration(stats.avgDelayH);
  document.getElementById('kpiMaxDelay').textContent = fmtDuration(stats.maxDelayH);
  document.getElementById('kpiAvgCycle').textContent = fmtDuration(stats.avgCycleH);
}

// ---------- Diagnóstico do Processo ----------

function renderDiagnostico(stats) {
  const total = stats.total;
  const labels = ['Aguardando Stage', 'Stage', 'Packing'];
  const statsArr = labels.map(label => ({
    label,
    count: stats.diagnostico[label].count,
    avg: stats.diagnostico[label].avg,
    pct: total ? (stats.diagnostico[label].count / total) * 100 : 0
  }));

  setDiagCard('diagEspera', 'diagEsperaSub', statsArr[0], total);
  setDiagCard('diagStage', 'diagStageSub', statsArr[1], total);
  setDiagCard('diagPacking', 'diagPackingSub', statsArr[2], total);

  destroyChart('chartDiagnostico');
  charts.chartDiagnostico = new Chart(document.getElementById('chartDiagnostico'), {
    type: 'bar',
    data: {
      labels: statsArr.map(s => s.label),
      datasets: [{ label: '% dos pacotes', data: statsArr.map(s => s.pct), backgroundColor: ['#cbd5e1', '#ea580c', '#1e293b'], borderWidth: 0, borderRadius: 4 }]
    },
    options: { ...chartOpts(), indexAxis: 'y', scales: { x: { max: 100, grid: { color: '#f1f5f9' }, ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } } }, y: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } } } } }
  });
}

function setDiagCard(valueId, subId, stat, total) {
  document.getElementById(valueId).textContent = total ? fmtPct(stat.pct) : '—';
  document.getElementById(subId).textContent = stat.count
    ? `${stat.count.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} pacotes · média ${fmtDuration(stat.avg)} nesse processo`
    : 'Nenhum pacote';
}

// ---------- Por Turno ----------

function renderTurnoChart(stats) {
  const turnos = stats.porTurno.map(t => t.turno);
  const counts = stats.porTurno.map(t => t.count);

  destroyChart('chartTurno');
  charts.chartTurno = new Chart(document.getElementById('chartTurno'), {
    type: 'bar',
    data: {
      labels: turnos,
      datasets: [
        { label: 'Pacotes Atrasados', data: counts, backgroundColor: '#ea580c', borderWidth: 0, borderRadius: 4 }
      ]
    },
    options: {
      ...chartOpts(),
      onClick: (evt, elements) => {
        if (!elements.length) return;
        openHeatmap('turno', turnos[elements[0].index]);
      },
      onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'; }
    }
  });
}

// ---------- Por Zona ----------

function renderZonaRanking(stats) {
  const container = document.getElementById('zonaRanking');
  const ranked = stats.porZona;
  const maxCount = ranked.length ? ranked[0].count : 1;

  if (!ranked.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:12px">Sem dados para os filtros selecionados.</p>';
    return;
  }

  container.innerHTML = ranked.map(z => `
    <div class="zona-row" data-zona="${escapeHtml(z.zona)}" role="button" tabindex="0" title="Clique para ver o mapa de calor de atrasos desta zona">
      <div>
        <div class="zn">${escapeHtml(z.zona)}</div>
        <div class="zbar"><span style="width:${(z.count / maxCount) * 100}%"></span></div>
      </div>
      <div class="zv">${z.count.toLocaleString('pt-BR')} pacotes</div>
      <div class="zv">${fmtDuration(z.avgHorasStage)} médio em zona</div>
    </div>
  `).join('');

  container.onclick = (e) => {
    const row = e.target.closest('.zona-row');
    if (row) openHeatmap('zona', row.dataset.zona);
  };
}

// ---------- Mapa de Calor (Zona / Turno) ----------

// Aberto a partir do clique numa zona (zona-row) ou numa barra do gráfico Por Turno.
// Mostra a concentração de pacotes Out of Time (atrasoH > 0) por dia × hora de
// recebimento — no modo "rows" calcula local (já tem as linhas); no modo "aggregate"
// pede a matriz pronta pro servidor (sem mandar linha bruta da janela de 10 dias).
async function openHeatmap(dim, value) {
  document.getElementById('heatmapTitle').textContent = `Mapa de Calor Out of Time — ${dim === 'zona' ? 'Zona' : 'Turno'}: ${value}`;
  document.getElementById('heatmapModal').classList.add('active');
  const sub = document.getElementById('heatmapSub');
  const grid = document.getElementById('heatmapGrid');

  if (dataMode === 'rows') {
    const subset = filteredData.filter(r =>
      (dim === 'zona' ? r.zona : r.turno) === value && r.received && r.atrasoH !== null && r.atrasoH > 0
    );
    sub.textContent = `${subset.length.toLocaleString('pt-BR')} pacotes atrasados (Packed após o CPT) · concentração por dia × hora de recebimento`;
    renderHeatmapGrid(buildHeatmapFromRows(subset));
    return;
  }

  sub.textContent = 'Carregando...';
  grid.innerHTML = '';
  try {
    const params = new URLSearchParams({ dim, value });
    const response = await fetch('/api/sheet-heatmap?' + params.toString());
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    sub.textContent = `${payload.count.toLocaleString('pt-BR')} pacotes atrasados (Packed após o CPT) · concentração por dia × hora de recebimento · janela completa em cache`;
    renderHeatmapGrid({ matrix: payload.matrix, dates: payload.dates, max: payload.max });
  } catch (err) {
    sub.textContent = '';
    grid.innerHTML = `<p style="color:var(--red);font-size:12px;padding:12px">Erro ao carregar mapa de calor: ${escapeHtml(err.message)}</p>`;
  }
}

function closeHeatmap() {
  document.getElementById('heatmapModal').classList.remove('active');
}

function buildHeatmapFromRows(subset) {
  const matrix = {};
  let max = 0;
  subset.forEach(r => {
    const d = toDateStr(r.received);
    const h = r.received.getHours();
    if (!matrix[d]) matrix[d] = new Array(24).fill(0);
    matrix[d][h]++;
    if (matrix[d][h] > max) max = matrix[d][h];
  });
  return { matrix, dates: Object.keys(matrix).sort(), max };
}

function renderHeatmapGrid({ matrix, dates, max }) {
  const container = document.getElementById('heatmapGrid');
  if (!dates.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:12px">Sem pacotes Out of Time para essa seleção no período filtrado.</p>';
    return;
  }

  let html = '<div class="heatmap-table">';
  html += '<div class="heatmap-row heatmap-header"><div class="heatmap-cell heatmap-label"></div>' +
    Array.from({ length: 24 }, (_, h) => `<div class="heatmap-cell heatmap-hour">${h}h</div>`).join('') + '</div>';
  dates.forEach(d => {
    html += `<div class="heatmap-row"><div class="heatmap-cell heatmap-label">${d.slice(5)}</div>`;
    for (let h = 0; h < 24; h++) {
      const count = matrix[d][h];
      const intensity = max ? count / max : 0;
      const bg = count ? `rgba(220,38,38,${(0.12 + intensity * 0.78).toFixed(2)})` : '';
      const fg = intensity > 0.55 ? '#fff' : '';
      html += `<div class="heatmap-cell heatmap-val" style="${bg ? `background:${bg};` : ''}${fg ? `color:${fg};` : ''}" title="${d} ${h}h — ${count} pacote(s)">${count || ''}</div>`;
    }
    html += '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// ---------- Histogramas ----------

function renderHistogramFromBuckets(canvasId, buckets) {
  destroyChart(canvasId);
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels: buckets.map(b => b.label), datasets: [{ label: 'Pacotes', data: buckets.map(b => b.count), backgroundColor: '#1e293b', borderWidth: 0, borderRadius: 4 }] },
    options: chartOpts()
  });
}

// ---------- Drill-down ----------

function renderDrilldown() {
  const tbody = document.getElementById('drilldownBody');

  if (dataMode === 'aggregate') {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:24px">Selecione uma data (campo "Packed de") para ver o detalhe por pacote — a visão geral mostra só os totais dos 10 dias.</td></tr>';
    return;
  }

  const search = document.getElementById('searchBr').value.trim().toUpperCase();
  const rows = (search ? filteredData.filter(r => (r.toNumber || '').toUpperCase().includes(search)) : filteredData).slice(0, 200);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:24px">Nenhum registro encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.toNumber || '—')}</td>
      <td>${escapeHtml(r.br || '—')}</td>
      <td>${turnoBadge(r.turno)}</td>
      <td class="td-num">${fmtDate(r.received)}</td>
      <td class="td-num">${fmtDuration(r.esperaStage)}</td>
      <td class="td-num">${fmtDuration(r.horasStage)}</td>
      <td class="td-num">${fmtDate(r.detach)}</td>
      <td class="td-num">${fmtDuration(r.minPacking !== null ? r.minPacking / 60 : null)}</td>
      <td class="td-num">${fmtDate(r.packed)}</td>
      <td class="td-num">${fmtDate(r.cpt)}</td>
      <td class="td-num td-accent">${fmtDuration(r.atrasoH)}</td>
      <td>${escapeHtml(r.zona)}</td>
    </tr>
  `).join('');
}

function turnoBadge(turno) {
  return `<span class="turno-badge">${escapeHtml(turno)}</span>`;
}

function fmtDate(d) { return d ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Utilidades de UI ----------

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function chartOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: '#475569', font: { size: 11, family: 'Inter' }, padding: 16, boxWidth: 10 } },
      tooltip: { backgroundColor: '#fff', borderColor: '#e5e7eb', borderWidth: 1, titleColor: '#0f172a', bodyColor: '#475569', padding: 10 },
      datalabels: {
        display: true, color: '#0f172a', font: { size: 10, weight: 'bold', family: 'JetBrains Mono' }, anchor: 'end', align: 'top', offset: 2,
        formatter: (value) => value > 0 ? (value >= 1000 ? (value / 1000).toFixed(1) + 'k' : Math.round(value * 10) / 10) : ''
      }
    },
    scales: {
      x: { grid: { color: '#f1f5f9' }, ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } } },
      y: { grid: { color: '#f1f5f9' }, ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } } }
    }
  };
}

function setStatus(type, msg) {
  const bar = document.getElementById('statusBar'), text = document.getElementById('statusText');
  bar.className = 'status-bar';
  if (type === 'ok') bar.classList.add('status-ok');
  if (type === 'err') bar.classList.add('status-err');
  if (type === 'load') bar.classList.add('status-load');
  bar.querySelector('span').textContent = type === 'load' ? '⟳' : '⬤';
  text.textContent = msg;
}

function showLoader(msg) { document.getElementById('loaderMsg').textContent = msg; document.getElementById('loader').classList.add('active'); }
function hideLoader() { document.getElementById('loader').classList.remove('active'); }

document.addEventListener('DOMContentLoaded', () => loadAggregate(false));
