// Agregações calculadas em uma única passada sobre as linhas cacheadas (até ~250k),
// sem nunca montar arrays gigantes nem usar Math.max(...arr)/Math.min(...arr) — span
// muito grande nesses spreads já causou "Maximum call stack size exceeded" no painel.
// Usado pelos endpoints /api/sheet-summary e /api/sheet-heatmap pra devolver só os
// números agregados (poucos KB) em vez das linhas brutas (~40MB pra 10 dias).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/;
const CICLO_EDGES = [0, 12, 24, 48, 72];
const PACKING_EDGES = [0, 15, 30, 60, 120];

function parseDateParts(value) {
  if (!value) return null;
  const m = String(value).match(DATE_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), dateStr: `${y}-${mo}-${d}`, hour: +h };
}

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function buildIndex(headers) {
  return {
    received: headers.indexOf('received_datetime'),
    packed: headers.indexOf('packed_datetime'),
    cpt: headers.indexOf('cpt_planejado'),
    turno: headers.indexOf('turno_ofensor'),
    zona: headers.indexOf('grupo_stage_inbound'),
    stagingIn: headers.indexOf('staging_in_datetime'),
    minPacking: headers.indexOf('min_no_packing'),
    horasStage: headers.indexOf('horas_no_stage_inbound'),
    totalCycle: headers.indexOf('total_received_ate_packed_h')
  };
}

function rowFields(row, idx) {
  const received = parseDateParts(row[idx.received]);
  const packed = parseDateParts(row[idx.packed]);
  const cpt = parseDateParts(row[idx.cpt]);
  const stagingIn = parseDateParts(row[idx.stagingIn]);
  const minPacking = toNumber(row[idx.minPacking]);
  const horasStage = toNumber(row[idx.horasStage]);
  const totalCycle = toNumber(row[idx.totalCycle]);
  return {
    received,
    packed,
    turno: row[idx.turno] || 'Não informado',
    zona: (row[idx.zona] || 'Não informado').trim() || 'Não informado',
    minPacking,
    horasStage,
    totalCycle,
    atrasoH: (packed && cpt) ? (packed.ms - cpt.ms) / 3600000 : null,
    esperaStage: (received && stagingIn) ? (stagingIn.ms - received.ms) / 3600000 : null
  };
}

function classifyBottleneck(f) {
  const procs = [
    { label: 'Aguardando Stage', value: f.esperaStage },
    { label: 'Stage', value: f.horasStage },
    { label: 'Packing', value: f.minPacking !== null ? f.minPacking / 60 : null }
  ].filter(p => p.value !== null && !Number.isNaN(p.value));
  if (!procs.length) return null;
  return procs.reduce((max, p) => (p.value > max.value ? p : max), procs[0]);
}

function bucketInc(buckets, edges, value) {
  for (let i = edges.length - 1; i >= 0; i--) {
    if (value >= edges[i]) { buckets[i]++; return; }
  }
}

function bucketsToStats(buckets, edges, unit) {
  return edges.map((e, i) => ({
    label: i < edges.length - 1 ? `${e}-${edges[i + 1]}${unit}` : `${e}${unit}+`,
    count: buckets[i]
  }));
}

// rows: linhas cacheadas (array de arrays, na ordem de `headers`).
// opts: { from, to, turno, zona } — todos opcionais, aplicados como filtro antes de agregar.
function buildStats(rows, headers, opts) {
  const { from, to, turno: turnoFilter, zona: zonaFilter } = opts || {};
  const idx = buildIndex(headers);

  let total = 0;
  let delaySum = 0, delayCount = 0, maxDelay = -Infinity;
  let cycleSum = 0, cycleCount = 0;
  const diag = {
    'Aguardando Stage': { count: 0, sum: 0 },
    'Stage': { count: 0, sum: 0 },
    'Packing': { count: 0, sum: 0 }
  };
  const turnoCount = {};
  const zonaCount = {};
  const zonaHorasSum = {};
  const zonaHorasCount = {};
  const cicloBuckets = CICLO_EDGES.map(() => 0);
  const packingBuckets = PACKING_EDGES.map(() => 0);
  let naoInformadoCount = 0;

  for (const row of rows) {
    const f = rowFields(row, idx);
    if (!f.packed) continue;
    const d = f.packed.dateStr;
    if (from && d < from) continue;
    if (to && d > to) continue;
    if (turnoFilter && f.turno !== turnoFilter) continue;
    if (zonaFilter && f.zona !== zonaFilter) continue;

    total++;
    if (f.atrasoH !== null) {
      delaySum += f.atrasoH; delayCount++;
      if (f.atrasoH > maxDelay) maxDelay = f.atrasoH;
    }
    if (f.totalCycle !== null) { cycleSum += f.totalCycle; cycleCount++; bucketInc(cicloBuckets, CICLO_EDGES, f.totalCycle); }
    if (f.minPacking !== null) bucketInc(packingBuckets, PACKING_EDGES, f.minPacking);

    const b = classifyBottleneck(f);
    if (b) { diag[b.label].count++; diag[b.label].sum += b.value; }

    turnoCount[f.turno] = (turnoCount[f.turno] || 0) + 1;
    zonaCount[f.zona] = (zonaCount[f.zona] || 0) + 1;
    if (f.horasStage !== null) {
      zonaHorasSum[f.zona] = (zonaHorasSum[f.zona] || 0) + f.horasStage;
      zonaHorasCount[f.zona] = (zonaHorasCount[f.zona] || 0) + 1;
    }
    if (f.zona === 'Não informado') naoInformadoCount++;
  }

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
    histCiclo: bucketsToStats(cicloBuckets, CICLO_EDGES, 'h'),
    histPacking: bucketsToStats(packingBuckets, PACKING_EDGES, 'min'),
    insights: {
      topProc: topProc && topProc.count ? topProc : null,
      topZona: porZona.length ? porZona[0] : null,
      naoInformadoPct,
      topTurno: turnoRanked.length ? { turno: turnoRanked[0][0], count: turnoRanked[0][1] } : null,
      outlier
    }
  };
}

// Matriz dia × hora (0-23) de pacotes atrasados (atrasoH > 0) recebidos, filtrados
// por zona ou turno — usada pelo mapa de calor sem precisar mandar linhas brutas.
function buildHeatmap(rows, headers, dim, value, opts) {
  const { from, to } = opts || {};
  const idx = buildIndex(headers);
  const matrix = {};
  let max = 0;
  let count = 0;

  for (const row of rows) {
    const f = rowFields(row, idx);
    if (!f.received || !f.packed || f.atrasoH === null || f.atrasoH <= 0) continue;
    if ((dim === 'zona' ? f.zona : f.turno) !== value) continue;
    const packedDateStr = f.packed.dateStr;
    if (from && packedDateStr < from) continue;
    if (to && packedDateStr > to) continue;

    const d = f.received.dateStr;
    if (!matrix[d]) matrix[d] = new Array(24).fill(0);
    matrix[d][f.received.hour]++;
    if (matrix[d][f.received.hour] > max) max = matrix[d][f.received.hour];
    count++;
  }

  return { matrix, max, count, dates: Object.keys(matrix).sort() };
}

module.exports = { buildStats, buildHeatmap };
