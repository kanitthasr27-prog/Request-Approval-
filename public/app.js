'use strict';

const $app = document.getElementById('app');
let me = null;
let unread = 0;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = (iso) => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
const fmtD = (d) => (d ? new Date(d + 'T00:00:00+07:00').toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' }) : '-');
const todayStr = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const TYPE_TH = { give: 'ให้ถาวร', loan: 'ยืม' };
const PURPOSE_TH = { trial: 'ลูกค้าทดลอง', marketing: 'งานการตลาด' };
const ROLE_TH = { requester: 'ผู้ขอ', approver: 'ผู้อนุมัติ', warehouse: 'เจ้าหน้าที่คลัง', admin: 'ผู้ดูแลระบบ', hr: 'HR' };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { me = null; renderLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
}

const statusPill = (r) =>
  `<span class="pill ${r.status}">${esc(r.status_th)}</span>` + (r.overdue ? ' <span class="pill overdue">เลยกำหนดคืน</span>' : '');
const itemsText = (r) => r.items.map((i) => `${esc(i.name)} ×${i.qty_requested}`).join(', ');

function showError(box, msg) { box.innerHTML = msg ? `<div class="error">${esc(msg)}</div>` : ''; }

// ---------- login / change password ----------
function renderLogin() {
  $app.innerHTML = `
    <div class="login-wrap"><form class="login-card" id="f">
      <div class="brand">เบิกตัวอย่าง</div>
      <h1>ระบบเบิกสินค้าตัวอย่าง</h1>
      <div class="muted">กรอกบัญชีของคุณเพื่อเข้าสู่ระบบ</div>
      <label>ชื่อผู้ใช้</label><input name="username" autocomplete="username" required autofocus>
      <label>รหัสผ่าน</label><input name="password" type="password" autocomplete="current-password" required>
      <div id="err"></div>
      <button class="btn block">เข้าสู่ระบบ →</button>
    </form></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const d = await api('/login', { body: { username: f.get('username'), password: f.get('password') } });
      me = d.user;
      start();
    } catch (err) { showError(document.getElementById('err'), err.message); }
  };
}

function renderForceChange() {
  $app.innerHTML = `
    <div class="login-wrap"><form class="login-card" id="f">
      <h1>เปลี่ยนรหัสผ่าน</h1>
      <div class="info">ครั้งแรกที่เข้าใช้งาน (หรือหลังรีเซ็ต) ต้องตั้งรหัสผ่านใหม่ก่อน</div>
      <label>รหัสผ่านปัจจุบัน (ชั่วคราว)</label><input name="cur" type="password" required autocomplete="current-password">
      <label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)</label><input name="np" type="password" required minlength="8" autocomplete="new-password">
      <div id="err"></div>
      <button class="btn block">บันทึก</button>
      <button type="button" class="btn ghost block" id="out">ออกจากระบบ</button>
    </form></div>`;
  document.getElementById('out').onclick = logout;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/change-password', { body: { current_password: f.get('cur'), new_password: f.get('np') } });
      me.must_change_password = false;
      start();
    } catch (err) { showError(document.getElementById('err'), err.message); }
  };
}

async function logout() {
  try { await api('/logout', { method: 'POST', body: {} }); } catch {}
  me = null;
  renderLogin();
}

// ---------- shell & routing ----------
const NAV = {
  requester: [['my', '📋', 'คำขอของฉัน'], ['new', '➕', 'สร้างคำขอ'], ['notif', '🔔', 'แจ้งเตือน']],
  approver: [['pending', '⏳', 'รอตัดสิน'], ['all', '📋', 'คำขอทั้งหมด'], ['notif', '🔔', 'แจ้งเตือน']],
  warehouse: [['dispense', '📦', 'รอจ่าย'], ['loans', '↩️', 'รอรับคืน'], ['notif', '🔔', 'แจ้งเตือน']],
  admin: [['products', '🏷️', 'จัดการสินค้า'], ['links', '🔗', 'กำหนดผู้อนุมัติ'], ['all', '📋', 'คำขอทั้งหมด'], ['notif', '🔔', 'แจ้งเตือน']],
  hr: [['accounts', '👥', 'จัดการบัญชี'], ['notif', '🔔', 'แจ้งเตือน']],
};

function start() {
  if (me.must_change_password) return renderForceChange();
  if (!location.hash) location.hash = '#/' + NAV[me.role][0][0];
  route();
}

window.addEventListener('hashchange', () => { if (me && !me.must_change_password) route(); });

async function route() {
  const [, rawPage = '', arg] = (location.hash || '#/').split('/');
  const page = rawPage.split('?')[0];
  const nav = NAV[me.role];
  const current = nav.some((n) => n[0] === page) || page === 'request' ? page : nav[0][0];
  const navHtml = nav.map(([k, ico, label]) =>
    `<a class="nav-item ${k === current || (page === 'request' && k === nav[0][0]) ? 'active' : ''}" href="#/${k}">
       <span class="ico">${ico}</span>${label}${k === 'notif' ? `<span class="badge ${unread ? '' : 'hidden'}" id="nbadge">${unread}</span>` : ''}</a>`).join('');
  $app.innerHTML = `
    <div class="shell">
      <nav class="sidebar"><div class="brand">เบิกตัวอย่าง</div>${navHtml}<div class="spacer"></div>
        <button class="nav-item logout" id="logout"><span class="ico">🚪</span>ออกจากระบบ</button></nav>
      <main class="main">
        <div class="topbar"><div class="who">${esc(me.full_name)} · ${ROLE_TH[me.role]}</div>
          <div class="row"><button class="btn ghost small" id="pw">เปลี่ยนรหัสผ่าน</button><button class="btn ghost small" id="logout2">ออก</button></div></div>
        <div id="page"><div class="muted">กำลังโหลด...</div></div>
      </main>
    </div>`;
  document.getElementById('logout').onclick = logout;
  document.getElementById('logout2').onclick = logout;
  document.getElementById('pw').onclick = () => { me.must_change_password = true; renderForceChange(); };
  refreshUnread();
  const el = document.getElementById('page');
  try {
    const pages = { my: pgMy, new: pgNew, pending: pgPending, all: pgAll, dispense: pgDispense, loans: pgLoans, products: pgProducts, links: pgLinks, accounts: pgAccounts, notif: pgNotif, request: pgRequest };
    await pages[current](el, arg);
  } catch (e) { el.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

async function refreshUnread() {
  try {
    const d = await api('/notifications');
    unread = d.unread;
    const b = document.getElementById('nbadge');
    if (b) { b.textContent = unread; b.classList.toggle('hidden', !unread); }
  } catch {}
}
setInterval(() => { if (me && !me.must_change_password) refreshUnread(); }, 30000);

function requestRow(r, showWho) {
  return `<div class="list-item" data-id="${r.id}"><div>
    <b>#${r.id}</b> ${esc(r.customer)} <span class="muted">· ${TYPE_TH[r.type]}${showWho ? ' · ' + esc(r.requester_name) : ''}</span><br>
    <span class="muted">${itemsText(r)}</span><br><span class="muted">ยื่นเมื่อ ${fmtDT(r.created_at)}</span></div>
    <div>${statusPill(r)}</div></div>`;
}
function bindRows(el) {
  el.querySelectorAll('.list-item').forEach((n) => (n.onclick = () => (location.hash = '#/request/' + n.dataset.id)));
}

// ---------- requester ----------
async function pgMy(el) {
  const d = await api('/my/requests');
  el.innerHTML = `<h1>คำขอของฉัน</h1>
    ${d.loans.length ? `<div class="card"><h3>ของยืมที่ยังไม่คืน</h3>${d.loans.map((r) => `
      <div class="list-item" data-id="${r.id}"><div><b>#${r.id}</b> ${esc(r.customer)}<br><span class="muted">กำหนดคืน ${fmtD(r.due_date)} · ค้างคืน ${r.unreturned} ชิ้น</span></div>
      <div>${r.overdue ? '<span class="pill overdue">เลยกำหนดคืน</span>' : '<span class="pill">ยืมอยู่</span>'}</div></div>`).join('')}</div>` : ''}
    <div class="card"><h3>คำขอทั้งหมด</h3>${d.requests.length ? d.requests.map((r) => requestRow(r)).join('') : '<div class="muted">ยังไม่มีคำขอ</div>'}</div>`;
  bindRows(el);
}

async function pgNew(el) {
  const { products } = await api('/products');
  const opts = products.map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)} (${esc(p.unit)})</option>`).join('');
  el.innerHTML = `<h1>สร้างคำขอเบิก</h1><form class="card" id="f">
    <h3>รายการสินค้า</h3><div id="lines"></div>
    <button type="button" class="btn ghost small" id="add">+ เพิ่มสินค้า</button>
    <div class="grid2">
      <div><label>ประเภท</label><select name="type"><option value="give">ให้ถาวร</option><option value="loan">ยืม</option></select></div>
      <div id="dueBox" class="hidden"><label>กำหนดคืน</label><input type="date" name="due_date" min="${todayStr()}"></div>
      <div><label>วัตถุประสงค์</label><select name="purpose"><option value="trial">ลูกค้าทดลอง</option><option value="marketing">งานการตลาด</option></select></div>
      <div><label>ชื่อลูกค้า / ชื่องาน</label><input name="customer" required maxlength="200"></div>
      <div><label>วันที่ต้องการรับของ</label><input type="date" name="need_date" required min="${todayStr()}"></div>
    </div>
    <label>หมายเหตุ</label><textarea name="note" maxlength="1000"></textarea>
    <div id="err"></div><button class="btn block">ส่งคำขอ</button></form>`;
  const lines = document.getElementById('lines');
  const addLine = () => {
    const d = document.createElement('div');
    d.className = 'row'; d.style.marginBottom = '8px';
    d.innerHTML = `<select style="flex:1;min-width:200px">${opts}</select><input type="number" min="1" step="1" value="1" class="qty-input"><button type="button" class="btn ghost small">ลบ</button>`;
    d.querySelector('button').onclick = () => { if (lines.children.length > 1) d.remove(); };
    lines.appendChild(d);
  };
  addLine();
  document.getElementById('add').onclick = addLine;
  const f = document.getElementById('f');
  f.type.onchange = () => {
    document.getElementById('dueBox').classList.toggle('hidden', f.type.value !== 'loan');
    f.due_date.required = f.type.value === 'loan';
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const items = [...lines.children].map((d) => ({ product_id: Number(d.querySelector('select').value), qty: Number(d.querySelector('input').value) }));
    try {
      const r = await api('/requests', { body: { items, type: f.type.value, due_date: f.due_date.value || null, purpose: f.purpose.value,
        customer: f.customer.value, need_date: f.need_date.value, note: f.note.value } });
      location.hash = '#/request/' + r.id;
    } catch (err) { showError(document.getElementById('err'), err.message); }
  };
}

// ---------- request detail (all roles that may view) ----------
async function pgRequest(el, id) {
  const d = await api('/requests/' + id);
  const r = d.request;
  const dec = r.decision;
  const itemsTbl = `<div class="table-wrap"><table><tr><th>สินค้า</th><th>ขอ</th><th>จ่ายแล้ว</th><th>ค้าง</th>${r.type === 'loan' ? '<th>คืนแล้ว</th>' : ''}<th>ยกเลิก</th></tr>
    ${r.items.map((i) => `<tr><td>${esc(i.code)} ${esc(i.name)}</td><td>${i.qty_requested} ${esc(i.unit)}</td><td>${i.qty_dispensed}</td>
      <td>${i.qty_requested - i.qty_dispensed - i.qty_cancelled}</td>${r.type === 'loan' ? `<td>${i.qty_returned}</td>` : ''}<td>${i.qty_cancelled}</td></tr>`).join('')}</table></div>`;
  el.innerHTML = `<h1>คำขอ #${r.id} ${statusPill(r)}</h1>
    <div class="card"><dl class="kv">
      <dt>ผู้ขอ</dt><dd>${esc(r.requester_name)} (${esc(r.requester_department)})</dd>
      <dt>ประเภท</dt><dd>${TYPE_TH[r.type]}${r.type === 'loan' ? ' · กำหนดคืน ' + fmtD(r.due_date) : ''}</dd>
      <dt>วัตถุประสงค์</dt><dd>${PURPOSE_TH[r.purpose]}</dd>
      <dt>ลูกค้า / งาน</dt><dd>${esc(r.customer)}</dd>
      <dt>วันที่ต้องการรับของ</dt><dd>${fmtD(r.need_date)}</dd>
      <dt>หมายเหตุ</dt><dd>${esc(r.note) || '-'}</dd>
      <dt>ยื่นเมื่อ</dt><dd>${fmtDT(r.created_at)}</dd>
      ${dec ? `<dt>ผลการตัดสิน</dt><dd><b>${dec.result === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ'}</b> โดย ${esc(dec.approver_name)} · ${fmtDT(dec.decided_at)}${dec.reason ? `<br>เหตุผล: ${esc(dec.reason)}` : ''}</dd>` : ''}
    </dl></div>
    <div class="card"><h3>รายการสินค้า</h3>${itemsTbl}</div>
    <div id="actions"></div><div id="err"></div>`;
  const act = document.getElementById('actions');
  const err = document.getElementById('err');
  const run = async (fn) => { try { await fn(); route(); } catch (e) { showError(err, e.message); } };

  // requester cancel
  if (me.role === 'requester' && (r.status === 'pending' || (['approved', 'partial'].includes(r.status) && r.outstanding > 0))) {
    act.innerHTML = `<button class="btn danger" id="cancel">${r.status === 'pending' ? 'ยกเลิกคำขอ' : 'ยกเลิกยอดค้าง'}</button>`;
    document.getElementById('cancel').onclick = () => confirm('ยืนยันการยกเลิก?') && run(() => api(`/requests/${r.id}/cancel`, { body: {} }));
  }

  // approver decision
  if (me.role === 'approver') {
    if (r.status === 'pending' && d.can_decide) {
      act.innerHTML = `<div class="card"><h3>ตัดสินคำขอ</h3>
        <label>เหตุผล (บังคับเมื่อไม่อนุมัติ)</label><textarea id="reason"></textarea>
        <div class="row" style="margin-top:12px"><button class="btn ok" id="ap">อนุมัติ</button><button class="btn danger" id="rj">ไม่อนุมัติ</button></div></div>`;
      const decide = (result) => run(() => api(`/requests/${r.id}/decide`, { body: { result, reason: document.getElementById('reason').value } }));
      document.getElementById('ap').onclick = () => decide('approved');
      document.getElementById('rj').onclick = () => decide('rejected');
    } else if (r.status === 'pending') {
      act.innerHTML = `<div class="info">คำขอนี้ไม่ได้ส่งถึงคุณ</div>`;
    } else if (dec) {
      act.innerHTML = `<div class="card"><h3>ตัดสินคำขอ</h3>
        <div class="info">${dec.result === 'approved' ? 'อนุมัติ' : 'ไม่อนุมัติ'}แล้วโดย ${esc(dec.approver_name)}</div>
        <div class="row"><button class="btn" disabled>อนุมัติ</button><button class="btn" disabled>ไม่อนุมัติ</button></div></div>`;
    }
    const h = d.history;
    act.insertAdjacentHTML('afterend', `<div class="card"><h3>ประวัติการเบิกของ ${esc(r.requester_name)} (6 เดือนล่าสุด)</h3>
      <p>จำนวนชิ้นรวมที่จ่ายจริง: <b>${h.total_dispensed}</b> ชิ้น</p>
      ${h.outstanding_loans.length ? `<h3>ของยืมที่ยังไม่คืน</h3><ul>${h.outstanding_loans.map((l) =>
        `<li>#${l.id} ${itemsText(l)} — ค้างคืน ${l.unreturned} ชิ้น · กำหนดคืน ${fmtD(l.due_date)} ${l.overdue ? '<span class="pill overdue">เลยกำหนด</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">ไม่มีของยืมค้างคืน</p>'}
      <div class="table-wrap"><table><tr><th>วันที่</th><th>รายการ</th><th>ประเภท</th><th>ผล</th></tr>
      ${h.requests.length ? h.requests.map((x) => `<tr><td>${fmtD(x.created_at.slice(0, 10))}</td><td>${itemsText(x)}</td><td>${TYPE_TH[x.type]}</td><td>${statusPill(x)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">ไม่มีประวัติ</td></tr>'}
      </table></div></div>`);
  }

  // warehouse
  if (me.role === 'warehouse') {
    if (['approved', 'partial'].includes(r.status)) {
      act.innerHTML = `<div class="card"><h3>บันทึกการจ่ายสินค้า</h3>
        ${r.items.map((i) => { const left = i.qty_requested - i.qty_dispensed - i.qty_cancelled;
          return `<div class="row" style="margin-bottom:8px"><div style="flex:1">${esc(i.name)} <span class="muted">(ค้างจ่าย ${left})</span></div>
          <input type="number" class="qty-input dq" data-item="${i.id}" min="0" max="${left}" value="0" ${left ? '' : 'disabled'}></div>`; }).join('')}
        <label>หมายเหตุ</label><input id="dnote" maxlength="500">
        <div class="row" style="margin-top:12px"><button class="btn" id="dsp">บันทึกการจ่าย</button></div>
        <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <label>ยกเลิกยอดค้าง (ต้องใส่เหตุผล)</label><input id="creason" maxlength="1000" placeholder="เหตุผล">
        <button class="btn danger small" id="cnl" style="margin-top:10px">ยกเลิกยอดค้างทั้งหมด</button></div>`;
      document.getElementById('dsp').onclick = () => run(() => api(`/requests/${r.id}/dispense`, { body: {
        note: document.getElementById('dnote').value,
        lines: [...document.querySelectorAll('.dq')].map((x) => ({ item_id: Number(x.dataset.item), qty: Number(x.value) })) } }));
      document.getElementById('cnl').onclick = () => confirm('ยืนยันยกเลิกยอดค้าง?') &&
        run(() => api(`/requests/${r.id}/cancel`, { body: { reason: document.getElementById('creason').value } }));
    }
    if (r.type === 'loan' && r.unreturned > 0) {
      act.insertAdjacentHTML('beforeend', `<div class="card"><h3>รับคืนสินค้า</h3>
        ${r.items.filter((i) => i.qty_dispensed - i.qty_returned > 0).map((i) => `<div class="row" style="margin-bottom:8px"><div style="flex:1">${esc(i.name)} <span class="muted">(ค้างคืน ${i.qty_dispensed - i.qty_returned})</span></div>
          <input type="number" class="qty-input rq" data-item="${i.id}" min="0" max="${i.qty_dispensed - i.qty_returned}" value="0"></div>`).join('')}
        <button class="btn" id="rtn">บันทึกรับคืน</button></div>`);
      document.getElementById('rtn').onclick = () => run(() => api(`/requests/${r.id}/return`, { body: {
        lines: [...document.querySelectorAll('.rq')].map((x) => ({ item_id: Number(x.dataset.item), qty: Number(x.value) })) } }));
    }
  }
}

// ---------- approver / admin lists ----------
async function pgPending(el) {
  const d = await api('/requests?view=pending');
  el.innerHTML = `<h1>รอตัดสิน</h1><div class="card">${d.requests.length ? d.requests.map((r) => requestRow(r, true)).join('') : '<div class="muted">ไม่มีคำขอที่รอตัดสิน</div>'}</div>`;
  bindRows(el);
}

async function pgAll(el) {
  const status = (location.hash.split('?')[1] || '').replace('s=', '');
  const d = await api('/requests' + (status ? '?status=' + encodeURIComponent(status) : ''));
  const opts = ['', 'pending', 'approved', 'partial', 'completed', 'rejected', 'cancelled'];
  const th = { '': 'ทุกสถานะ', pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', partial: 'จ่ายบางส่วน', completed: 'จ่ายครบ', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' };
  el.innerHTML = `<h1>คำขอทั้งหมด</h1><div class="card"><div class="row" style="margin-bottom:10px">
    <select id="st" style="max-width:200px">${opts.map((o) => `<option value="${o}" ${o === status ? 'selected' : ''}>${th[o]}</option>`).join('')}</select>
    <button class="btn" id="xl">ส่งออก Excel</button></div>
    ${d.requests.length ? d.requests.map((r) => requestRow(r, true)).join('') : '<div class="muted">ไม่มีคำขอ</div>'}</div>`;
  document.getElementById('st').onchange = (e) => { location.hash = '#/all' + (e.target.value ? '?s=' + e.target.value : ''); };
  document.getElementById('xl').onclick = () => { location.href = '/api/export' + (status ? '?status=' + encodeURIComponent(status) : ''); };
  bindRows(el);
}

// ---------- warehouse ----------
async function pgDispense(el) {
  const d = await api('/requests?view=dispense');
  el.innerHTML = `<h1>รอจ่าย</h1><div class="card">${d.requests.length ? d.requests.map((r) => requestRow(r, true)).join('') : '<div class="muted">ไม่มีคำขอรอจ่าย</div>'}</div>`;
  bindRows(el);
}
async function pgLoans(el) {
  const d = await api('/requests?view=loans');
  el.innerHTML = `<h1>รอรับคืน</h1><div class="card">${d.requests.length ? d.requests.map((r) => `<div class="list-item" data-id="${r.id}"><div>
    <b>#${r.id}</b> ${esc(r.customer)} <span class="muted">· ${esc(r.requester_name)}</span><br>
    <span class="muted">กำหนดคืน ${fmtD(r.due_date)} · ค้างคืน ${r.unreturned} ชิ้น</span></div>
    <div>${r.overdue ? '<span class="pill overdue">เลยกำหนดคืน</span>' : ''}</div></div>`).join('') : '<div class="muted">ไม่มีของยืมค้างคืน</div>'}</div>`;
  bindRows(el);
}

// ---------- notifications ----------
async function pgNotif(el) {
  const d = await api('/notifications');
  el.innerHTML = `<div class="topbar"><h1>แจ้งเตือน</h1><button class="btn ghost small" id="ra">อ่านทั้งหมด</button></div>
    <div class="card">${d.items.length ? d.items.map((n) => `<div class="notif ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-req="${n.request_id || ''}">
      ${esc(n.message)}<br><span class="muted">${fmtDT(n.at)}</span></div>`).join('') : '<div class="muted">ไม่มีการแจ้งเตือน</div>'}</div>`;
  document.getElementById('ra').onclick = async () => { await api('/notifications/read-all', { body: {} }); route(); };
  el.querySelectorAll('.notif').forEach((n) => (n.onclick = async () => {
    await api(`/notifications/${n.dataset.id}/read`, { body: {} });
    if (n.dataset.req) location.hash = '#/request/' + n.dataset.req; else route();
  }));
}

// ---------- admin ----------
async function pgProducts(el) {
  const { products } = await api('/products');
  el.innerHTML = `<h1>จัดการสินค้า</h1>
    <form class="card" id="f"><h3>เพิ่มสินค้า</h3><div class="grid2">
      <div><label>รหัส</label><input name="code" required></div><div><label>ชื่อ</label><input name="name" required></div>
      <div><label>หน่วย</label><input name="unit" required placeholder="ชิ้น / กล่อง"></div></div>
      <div id="err"></div><button class="btn" style="margin-top:12px">เพิ่ม</button></form>
    <div class="card"><div class="table-wrap"><table><tr><th>รหัส</th><th>ชื่อ</th><th>หน่วย</th><th>สถานะ</th><th></th></tr>
    ${products.map((p) => `<tr><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.unit)}</td>
      <td>${p.active ? 'ใช้งาน' : '<span class="muted">ปิดใช้งาน</span>'}</td>
      <td><button class="btn ghost small" data-edit="${p.id}">แก้ไข</button> <button class="btn ghost small" data-toggle="${p.id}">${p.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button></td></tr>`).join('')}
    </table></div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api('/products', { body: { code: f.code.value, name: f.name.value, unit: f.unit.value } }); route(); }
    catch (er) { showError(document.getElementById('err'), er.message); }
  };
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  el.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    const p = byId[b.dataset.toggle];
    await api('/products/' + p.id, { method: 'PUT', body: { active: !p.active } }); route();
  }));
  el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
    const p = byId[b.dataset.edit];
    const name = prompt('ชื่อสินค้า', p.name); if (name === null) return;
    const code = prompt('รหัส', p.code); if (code === null) return;
    const unit = prompt('หน่วย', p.unit); if (unit === null) return;
    try { await api('/products/' + p.id, { method: 'PUT', body: { name, code, unit } }); route(); } catch (er) { alert(er.message); }
  }));
}

async function pgLinks(el) {
  const d = await api('/approver-links');
  el.innerHTML = `<h1>กำหนดผู้อนุมัติ</h1><div class="info">คำขอใหม่จะส่งถึงผู้อนุมัติที่เลือกไว้ (คนใดคนหนึ่งตัดสินได้)</div>
    <div class="card">${d.requesters.length ? d.requesters.map((r) => `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
      <b>${esc(r.full_name)}</b> <span class="muted">${esc(r.department)}</span>
      <div class="row" style="margin-top:6px">${d.approvers.map((a) => `<label style="margin:0;font-weight:400"><input type="checkbox" style="width:auto" data-r="${r.id}" data-a="${a.id}" ${r.approver_ids.includes(a.id) ? 'checked' : ''}> ${esc(a.full_name)}</label>`).join('') || '<span class="muted">ยังไม่มีผู้อนุมัติในระบบ</span>'}</div></div>`).join('') : '<div class="muted">ยังไม่มีผู้ขอ</div>'}</div><div id="err"></div>`;
  el.querySelectorAll('input[type=checkbox]').forEach((c) => (c.onchange = async () => {
    const rid = c.dataset.r;
    const ids = [...el.querySelectorAll(`input[data-r="${rid}"]:checked`)].map((x) => Number(x.dataset.a));
    try { await api('/approver-links/' + rid, { method: 'PUT', body: { approver_ids: ids } }); showError(document.getElementById('err'), ''); }
    catch (er) { showError(document.getElementById('err'), er.message); }
  }));
}

// ---------- HR ----------
async function pgAccounts(el) {
  const { users } = await api('/users');
  el.innerHTML = `<h1>จัดการบัญชี</h1>
    <form class="card" id="f"><h3>สร้างบัญชี</h3><div class="grid2">
      <div><label>ชื่อผู้ใช้</label><input name="username" required></div><div><label>ชื่อ-นามสกุล</label><input name="full_name" required></div>
      <div><label>แผนก</label><input name="department"></div>
      <div><label>บทบาท</label><select name="role">${Object.entries(ROLE_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div><label>รหัสผ่านชั่วคราว (อย่างน้อย 8 ตัว)</label><input name="password" required minlength="8"></div></div>
      <div id="err"></div><button class="btn" style="margin-top:12px">สร้างบัญชี</button></form>
    <div class="card"><div class="table-wrap"><table><tr><th>ชื่อผู้ใช้</th><th>ชื่อ</th><th>แผนก</th><th>บทบาท</th><th>สถานะ</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.department)}</td><td>${ROLE_TH[u.role]}</td>
      <td>${u.active ? 'ใช้งาน' : '<span class="muted">ปิดแล้ว</span>'}${u.must_change_password ? ' <span class="pill">รอเปลี่ยนรหัส</span>' : ''}</td>
      <td><button class="btn ghost small" data-reset="${u.id}">รีเซ็ตรหัส</button> <button class="btn ghost small" data-act="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? 'ปิดบัญชี' : 'เปิดบัญชี'}</button></td></tr>`).join('')}
    </table></div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/users', { body: { username: f.username.value, full_name: f.full_name.value, department: f.department.value, role: f.role.value, password: f.password.value } });
      route();
    } catch (er) { showError(document.getElementById('err'), er.message); }
  };
  el.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = async () => {
    const pw = prompt('รหัสผ่านชั่วคราวใหม่ (อย่างน้อย 8 ตัว)'); if (!pw) return;
    try { await api(`/users/${b.dataset.reset}/reset-password`, { body: { password: pw } }); alert('รีเซ็ตแล้ว ผู้ใช้ต้องเปลี่ยนรหัสผ่านตอนเข้าครั้งถัดไป'); route(); } catch (er) { alert(er.message); }
  }));
  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    try { await api(`/users/${b.dataset.act}/active`, { body: { active: b.dataset.v === '1' } }); route(); } catch (er) { alert(er.message); }
  }));
}

// ---------- boot ----------
(async () => {
  try { me = (await api('/me')).user; start(); } catch { renderLogin(); }
})();
