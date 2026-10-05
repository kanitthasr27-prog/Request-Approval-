const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const { openDb, tx, hashPassword, verifyPassword } = require('./db');

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

function createApp(dbFile) {
  const db = openDb(dbFile);
  const q = (sql) => db.prepare(sql);
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // ---------- helpers ----------
  const notify = (userId, message, requestId) =>
    q('INSERT INTO notifications (user_id, message, request_id, at) VALUES (?,?,?,?)')
      .run(userId, message, requestId ?? null, nowIso());

  const idsByRole = (role) =>
    q('SELECT id FROM users WHERE role = ? AND active = 1').all(role).map((r) => r.id);

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
    }
  };

  // authenticate every /api request except login
  function auth(req, res, next) {
    const token = parseCookies(req).sid;
    const row = token && q(
      `SELECT u.id, u.username, u.full_name, u.department, u.role, u.active, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (!row || !row.active) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    req.user = row;
    req.token = token;
    next();
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
  function loadItems(requestId) {
    return q(`SELECT i.id, i.product_id, p.code, p.name, p.unit, i.qty_requested, i.qty_dispensed,
                     i.qty_returned, i.qty_cancelled
              FROM request_items i JOIN products p ON p.id = i.product_id
              WHERE i.request_id = ? ORDER BY i.id`).all(requestId);
  }

  function decorate(r) {
    const items = loadItems(r.id);
    const decision = q(`SELECT d.result, d.reason, d.decided_at, d.approver_id, u.full_name AS approver_name
                        FROM decisions d JOIN users u ON u.id = d.approver_id WHERE d.request_id = ?`).get(r.id) || null;
    const outstanding = items.reduce((s, i) => s + (i.qty_requested - i.qty_dispensed - i.qty_cancelled), 0);
    const unreturned = r.type === 'loan' ? items.reduce((s, i) => s + (i.qty_dispensed - i.qty_returned), 0) : 0;
    return {
      ...r, status_th: STATUS_TH[r.status], items, decision, outstanding, unreturned,
      overdue: r.type === 'loan' && unreturned > 0 && !!r.due_date && r.due_date < todayBkk(),
    };
  }

  const REQ_SELECT = `SELECT r.*, u.full_name AS requester_name, u.department AS requester_department
                      FROM requests r JOIN users u ON u.id = r.requester_id`;

  const getRequest = (id) => {
    const r = q(`${REQ_SELECT} WHERE r.id = ?`).get(id);
    return r ? decorate(r) : null;
  };

  function canView(user, r) {
    if (user.role === 'requester') return r.requester_id === user.id;
    return ['approver', 'admin', 'warehouse'].includes(user.role);
  }

  // Recomputes status after dispense/cancel (D7/D8).
  function recomputeStatus(requestId) {
    const items = loadItems(requestId);
    const dispensed = items.reduce((s, i) => s + i.qty_dispensed, 0);
    const outstanding = items.reduce((s, i) => s + (i.qty_requested - i.qty_dispensed - i.qty_cancelled), 0);
    let status;
    if (outstanding === 0) status = dispensed === 0 ? 'cancelled' : 'completed';
    else status = dispensed === 0 ? 'approved' : 'partial';
    q('UPDATE requests SET status = ? WHERE id = ?').run(status, requestId);
    return status;
  }

  // Loan overdue notifications, once per request (D12).
  function checkOverdue() {
    const rows = q(`SELECT r.id, r.requester_id, r.due_date FROM requests r
                    WHERE r.type = 'loan' AND r.overdue_notified = 0 AND r.due_date < ?
                      AND (SELECT COALESCE(SUM(qty_dispensed - qty_returned),0) FROM request_items WHERE request_id = r.id) > 0`)
      .all(todayBkk());
    for (const r of rows) {
      tx(db, () => {
        q('UPDATE requests SET overdue_notified = 1 WHERE id = ?').run(r.id);
        notify(r.requester_id, `ของยืมในคำขอ #${r.id} เลยกำหนดคืน (${r.due_date}) แล้ว`, r.id);
      });
    }
    return rows.length;
  }

  // ---------- auth routes ----------
  app.post('/api/login', wrap((req, res) => {
    const username = str(req.body.username, 100);
    const u = q('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || !u.active || !verifyPassword(String(req.body.password ?? ''), u.password_hash))
      throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)').run(token, u.id, nowIso());
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return { user: publicUser(u) };
  }));

  app.use('/api', auth);

  app.post('/api/logout', wrap((req, res) => {
    q('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }));

  app.get('/api/me', wrap((req) => ({ user: publicUser(req.user) })));

  app.post('/api/change-password', wrap((req) => {
    const u = q('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.current_password ?? ''), u.password_hash))
      throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    const np = String(req.body.new_password ?? '');
    if (np.length < MIN_PW) throw bad(`รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
    if (np === String(req.body.current_password)) throw bad('รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม');
    q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(np), u.id);
    return { ok: true };
  }));

  // ---------- notifications (all roles) ----------
  app.get('/api/notifications', wrap((req) => {
    if (req.user.role === 'requester') checkOverdue();
    const items = q('SELECT id, message, request_id, is_read, at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100')
      .all(req.user.id);
    return { items, unread: items.filter((n) => !n.is_read).length };
  }));
  app.post('/api/notifications/:id/read', wrap((req) => {
    q('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    return { ok: true };
  }));
  app.post('/api/notifications/read-all', wrap((req) => {
    q('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
    return { ok: true };
  }));

  // ---------- HR: accounts ----------
  const hr = allow('hr');
  app.get('/api/users', hr, wrap(() => ({
    users: q('SELECT id, username, full_name, department, role, active, must_change_password FROM users ORDER BY id').all(),
  })));

  app.post('/api/users', hr, wrap((req) => {
    const b = req.body;
    const username = str(b.username, 50), full_name = str(b.full_name, 100);
    if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) throw bad('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ยาว 3-50 ตัว');
    if (!full_name) throw bad('กรุณากรอกชื่อ-นามสกุล');
    if (!ROLES.includes(b.role)) throw bad('บทบาทไม่ถูกต้อง');
    const pw = String(b.password ?? '');
    if (pw.length < MIN_PW) throw bad(`รหัสผ่านชั่วคราวต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('ชื่อผู้ใช้นี้มีอยู่แล้ว');
    const r = q('INSERT INTO users (username, password_hash, full_name, department, role, must_change_password) VALUES (?,?,?,?,?,1)')
      .run(username, hashPassword(pw), full_name, str(b.department, 100), b.role);
    return { id: Number(r.lastInsertRowid) };
  }));

  app.post('/api/users/:id/reset-password', hr, wrap((req) => {
    const pw = String(req.body.password ?? '');
    if (pw.length < MIN_PW) throw bad(`รหัสผ่านชั่วคราวต้องยาวอย่างน้อย ${MIN_PW} ตัวอักษร`);
    const id = Number(req.params.id);
    if (!q('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'ไม่พบผู้ใช้');
    q('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(pw), id);
    q('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  }));

  app.post('/api/users/:id/active', hr, wrap((req) => {
    const id = Number(req.params.id);
    const active = req.body.active ? 1 : 0;
    if (id === req.user.id && !active) throw bad('ไม่สามารถปิดบัญชีของตัวเองได้');
    if (!q('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'ไม่พบผู้ใช้');
    q('UPDATE users SET active = ? WHERE id = ?').run(active, id);
    if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  }));

  // ---------- Admin: products & approver links ----------
  app.get('/api/products', wrap((req) => {
    const all = req.user.role === 'admin';
    return { products: q(`SELECT id, code, name, unit, active FROM products ${all ? '' : 'WHERE active = 1'} ORDER BY code`).all() };
  }));

  const admin = allow('admin');
  app.post('/api/products', admin, wrap((req) => {
    const code = str(req.body.code, 50), name = str(req.body.name, 200), unit = str(req.body.unit, 30);
    if (!code || !name || !unit) throw bad('กรุณากรอกรหัส ชื่อ และหน่วย');
    if (q('SELECT 1 FROM products WHERE code = ?').get(code)) throw bad('รหัสสินค้านี้มีอยู่แล้ว');
    const r = q('INSERT INTO products (code, name, unit) VALUES (?,?,?)').run(code, name, unit);
    return { id: Number(r.lastInsertRowid) };
  }));

  app.put('/api/products/:id', admin, wrap((req) => {
    const id = Number(req.params.id);
    const p = q('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'ไม่พบสินค้า');
    const code = str(req.body.code ?? p.code, 50), name = str(req.body.name ?? p.name, 200), unit = str(req.body.unit ?? p.unit, 30);
    if (!code || !name || !unit) throw bad('กรุณากรอกรหัส ชื่อ และหน่วย');
    if (q('SELECT 1 FROM products WHERE code = ? AND id <> ?').get(code, id)) throw bad('รหัสสินค้านี้มีอยู่แล้ว');
    const active = req.body.active === undefined ? p.active : (req.body.active ? 1 : 0);
    q('UPDATE products SET code = ?, name = ?, unit = ?, active = ? WHERE id = ?').run(code, name, unit, active, id);
    return { ok: true };
  }));

  app.get('/api/approver-links', admin, wrap(() => ({
    requesters: q(`SELECT id, full_name, department FROM users WHERE role = 'requester' AND active = 1 ORDER BY full_name`).all()
      .map((r) => ({ ...r, approver_ids: q('SELECT approver_id FROM approver_links WHERE requester_id = ?').all(r.id).map((x) => x.approver_id) })),
    approvers: q(`SELECT id, full_name FROM users WHERE role = 'approver' AND active = 1 ORDER BY full_name`).all(),
  })));

  app.put('/api/approver-links/:requesterId', admin, wrap((req) => {
    const rid = Number(req.params.requesterId);
    if (!q(`SELECT 1 FROM users WHERE id = ? AND role = 'requester'`).get(rid)) throw new HttpError(404, 'ไม่พบผู้ขอ');
    const ids = Array.isArray(req.body.approver_ids) ? [...new Set(req.body.approver_ids.map(Number))] : [];
    for (const a of ids)
      if (!q(`SELECT 1 FROM users WHERE id = ? AND role = 'approver' AND active = 1`).get(a)) throw bad('ผู้อนุมัติไม่ถูกต้อง');
    tx(db, () => {
      q('DELETE FROM approver_links WHERE requester_id = ?').run(rid);
      for (const a of ids) q('INSERT INTO approver_links (requester_id, approver_id) VALUES (?,?)').run(rid, a);
    });
    return { ok: true };
  }));

  // ---------- Requester: create / list ----------
  const requester = allow('requester');

  app.post('/api/requests', requester, wrap((req) => {
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
      if (!q('SELECT 1 FROM products WHERE id = ? AND active = 1').get(it.product_id)) throw bad('มีสินค้าที่ไม่พร้อมให้เบิก');
    }
    const approvers = q(`SELECT l.approver_id FROM approver_links l JOIN users u ON u.id = l.approver_id
                         WHERE l.requester_id = ? AND u.active = 1`).all(req.user.id).map((r) => r.approver_id);
    if (approvers.length === 0) throw bad('ยังไม่ได้กำหนดผู้อนุมัติให้คุณ กรุณาติดต่อผู้ดูแลระบบ');

    return tx(db, () => {
      const r = q(`INSERT INTO requests (requester_id, type, due_date, purpose, customer, need_date, note, status, created_at)
                   VALUES (?,?,?,?,?,?,?,'pending',?)`)
        .run(req.user.id, b.type, due, b.purpose, customer, b.need_date, str(b.note, 1000), nowIso());
      const id = Number(r.lastInsertRowid);
      for (const it of b.items)
        q('INSERT INTO request_items (request_id, product_id, qty_requested) VALUES (?,?,?)').run(id, it.product_id, it.qty);
      for (const a of approvers) notify(a, `คำขอเบิกใหม่ #${id} จาก ${req.user.full_name} รอการตัดสิน`, id);
      return { id };
    });
  }));

  app.get('/api/my/requests', requester, wrap((req) => {
    checkOverdue();
    const rows = q(`${REQ_SELECT} WHERE r.requester_id = ? ORDER BY r.id DESC`).all(req.user.id).map(decorate);
    return { requests: rows, loans: rows.filter((r) => r.unreturned > 0) };
  }));

  // ---------- shared request list / detail ----------
  app.get('/api/requests', allow('approver', 'admin', 'warehouse'), wrap((req) => {
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
      where = `r.type = 'loan' AND (SELECT COALESCE(SUM(qty_dispensed - qty_returned),0) FROM request_items WHERE request_id = r.id) > 0`;
    } else {
      if (req.user.role === 'warehouse') throw new HttpError(403, 'ไม่มีสิทธิ์');
      if (req.query.status) { where = 'r.status = ?'; params = [String(req.query.status)]; }
    }
    return { requests: q(`${REQ_SELECT} WHERE ${where} ORDER BY r.id ${view === 'pending' || view === 'dispense' ? 'ASC' : 'DESC'}`).all(...params).map(decorate) };
  }));

  function history(requesterId, excludeId) {
    const d = new Date(); d.setMonth(d.getMonth() - 6);
    const since = d.toISOString();
    const rows = q(`${REQ_SELECT} WHERE r.requester_id = ? AND r.id <> ? AND r.created_at >= ? ORDER BY r.id DESC`)
      .all(requesterId, excludeId, since).map(decorate);
    const outstandingLoans = q(`${REQ_SELECT} WHERE r.requester_id = ? AND r.type = 'loan' ORDER BY r.id`).all(requesterId)
      .map(decorate).filter((r) => r.unreturned > 0);
    return {
      since,
      requests: rows,
      total_dispensed: rows.reduce((s, r) => s + r.items.reduce((t, i) => t + i.qty_dispensed, 0), 0),
      outstanding_loans: outstandingLoans,
    };
  }

  app.get('/api/requests/:id', wrap((req) => {
    if (req.user.must_change_password) throw new HttpError(403, 'ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน');
    const r = getRequest(Number(req.params.id));
    // same response for missing and forbidden: no leaking of other people's request ids
    if (!r || !canView(req.user, r)) throw new HttpError(404, 'ไม่พบคำขอ');
    const out = { request: r };
    if (req.user.role === 'approver') {
      out.can_decide = !!q('SELECT 1 FROM approver_links WHERE approver_id = ? AND requester_id = ?').get(req.user.id, r.requester_id);
      out.history = history(r.requester_id, r.id);
    }
    return out;
  }));

  // ---------- Approver: decide (race-safe) ----------
  app.post('/api/requests/:id/decide', allow('approver'), wrap((req) => {
    const id = Number(req.params.id);
    const result = req.body.result;
    if (!['approved', 'rejected'].includes(result)) throw bad('ผลการตัดสินไม่ถูกต้อง');
    const reason = str(req.body.reason, 1000);
    if (result === 'rejected' && !reason) throw bad('กรุณาระบุเหตุผลที่ไม่อนุมัติ');

    return tx(db, () => {
      const r = q('SELECT * FROM requests WHERE id = ?').get(id);
      if (!r) throw new HttpError(404, 'ไม่พบคำขอ');
      if (!q('SELECT 1 FROM approver_links WHERE approver_id = ? AND requester_id = ?').get(req.user.id, r.requester_id))
        throw new HttpError(403, 'คำขอนี้ไม่ได้ส่งถึงคุณ');
      // Only the first writer flips pending -> decided; a second sees 0 changed rows.
      const upd = q(`UPDATE requests SET status = ? WHERE id = ? AND status = 'pending'`)
        .run(result === 'approved' ? 'approved' : 'rejected', id);
      if (upd.changes !== 1) {
        const d = q(`SELECT d.result, u.full_name FROM decisions d JOIN users u ON u.id = d.approver_id WHERE d.request_id = ?`).get(id);
        throw new HttpError(409, d
          ? `คำขอนี้ถูก${d.result === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ'}โดย ${d.full_name} ไปแล้ว`
          : 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติแล้ว');
      }
      q('INSERT INTO decisions (request_id, approver_id, result, reason, decided_at) VALUES (?,?,?,?,?)')
        .run(id, req.user.id, result, result === 'rejected' ? reason : null, nowIso());
      if (result === 'approved') {
        notify(r.requester_id, `คำขอ #${id} ของคุณได้รับการอนุมัติโดย ${req.user.full_name}`, id);
        for (const w of idsByRole('warehouse')) notify(w, `คำขอ #${id} อนุมัติแล้ว รอจ่ายสินค้า`, id);
      } else {
        notify(r.requester_id, `คำขอ #${id} ไม่ได้รับอนุมัติ: ${reason}`, id);
      }
      return { ok: true };
    });
  }));

  // ---------- Warehouse: dispense / return ----------
  const warehouse = allow('warehouse');

  app.post('/api/requests/:id/dispense', warehouse, wrap((req) => {
    const id = Number(req.params.id);
    const lines = Array.isArray(req.body.lines) ? req.body.lines.filter((l) => l && Number(l.qty) !== 0) : [];
    if (lines.length === 0) throw bad('กรุณากรอกจำนวนที่จ่ายอย่างน้อย 1 รายการ');
    const note = str(req.body.note, 500);
    return tx(db, () => {
      const r = q('SELECT * FROM requests WHERE id = ?').get(id);
      if (!r || !['approved', 'partial'].includes(r.status)) throw bad('คำขอนี้ไม่อยู่ในสถานะรอจ่าย');
      for (const l of lines) {
        const qty = posInt(l.qty);
        if (!qty) throw bad('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
        const item = q('SELECT * FROM request_items WHERE id = ? AND request_id = ?').get(Number(l.item_id), id);
        if (!item) throw bad('ไม่พบรายการสินค้าในคำขอ');
        const left = item.qty_requested - item.qty_dispensed - item.qty_cancelled;
        if (qty > left) throw bad(`จำนวนจ่ายเกินยอดค้าง (ค้าง ${left})`);
        q('UPDATE request_items SET qty_dispensed = qty_dispensed + ? WHERE id = ?').run(qty, item.id);
        q('INSERT INTO dispenses (request_id, item_id, qty, officer_id, at, note) VALUES (?,?,?,?,?,?)')
          .run(id, item.id, qty, req.user.id, nowIso(), note);
      }
      const status = recomputeStatus(id);
      notify(r.requester_id,
        status === 'completed' ? `คำขอ #${id} จ่ายสินค้าครบแล้ว` : `คำขอ #${id} จ่ายสินค้าบางส่วนแล้ว ยังมียอดค้าง`, id);
      return { status };
    });
  }));

  app.post('/api/requests/:id/return', warehouse, wrap((req) => {
    const id = Number(req.params.id);
    const lines = Array.isArray(req.body.lines) ? req.body.lines.filter((l) => l && Number(l.qty) !== 0) : [];
    if (lines.length === 0) throw bad('กรุณากรอกจำนวนที่รับคืนอย่างน้อย 1 รายการ');
    return tx(db, () => {
      const r = q('SELECT * FROM requests WHERE id = ?').get(id);
      if (!r || r.type !== 'loan') throw bad('คำขอนี้ไม่ใช่แบบยืม');
      for (const l of lines) {
        const qty = posInt(l.qty);
        if (!qty) throw bad('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
        const item = q('SELECT * FROM request_items WHERE id = ? AND request_id = ?').get(Number(l.item_id), id);
        if (!item) throw bad('ไม่พบรายการสินค้าในคำขอ');
        const left = item.qty_dispensed - item.qty_returned;
        if (qty > left) throw bad(`จำนวนรับคืนเกินยอดที่ยังไม่คืน (เหลือ ${left})`);
        q('UPDATE request_items SET qty_returned = qty_returned + ? WHERE id = ?').run(qty, item.id);
        q('INSERT INTO returns (item_id, qty, officer_id, at) VALUES (?,?,?,?)').run(item.id, qty, req.user.id, nowIso());
      }
      return { ok: true };
    });
  }));

  // ---------- Cancel (requester and warehouse) ----------
  app.post('/api/requests/:id/cancel', allow('requester', 'warehouse'), wrap((req) => {
    const id = Number(req.params.id);
    const reason = str(req.body.reason, 1000);
    if (req.user.role === 'warehouse' && !reason) throw bad('กรุณาระบุเหตุผลที่ยกเลิกยอดค้าง');
    return tx(db, () => {
      const r = q('SELECT * FROM requests WHERE id = ?').get(id);
      if (!r || (req.user.role === 'requester' && r.requester_id !== req.user.id)) throw new HttpError(404, 'ไม่พบคำขอ');
      if (r.status === 'pending') {
        if (req.user.role !== 'requester') throw bad('คลังยกเลิกได้เฉพาะคำขอที่อนุมัติแล้ว');
        const upd = q(`UPDATE requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(id);
        if (upd.changes !== 1) throw new HttpError(409, 'คำขอนี้ถูกตัดสินไปแล้ว ไม่สามารถยกเลิกได้');
        q('INSERT INTO cancellations (request_id, item_id, qty, user_id, reason, at) VALUES (?,?,?,?,?,?)')
          .run(id, null, 0, req.user.id, reason || null, nowIso());
        return { status: 'cancelled' };
      }
      if (!['approved', 'partial'].includes(r.status)) throw bad('คำขอนี้ไม่สามารถยกเลิกได้');
      for (const it of loadItems(id)) {
        const left = it.qty_requested - it.qty_dispensed - it.qty_cancelled;
        if (left <= 0) continue;
        q('UPDATE request_items SET qty_cancelled = qty_cancelled + ? WHERE id = ?').run(left, it.id);
        q('INSERT INTO cancellations (request_id, item_id, qty, user_id, reason, at) VALUES (?,?,?,?,?,?)')
          .run(id, it.id, left, req.user.id, reason || null, nowIso());
      }
      const status = recomputeStatus(id);
      if (req.user.role === 'warehouse')
        notify(r.requester_id, `คลังยกเลิกยอดค้างของคำขอ #${id}: ${reason}`, id);
      return { status };
    });
  }));

  // ---------- Excel export ----------
  app.get('/api/export', allow('approver', 'admin'), async (req, res) => {
    try {
      const params = [];
      let where = '1=1';
      if (req.query.status) { where = 'r.status = ?'; params.push(String(req.query.status)); }
      const requests = q(`${REQ_SELECT} WHERE ${where} ORDER BY r.id DESC`).all(...params).map(decorate);
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
