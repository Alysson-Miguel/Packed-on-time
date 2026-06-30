const { get } = require('@vercel/blob');
const { fetchAndCacheSnapshot, SNAPSHOT_KEY } = require('./_lib/sheet');
const { buildStats } = require('./_lib/metrics');

// Devolve só os números agregados (KPIs, diagnóstico, por turno/zona, histogramas,
// insights) sobre a janela pedida — sem precisar mandar as linhas brutas pro
// navegador. Por padrão (sem from/to) agrega a janela de cache inteira (10 dias).
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
          dateBounds: null,
          stats: null,
          notice: 'Cache ainda não gerado. Aguarde o primeiro refresh agendado ou acione /api/refresh-cache manualmente.'
        });
        return;
      }
      const text = await new Response(result.stream).text();
      snapshot = JSON.parse(text);
    }

    if (!snapshot.headers || !snapshot.headers.length) {
      res.status(200).json({ lastUpdate: snapshot.lastUpdate, dateBounds: null, stats: null, notice: snapshot.notice });
      return;
    }

    const from = (req.query.from || '').slice(0, 10) || null;
    const to = (req.query.to || '').slice(0, 10) || null;
    const turno = req.query.turno || null;
    const zona = req.query.zona || null;

    const stats = buildStats(snapshot.rows, snapshot.headers, { from, to, turno, zona });

    res.status(200).json({
      lastUpdate: snapshot.lastUpdate,
      dateBounds: snapshot.dateBounds,
      appliedRange: { from: from || (snapshot.dateBounds && snapshot.dateBounds.min), to: to || (snapshot.dateBounds && snapshot.dateBounds.max) },
      stats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
