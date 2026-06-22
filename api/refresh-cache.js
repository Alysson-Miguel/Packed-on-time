const { fetchAndCacheSnapshot } = require('./_lib/sheet');

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  return process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Não autorizado.' });
    return;
  }

  try {
    const { totalSheetRows, cachedRows, cutoff } = await fetchAndCacheSnapshot();
    res.status(200).json({ ok: true, totalSheetRows, cachedRows, cutoff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
