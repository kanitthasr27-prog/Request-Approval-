const path = require('node:path');
const { createApp } = require('./app');
const { bootstrapAccounts } = require('./db');

const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const app = createApp(dbFile);

const created = bootstrapAccounts(app.locals.db);
if (created) {
  console.log('สร้างบัญชีเริ่มต้นแล้ว (ต้องเปลี่ยนรหัสผ่านตอนเข้าครั้งแรก — แสดงครั้งเดียว):');
  console.log(`  hr    / ${created.hr}`);
  console.log(`  admin / ${created.admin}`);
}

app.locals.checkOverdue();
setInterval(() => app.locals.checkOverdue(), 60 * 60 * 1000).unref();

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`เปิดที่ http://localhost:${port}`));
