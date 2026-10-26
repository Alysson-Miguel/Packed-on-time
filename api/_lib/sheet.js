const { JWT } = require('google-auth-library');

const SHEET_ID = '1tYIoqJZU-LzCwGnoRG5ScTLDq2sR6Qo9UA5wcOol204';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

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

// A aba "Packed on time" já vem pré-agregada por dia/turno/hub/zona/estação (uma
// linha por combinação, não por pacote). As colunas são localizadas pelo nome do
// cabeçalho, então o range vai até Z pra novas colunas (ex: estacao_atual, em P)
// entrarem sem precisar mexer aqui.
const PACKED_SUMMARY_SHEET_NAME = 'Packed on time';
const PACKED_SUMMARY_LAST_COL = 'Z';

// Cache em memória da instância (vale enquanto a função estiver "quente"): cada
// troca de filtro no painel vira uma requisição, e sem isso cada clique bateria na
// API do Sheets. "Atualizar" no painel manda force=1 e ignora o cache.
const CACHE_TTL_MS = 60 * 1000;
let cache = null;

async function fetchPackedSummaryRows({ force } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error('Variáveis GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY não configuradas.');
  }
  const client = getClient();
  const response = await client.request({ url: valuesUrl(`${PACKED_SUMMARY_SHEET_NAME}!A:${PACKED_SUMMARY_LAST_COL}`) });
  const values = response.data.values || [];
  const headers = values[0] || [];
  const rows = values.slice(1);
  const fetchedAt = new Date().toISOString();
  cache = { at: Date.now(), data: { headers, rows, fetchedAt } };
  return cache.data;
}

module.exports = { fetchPackedSummaryRows };
