// Creates demo users (one+ per role) and sample products for trial runs (D20).
// All demo accounts use password "Demo12345" and must change it on first login.
const path = require('node:path');
const { openDb, hashPassword, bootstrapAccounts } = require('./db');

const db = openDb(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'));
const created = bootstrapAccounts(db);
if (created) console.log(`hr / ${created.hr}\nadmin / ${created.admin}`);

const pw = hashPassword('Demo12345');
const users = [
  ['sale1', 'สมชาย ขายดี', 'ขาย', 'requester'],
  ['sale2', 'สมหญิง รักงาน', 'การตลาด', 'requester'],
  ['boss1', 'ผู้บริหาร หนึ่ง', 'บริหาร', 'approver'],
  ['boss2', 'ผู้บริหาร สอง', 'บริหาร', 'approver'],
  ['wh1', 'คลัง หนึ่ง', 'คลังสินค้า', 'warehouse'],
];
const insU = db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, full_name, department, role, must_change_password) VALUES (?,?,?,?,?,1)`);
for (const [u, n, d, r] of users) insU.run(u, pw, n, d, r);

const insP = db.prepare('INSERT OR IGNORE INTO products (code, name, unit) VALUES (?,?,?)');
insP.run('S-001', 'ผลิตภัณฑ์ตัวอย่าง A', 'ชิ้น');
insP.run('S-002', 'ผลิตภัณฑ์ตัวอย่าง B', 'กล่อง');
insP.run('S-003', 'ผลิตภัณฑ์ตัวอย่าง C', 'ชุด');

const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
const link = db.prepare('INSERT OR IGNORE INTO approver_links (requester_id, approver_id) VALUES (?,?)');
for (const r of ['sale1', 'sale2']) for (const a of ['boss1', 'boss2']) link.run(id(r), id(a));

console.log('สร้างข้อมูลสาธิตแล้ว: sale1, sale2, boss1, boss2, wh1 (รหัส Demo12345)');
