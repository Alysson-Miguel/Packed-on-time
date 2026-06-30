const { JWT } = require('google-auth-library');
const { put, get } = require('@vercel/blob');

const SHEET_ID = '1tYIoqJZU-LzCwGnoRG5ScTLDq2sR6Qo9UA5wcOol204';
const SHEET_NAME = 'Detail';
const LAST_COL = 'S'; // br..passou_por_stage (time adicionou `to_number` antes de received_datetime, empurrando as colunas seguintes uma posição)
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const WINDOW_DAYS = 10; // janela dinâmica: sempre os últimos N dias a partir da data mais recente presente na planilha
const SNAPSHOT_KEY = 'packed-on-time-snapshot.json';

// Só as colunas realmente usadas pelo painel (ver "# 📦 KPI Packed On Time — Contexto.txt").
// As demais (hub_destino, OOT, atraso_min, atraso_h, zona_stage_inbound, min_no_stage_inbound)
// já estão marcadas como "Ignorado por performance" e não precisam ir pro cache.
const ACTIVE_HEADERS = [
  'br', 'to_number', 'received_datetime', 'packed_datetime', 'cpt_planejado', 'turno_ofensor',
  'grupo_stage_inbound', 'staging_in_datetime', 'detach_inbound_datetime',
  'min_no_packing', 'horas_no_stage_inbound', 'total_received_ate_packed_h'
];

function getClient() {
  return new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: SCOPES
  });
}

function valuesUrl(range) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
}

// Cutoff dinâmico: WINDOW_DAYS contados a partir da data mais recente encontrada nos
// dados (não da data do servidor), pra janela acompanhar a planilha mesmo se ela
// estiver atrasada ou adiantada em relação a "hoje".
function cutoffStr(rows, dateCol) {
  let maxDate = null;
  if (dateCol >= 0) {
    for (const row of rows) {
      const raw = String(row[dateCol] || '').slice(0, 10);
      if (raw && (!maxDate || raw > maxDate)) maxDate = raw;
    }
  }
  const base = maxDate ? new Date(maxDate + 'T00:00:00') : new Date();
  base.setDate(base.getDate() - WINDOW_DAYS);
  return base.toISOString().slice(0, 10);
}

// Reduz linhas no formato bruto (A:Q) para só as colunas ativas, usando os nomes
// do cabeçalho original pra mapear a posição certa (não depende de ordem fixa).
function trimRows(rawHeaders, rawRows) {
  const headers = ACTIVE_HEADERS.filter(h => rawHeaders.includes(h));
  const indices = headers.map(h => rawHeaders.indexOf(h));
  const rows = rawRows.map(rr => indices.map(i => (rr[i] !== undefined ? rr[i] : '')));
  return { headers, rows };
}

async function loadExistingSnapshot() {
  try {
    const result = await get(SNAPSHOT_KEY, { access: 'private', useCache: false });
    if (!result) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Busca e mantém o cache em modo incremental: só baixa as linhas A:Q inteiras na
// primeira vez (ou se detectar inconsistência). Nas demais vezes, conta as linhas
// atuais lendo só a coluna A (bem mais leve) e baixa apenas as linhas novas desde
// a última sincronização, somando ao que já estava em cache e refiltrando pela
// janela de dias (que avança a cada dia, então linhas antigas saem naturalmente).
async function fetchAndCacheSnapshot() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error('Variáveis GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY não configuradas.');
  }

  const client = getClient();

  const countResp = await client.request({ url: valuesUrl(`${SHEET_NAME}!A:A`) });
  const colA = countResp.data.values || [];
  const totalRows = colA.length;

  const existing = await loadExistingSnapshot();
  let needsFullSync = !existing || !existing.lastRowCount || !existing.rawHeaders || existing.windowDays !== WINDOW_DAYS || totalRows < existing.lastRowCount;

  if (!needsFullSync && existing.lastRowCount > 1) {
    const markerNow = (colA[existing.lastRowCount - 1] && colA[existing.lastRowCount - 1][0]) || '';
    if (existing.lastRowMarker !== undefined && markerNow !== existing.lastRowMarker) needsFullSync = true;
  }

  let rawHeaders, headers, rows;
  if (needsFullSync) {
    const response = await client.request({ url: valuesUrl(`${SHEET_NAME}!A:${LAST_COL}`) });
    const values = response.data.values || [];
    rawHeaders = values[0] || [];
    const trimmed = trimRows(rawHeaders, values.slice(1));
    headers = trimmed.headers;
    rows = trimmed.rows;
  } else if (totalRows > existing.lastRowCount) {
    rawHeaders = existing.rawHeaders;
    const response = await client.request({ url: valuesUrl(`${SHEET_NAME}!A${existing.lastRowCount + 1}:${LAST_COL}${totalRows}`) });
    const newValues = response.data.values || [];
    const trimmed = trimRows(rawHeaders, newValues);
    headers = trimmed.headers;
    rows = existing.rows.concat(trimmed.rows);
  } else {
    rawHeaders = existing.rawHeaders;
    headers = existing.headers;
    rows = existing.rows;
  }

  if (!headers.length) {
    const empty = { lastUpdate: new Date().toISOString(), headers: [], rows: [], lastRowCount: totalRows, windowDays: WINDOW_DAYS, lastRowMarker: '', rawHeaders: rawHeaders || [], dateBounds: null, dailyCounts: {} };
    await put(SNAPSHOT_KEY, JSON.stringify(empty), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
    return { snapshot: empty, totalSheetRows: 0, cachedRows: 0, cutoff: null };
  }

  const dateCol = headers.indexOf('packed_datetime');
  const cutoff = cutoffStr(rows, dateCol);
  const filteredRows = rows.filter(row => {
    const rawDate = dateCol >= 0 ? String(row[dateCol] || '') : '';
    return rawDate.slice(0, 10) >= cutoff;
  });

  // Contagem por dia + extremos: o /api/sheet-data usa isso pra saber qual dia
  // mostrar por padrão e pra validar/limitar o tamanho de uma faixa pedida, sem
  // precisar percorrer as ~250k linhas a cada requisição do painel.
  const dailyCounts = {};
  filteredRows.forEach(row => {
    const d = dateCol >= 0 ? String(row[dateCol] || '').slice(0, 10) : '';
    if (d) dailyCounts[d] = (dailyCounts[d] || 0) + 1;
  });
  const sortedDates = Object.keys(dailyCounts).sort();
  const dateBounds = sortedDates.length ? { min: sortedDates[0], max: sortedDates[sortedDates.length - 1] } : null;

  const lastRowMarker = totalRows > 1 ? (colA[totalRows - 1][0] || '') : '';

  const snapshot = {
    lastUpdate: new Date().toISOString(),
    headers,
    rows: filteredRows,
    lastRowCount: totalRows,
    windowDays: WINDOW_DAYS,
    lastRowMarker,
    rawHeaders,
    dateBounds,
    dailyCounts
  };
  await put(SNAPSHOT_KEY, JSON.stringify(snapshot), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });

  return { snapshot, totalSheetRows: totalRows - 1, cachedRows: filteredRows.length, cutoff };
}

module.exports = { fetchAndCacheSnapshot, SNAPSHOT_KEY, WINDOW_DAYS };
