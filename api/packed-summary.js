const { fetchPackedSummaryRows } = require('./_lib/sheet');
const { buildPackedStats } = require('./_lib/packed-metrics');

// Painel "Resumo" — lê a aba "Packed on time" (já agregada por dia/turno/hub/zona)
// direto da planilha a cada chamada. Sem cache em Blob: o volume de linhas dessa
// aba é pequeno o bastante (uma linha por combinação, não por pacote).
module.exports = async (req, res) => {
  try {
    const { headers, rows } = await fetchPackedSummaryRows();
    if (!headers.length) {
      res.status(200).json({ stats: null, notice: 'Aba "Packed on time" vazia ou não encontrada.' });
      return;
    }

    const from = (req.query.from || '').slice(0, 10) || null;
    const to = (req.query.to || '').slice(0, 10) || null;
    const turno = req.query.turno || null;
    const zona = req.query.zona || null;
    const hub = req.query.hub || null;

    const dataCol = headers.indexOf('data_packed');
    const dates = dataCol >= 0 ? rows.map(r => r[dataCol]).filter(Boolean) : [];
    const dateBounds = dates.length ? { min: dates.reduce((a, b) => (b < a ? b : a)), max: dates.reduce((a, b) => (b > a ? b : a)) } : null;

    const turnos = [...new Set(rows.map(r => r[headers.indexOf('turno_ofensor')]).filter(Boolean))].sort();
    const zonas = [...new Set(rows.map(r => r[headers.indexOf('zona_classificada')]).filter(Boolean))].sort();
    const hubs = [...new Set(rows.map(r => r[headers.indexOf('hub_destino')]).filter(Boolean))].sort();

    const stats = buildPackedStats(rows, headers, { from, to, turno, zona, hub });

    res.status(200).json({
      lastUpdate: new Date().toISOString(),
      dateBounds,
      appliedRange: { from: from || (dateBounds && dateBounds.min), to: to || (dateBounds && dateBounds.max) },
      filterOptions: { turnos, zonas, hubs },
      stats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
