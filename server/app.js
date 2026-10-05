const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const { hashPassword, verifyPassword } = require('./db');

const ROLES = ['requester', 'approver', 'warehouse', 'admin', 'hr'];
const STATUS_TH = {
  pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ', approved: 'อนุมัติแล้ว',
  partial: 'จ่ายบางส่วน', completed: 'จ่ายครบ', cancelled: 'ยกเลิก',
};
const MIN_PW = 8;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const nowIso = () => new Date().toISOString();
const todayBkk = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

// db: object from openDb() (q / run / tx). Helpers take `d` so they work both on db and inside a transaction.
function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));

  // ---------- helpers ----------
  const one = async (d, sql, params) => (await d.q(sql, params))[0];

  const notify = (d, userId, message, requestId) =>
    d.run('INSERT INTO notifications (user_id, message, request_id, at) VALUES (?,?,?,?)',
      [userId, message, requestId ?? null, nowIso()]);

  const idsByRole = async (d, role) =>
    (await d.q('SELECT id FROM users WHERE role = ? AND active = 1', [role])).map((r) => r.id);

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
    }
  };

  const cookieFlags = (req) => `HttpOnly; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`;

  // authenticate every /api request except login
  async function auth(req, res, next) {
    try {
      const token = parseCookies(req).sid;
      const row = token && await one(db,
        `SELECT u.id, u.username, u.full_name, u.department, u.role, u.active, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, [token]);
      if (!row || !row.active) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
      req.user = row;
      req.token = token;
      next();
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
    }
  }

  const allow = (...roles) => (req, res, next) => {
    if (req.user.must_change_password) return res.status(403).json({ error: 'ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' });
    next();
  };

  const publicUser = (u) => ({
    id: u.id, username: u.username, full_name: u.full_name, department: u.department,
    role: u.role, must_change_password: !!u.must_change_password,
  });

  // ---------- request loading ----------
  const loadItems = (d, requestId) =>
    d.q(`SELECT i.id, i.product_id, p.code, p.name, p.unit, i.qty_requested, i.qty_dispensed,
                i.qty_returned, i.qty_cancelled
         FROM request_items i JOIN products p ON p.id = i.product_id
         WHERE i.request_id = ? ORDER BY i.id`, [requestId]);

  async function decorate(d, r) {
    const items = await loadItems(d, r.id);
    const decision = (await one(d, `SELECT d.result, d.reason, d.decided_at, d.approver_id, u.full_name AS approver_name
                        FROM decisions d JOIN users u ON u.id = d.approver_id WHERE d.request_id = ?`, [r.id])) || null;
    const outstanding = items.reduce((s, i) => s + (i.qty_requested - i.qty_dispensed - i.qty_cancelled), 0);
    const unreturned = r.type === 'loan' ? items.reduce((s, i) => s + (i.qty_dispensed - i.qty_returned), 0) : 0;
    return {
      ...r, status_th: STATUS_TH[r.status], items, decision, outstanding, unreturned,
      overdue: r.type === 'loan' && unreturned > 0 && !!r.due_date && r.due_date < todayBkk(),
    };
  }
  const decorateAll = (d, rows) => Promise.all(rows.map((r) => decorate(d, r)));

  const REQ_SELECT = `SELECT r.*, u.full_name AS requester_name, u.department AS requester_department
                      FROM requests r JOIN users u ON u.id = r.requester_id`;

  async function getRequest(d, id) {
    const r = await one(d, `${REQ_SELECT} WHERE r.id = ?`, [id]);
    return r ? decorate(d, r) : null;
  }

  function canView(user, r) {
    if (user.role === 'requester') return r.requester_id === user.id;
    return ['approver', 'admin', 'warehouse'].includes(user.role);
  }

  // Recomputes status after dispense/cancel (D7/D8).
  async function recomputeStatus(d, requestId) {
    const items = await loadItems(d, requestId);
    const dispensed = items.reduce((s, i) => s + i.qty_dispensed, 0);
    const outstanding = items.reduce((s, i) => s + (i.qty_requested - i.qty_dispensed - i.qty_cancelled), 0);
    let status;
    if (outstanding === 0) status = dispensed === 0 ? 'cancelled' : 'completed';
    else status = dispensed === 0 ? 'approved' : 'partial';
    await d.run('UPDATE requests SET status = ? WHERE id = ?', [status, requestId]);
    return status;
  }

  // Loan overdue notifications, once per request (D12).
  async function checkOverdue() {
    const rows = await db.q(`SELECT r.id, r.requester_id, r.due_date FROM requests r
                    WHERE r.type = 'loan' AND r.overdue_notified = 0 AND r.due_date < ?
                      AND (SELECT COALESCE(SUM(qty_dispensed - qty_returned),0)::int FROM request_items WHERE request_id = r.id) > 0`,
      [todayBkk()]);
    for (const r of rows) {
      await db.tx(async (t) => {
        // the flag flip is the guard: only one concurrent caller gets changes = 1
        const n = await t.run('UPDATE requests SET overdue_notified = 1 WHERE id = ? AND overdue_notified = 0', [r.id]);
        if (n === 1) await notify(t, r.requester_id, `ของยืมในคำขอ #${r.id} เลยกำหนดคืน (${r.due_date}) แล้ว`, r.id);
      });
    }
    return rows.length;
  }

  // ---------- cron (Vercel Cron sends "Authorization: Bearer $CRON_SECRET") ----------
  app.get('/api/cron/overdue', wrap(async (req) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'ไม่ได้รับอนุญาต');
    return { notified: await checkOverdue() };
  }));

  // ---------- auth routes ----------
  app.post('/api/login', wrap(async (req, res) => {
    const username = str(req.body.username, 100);
    const u = await one(db, 'SELECT * FROM users WHERE username = ?', [username]);
    if (!u || !u.active || !verifyPassword(String(req.body.password ?? ''), u.password_hash))
      throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const token = crypto.randomBytes(32).toString('hex');
    await db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', [token, u.id, nowIso()]);
    res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${60 * 60 * 24 * 30}`);
    return { user: publicUser(u) };
  }));

  app.use('/api', auth);

  app.post('/api/logout', wrap(async (req, res) => {
    await db.run('DELETE FROM sessions WHERE token = ?', [req.token]);
    res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
    return { ok: true };
  }));

  app.get('/api/me', wrap(async (req) => ({ user: publicUser(req.user) })));

  app.post('/api/change-password', wrap(async (req) => {
    const u = await one(db, 'SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(String(req.body.current_password ?? ''), u.password_hash))
      throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    const np = String(req.body.new_password ?? '');
    if (np.length < MIN_PW) throw bad(`รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
    if (np === String(req.body.current_password)) throw bad('รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม');
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(np), u.id]);
    return { ok: true };
  }));

  // ---------- notifications (all roles) ----------
  app.get('/api/notifications', wrap(async (req) => {
    if (req.user.role === 'requester') await checkOverdue();
    const items = await db.q('SELECT id, message, request_id, is_read, at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100',
      [req.user.id]);
    return { items, unread: items.filter((n) => !n.is_read).length };
  }));
  app.post('/api/notifications/:id/read', wrap(async (req) => {
    await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
    return { ok: true };
  }));
  app.post('/api/notifications/read-all', wrap(async (req) => {
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    return { ok: true };
  }));

  // ---------- HR: accounts ----------
  const hr = allow('hr');
  app.get('/api/users', hr, wrap(async () => ({
    users: await db.q('SELECT id, username, full_name, department, role, active, must_change_password FROM users ORDER BY id'),
  })));

  app.post('/api/users', hr, wrap(async (req) => {
    const b = req.body;
    const username = str(b.username, 50), full_name = str(b.full_name, 100);
    if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) throw bad('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ยาว 3-50 ตัว');
    if (!full_name) throw bad('กรุณากรอกชื่อ-นามสกุล');
    if (!ROLES.includes(b.role)) throw bad('บทบาทไม่ถูกต้อง');
    const pw = String(b.password ?? '');
    if (pw.length < MIN_PW) throw bad(`รหัสผ่านชั่วคราวต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
    if (await one(db, 'SELECT 1 FROM users WHERE username = ?', [username])) throw bad('ชื่อผู้ใช้นี้มีอยู่แล้ว');
    const r = await one(db,
      'INSERT INTO users (username, password_hash, full_name, department, role, must_change_password) VALUES (?,?,?,?,?,1) RETURNING id',
      [username, hashPassword(pw), full_name, str(b.department, 100), b.role]);
    return { id: r.id };
  }));

  app.post('/api/users/:id/reset-password', hr, wrap(async (req) => {
    const pw = String(req.body.password ?? '');
    if (pw.length < MIN_PW) throw bad(`รหัสผ่านชั่วคราวต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
    const id = Number(req.params.id);
    if (!await one(db, 'SELECT 1 FROM users WHERE id = ?', [id])) throw new HttpError(404, 'ไม่พบผู้ใช้');
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(pw), id]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    return { ok: true };
  }));

  app.post('/api/users/:id/active', hr, wrap(async (req) => {
    const id = Number(req.params.id);
    const active = req.body.active ? 1 : 0;
    if (id === req.user.id && !active) throw bad('ไม่สามารถปิดบัญชีของตัวเองได้');
    if (!await one(db, 'SELECT 1 FROM users WHERE id = ?', [id])) throw new HttpError(404, 'ไม่พบผู้ใช้');
    await db.run('UPDATE users SET active = ? WHERE id = ?', [active, id]);
    if (!active) await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    return { ok: true };
  }));

  // ---------- Admin: products & approver links ----------
  app.get('/api/products', wrap(async (req) => {
    const all = req.user.role === 'admin';
    return { products: await db.q(`SELECT id, code, name, unit, active FROM products ${all ? '' : 'WHERE active = 1'} ORDER BY code`) };
  }));

  const admin = allow('admin');
  app.post('/api/products', admin, wrap(async (req) => {
    const code = str(req.body.code, 50), name = str(req.body.name, 200), unit = str(req.body.unit, 30);
    if (!code || !name || !unit) throw bad('กรุณากรอกรหัส ชื่อ และหน่วย');
    if (await one(db, 'SELECT 1 FROM products WHERE code = ?', [code])) throw bad('รหัสสินค้านี้มีอยู่แล้ว');
    const r = await one(db, 'INSERT INTO products (code, name, unit) VALUES (?,?,?) RETURNING id', [code, name, unit]);
    return { id: r.id };
  }));

  app.put('/api/products/:id', admin, wrap(async (req) => {
    const id = Number(req.params.id);
    const p = await one(db, 'SELECT * FROM products WHERE id = ?', [id]);
    if (!p) throw new HttpError(404, 'ไม่พบสินค้า');
    const code = str(req.body.code ?? p.code, 50), name = str(req.body.name ?? p.name, 200), unit = str(req.body.unit ?? p.unit, 30);
    if (!code || !name || !unit) throw bad('กรุณากรอกรหัส ชื่อ และหน่วย');
    if (await one(db, 'SELECT 1 FROM products WHERE code = ? AND id <> ?', [code, id])) throw bad('รหัสสินค้านี้มีอยู่แล้ว');
    const active = req.body.active === undefined ? p.active : (req.body.active ? 1 : 0);
    await db.run('UPDATE products SET code = ?, name = ?, unit = ?, active = ? WHERE id = ?', [code, name, unit, active, id]);
    return { ok: true };
  }));

  app.get('/api/approver-links', admin, wrap(async () => {
    const requesters = await db.q(`SELECT id, full_name, department FROM users WHERE role = 'requester' AND active = 1 ORDER BY full_name`);
    const links = await db.q('SELECT requester_id, approver_id FROM approver_links');
    return {
      requesters: requesters.map((r) => ({ ...r, approver_ids: links.filter((l) => l.requester_id === r.id).map((l) => l.approver_id) })),
      approvers: await db.q(`SELECT id, full_name FROM users WHERE role = 'approver' AND active = 1 ORDER BY full_name`),
    };
  }));

  app.put('/api/approver-links/:requesterId', admin, wrap(async (req) => {
    const rid = Number(req.params.requesterId);
    if (!await one(db, `SELECT 1 FROM users WHERE id = ? AND role = 'requester'`, [rid])) throw new HttpError(404, 'ไม่พบผู้ขอ');
    const ids = Array.isArray(req.body.approver_ids) ? [...new Set(req.body.approver_ids.map(Number))] : [];
    for (const a of ids)
      if (!await one(db, `SELECT 1 FROM users WHERE id = ? AND role = 'approver' AND active = 1`, [a])) throw bad('ผู้อนุมัติไม่ถูกต้อง');
    await db.tx(async (t) => {
      await t.run('DELETE FROM approver_links WHERE requester_id = ?', [rid]);
      for (const a of ids) await t.run('INSERT INTO approver_links (requester_id, approver_id) VALUES (?,?)', [rid, a]);
    });
    return { ok: true };
  }));

  // ---------- Requester: create / list ----------
  const requester = allow('requester');

  app.post('/api/requests', requester, wrap(async (req) => {
    const b = req.body;
    if (!['give', 'loan'].includes(b.type)) throw bad('กรุณาเลือกประเภท');
    if (!['trial', 'marketing'].includes(b.purpose)) throw bad('กรุณาเลือกวัตถุประสงค์');
    const customer = str(b.customer, 200);
    if (!customer) throw bad('กรุณากรอกชื่อลูกค้าหรือชื่องาน');
    if (!isDate(b.need_date)) throw bad('กรุณาระบุวันที่ต้องการรับของ');
    let due = null;
    if (b.type === 'loan') {
      if (!isDate(b.due_date)) throw bad('กรุณาระบุกำหนดคืน');
      if (b.due_date < todayBkk()) throw bad('กำหนดคืนต้องไม่ก่อนวันนี้');
      due = b.due_date;
    }
    if (!Array.isArray(b.items) || b.items.length === 0) throw bad('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ');
    const seen = new Set();
    for (const it of b.items) {
      if (!posInt(it.product_id) || !posInt(it.qty)) throw bad('รายการสินค้าหรือจำนวนไม่ถูกต้อง');
      if (seen.has(it.product_id)) throw bad('มีสินค้าซ้ำในคำขอ กรุณารวมเป็นบรรทัดเดียว');
      seen.add(it.product_id);
      if (!await one(db, 'SELECT 1 FROM products WHERE id = ? AND active = 1', [it.product_id])) throw bad('มีสินค้าที่ไม่พร้อมให้เบิก');
    }
    const approvers = (await db.q(`SELECT l.approver_id FROM approver_links l JOIN users u ON u.id = l.approver_id
                         WHERE l.requester_id = ? AND u.active = 1`, [req.user.id])).map((r) => r.approver_id);
    if (approvers.length === 0) throw bad('ยังไม่ได้กำหนดผู้อนุมัติให้คุณ กรุณาติดต่อผู้ดูแลระบบ');

    return db.tx(async (t) => {
      const r = await one(t, `INSERT INTO requests (requester_id, type, due_date, purpose, customer, need_date, note, status, created_at)
                   VALUES (?,?,?,?,?,?,?,'pending',?) RETURNING id`,
        [req.user.id, b.type, due, b.purpose, customer, b.need_date, str(b.note, 1000), nowIso()]);
      for (const it of b.items)
        await t.run('INSERT INTO request_items (request_id, product_id, qty_requested) VALUES (?,?,?)', [r.id, it.product_id, it.qty]);
      for (const a of approvers) await notify(t, a, `คำขอเบิกใหม่ #${r.id} จาก ${req.user.full_name} รอการตัดสิน`, r.id);
      return { id: r.id };
    });
  }));

  app.get('/api/my/requests', requester, wrap(async (req) => {
    await checkOverdue();
    const rows = await decorateAll(db, await db.q(`${REQ_SELECT} WHERE r.requester_id = ? ORDER BY r.id DESC`, [req.user.id]));
    return { requests: rows, loans: rows.filter((r) => r.unreturned > 0) };
  }));

  // ---------- shared request list / detail ----------
  app.get('/api/requests', allow('approver', 'admin', 'warehouse'), wrap(async (req) => {
    const view = req.query.view;
    let where = '1=1', params = [];
    if (view === 'pending') {
      if (req.user.role !== 'approver') throw new HttpError(403, 'ไม่มีสิทธิ์');
      where = `r.status = 'pending' AND r.requester_id IN (SELECT requester_id FROM approver_links WHERE approver_id = ?)`;
      params = [req.user.id];
    } else if (view === 'dispense') {
      if (req.user.role !== 'warehouse') throw new HttpError(403, 'ไม่มีสิทธิ์');
      where = `r.status IN ('approved','partial')`;
    } else if (view === 'loans') {
      if (req.user.role !== 'warehouse') throw new HttpError(403, 'ไม่มีสิทธิ์');
      where = `r.type = 'loan' AND (SELECT COALESCE(SUM(qty_dispensed - qty_returned),0)::int FROM request_items WHERE request_id = r.id) > 0`;
    } else {
      if (req.user.role === 'warehouse') throw new HttpError(403, 'ไม่มีสิทธิ์');
      if (req.query.status) { where = 'r.status = ?'; params = [String(req.query.status)]; }
    }
    const order = view === 'pending' || view === 'dispense' ? 'ASC' : 'DESC';
    return { requests: await decorateAll(db, await db.q(`${REQ_SELECT} WHERE ${where} ORDER BY r.id ${order}`, params)) };
  }));

  async function history(requesterId, excludeId) {
    const dt = new Date(); dt.setMonth(dt.getMonth() - 6);
    const since = dt.toISOString();
    const rows = await decorateAll(db, await db.q(
      `${REQ_SELECT} WHERE r.requester_id = ? AND r.id <> ? AND r.created_at >= ? ORDER BY r.id DESC`, [requesterId, excludeId, since]));
    const outstandingLoans = (await decorateAll(db, await db.q(
      `${REQ_SELECT} WHERE r.requester_id = ? AND r.type = 'loan' ORDER BY r.id`, [requesterId]))).filter((r) => r.unreturned > 0);
    return {
      since,
      requests: rows,
      total_dispensed: rows.reduce((s, r) => s + r.items.reduce((t, i) => t + i.qty_dispensed, 0), 0),
      outstanding_loans: outstandingLoans,
    };
  }

  app.get('/api/requests/:id', wrap(async (req) => {
    if (req.user.must_change_password) throw new HttpError(403, 'ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน');
    const r = await getRequest(db, Number(req.params.id));
    // same response for missing and forbidden: no leaking of other people's request ids
    if (!r || !canView(req.user, r)) throw new HttpError(404, 'ไม่พบคำขอ');
    const out = { request: r };
    if (req.user.role === 'approver') {
      out.can_decide = !!await one(db, 'SELECT 1 FROM approver_links WHERE approver_id = ? AND requester_id = ?', [req.user.id, r.requester_id]);
      out.history = await history(r.requester_id, r.id);
    }
    return out;
  }));

  // ---------- Approver: decide (race-safe) ----------
  app.post('/api/requests/:id/decide', allow('approver'), wrap(async (req) => {
    const id = Number(req.params.id);
    const result = req.body.result;
    if (!['approved', 'rejected'].includes(result)) throw bad('ผลการตัดสินไม่ถูกต้อง');
    const reason = str(req.body.reason, 1000);
    if (result === 'rejected' && !reason) throw bad('กรุณาระบุเหตุผลที่ไม่อนุมัติ');

    return db.tx(async (t) => {
      const r = await one(t, 'SELECT * FROM requests WHERE id = ?', [id]);
      if (!r) throw new HttpError(404, 'ไม่พบคำขอ');
      if (!await one(t, 'SELECT 1 FROM approver_links WHERE approver_id = ? AND requester_id = ?', [req.user.id, r.requester_id]))
        throw new HttpError(403, 'คำขอนี้ไม่ได้ส่งถึงคุณ');
      // Only the first writer flips pending -> decided; a concurrent second one waits on the row lock,
      // then re-checks status = 'pending' and updates 0 rows.
      const changed = await t.run(`UPDATE requests SET status = ? WHERE id = ? AND status = 'pending'`,
        [result === 'approved' ? 'approved' : 'rejected', id]);
      if (changed !== 1) {
        const d = await one(t, `SELECT d.result, u.full_name FROM decisions d JOIN users u ON u.id = d.approver_id WHERE d.request_id = ?`, [id]);
        throw new HttpError(409, d
          ? `คำขอนี้ถูก${d.result === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ'}โดย ${d.full_name} ไปแล้ว`
          : 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติแล้ว');
      }
      await t.run('INSERT INTO decisions (request_id, approver_id, result, reason, decided_at) VALUES (?,?,?,?,?)',
        [id, req.user.id, result, result === 'rejected' ? reason : null, nowIso()]);
      if (result === 'approved') {
        await notify(t, r.requester_id, `คำขอ #${id} ของคุณได้รับการอนุมัติโดย ${req.user.full_name}`, id);
        for (const w of await idsByRole(t, 'warehouse')) await notify(t, w, `คำขอ #${id} อนุมัติแล้ว รอจ่ายสินค้า`, id);
      } else {
        await notify(t, r.requester_id, `คำขอ #${id} ไม่ได้รับอนุมัติ: ${reason}`, id);
      }
      return { ok: true };
    });
  }));

  // ---------- Warehouse: dispense / return ----------
  const warehouse = allow('warehouse');

  app.post('/api/requests/:id/dispense', warehouse, wrap(async (req) => {
    const id = Number(req.params.id);
    const lines = Array.isArray(req.body.lines) ? req.body.lines.filter((l) => l && Number(l.qty) !== 0) : [];
    if (lines.length === 0) throw bad('กรุณากรอกจำนวนที่จ่ายอย่างน้อย 1 รายการ');
    const note = str(req.body.note, 500);
    return db.tx(async (t) => {
      const r = await one(t, 'SELECT * FROM requests WHERE id = ? FOR UPDATE', [id]);
      if (!r || !['approved', 'partial'].includes(r.status)) throw bad('คำขอนี้ไม่อยู่ในสถานะรอจ่าย');
      for (const l of lines) {
        const qty = posInt(l.qty);
        if (!qty) throw bad('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
        const item = await one(t, 'SELECT * FROM request_items WHERE id = ? AND request_id = ?', [Number(l.item_id), id]);
        if (!item) throw bad('ไม่พบรายการสินค้าในคำขอ');
        const left = item.qty_requested - item.qty_dispensed - item.qty_cancelled;
        if (qty > left) throw bad(`จำนวนจ่ายเกินยอดค้าง (ค้าง ${left})`);
        await t.run('UPDATE request_items SET qty_dispensed = qty_dispensed + ? WHERE id = ?', [qty, item.id]);
        await t.run('INSERT INTO dispenses (request_id, item_id, qty, officer_id, at, note) VALUES (?,?,?,?,?,?)',
          [id, item.id, qty, req.user.id, nowIso(), note]);
      }
      const status = await recomputeStatus(t, id);
      await notify(t, r.requester_id,
        status === 'completed' ? `คำขอ #${id} จ่ายสินค้าครบแล้ว` : `คำขอ #${id} จ่ายสินค้าบางส่วนแล้ว ยังมียอดค้าง`, id);
      return { status };
    });
  }));

  app.post('/api/requests/:id/return', warehouse, wrap(async (req) => {
    const id = Number(req.params.id);
    const lines = Array.isArray(req.body.lines) ? req.body.lines.filter((l) => l && Number(l.qty) !== 0) : [];
    if (lines.length === 0) throw bad('กรุณากรอกจำนวนที่รับคืนอย่างน้อย 1 รายการ');
    return db.tx(async (t) => {
      const r = await one(t, 'SELECT * FROM requests WHERE id = ? FOR UPDATE', [id]);
      if (!r || r.type !== 'loan') throw bad('คำขอนี้ไม่ใช่แบบยืม');
      for (const l of lines) {
        const qty = posInt(l.qty);
        if (!qty) throw bad('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
        const item = await one(t, 'SELECT * FROM request_items WHERE id = ? AND request_id = ?', [Number(l.item_id), id]);
        if (!item) throw bad('ไม่พบรายการสินค้าในคำขอ');
        const left = item.qty_dispensed - item.qty_returned;
        if (qty > left) throw bad(`จำนวนรับคืนเกินยอดที่ยังไม่คืน (เหลือ ${left})`);
        await t.run('UPDATE request_items SET qty_returned = qty_returned + ? WHERE id = ?', [qty, item.id]);
        await t.run('INSERT INTO returns (item_id, qty, officer_id, at) VALUES (?,?,?,?)', [item.id, qty, req.user.id, nowIso()]);
      }
      return { ok: true };
    });
  }));

  // ---------- Cancel (requester and warehouse) ----------
  app.post('/api/requests/:id/cancel', allow('requester', 'warehouse'), wrap(async (req) => {
    const id = Number(req.params.id);
    const reason = str(req.body.reason, 1000);
    if (req.user.role === 'warehouse' && !reason) throw bad('กรุณาระบุเหตุผลที่ยกเลิกยอดค้าง');
    return db.tx(async (t) => {
      const r = await one(t, 'SELECT * FROM requests WHERE id = ? FOR UPDATE', [id]);
      if (!r || (req.user.role === 'requester' && r.requester_id !== req.user.id)) throw new HttpError(404, 'ไม่พบคำขอ');
      if (r.status === 'pending') {
        if (req.user.role !== 'requester') throw bad('คลังยกเลิกได้เฉพาะคำขอที่อนุมัติแล้ว');
        const changed = await t.run(`UPDATE requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'`, [id]);
        if (changed !== 1) throw new HttpError(409, 'คำขอนี้ถูกตัดสินไปแล้ว ไม่สามารถยกเลิกได้');
        await t.run('INSERT INTO cancellations (request_id, item_id, qty, user_id, reason, at) VALUES (?,?,?,?,?,?)',
          [id, null, 0, req.user.id, reason || null, nowIso()]);
        return { status: 'cancelled' };
      }
      if (!['approved', 'partial'].includes(r.status)) throw bad('คำขอนี้ไม่สามารถยกเลิกได้');
      for (const it of await loadItems(t, id)) {
        const left = it.qty_requested - it.qty_dispensed - it.qty_cancelled;
        if (left <= 0) continue;
        await t.run('UPDATE request_items SET qty_cancelled = qty_cancelled + ? WHERE id = ?', [left, it.id]);
        await t.run('INSERT INTO cancellations (request_id, item_id, qty, user_id, reason, at) VALUES (?,?,?,?,?,?)',
          [id, it.id, left, req.user.id, reason || null, nowIso()]);
      }
      const status = await recomputeStatus(t, id);
      if (req.user.role === 'warehouse')
        await notify(t, r.requester_id, `คลังยกเลิกยอดค้างของคำขอ #${id}: ${reason}`, id);
      return { status };
    });
  }));

  // ---------- Excel export ----------
  app.get('/api/export', allow('approver', 'admin'), async (req, res) => {
    try {
      const params = [];
      let where = '1=1';
      if (req.query.status) { where = 'r.status = ?'; params.push(String(req.query.status)); }
      const requests = await decorateAll(db, await db.q(`${REQ_SELECT} WHERE ${where} ORDER BY r.id DESC`, params));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('คำขอเบิก');
      ws.columns = [
        ['เลขที่คำขอ', 10], ['วันที่ยื่น', 18], ['ผู้ขอ', 22], ['แผนก', 16], ['ประเภท', 10], ['กำหนดคืน', 12],
        ['วัตถุประสงค์', 14], ['ลูกค้า/งาน', 24], ['วันที่ต้องการรับของ', 16], ['หมายเหตุ', 24], ['สถานะ', 14],
        ['ผู้ตัดสิน', 20], ['ผลตัดสิน', 12], ['เหตุผลที่ไม่อนุมัติ', 28], ['รหัสสินค้า', 14], ['สินค้า', 26], ['หน่วย', 8],
        ['จำนวนที่ขอ', 11], ['จ่ายแล้ว', 10], ['รับคืนแล้ว', 11], ['ยกเลิก', 9],
      ].map(([header, width]) => ({ header, width }));
      ws.getRow(1).font = { bold: true };
      for (const r of requests) {
        const base = [
          r.id, new Date(new Date(r.created_at).getTime() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
          r.requester_name, r.requester_department, r.type === 'loan' ? 'ยืม' : 'ให้ถาวร', r.due_date || '',
          r.purpose === 'trial' ? 'ลูกค้าทดลอง' : 'งานการตลาด', r.customer, r.need_date, r.note, r.status_th,
          r.decision?.approver_name || '',
          r.decision ? (r.decision.result === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ') : '', r.decision?.reason || '',
        ];
        for (const i of r.items)
          ws.addRow([...base, i.code, i.name, i.unit, i.qty_requested, i.qty_dispensed, i.qty_returned, i.qty_cancelled]);
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="requests-${todayBkk()}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: 'ส่งออกไม่สำเร็จ' });
    }
  });

  // ---------- static + errors ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  });

  app.locals.db = db;
  app.locals.checkOverdue = checkOverdue;
  return app;
}

module.exports = { createApp };
