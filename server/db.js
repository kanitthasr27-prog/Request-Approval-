const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('requester','approver','warehouse','admin','hr')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approver_links (
  requester_id INTEGER NOT NULL REFERENCES users(id),
  approver_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (requester_id, approver_id)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('give','loan')),
  due_date TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('trial','marketing')),
  customer TEXT NOT NULL,
  need_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','rejected','approved','partial','completed','cancelled')),
  created_at TEXT NOT NULL,
  overdue_notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id, created_at);
CREATE TABLE IF NOT EXISTS request_items (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_requested INTEGER NOT NULL CHECK (qty_requested > 0),
  qty_dispensed INTEGER NOT NULL DEFAULT 0,
  qty_returned INTEGER NOT NULL DEFAULT 0,
  qty_cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS decisions (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id),
  approver_id INTEGER NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('approved','rejected')),
  reason TEXT,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispenses (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  item_id INTEGER NOT NULL REFERENCES request_items(id),
  qty INTEGER NOT NULL,
  officer_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES request_items(id),
  qty INTEGER NOT NULL,
  officer_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cancellations (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  item_id INTEGER REFERENCES request_items(id),
  qty INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  request_id INTEGER REFERENCES requests(id),
  is_read INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside an immediate (write-locking) transaction.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Creates the first HR and Admin accounts when the users table is empty (D4).
// Returns the credentials created, or null if users already exist.
function bootstrapAccounts(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return null;
  const hrPw = process.env.INITIAL_HR_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const adminPw = process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const ins = db.prepare(
    'INSERT INTO users (username, password_hash, full_name, department, role, must_change_password) VALUES (?,?,?,?,?,1)'
  );
  ins.run('hr', hashPassword(hrPw), 'ฝ่ายบุคคล', 'HR', 'hr');
  ins.run('admin', hashPassword(adminPw), 'ผู้ดูแลระบบ', 'IT', 'admin');
  return { hr: hrPw, admin: adminPw };
}

module.exports = { openDb, tx, hashPassword, verifyPassword, bootstrapAccounts };
