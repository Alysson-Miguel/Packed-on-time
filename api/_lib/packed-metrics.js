// Agregações sobre a aba "Packed on time": diferente de metrics.js (que agrega
// linha a linha, um pacote por linha), aqui cada linha da planilha já é um
// agregado por dia × turno × hub × zona. Este módulo só soma/pondera esses
// agregados sobre o recorte pedido (from/to/turno/zona/hub) — nunca itera pacote
// a pacote, por isso não precisa de cache em Blob nem de paginação.
//
// As colunas total_oot, total_on_time, total_cpt_nao_disponivel e pct_oot da
// planilha são ignoradas (dado não confiável nessa aba) — o painel usa só
// volume (total_shipments) e os tempos médios.

const HEADER_KEYS = [
  'data_packed', 'turno_ofensor', 'hub_destino', 'zona_classificada', 'passou_por_stage',
  'total_shipments', 'avg_atraso_min', 'avg_lead_time_h', 'avg_min_no_packing', 'avg_min_no_stage_inbound'
];

// Números na planilha vêm formatados com vírgula como separador de milhar
// (ex: "1,387") e ponto como decimal (ex: "15.7") — padrão da exportação da
// aba, diferente do "Detail".
function toNum(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

function buildIndex(headers) {
  const idx = {};
  HEADER_KEYS.forEach(key => { idx[key] = headers.indexOf(key); });
  return idx;
}

function parseRow(row, idx) {
  return {
    data: row[idx.data_packed] || '',
    turno: row[idx.turno_ofensor] || 'Não informado',
    hub: row[idx.hub_destino] || 'Não informado',
    zona: (row[idx.zona_classificada] || 'Não informado').trim() || 'Não informado',
    passouStage: row[idx.passou_por_stage] || '',
    totalShipments: toNum(row[idx.total_shipments]) || 0,
    avgAtrasoMin: toNum(row[idx.avg_atraso_min]),
    avgLeadTimeH: toNum(row[idx.avg_lead_time_h]),
    avgMinPacking: toNum(row[idx.avg_min_no_packing]),
    avgMinStageInbound: toNum(row[idx.avg_min_no_stage_inbound])
  };
}

// Acumulador de média ponderada: soma valor*peso e o peso, divide só no final.
function accWeighted(acc, value, weight) {
  if (value === null || !weight) return;
  acc.sum += value * weight;
  acc.weight += weight;
}
function finishWeighted(acc) { return acc.weight ? acc.sum / acc.weight : null; }
function newAcc() { return { sum: 0, weight: 0 }; }

// rows: linhas cruas (array de arrays) da aba "Packed on time".
// opts: { from, to, turno, zona, hub } — todos opcionais. turno/zona/hub aceitam
// string única ou array de valores (filtro OR dentro do mesmo campo).
function buildPackedStats(rows, headers, opts) {
  const { from, to, turno: turnoFilter, zona: zonaFilter, hub: hubFilter } = opts || {};
  const toArr = v => (v == null ? null : Array.isArray(v) ? v : [v]);
  const turnoArr = toArr(turnoFilter), zonaArr = toArr(zonaFilter), hubArr = toArr(hubFilter);
  const idx = buildIndex(headers);

  let totalShipments = 0;
  const accAtraso = newAcc(), accLead = newAcc(), accPacking = newAcc(), accStage = newAcc();

  const porDia = {}, porTurno = {}, porZona = {}, porHub = {};
  const bump = (bucket, key) => {
    if (!bucket[key]) bucket[key] = { shipments: 0, accAtraso: newAcc(), accLead: newAcc() };
    return bucket[key];
  };

  let matched = 0;

  for (const row of rows) {
    const f = parseRow(row, idx);
    if (!f.data) continue;
    if (from && f.data < from) continue;
    if (to && f.data > to) continue;
    if (turnoArr && !turnoArr.includes(f.turno)) continue;
    if (zonaArr && !zonaArr.includes(f.zona)) continue;
    if (hubArr && !hubArr.includes(f.hub)) continue;

    matched++;
    totalShipments += f.totalShipments;

    accWeighted(accAtraso, f.avgAtrasoMin, f.totalShipments);
    accWeighted(accLead, f.avgLeadTimeH, f.totalShipments);
    accWeighted(accPacking, f.avgMinPacking, f.totalShipments);
    accWeighted(accStage, f.avgMinStageInbound, f.totalShipments);

    const dia = bump(porDia, f.data);
    dia.shipments += f.totalShipments;
    accWeighted(dia.accAtraso, f.avgAtrasoMin, f.totalShipments);
    accWeighted(dia.accLead, f.avgLeadTimeH, f.totalShipments);

    const trn = bump(porTurno, f.turno);
    trn.shipments += f.totalShipments;
    accWeighted(trn.accAtraso, f.avgAtrasoMin, f.totalShipments);
    accWeighted(trn.accLead, f.avgLeadTimeH, f.totalShipments);

    const zn = bump(porZona, f.zona);
    zn.shipments += f.totalShipments;
    accWeighted(zn.accAtraso, f.avgAtrasoMin, f.totalShipments);
    accWeighted(zn.accLead, f.avgLeadTimeH, f.totalShipments);

    const hb = bump(porHub, f.hub);
    hb.shipments += f.totalShipments;
    accWeighted(hb.accAtraso, f.avgAtrasoMin, f.totalShipments);
    accWeighted(hb.accLead, f.avgLeadTimeH, f.totalShipments);
  }

  const toRanked = (bucket, keyName) => Object.entries(bucket)
    .map(([key, v]) => ({ [keyName]: key, shipments: v.shipments, avgAtrasoMin: finishWeighted(v.accAtraso), avgLeadTimeH: finishWeighted(v.accLead) }))
    .sort((a, b) => (b.avgAtrasoMin || 0) - (a.avgAtrasoMin || 0));

  const porDiaArr = Object.entries(porDia)
    .map(([data, v]) => ({ data, shipments: v.shipments, avgAtrasoMin: finishWeighted(v.accAtraso), avgLeadTimeH: finishWeighted(v.accLead) }))
    .sort((a, b) => a.data.localeCompare(b.data));

  const porTurnoArr = toRanked(porTurno, 'turno');
  const porZonaArr = toRanked(porZona, 'zona');
  const porHubArr = toRanked(porHub, 'hub');

  const topOfensorZona = porZonaArr.length ? porZonaArr[0] : null;
  const topOfensorHub = porHubArr.length ? porHubArr[0] : null;
  const topOfensorTurno = porTurnoArr.length ? porTurnoArr[0] : null;

  return {
    matched,
    total: totalShipments,
    avgAtrasoMin: finishWeighted(accAtraso),
    avgLeadTimeH: finishWeighted(accLead),
    avgMinPacking: finishWeighted(accPacking),
    avgMinStageInbound: finishWeighted(accStage),
    porDia: porDiaArr,
    porTurno: porTurnoArr,
    porZona: porZonaArr,
    porHub: porHubArr,
    insights: { topOfensorZona, topOfensorHub, topOfensorTurno }
  };
}

module.exports = { buildPackedStats };
