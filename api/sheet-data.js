const { get } = require('@vercel/blob');
const { fetchAndCacheSnapshot, SNAPSHOT_KEY } = require('./_lib/sheet');

// Limite de linhas devolvidas por requisição: o payload completo da janela de
// cache (~250k linhas / ~40MB) excede o limite de resposta de Serverless
// Functions da Vercel (~4.5MB) e travava o painel. Cada linha trimmed tem
// ~175 bytes em JSON, então 20k linhas fica em ~3.5MB, com margem de segurança.
const MAX_ROWS = 20000;

function filterByDate(rows, dateCol, from, to) {
  if (!from && !to) return rows;
  return rows.filter(row => {
    const d = dateCol >= 0 ? String(row[dateCol] || '').slice(0, 10) : '';
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

module.exports = async (req, res) => {
  try {
    let snapshot;
    if (req.query.force) {
      const result = await fetchAndCacheSnapshot();
      snapshot = result.snapshot;
    } else {
      const result = await get(SNAPSHOT_KEY, { access: 'private', useCache: false });
      if (!result) {
        res.status(200).json({
          lastUpdate: null,
          headers: [],
          rows: [],
          dateBounds: null,
          notice: 'Cache ainda não gerado. Aguarde o primeiro refresh agendado ou acione /api/refresh-cache manualmente.'
        });
        return;
      }
      const text = await new Response(result.stream).text();
      snapshot = JSON.parse(text);
    }

    if (!snapshot.headers || !snapshot.headers.length) {
      res.status(200).json(snapshot);
      return;
    }

    const dateCol = snapshot.headers.indexOf('packed_datetime');
    let from = (req.query.from || '').slice(0, 10) || null;
    let to = (req.query.to || '').slice(0, 10) || null;

    // Sem filtro de data explícito, devolve só o dia mais recente disponível em
    // cache — mantém o payload inicial pequeno em vez dos 10 dias inteiros.
    if (!from && !to && snapshot.dateBounds) {
      from = to = snapshot.dateBounds.max;
    }

    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const allRows = filterByDate(snapshot.rows, dateCol, from, to);
    const totalInRange = allRows.length;
    // Cada resposta fica limitada a MAX_ROWS linhas pra não passar do limite de
    // payload da Vercel; o cliente pagina (offset crescente) até buscar tudo.
    const rows = allRows.slice(offset, offset + MAX_ROWS);
    const truncated = offset + rows.length < totalInRange;

    res.status(200).json({
      lastUpdate: snapshot.lastUpdate,
      headers: snapshot.headers,
      rows,
      dateBounds: snapshot.dateBounds,
      appliedRange: { from, to },
      totalInRange,
      offset,
      nextOffset: truncated ? offset + rows.length : null,
      truncated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
