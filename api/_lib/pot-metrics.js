// Agregações sobre a aba "db_pot": cada linha é o total de pedidos de um dia ×
// estação × status OOT (On time / Out time / CPT not available). Daqui sai o
// % POT do painel:
//
//   % POT = (On time - (CPT not available + Out time)) / On time
//
// ou seja, 100% menos a proporção de pedidos fora do prazo para cada pedido no
// prazo — quanto maior, melhor. Linhas sem outbound_day são ignoradas (não dá pra
// encaixá-las em nenhum período).

const STATUS_KEY = { 'On time': 'onTime', 'Out time': 'outTime', 'CPT not available': 'cptNa' };

function toNum(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

function potPct(b) { return b.onTime ? (b.onTime - (b.cptNa + b.outTime)) / b.onTime : null; }

function newBucket() { return { onTime: 0, outTime: 0, cptNa: 0 }; }

function finish(b) {
  return { ...b, total: b.onTime + b.outTime + b.cptNa, pct: potPct(b) };
}

// opts: { from, to, estacao } — estacao aceita array (filtro OR), igual ao resto.
function buildPotStats(rows, headers, opts) {
  const { from, to, estacao } = opts || {};
  const estacaoArr = estacao && estacao.length ? estacao : null;
  const col = name => headers.indexOf(name);
  const iDay = col('outbound_day'), iWeek = col('outbound_week'), iMonth = col('outbound_month');
  const iStatus = col('OOT'), iStation = col('station_name'), iOrders = col('total_orders');
  if (iDay < 0 || iStatus < 0 || iOrders < 0) return null;

  const geral = newBucket();
  const porDia = {}, porSemana = {}, porMes = {}, porEstacao = {};
  let min = null, max = null;
  const add = (bucket, key, statusKey, n) => {
    if (!bucket[key]) bucket[key] = newBucket();
    bucket[key][statusKey] += n;
  };

  for (const row of rows) {
    const data = (row[iDay] || '').slice(0, 10);
    const statusKey = STATUS_KEY[(row[iStatus] || '').trim()];
    if (!data || !statusKey) continue;
    const station = (row[iStation] || '').trim() || 'Não informado';
    if (estacaoArr && !estacaoArr.includes(station)) continue;
    if (!min || data < min) min = data;
    if (!max || data > max) max = data;
    if (from && data < from) continue;
    if (to && data > to) continue;

    const n = toNum(row[iOrders]);
    geral[statusKey] += n;
    add(porDia, data, statusKey, n);
    add(porSemana, (row[iWeek] || data).slice(0, 10), statusKey, n);
    add(porMes, (row[iMonth] || data).slice(0, 7), statusKey, n);
    add(porEstacao, station, statusKey, n);
  }

  const series = bucket => Object.entries(bucket)
    .map(([periodo, b]) => ({ periodo, ...finish(b) }))
    .sort((a, b) => a.periodo.localeCompare(b.periodo));

  return {
    ...finish(geral),
    dateBounds: min ? { min, max } : null,
    porDia: series(porDia),
    porSemana: series(porSemana),
    porMes: series(porMes),
    porEstacao: Object.entries(porEstacao)
      .map(([est, b]) => ({ estacao: est, ...finish(b) }))
      .sort((a, b) => (a.pct ?? Infinity) - (b.pct ?? Infinity)) // pior (menor %) primeiro
  };
}

module.exports = { buildPotStats };
