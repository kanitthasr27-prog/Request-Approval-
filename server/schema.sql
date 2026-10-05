CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_requested INTEGER NOT NULL CHECK (qty_requested > 0),
  qty_dispensed INTEGER NOT NULL DEFAULT 0,
  qty_returned INTEGER NOT NULL DEFAULT 0,
  qty_cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_request ON request_items(request_id);
CREATE TABLE IF NOT EXISTS decisions (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id),
  approver_id INTEGER NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('approved','rejected')),
  reason TEXT,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispenses (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  item_id INTEGER NOT NULL REFERENCES request_items(id),
  qty INTEGER NOT NULL,
  officer_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS returns (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES request_items(id),
  qty INTEGER NOT NULL,
  officer_id INTEGER NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cancellations (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  item_id INTEGER REFERENCES request_items(id),
  qty INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  request_id INTEGER REFERENCES requests(id),
  is_read INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- Supabase exposes tables through its public API; with RLS on and no policies,
-- only the server's direct database connection can read or write them.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approver_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
