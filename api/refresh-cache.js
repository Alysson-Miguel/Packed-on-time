const { JWT } = require('google-auth-library');
const { put } = require('@vercel/blob');

const SHEET_ID = '1tYIoqJZU-LzCwGnoRG5ScTLDq2sR6Qo9UA5wcOol204';
const RANGE = 'Detail!A:Q';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const WINDOW_DAYS = 3; // mantém um buffer além do "hoje + ontem" usado por padrão no painel
const SNAPSHOT_KEY = 'packed-on-time-snapshot.json';

function getClient() {
  return new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: SCOPES
  });
}

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
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      throw new Error('Variáveis GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY não configuradas.');
    }

    const client = getClient();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
    const response = await client.request({ url });
    const values = response.data.values || [];

    if (values.length < 2) {
      const empty = { lastUpdate: new Date().toISOString(), headers: [], rows: [] };
      await put(SNAPSHOT_KEY, JSON.stringify(empty), { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
      res.status(200).json({ ok: true, rows: 0 });
      return;
    }

    const headers = values[0];
    const dateCol = headers.indexOf('received_datetime');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const rawDate = dateCol >= 0 ? String(values[i][dateCol] || '') : '';
      if (rawDate.slice(0, 10) < cutoffStr) continue;
      rows.push(headers.map((_, c) => (values[i][c] !== undefined ? values[i][c] : '')));
    }

    const snapshot = { lastUpdate: new Date().toISOString(), headers, rows };
    await put(SNAPSHOT_KEY, JSON.stringify(snapshot), { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });

    res.status(200).json({ ok: true, totalSheetRows: values.length - 1, cachedRows: rows.length, cutoff: cutoffStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
