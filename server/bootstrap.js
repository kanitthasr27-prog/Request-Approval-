// One-off: creates the schema (if missing) and the first hr/admin accounts in the database at DATABASE_URL.
// Run once after creating the database, e.g. before the first Vercel deploy.
const path = require('node:path');
const { openDb, bootstrapAccounts } = require('./db');

(async () => {
  const db = await openDb(process.env.DATABASE_URL || path.join(__dirname, '..', 'data', 'pglite'));
  await db.ensureSchema();
  const created = await bootstrapAccounts(db);
  if (created) {
    console.log('สร้างบัญชีเริ่มต้นแล้ว (ต้องเปลี่ยนรหัสผ่านตอนเข้าครั้งแรก — แสดงครั้งเดียว):');
    console.log(`  hr    / ${created.hr}`);
    console.log(`  admin / ${created.admin}`);
  } else {
    console.log('มีบัญชีอยู่แล้ว ไม่ได้สร้างเพิ่ม');
  }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
