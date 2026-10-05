// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
const { createApp } = require('../server/app');
const { openDb } = require('../server/db');

let appPromise;
function getApp() {
  if (!appPromise) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    appPromise = openDb(process.env.DATABASE_URL).then(createApp).catch((e) => { appPromise = undefined; throw e; });
  }
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    (await getApp())(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'เกิดข้อผิดพลาดในระบบ' }));
  }
};
