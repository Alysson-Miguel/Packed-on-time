const { fetchPackedSummaryRows, fetchPotRows } = require('./_lib/sheet');
const { buildPackedStats, buildFilterOptions } = require('./_lib/packed-metrics');
const { buildPotStats } = require('./_lib/pot-metrics');

// Painel "Resumo" — lê a aba "Packed on time" (já agregada por dia/turno/hub/zona/
// estação) e a "db_pot" (pedidos por dia × estação × status, base do % POT). A
// leitura da planilha tem um cache curto em memória (ver sheet.js); force=1 ignora
// o cache. Uma falha na db_pot não derruba o resto do painel — volta em pot.error.
module.exports = async (req, res) => {
  try {
    const force = req.query.force === '1';
    const [{ headers, rows, fetchedAt }, potResult] = await Promise.all([
      fetchPackedSummaryRows({ force }),
      fetchPotRows({ force }).catch(err => ({ error: err.message }))
    ]);
    if (!headers.length) {
      res.status(200).json({ stats: null, notice: 'Aba "Packed on time" vazia ou não encontrada.' });
      return;
    }

    const from = (req.query.from || '').slice(0, 10) || null;
    const to = (req.query.to || '').slice(0, 10) || null;
    const parseMulti = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null);
    const estacao = parseMulti(req.query.estacao);
    const turno = parseMulti(req.query.turno);
    const zona = parseMulti(req.query.zona);
    const hub = parseMulti(req.query.hub);

    const { dateBounds, options } = buildFilterOptions(rows, headers, estacao);
    const stats = buildPackedStats(rows, headers, { from, to, estacao, turno, zona, hub });

    let pot;
    if (potResult.error) pot = { error: potResult.error };
    else pot = buildPotStats(potResult.rows, potResult.headers, { from, to, estacao }) || { error: 'Aba "db_pot" sem as colunas esperadas.' };

    res.status(200).json({
      lastUpdate: fetchedAt,
      dateBounds,
      appliedRange: { from: from || (dateBounds && dateBounds.min), to: to || (dateBounds && dateBounds.max) },
      filterOptions: options,
      stats,
      pot
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
