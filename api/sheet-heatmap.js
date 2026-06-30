const { get } = require('@vercel/blob');
const { SNAPSHOT_KEY } = require('./_lib/sheet');
const { buildHeatmap } = require('./_lib/metrics');

// Matriz dia × hora de pacotes Out of Time pra uma zona/turno, sem mandar linhas
// brutas — usado pelo mapa de calor quando o painel está no modo agregado (sem
// uma data específica selecionada).
module.exports = async (req, res) => {
  try {
    const dim = req.query.dim;
    const value = req.query.value;
    if (dim !== 'zona' && dim !== 'turno') {
      res.status(400).json({ error: 'Parâmetro "dim" precisa ser "zona" ou "turno".' });
      return;
    }
    if (!value) {
      res.status(400).json({ error: 'Parâmetro "value" é obrigatório.' });
      return;
    }

    const result = await get(SNAPSHOT_KEY, { access: 'private', useCache: false });
    if (!result) {
      res.status(200).json({ matrix: {}, max: 0, count: 0, dates: [] });
      return;
    }
    const text = await new Response(result.stream).text();
    const snapshot = JSON.parse(text);
    if (!snapshot.headers || !snapshot.headers.length) {
      res.status(200).json({ matrix: {}, max: 0, count: 0, dates: [] });
      return;
    }

    const from = (req.query.from || '').slice(0, 10) || null;
    const to = (req.query.to || '').slice(0, 10) || null;
    const heatmap = buildHeatmap(snapshot.rows, snapshot.headers, dim, value, { from, to });

    res.status(200).json(heatmap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
