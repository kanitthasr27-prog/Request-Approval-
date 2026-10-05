const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

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

// "?" placeholders -> "$1, $2..." so SQL stays easy to read.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wraps anything with query(sql, params) -> { rows, affectedRows|rowCount } into the app's tiny API:
//   q(sql, params) -> rows[]      run(sql, params) -> number of rows changed
function api(exec) {
  return {
    async q(sql, params = []) { return (await exec(toPg(sql), params)).rows; },
    async run(sql, params = []) {
      const r = await exec(toPg(sql), params);
      return r.rowCount ?? r.affectedRows ?? 0;
    },
  };
}

// target: a postgres:// URL (Supabase / any Postgres), or a folder path / ':memory:' for a local embedded
// Postgres (PGlite) used for development and tests.
async function openDb(target) {
  let base, close;
  let txRunner;

  if (/^postgres(ql)?:\/\//.test(target)) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint -> number
    const pool = new Pool({
      connectionString: target,
      ssl: /localhost|127\.0\.0\.1/.test(target) ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX) || 3,
    });
    base = api((sql, params) => pool.query(sql, params));
    txRunner = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(api((sql, params) => client.query(sql, params)));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    };
    close = () => pool.end();
  } else {
    // loaded by variable name so serverless bundlers do not pull the embedded engine into production
    const mod = '@electric-sql/pglite';
    const { PGlite } = require(mod);
    if (target !== ':memory:') fs.mkdirSync(path.resolve(target), { recursive: true });
    const lite = new PGlite(target === ':memory:' ? undefined : path.resolve(target));
    await lite.waitReady;
    base = api((sql, params) => lite.query(sql, params));
    txRunner = (fn) => lite.transaction((t) => fn(api((sql, params) => t.query(sql, params))));
    close = () => lite.close();
  }

  return {
    ...base,
    tx: txRunner,
    close,
    isEmbedded: !/^postgres(ql)?:\/\//.test(target),
    async exec(sqlText) {
      // schema files: run statement by statement
      for (const stmt of sqlText.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) await base.run(stmt);
    },
    async ensureSchema() {
      await this.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    },
  };
}

// Creates the first HR and Admin accounts when the users table is empty (D4).
// Returns the credentials created, or null if users already exist.
async function bootstrapAccounts(db) {
  const [{ n }] = await db.q('SELECT COUNT(*)::int AS n FROM users');
  if (n > 0) return null;
  const hrPw = process.env.INITIAL_HR_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const adminPw = process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const ins = 'INSERT INTO users (username, password_hash, full_name, department, role, must_change_password) VALUES (?,?,?,?,?,1)';
  await db.run(ins, ['hr', hashPassword(hrPw), 'ฝ่ายบุคคล', 'HR', 'hr']);
  await db.run(ins, ['admin', hashPassword(adminPw), 'ผู้ดูแลระบบ', 'IT', 'admin']);
  return { hr: hrPw, admin: adminPw };
}

module.exports = { openDb, hashPassword, verifyPassword, bootstrapAccounts };
