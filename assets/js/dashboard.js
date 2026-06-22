let rawData = [], filteredData = [], charts = {};

if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// ---------- Fetch ----------

async function fetchData(force) {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true; btn.textContent = force ? '⟳ Buscando na planilha...' : '⟳ Buscando...';
  showLoader(force ? 'Buscando dados direto da planilha (pode levar até 30s)...' : 'Carregando dados...');
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
      const response = await fetch(force ? '/api/sheet-data?force=1' : '/api/sheet-data');
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);
      lastUpdate = payload.lastUpdate;
      rows = arraysToRows(payload.headers || [], payload.rows || []);
      document.getElementById('liveDot').classList.remove('mock');
      document.getElementById('liveLabel').textContent = 'Live';
      setStatus(payload.notice ? 'load' : 'ok', payload.notice || `Conectado à planilha. ${rows.length} registros carregados (${force ? 'busca direta agora' : 'últimos dias em cache'}).`);
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
  const stagingIn = parseDate(r.staging_in_datetime);
  return {
    br: r.br,
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

function updateDateBounds() {
  const dates = rawData.map(r => r.received).filter(d => d);
  const ini = document.getElementById('filterDataIni');
  const fim = document.getElementById('filterDataFim');
  if (!dates.length) {
    ini.removeAttribute('min'); ini.removeAttribute('max');
    fim.removeAttribute('min'); fim.removeAttribute('max');
    return;
  }
  const minStr = toDateStr(new Date(Math.min(...dates)));
  const maxStr = toDateStr(new Date(Math.max(...dates)));
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
    if (r.received) {
      const dStr = toDateStr(r.received);
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
  renderInsights();
  renderDiagnostico();
  renderTurnoChart();
  renderZonaRanking();
  renderHistogram('chartCiclo', filteredData.map(r => r.totalCycle).filter(v => v !== null), [0, 12, 24, 48, 72], 'h');
  renderHistogram('chartPacking', filteredData.map(r => r.minPacking).filter(v => v !== null), [0, 15, 30, 60, 120], 'min');
  renderDrilldown();
}

// ---------- Insights Automáticos ----------

function renderInsights() {
  const container = document.getElementById('insightsList');
  const total = filteredData.length;
  if (!total) {
    container.innerHTML = '<li>Sem dados para os filtros selecionados.</li>';
    return;
  }

  const items = [];

  // 1. Processo que mais consome tempo (reaproveita a mesma classificação do Diagnóstico)
  const groups = { 'Aguardando Stage': { count: 0, sum: 0 }, 'Stage': { count: 0, sum: 0 }, 'Packing': { count: 0, sum: 0 } };
  filteredData.forEach(r => {
    const b = classifyBottleneck(r);
    if (b) { groups[b.label].count++; groups[b.label].sum += b.value; }
  });
  const stats = Object.entries(groups).map(([label, g]) => ({ label, count: g.count, avg: g.count ? g.sum / g.count : null }));
  const topProc = stats.reduce((max, s) => (s.count > max.count ? s : max), stats[0]);
  if (topProc.count) {
    items.push(`<strong>${fmtPct((topProc.count / total) * 100)}</strong> dos pacotes (${topProc.count.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}) tiveram seu maior tempo perdido no processo <strong>${topProc.label}</strong>, com média de ${fmtDuration(topProc.avg)} nessa etapa.`);
  }

  // 2. Concentração por zona + alerta de qualidade de dado
  const zonaCount = {};
  filteredData.forEach(r => { zonaCount[r.zona] = (zonaCount[r.zona] || 0) + 1; });
  const zonaRanked = Object.entries(zonaCount).sort((a, b) => b[1] - a[1]);
  if (zonaRanked.length) {
    const [topZona, topZonaCount] = zonaRanked[0];
    items.push(`A zona <strong>${escapeHtml(topZona)}</strong> concentra <strong>${fmtPct((topZonaCount / total) * 100)}</strong> dos pacotes (${topZonaCount.toLocaleString('pt-BR')}).`);
  }
  const naoInformado = zonaCount['Não informado'] || 0;
  if (naoInformado / total > 0.05) {
    items.push({ warn: true, html: `<strong>${fmtPct((naoInformado / total) * 100)}</strong> dos pacotes não têm zona registrada — isso limita a análise por zona e pode indicar falha de captura de dado.` });
  }

  // 3. Concentração por turno
  const turnoCount = {};
  filteredData.forEach(r => { turnoCount[r.turno] = (turnoCount[r.turno] || 0) + 1; });
  const turnoRanked = Object.entries(turnoCount).sort((a, b) => b[1] - a[1]);
  if (turnoRanked.length) {
    const [topTurno, topTurnoCount] = turnoRanked[0];
    items.push(`O <strong>${escapeHtml(topTurno)}</strong> concentra a maior parte dos atrasos: <strong>${fmtPct((topTurnoCount / total) * 100)}</strong> (${topTurnoCount.toLocaleString('pt-BR')} pacotes).`);
  }

  // 4. Outlier de atraso (pior caso muito acima da média)
  const atrasos = filteredData.map(r => r.atrasoH).filter(v => v !== null);
  if (atrasos.length) {
    const avgAtraso = avg(atrasos);
    const maxAtraso = Math.max(...atrasos);
    if (avgAtraso !== null && maxAtraso > avgAtraso * 3 && maxAtraso > 24) {
      items.push({ warn: true, html: `O pior caso individual chegou a <strong>${fmtDuration(maxAtraso)}</strong> de atraso — bem acima da média (${fmtDuration(avgAtraso)}). Parece ser uma exceção isolada, não o padrão do período.` });
    }
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

function renderKPIs() {
  const delays = filteredData.map(r => r.atrasoH).filter(v => v !== null);
  const avgDelay = avg(delays);
  const maxDelay = delays.length ? Math.max(...delays) : null;
  const avgCycle = avg(filteredData.map(r => r.totalCycle).filter(v => v !== null));

  document.getElementById('kpiTotal').textContent = filteredData.length.toLocaleString('pt-BR');
  document.getElementById('kpiAvgDelay').textContent = fmtDuration(avgDelay);
  document.getElementById('kpiMaxDelay').textContent = fmtDuration(maxDelay);
  document.getElementById('kpiAvgCycle').textContent = fmtDuration(avgCycle);
}

// ---------- Diagnóstico do Processo ----------

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

function renderDiagnostico() {
  const total = filteredData.length;
  const groups = { 'Aguardando Stage': { count: 0, sum: 0 }, 'Stage': { count: 0, sum: 0 }, 'Packing': { count: 0, sum: 0 } };

  filteredData.forEach(r => {
    const b = classifyBottleneck(r);
    if (!b) return;
    groups[b.label].count++;
    groups[b.label].sum += b.value;
  });

  const stats = Object.entries(groups).map(([label, g]) => ({
    label,
    count: g.count,
    avg: g.count ? g.sum / g.count : null,
    pct: total ? (g.count / total) * 100 : 0
  }));

  setDiagCard('diagEspera', 'diagEsperaSub', stats[0], total);
  setDiagCard('diagStage', 'diagStageSub', stats[1], total);
  setDiagCard('diagPacking', 'diagPackingSub', stats[2], total);

  destroyChart('chartDiagnostico');
  charts.chartDiagnostico = new Chart(document.getElementById('chartDiagnostico'), {
    type: 'bar',
    data: {
      labels: stats.map(s => s.label),
      datasets: [{ label: '% dos pacotes', data: stats.map(s => s.pct), backgroundColor: ['#cbd5e1', '#ea580c', '#1e293b'], borderWidth: 0, borderRadius: 4 }]
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
      <div class="zv">${fmtDuration(z.avgHoras)} médio em zona</div>
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
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:24px">Nenhum registro encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
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

document.addEventListener('DOMContentLoaded', fetchData);
