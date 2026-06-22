const { JWT } = require('google-auth-library');
const { put, get } = require('@vercel/blob');

const SHEET_ID = '1tYIoqJZU-LzCwGnoRG5ScTLDq2sR6Qo9UA5wcOol204';
const SHEET_NAME = 'Detail';
const LAST_COL = 'Q';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const WINDOW_DAYS = 7; // mantém um buffer além do "hoje + ontem" usado por padrão no painel
const SNAPSHOT_KEY = 'packed-on-time-snapshot.json';

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

function cutoffStr() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
  return cutoff.toISOString().slice(0, 10);
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
  let needsFullSync = !existing || !existing.lastRowCount || existing.windowDays !== WINDOW_DAYS || totalRows < existing.lastRowCount;

  if (!needsFullSync && existing.lastRowCount > 1) {
    const markerNow = (colA[existing.lastRowCount - 1] && colA[existing.lastRowCount - 1][0]) || '';
    if (existing.lastRowMarker !== undefined && markerNow !== existing.lastRowMarker) needsFullSync = true;
  }

  let headers, rows;
  if (needsFullSync) {
    const response = await client.request({ url: valuesUrl(`${SHEET_NAME}!A:${LAST_COL}`) });
    const values = response.data.values || [];
    headers = values[0] || [];
    rows = values.slice(1);
  } else if (totalRows > existing.lastRowCount) {
    const response = await client.request({ url: valuesUrl(`${SHEET_NAME}!A${existing.lastRowCount + 1}:${LAST_COL}${totalRows}`) });
    const newValues = response.data.values || [];
    headers = existing.headers;
    rows = existing.rows.concat(newValues.map(v => headers.map((_, c) => (v[c] !== undefined ? v[c] : ''))));
  } else {
    headers = existing.headers;
    rows = existing.rows;
  }

  if (!headers.length) {
    const empty = { lastUpdate: new Date().toISOString(), headers: [], rows: [], lastRowCount: totalRows, windowDays: WINDOW_DAYS, lastRowMarker: '' };
    await put(SNAPSHOT_KEY, JSON.stringify(empty), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
    return { snapshot: empty, totalSheetRows: 0, cachedRows: 0, cutoff: null };
  }

  const dateCol = headers.indexOf('received_datetime');
  const cutoff = cutoffStr();
  const filteredRows = rows.filter(row => {
    const rawDate = dateCol >= 0 ? String(row[dateCol] || '') : '';
    return rawDate.slice(0, 10) >= cutoff;
  });

  const lastRowMarker = totalRows > 1 ? (colA[totalRows - 1][0] || '') : '';

  const snapshot = {
    lastUpdate: new Date().toISOString(),
    headers,
    rows: filteredRows,
    lastRowCount: totalRows,
    windowDays: WINDOW_DAYS,
    lastRowMarker
  };
  await put(SNAPSHOT_KEY, JSON.stringify(snapshot), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });

  return { snapshot, totalSheetRows: totalRows - 1, cachedRows: filteredRows.length, cutoff };
}

module.exports = { fetchAndCacheSnapshot, SNAPSHOT_KEY, WINDOW_DAYS };
