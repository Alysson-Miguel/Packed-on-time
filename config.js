// Enquanto USE_MOCK=true, o painel usa assets/js/mock-data.js para testar
// o layout e os cálculos localmente, sem depender da API.
// Quando false, busca os dados reais em /api/sheet-data (serverless function
// que lê a planilha via Service Account do GCP — ver api/sheet-data.js).
const USE_MOCK = false;
