const { get } = require('@vercel/blob');
const { fetchAndCacheSnapshot, SNAPSHOT_KEY } = require('./_lib/sheet');

module.exports = async (req, res) => {
  try {
    if (req.query.force) {
      const { snapshot } = await fetchAndCacheSnapshot();
      res.status(200).json(snapshot);
      return;
    }

    const result = await get(SNAPSHOT_KEY, { access: 'private', useCache: false });
    if (!result) {
      res.status(200).json({
        lastUpdate: null,
        headers: [],
        rows: [],
        notice: 'Cache ainda não gerado. Aguarde o primeiro refresh agendado ou acione /api/refresh-cache manualmente.'
      });
      return;
    }

    const text = await new Response(result.stream).text();
    res.status(200).json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
