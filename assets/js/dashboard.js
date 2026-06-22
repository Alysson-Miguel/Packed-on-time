let rawData = [], filteredData = [], charts = {};

if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// ---------- Fetch ----------

async function fetchData() {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true; btn.textContent = '⟳ Buscando...';
  showLoader('Carregando dados...');
  try {
    let rows;
    let lastUpdate;
    if (typeof USE_MOCK !== 'undefined' && USE_MOCK) {
      rows = MOCK_ROWS;
      lastUpdate = new Date().toISOString();
      document.getElementById('liveDot').classList.add('mock');
      document.getElementById('liveLabel').textContent = 'Mock';
      setStatus('load', 'Usando dados de exemplo (mock). Defina USE_MOCK=false em config.js para conectar à planilha real.');
    } else {
      const response = await fetch('/api/sheet-data');
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);
      lastUpdate = payload.lastUpdate;
      rows = arraysToRows(payload.headers || [], payload.rows || []);
      document.getElementById('liveDot').classList.remove('mock');
      document.getElementById('liveLabel').textContent = 'Live';
      setStatus(payload.notice ? 'load' : 'ok', payload.notice || `Conectado à planilha. ${rows.length} registros carregados (últimos dias em cache).`);
    }
    document.getElementById('lastUpdate').textContent = lastUpdate ? new Date(lastUpdate).toLocaleString('pt-BR') : '—';
    rawData = rows.map(normalizeRow);
    populateFilterOptions();
    applyFilters();
  } catch (err) {
    console.error(err);
    setStatus('err', 'Erro ao carregar dados: ' + err.message);
  } finally {
    hideLoader();
    btn.disabled = false; btn.textContent = '⟳ Atualizar';
  }
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
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
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
  return {
    br: r.br,
    hub: r.hub_destino,
    received, packed, cpt,
    turno: r.turno_ofensor || 'Não informado',
    zona: (r.grupo_stage_inbound || 'Não informado').trim() || 'Não informado',
    stagingIn: parseDate(r.staging_in_datetime),
    detach: parseDate(r.detach_inbound_datetime),
    minPacking: toNumber(r.min_no_packing),
    horasStage: toNumber(r.horas_no_stage_inbound),
    totalCycle: toNumber(r.total_received_ate_packed_h),
    atrasoH: (packed && cpt) ? (packed.getTime() - cpt.getTime()) / 3600000 : null
  };
}

// ---------- Filtros ----------

function populateFilterOptions() {
  const turnos = [...new Set(rawData.map(r => r.turno))].sort();
  const zonas = [...new Set(rawData.map(r => r.zona))].sort();
  fillSelect('filterTurno', turnos);
  fillSelect('filterZona', zonas);
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
    if (r.received) {
      const d = r.received;
      const dStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (dateFrom && dStr < dateFrom) return false;
      if (dateTo && dStr > dateTo) return false;
    } else if (dateFrom || dateTo) {
      return false;
    }
    return true;
  });

  renderAll();
}

function clearFilters() {
  document.getElementById('filterDataIni').value = '';
  document.getElementById('filterDataFim').value = '';
  document.getElementById('filterTurno').value = '';
  document.getElementById('filterZona').value = '';
  applyFilters();
}

function renderAll() {
  renderKPIs();
  renderDiagnostico();
  renderTurnoChart();
  renderZonaRanking();
  renderHistogram('chartCiclo', filteredData.map(r => r.totalCycle).filter(v => v !== null), [0, 12, 24, 48, 72], 'h');
  renderHistogram('chartPacking', filteredData.map(r => r.minPacking).filter(v => v !== null), [0, 15, 30, 60, 120], 'min');
  renderDrilldown();
}

// ---------- KPIs ----------

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function fmtH(n) { return n === null || n === undefined ? '—' : n.toFixed(1) + 'h'; }
function fmtPct(n) { return n === null || n === undefined ? '—' : n.toFixed(1) + '%'; }

function renderKPIs() {
  const delays = filteredData.map(r => r.atrasoH).filter(v => v !== null);
  const avgDelay = avg(delays);
  const maxDelay = delays.length ? Math.max(...delays) : null;
  const avgCycle = avg(filteredData.map(r => r.totalCycle).filter(v => v !== null));

  document.getElementById('kpiTotal').textContent = filteredData.length.toLocaleString('pt-BR');
  document.getElementById('kpiAvgDelay').textContent = fmtH(avgDelay);
  document.getElementById('kpiMaxDelay').textContent = fmtH(maxDelay);
  document.getElementById('kpiAvgCycle').textContent = fmtH(avgCycle);
}

// ---------- Diagnóstico do Processo ----------

function renderDiagnostico() {
  const avgStage = avg(filteredData.map(r => r.horasStage).filter(v => v !== null));
  const avgPackingH = avg(filteredData.map(r => r.minPacking).filter(v => v !== null).map(v => v / 60));
  const avgCycle = avg(filteredData.map(r => r.totalCycle).filter(v => v !== null));
  const avgOutros = (avgCycle !== null && avgStage !== null && avgPackingH !== null) ? Math.max(avgCycle - avgStage - avgPackingH, 0) : null;

  document.getElementById('diagStage').textContent = fmtH(avgStage);
  document.getElementById('diagStagePct').textContent = avgCycle ? fmtPct((avgStage / avgCycle) * 100) + ' do ciclo' : '—';
  document.getElementById('diagPacking').textContent = fmtH(avgPackingH);
  document.getElementById('diagPackingPct').textContent = avgCycle ? fmtPct((avgPackingH / avgCycle) * 100) + ' do ciclo' : '—';
  document.getElementById('diagCycle').textContent = fmtH(avgCycle);
  document.getElementById('diagCyclePct').textContent = '100% do ciclo';

  destroyChart('chartDiagnostico');
  charts.chartDiagnostico = new Chart(document.getElementById('chartDiagnostico'), {
    type: 'bar',
    data: {
      labels: ['Tempo Médio do Ciclo'],
      datasets: [
        { label: 'Stage Inbound', data: [avgStage || 0], backgroundColor: '#ea580c', borderWidth: 0 },
        { label: 'Packing', data: [avgPackingH || 0], backgroundColor: '#1e293b', borderWidth: 0 },
        { label: 'Outros / Não Mapeado', data: [avgOutros || 0], backgroundColor: '#cbd5e1', borderWidth: 0 }
      ]
    },
    options: { ...chartOpts(), indexAxis: 'y', scales: { x: { stacked: true, grid: { color: '#f1f5f9' }, ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } } }, y: { stacked: true, grid: { display: false }, ticks: { color: '#64748b', font: { size: 10, family: 'JetBrains Mono' } } } } }
  });
}

// ---------- Por Turno ----------

function renderTurnoChart() {
  const turnos = [...new Set(filteredData.map(r => r.turno))].sort();
  const counts = turnos.map(t => filteredData.filter(r => r.turno === t).length);

  destroyChart('chartTurno');
  charts.chartTurno = new Chart(document.getElementById('chartTurno'), {
    type: 'bar',
    data: {
      labels: turnos,
      datasets: [
        { label: 'Pacotes Atrasados', data: counts, backgroundColor: '#ea580c', borderWidth: 0, borderRadius: 4 }
      ]
    },
    options: chartOpts()
  });
}

// ---------- Por Zona ----------

function renderZonaRanking() {
  const container = document.getElementById('zonaRanking');
  const groups = {};
  filteredData.forEach(r => {
    if (!groups[r.zona]) groups[r.zona] = { count: 0, horas: [] };
    groups[r.zona].count++;
    if (r.horasStage !== null) groups[r.zona].horas.push(r.horasStage);
  });
  const ranked = Object.entries(groups)
    .map(([zona, g]) => ({ zona, count: g.count, avgHoras: avg(g.horas) }))
    .sort((a, b) => b.count - a.count);
  const maxCount = ranked.length ? ranked[0].count : 1;

  if (!ranked.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:12px">Sem dados para os filtros selecionados.</p>';
    return;
  }

  container.innerHTML = ranked.map(z => `
    <div class="zona-row">
      <div>
        <div class="zn">${escapeHtml(z.zona)}</div>
        <div class="zbar"><span style="width:${(z.count / maxCount) * 100}%"></span></div>
      </div>
      <div class="zv">${z.count.toLocaleString('pt-BR')} pacotes</div>
      <div class="zv">${fmtH(z.avgHoras)} médio em zona</div>
    </div>
  `).join('');
}

// ---------- Histogramas ----------

function renderHistogram(canvasId, values, edges, unit) {
  const buckets = edges.map((e, i) => {
    const next = edges[i + 1];
    return { label: next ? `${e}-${next}${unit}` : `${e}${unit}+`, min: e, max: next };
  });
  const counts = buckets.map(b => values.filter(v => v >= b.min && (b.max === undefined || v < b.max)).length);

  destroyChart(canvasId);
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels: buckets.map(b => b.label), datasets: [{ label: 'Pacotes', data: counts, backgroundColor: '#1e293b', borderWidth: 0, borderRadius: 4 }] },
    options: chartOpts()
  });
}

// ---------- Drill-down ----------

function renderDrilldown() {
  const search = document.getElementById('searchBr').value.trim().toUpperCase();
  const rows = (search ? filteredData.filter(r => (r.br || '').toUpperCase().includes(search)) : filteredData).slice(0, 200);
  const tbody = document.getElementById('drilldownBody');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px">Nenhum registro encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.br || '—')}</td>
      <td>${turnoBadge(r.turno)}</td>
      <td class="td-num">${fmtDate(r.received)}</td>
      <td class="td-num">${fmtDate(r.packed)}</td>
      <td class="td-num">${fmtDate(r.cpt)}</td>
      <td class="td-num td-accent">${r.atrasoH !== null ? r.atrasoH.toFixed(1) + 'h' : '-'}</td>
      <td>${escapeHtml(r.zona)}</td>
      <td class="td-num">${r.horasStage !== null ? r.horasStage.toFixed(1) + 'h' : '-'}</td>
      <td class="td-num">${r.minPacking !== null ? r.minPacking + 'min' : '-'}</td>
      <td class="td-num">${r.detach ? fmtDate(r.detach) : '-'}</td>
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

document.addEventListener('DOMContentLoaded', fetchData);
