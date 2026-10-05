const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/db');

// Boots the real app on a random port with an in-memory DB.
async function setup() {
  const app = createApp(':memory:');
  const db = app.locals.db;
  const pw = hashPassword('Passw0rd!');
  const mk = (u, name, role, must = 0) =>
    Number(db.prepare('INSERT INTO users (username,password_hash,full_name,department,role,must_change_password) VALUES (?,?,?,?,?,?)')
      .run(u, pw, name, 'X', role, must).lastInsertRowid);
  const ids = {
    req: mk('req', 'ผู้ขอ', 'requester'), req2: mk('req2', 'ผู้ขอสอง', 'requester'),
    a1: mk('a1', 'บอส1', 'approver'), a2: mk('a2', 'บอส2', 'approver'),
    wh: mk('wh', 'คลัง', 'warehouse'), admin: mk('admin', 'แอดมิน', 'admin'), hr: mk('hr', 'เอชอาร์', 'hr'),
  };
  db.prepare('INSERT INTO approver_links VALUES (?,?)').run(ids.req, ids.a1);
  db.prepare('INSERT INTO approver_links VALUES (?,?)').run(ids.req, ids.a2);
  db.prepare("INSERT INTO products (code,name,unit) VALUES ('P1','สินค้า 1','ชิ้น'),('P2','สินค้า 2','กล่อง')").run();
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function client(username, password = 'Passw0rd!') {
    let cookie = '';
    const call = async (method, path, body) => {
      const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
    };
    const login = await call('POST', '/login', { username, password });
    return { call, login };
  }
  return { app, db, ids, client, close: () => server.close() };
}

const tomorrow = () => new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const reqBody = (extra = {}) => ({ type: 'give', purpose: 'trial', customer: 'ลูกค้า A', need_date: tomorrow(), items: [{ product_id: 1, qty: 10 }, { product_id: 2, qty: 4 }], ...extra });

test('login, forced password change, wrong password', async () => {
  const s = await setup();
  s.db.prepare("UPDATE users SET must_change_password = 1 WHERE username = 'req2'").run();
  assert.equal((await s.client('req', 'wrong')).login.status, 401);
  const c = await s.client('req2');
  assert.equal(c.login.status, 200);
  assert.equal((await c.call('GET', '/my/requests')).status, 403, 'blocked until password changed');
  assert.equal((await c.call('POST', '/change-password', { current_password: 'Passw0rd!', new_password: 'short' })).status, 400);
  assert.equal((await c.call('POST', '/change-password', { current_password: 'Passw0rd!', new_password: 'NewPassw0rd!' })).status, 200);
  assert.equal((await c.call('GET', '/my/requests')).status, 200);
  s.close();
});

test('criteria 1-5: submit, notify, history, decision, reject reason', async () => {
  const s = await setup();
  const req = (await s.client('req')), a1 = await s.client('a1'), a2 = await s.client('a2');
  const created = await req.call('POST', '/requests', reqBody());
  assert.equal(created.status, 200);
  const id = created.body.id;
  for (const a of [a1, a2]) {
    assert.equal((await a.call('GET', '/requests?view=pending')).body.requests.length, 1);
    assert.equal((await a.call('GET', '/notifications')).body.unread, 1);
  }
  // history shows loan outstanding etc. (6 months)
  const detail = await a1.call('GET', '/requests/' + id);
  assert.equal(detail.body.can_decide, true);
  assert.ok(detail.body.history);
  // reject needs reason
  assert.equal((await a1.call('POST', `/requests/${id}/decide`, { result: 'rejected' })).status, 400);
  assert.equal((await a1.call('POST', `/requests/${id}/decide`, { result: 'rejected', reason: 'งบหมด' })).status, 200);
  const lose = await a2.call('POST', `/requests/${id}/decide`, { result: 'approved' });
  assert.equal(lose.status, 409);
  assert.match(lose.body.error, /บอส1/);
  const view = (await a2.call('GET', '/requests/' + id)).body.request;
  assert.equal(view.decision.approver_name, 'บอส1');
  const n = (await req.call('GET', '/notifications')).body.items;
  assert.ok(n.some((x) => x.message.includes('งบหมด')));
  s.close();
});

test('criterion 3: simultaneous approvals -> exactly one decision', async () => {
  const s = await setup();
  const req = await s.client('req'), a1 = await s.client('a1'), a2 = await s.client('a2');
  const { body: { id } } = await req.call('POST', '/requests', reqBody());
  const results = await Promise.all([
    a1.call('POST', `/requests/${id}/decide`, { result: 'approved' }),
    a2.call('POST', `/requests/${id}/decide`, { result: 'approved' }),
    a1.call('POST', `/requests/${id}/decide`, { result: 'rejected', reason: 'x' }),
    a2.call('POST', `/requests/${id}/decide`, { result: 'rejected', reason: 'y' }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM decisions WHERE request_id = ?').get(id).n, 1);
  s.close();
});

test('criteria 5-7: approve, partial dispense, continue, cancel remainder', async () => {
  const s = await setup();
  const req = await s.client('req'), a1 = await s.client('a1'), wh = await s.client('wh');
  const { body: { id } } = await req.call('POST', '/requests', reqBody());
  await a1.call('POST', `/requests/${id}/decide`, { result: 'approved' });
  assert.ok((await req.call('GET', '/notifications')).body.items.some((x) => x.message.includes('อนุมัติ')));
  assert.equal((await wh.call('GET', '/requests?view=dispense')).body.requests.length, 1);
  assert.equal((await wh.call('GET', '/notifications')).body.unread, 1);
  const items = (await wh.call('GET', '/requests/' + id)).body.request.items;
  // over-dispense rejected
  assert.equal((await wh.call('POST', `/requests/${id}/dispense`, { lines: [{ item_id: items[0].id, qty: 11 }] })).status, 400);
  let r = await wh.call('POST', `/requests/${id}/dispense`, { lines: [{ item_id: items[0].id, qty: 6 }, { item_id: items[1].id, qty: 4 }] });
  assert.equal(r.body.status, 'partial');
  let detail = (await req.call('GET', '/requests/' + id)).body.request;
  assert.equal(detail.outstanding, 4);
  // warehouse cancel needs reason
  assert.equal((await wh.call('POST', `/requests/${id}/cancel`, {})).status, 400);
  r = await wh.call('POST', `/requests/${id}/dispense`, { lines: [{ item_id: items[0].id, qty: 2 }] });
  assert.equal(r.body.status, 'partial');
  r = await wh.call('POST', `/requests/${id}/cancel`, { reason: 'หมดสต็อก' });
  assert.equal(r.body.status, 'completed');
  assert.equal((await wh.call('GET', '/requests?view=dispense')).body.requests.length, 0);
  // requester cancels outstanding of another request
  const { body: { id: id2 } } = await req.call('POST', '/requests', reqBody());
  await a1.call('POST', `/requests/${id2}/decide`, { result: 'approved' });
  const it2 = (await wh.call('GET', '/requests/' + id2)).body.request.items;
  await wh.call('POST', `/requests/${id2}/dispense`, { lines: [{ item_id: it2[0].id, qty: 1 }] });
  assert.equal((await req.call('POST', `/requests/${id2}/cancel`, {})).body.status, 'completed');
  s.close();
});

test('criterion 7: requester cancels before approval; cannot cancel after decision race', async () => {
  const s = await setup();
  const req = await s.client('req'), a1 = await s.client('a1'), req2 = await s.client('req2');
  const { body: { id } } = await req.call('POST', '/requests', reqBody());
  assert.equal((await req2.call('POST', `/requests/${id}/cancel`, {})).status, 404, "other requester can't touch it");
  assert.equal((await req.call('POST', `/requests/${id}/cancel`, {})).body.status, 'cancelled');
  assert.equal((await a1.call('POST', `/requests/${id}/decide`, { result: 'approved' })).status, 409);
  s.close();
});

test('criterion 8: loan return (partial) and overdue notification + history', async () => {
  const s = await setup();
  const req = await s.client('req'), a1 = await s.client('a1'), wh = await s.client('wh');
  assert.equal((await req.call('POST', '/requests', reqBody({ type: 'loan' }))).status, 400, 'loan needs due date');
  const { body: { id } } = await req.call('POST', '/requests', reqBody({ type: 'loan', due_date: tomorrow() }));
  await a1.call('POST', `/requests/${id}/decide`, { result: 'approved' });
  const items = (await wh.call('GET', '/requests/' + id)).body.request.items;
  await wh.call('POST', `/requests/${id}/dispense`, { lines: [{ item_id: items[0].id, qty: 10 }, { item_id: items[1].id, qty: 4 }] });
  assert.equal((await wh.call('GET', '/requests?view=loans')).body.requests.length, 1);
  assert.equal((await wh.call('POST', `/requests/${id}/return`, { lines: [{ item_id: items[0].id, qty: 11 }] })).status, 400);
  await wh.call('POST', `/requests/${id}/return`, { lines: [{ item_id: items[0].id, qty: 3 }] });
  assert.equal((await req.call('GET', '/my/requests')).body.loans[0].unreturned, 11);
  // make it overdue
  s.db.prepare("UPDATE requests SET due_date = '2000-01-01' WHERE id = ?").run(id);
  const mine = (await req.call('GET', '/my/requests')).body;
  assert.equal(mine.loans[0].overdue, true);
  assert.ok((await req.call('GET', '/notifications')).body.items.some((x) => x.message.includes('เลยกำหนดคืน')));
  assert.equal((await req.call('GET', '/notifications')).body.items.filter((x) => x.message.includes('เลยกำหนดคืน')).length, 1, 'only once');
  // approver sees it in history of a new request
  const { body: { id: id2 } } = await req.call('POST', '/requests', reqBody());
  const h = (await a1.call('GET', '/requests/' + id2)).body.history;
  assert.equal(h.outstanding_loans.length, 1);
  assert.equal(h.outstanding_loans[0].overdue, true);
  assert.equal(h.total_dispensed, 14);
  assert.equal(h.requests.length, 1);
  // return the rest: no longer outstanding
  await wh.call('POST', `/requests/${id}/return`, { lines: [{ item_id: items[0].id, qty: 7 }, { item_id: items[1].id, qty: 4 }] });
  assert.equal((await wh.call('GET', '/requests?view=loans')).body.requests.length, 0);
  s.close();
});

test('criterion 9: HR create/deactivate/reset; history survives', async () => {
  const s = await setup();
  const hr = await s.client('hr');
  assert.equal((await hr.call('POST', '/users', { username: 'new1', full_name: 'คนใหม่', role: 'requester', password: 'short' })).status, 400);
  assert.equal((await hr.call('POST', '/users', { username: 'new1', full_name: 'คนใหม่', role: 'requester', password: 'Temp12345' })).status, 200);
  const n = await s.client('new1', 'Temp12345');
  assert.equal(n.login.body.user.must_change_password, true);
  const req = await s.client('req');
  const { body: { id } } = await req.call('POST', '/requests', reqBody());
  const reqId = s.ids.req;
  assert.equal((await hr.call('POST', `/users/${reqId}/active`, { active: false })).status, 200);
  assert.equal((await req.call('GET', '/my/requests')).status, 401, 'session dropped');
  assert.equal((await s.client('req')).login.status, 401, 'cannot login');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM requests WHERE id = ?').get(id).n, 1);
  await hr.call('POST', `/users/${reqId}/active`, { active: true });
  assert.equal((await hr.call('POST', `/users/${reqId}/reset-password`, { password: 'Reset12345' })).status, 200);
  assert.equal((await s.client('req', 'Reset12345')).login.body.user.must_change_password, true);
  s.close();
});

test('criterion 10: products and approver re-link', async () => {
  const s = await setup();
  const admin = await s.client('admin'), req = await s.client('req'), a1 = await s.client('a1'), a2 = await s.client('a2');
  assert.equal((await admin.call('POST', '/products', { code: 'P3', name: 'ใหม่', unit: 'ชิ้น' })).status, 200);
  await admin.call('PUT', '/products/2', { active: false });
  assert.equal((await req.call('POST', '/requests', reqBody())).status, 400, 'inactive product');
  assert.equal((await req.call('GET', '/products')).body.products.length, 2);
  await admin.call('PUT', `/approver-links/${s.ids.req}`, { approver_ids: [s.ids.a2] });
  const ok = await req.call('POST', '/requests', reqBody({ items: [{ product_id: 1, qty: 1 }] }));
  assert.equal((await a1.call('GET', '/requests?view=pending')).body.requests.length, 0);
  assert.equal((await a2.call('GET', '/requests?view=pending')).body.requests.length, 1);
  assert.equal((await a1.call('POST', `/requests/${ok.body.id}/decide`, { result: 'approved' })).status, 403);
  await admin.call('PUT', `/approver-links/${s.ids.req}`, { approver_ids: [] });
  assert.equal((await req.call('POST', '/requests', reqBody({ items: [{ product_id: 1, qty: 1 }] }))).status, 400, 'no approver');
  s.close();
});

test('criterion 11: role isolation', async () => {
  const s = await setup();
  const req = await s.client('req'), req2 = await s.client('req2'), hr = await s.client('hr'), a1 = await s.client('a1'),
    wh = await s.client('wh'), admin = await s.client('admin');
  const { body: { id } } = await req.call('POST', '/requests', reqBody());
  assert.equal((await req2.call('GET', '/requests/' + id)).status, 404);
  assert.equal((await hr.call('GET', '/requests/' + id)).status, 404);
  assert.equal((await hr.call('GET', '/requests')).status, 403);
  assert.equal((await hr.call('GET', '/export')).status, 403);
  assert.equal((await req.call('GET', '/users')).status, 403);
  assert.equal((await req.call('GET', '/requests')).status, 403);
  assert.equal((await req.call('POST', '/products', { code: 'z', name: 'z', unit: 'z' })).status, 403);
  assert.equal((await a1.call('POST', '/requests', reqBody())).status, 403, 'approver cannot submit');
  assert.equal((await wh.call('GET', '/export')).status, 403);
  assert.equal((await wh.call('POST', `/requests/${id}/decide`, { result: 'approved' })).status, 403);
  assert.equal((await admin.call('POST', `/requests/${id}/decide`, { result: 'approved' })).status, 403);
  s.close();
});

test('criterion 12: Excel export matches data', async () => {
  const s = await setup();
  const ExcelJS = require('exceljs');
  const req = await s.client('req'), a1 = await s.client('a1'), admin = await s.client('admin');
  await req.call('POST', '/requests', reqBody());
  await req.call('POST', '/requests', reqBody({ customer: 'งานอีเวนต์', items: [{ product_id: 1, qty: 7 }] }));
  for (const c of [a1, admin]) {
    const r = await c.call('GET', '/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const ws = wb.worksheets[0];
    assert.equal(ws.rowCount, 1 + 3, 'header + 3 item rows');
    const qtys = [];
    ws.eachRow((row, n) => { if (n > 1) qtys.push(row.getCell(18).value); });
    assert.deepEqual(qtys.sort(), [10, 4, 7].sort());
  }
  s.close();
});

test('static: app shell, manifest and service worker served', async () => {
  const s = await setup();
  const server = await new Promise((res) => { const x = s.app.listen(0, () => res(x)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of ['/', '/manifest.json', '/sw.js', '/icon.svg', '/app.js']) assert.equal((await fetch(base + p)).status, 200, p);
  server.close(); s.close();
});
