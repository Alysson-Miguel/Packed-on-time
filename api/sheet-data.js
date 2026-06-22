const { list } = require('@vercel/blob');

const SNAPSHOT_KEY = 'packed-on-time-snapshot.json';

module.exports = async (req, res) => {
  try {
    const { blobs } = await list({ prefix: SNAPSHOT_KEY, limit: 1 });
    if (!blobs.length) {
      res.status(200).json({
        lastUpdate: null,
        headers: [],
        rows: [],
        notice: 'Cache ainda não gerado. Aguarde o primeiro refresh agendado ou acione /api/refresh-cache manualmente.'
      });
      return;
    }

    const response = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Falha ao ler snapshot (HTTP ${response.status}).`);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
