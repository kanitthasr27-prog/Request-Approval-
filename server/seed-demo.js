// Creates demo users (one+ per role) and sample products for trial runs (D20).
// All demo accounts use password "Demo12345" and must change it on first login.
// Uses DATABASE_URL if set, otherwise the local embedded database.
const path = require('node:path');
const { openDb, hashPassword, bootstrapAccounts } = require('./db');

(async () => {
  const db = await openDb(process.env.DATABASE_URL || path.join(__dirname, '..', 'data', 'pglite'));
  await db.ensureSchema();
  const created = await bootstrapAccounts(db);
  if (created) console.log(`hr / ${created.hr}\nadmin / ${created.admin}`);

  const pw = hashPassword('Demo12345');
  const users = [
    ['sale1', 'สมชาย ขายดี', 'ขาย', 'requester'],
    ['sale2', 'สมหญิง รักงาน', 'การตลาด', 'requester'],
    ['boss1', 'ผู้บริหาร หนึ่ง', 'บริหาร', 'approver'],
    ['boss2', 'ผู้บริหาร สอง', 'บริหาร', 'approver'],
    ['wh1', 'คลัง หนึ่ง', 'คลังสินค้า', 'warehouse'],
  ];
  for (const [u, n, d, r] of users)
    await db.run(`INSERT INTO users (username, password_hash, full_name, department, role, must_change_password)
                  VALUES (?,?,?,?,?,1) ON CONFLICT (username) DO NOTHING`, [u, pw, n, d, r]);

  for (const [c, n, u] of [['S-001', 'ผลิตภัณฑ์ตัวอย่าง A', 'ชิ้น'], ['S-002', 'ผลิตภัณฑ์ตัวอย่าง B', 'กล่อง'], ['S-003', 'ผลิตภัณฑ์ตัวอย่าง C', 'ชุด']])
    await db.run('INSERT INTO products (code, name, unit) VALUES (?,?,?) ON CONFLICT (code) DO NOTHING', [c, n, u]);

  const id = async (u) => (await db.q('SELECT id FROM users WHERE username = ?', [u]))[0].id;
  for (const r of ['sale1', 'sale2']) for (const a of ['boss1', 'boss2'])
    await db.run('INSERT INTO approver_links (requester_id, approver_id) VALUES (?,?) ON CONFLICT DO NOTHING', [await id(r), await id(a)]);

  console.log('สร้างข้อมูลสาธิตแล้ว: sale1, sale2, boss1, boss2, wh1 (รหัส Demo12345)');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
