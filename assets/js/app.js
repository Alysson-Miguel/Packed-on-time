let stats = null, charts = {};

if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// ---------- Tema ----------

function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pot-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'dark' ? '☀ Claro' : '☾ Escuro';
  if (stats) renderAll(stats); // recoloca os gráficos com a paleta do novo tema
}

function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

async function loadPacked(force) {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true; btn.textContent = '⟳ Buscando...';
  showLoader('Carregando resumo agregado...');
  try {
    const from = document.getElementById('filterDataIni').value;
    const to = document.getElementById('filterDataFim').value;
    const turno = document.getElementById('filterTurno').value;
    const zona = document.getElementById('filterZona').value;
    const hub = document.getElementById('filterHub').value;

    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (turno) params.set('turno', turno);
    if (zona) params.set('zona', zona);
    if (hub) params.set('hub', hub);

    const response = await fetch('/api/packed-summary' + (params.toString() ? '?' + params.toString() : ''));
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);

    document.getElementById('lastUpdate').textContent = payload.lastUpdate ? new Date(payload.lastUpdate).toLocaleString('pt-BR') : '—';

    if (!payload.stats) {
      setStatus('load', payload.notice || 'Sem dados disponíveis.');
      renderAll(null);
      return;
    }

    updateDateBounds(payload.dateBounds);
    fillSelect('filterTurno', payload.filterOptions.turnos);
    fillSelect('filterZona', payload.filterOptions.zonas);
    fillSelect('filterHub', payload.filterOptions.hubs);

    const range = payload.appliedRange || {};
    const rangeLabel = range.from && range.to
      ? (range.from === range.to ? range.from.split('-').reverse().join('/') : `${range.from.split('-').reverse().join('/')} a ${range.to.split('-').reverse().join('/')}`)
      : 'janela completa';
    setStatus('ok', `Conectado à aba "Packed on time". ${payload.stats.total.toLocaleString('pt-BR')} pacotes agregados (${rangeLabel}).`);

    stats = payload.stats;
    renderAll(stats);
  } catch (err) {
    console.error(err);
    setStatus('err', 'Erro ao carregar dados: ' + err.message);
  } finally {
    hideLoader();
    btn.disabled = false; btn.textContent = '⟳ Atualizar';
  }
}

function fillSelect(id, values) {
  const sel = document.getElementById(id);
  const prev = sel.value;
  sel.innerHTML = '<option value="">Todos</option>';
  values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
  if (prev && values.includes(prev)) sel.value = prev;
}

function updateDateBounds(bounds) {
  const ini = document.getElementById('filterDataIni');
  const fim = document.getElementById('filterDataFim');
  if (!bounds) { ini.removeAttribute('min'); ini.removeAttribute('max'); fim.removeAttribute('min'); fim.removeAttribute('max'); return; }
  ini.min = fim.min = bounds.min;
  ini.max = fim.max = bounds.max;
}

function clearFilters() {
  document.getElementById('filterDataIni').value = '';
  document.getElementById('filterDataFim').value = '';
  document.getElementById('filterTurno').value = '';
  document.getElementById('filterZona').value = '';
  document.getElementById('filterHub').value = '';
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
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Render ----------

function renderAll(s) {
  renderKPIs(s);
  renderInsights(s);
  renderTrendChart(s);
  renderTurnoCharts(s);
  renderRankList('rankHub', s ? s.porHub : [], 'hub');
  renderRankList('rankZona', s ? s.porZona : [], 'zona');
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

  items.push(`<strong>${s.total.toLocaleString('pt-BR')}</strong> pacotes no período, com atraso médio geral de <strong>${fmtMin(overall)}</strong> e lead time médio de <strong>${fmtH(s.avgLeadTimeH)}</strong>.`);

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
      const dataFmt = piorDia.data.split('-').reverse().join('/');
      items.push(`O pior dia do período foi <strong>${dataFmt}</strong>, com atraso médio de <strong>${fmtMin(piorDia.avgAtrasoMin)}</strong>.`);
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

function renderRankList(containerId, ranked, keyName) {
  const container = document.getElementById(containerId);
  if (!ranked || !ranked.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:16px 20px">Sem dados para os filtros selecionados.</p>';
    return;
  }
  const top = ranked.slice(0, 12);
  const maxAtraso = Math.max(...top.map(r => r.avgAtrasoMin || 0), 1);
  container.innerHTML = top.map(r => `
    <div class="rank-row">
      <div>
        <div class="rn">${escapeHtml(r[keyName])}</div>
        <div class="rbar"><span style="width:${((r.avgAtrasoMin || 0) / maxAtraso) * 100}%"></span></div>
      </div>
      <div class="rv">${fmtMin(r.avgAtrasoMin)}</div>
      <div class="rv">${r.shipments.toLocaleString('pt-BR')} pcts</div>
    </div>
  `).join('');
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
  loadPacked(false);
});
