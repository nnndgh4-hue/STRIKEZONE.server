// STRIKEZONE account + cloud save server.
// Storage: PostgreSQL when DATABASE_URL is set (use this on Render), otherwise a JSON file (local testing only).
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_BODY = 300 * 1024;          // a save is a few KB; this is generous
const SESSION_DAYS = 90;

/* ---------- storage ---------- */
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, name TEXT NOT NULL, lname TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created BIGINT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS saves(uid INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, upd BIGINT NOT NULL)`);
      await pool.query('ALTER TABLE saves ADD COLUMN IF NOT EXISTS at BIGINT');
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, uid INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp BIGINT NOT NULL)`);
    },
    async userByName(l) { const r = await pool.query('SELECT * FROM users WHERE lname=$1', [l]); return r.rows[0] || null; },
    async createUser(name, salt, hash) { try { const r = await pool.query('INSERT INTO users(name,lname,salt,hash,created) VALUES($1,$2,$3,$4,$5) RETURNING id', [name, name.toLowerCase(), salt, hash, Date.now()]); return r.rows[0].id; } catch (e) { if (e.code === '23505') return null; throw e; } },
    async addSession(th, uid, exp) { await pool.query('INSERT INTO sessions(th,uid,exp) VALUES($1,$2,$3)', [th, uid, exp]); await pool.query('DELETE FROM sessions WHERE exp<$1 OR th IN (SELECT th FROM sessions WHERE uid=$2 ORDER BY exp DESC OFFSET 10)', [Date.now(), uid]); },
    async sessionUser(th) { const r = await pool.query('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=$1 AND s.exp>$2', [th, Date.now()]); return r.rows[0] || null; },
    async delSession(th) { await pool.query('DELETE FROM sessions WHERE th=$1', [th]); },
    async getSave(uid) { const r = await pool.query('SELECT data,upd,at FROM saves WHERE uid=$1', [uid]); return r.rows[0] ? { data: r.rows[0].data, upd: Number(r.rows[0].upd), at: Number(r.rows[0].at || r.rows[0].upd) } : null; },
    async putSave(uid, data, upd, at) { await pool.query('INSERT INTO saves(uid,data,upd,at) VALUES($1,$2,$3,$4) ON CONFLICT(uid) DO UPDATE SET data=$2,upd=$3,at=$4', [uid, data, upd, at]); }
  };
} else {
  let db = { n: 1, users: {}, saves: {}, sessions: {} };
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  let t = null; const flush = () => { clearTimeout(t); t = setTimeout(() => { try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('save failed', e.message); } }, 300); };
  store = {
    async init() {},
    async userByName(l) { return db.users[l] || null; },
    async createUser(name, salt, hash) { const l = name.toLowerCase(); if (db.users[l]) return null; const id = db.n++; db.users[l] = { id, name, lname: l, salt, hash, created: Date.now() }; flush(); return id; },
    async addSession(th, uid, exp) { db.sessions[th] = { uid, exp }; const mine = Object.entries(db.sessions).filter(([, s]) => s.uid === uid).sort((a, b) => b[1].exp - a[1].exp); mine.slice(10).forEach(([k]) => delete db.sessions[k]); flush(); },
    async sessionUser(th) { const s = db.sessions[th]; if (!s || s.exp < Date.now()) return null; const u = Object.values(db.users).find(x => x.id === s.uid); return u ? { id: u.id, name: u.name } : null; },
    async delSession(th) { delete db.sessions[th]; flush(); },
    async getSave(uid) { return db.saves[uid] || null; },
    async putSave(uid, data, upd, at) { db.saves[uid] = { data, upd, at }; flush(); }
  };
}

/* ---------- helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400' };
const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)); res.end(JSON.stringify(obj)); };
const body = req => new Promise((res, rej) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > MAX_BODY) { rej(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (e) { rej(new Error('bad json')); } }); req.on('error', rej); });
const hits = new Map();   // simple per-IP limit on login/register
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(x => now - x < 600000); a.push(now); hits.set(ip, a); return a.length > 25; };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter(x => now - x < 600000); f.length ? hits.set(k, f) : hits.delete(k); } }, 600000).unref();
const NAME = /^[A-Za-z0-9_]{3,20}$/;
async function auth(req) { const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) return null; return store.sessionUser(sha(h.slice(7))); }
async function startSession(user) { const tok = crypto.randomBytes(32).toString('hex'); await store.addSession(sha(tok), user.id, Date.now() + SESSION_DAYS * 864e5); return tok; }
/* ---------- save checking (stops impossible progress) ---------- */
const KEYS = ['coins', 'own', 'eq', 'up', 'inv', 'lvl', 'xp', 'pts', 'camp', 'surv', 'mode', 'map', 'st', 'sk', 'dq', 'upd'];
const need = l => { const k = ((l - 1) % 100) + 1; return Math.round(120 + 2380 * Math.pow((k - 1) / 99, 2)); };
const totalXP = (lvl, xp) => { let t = xp; for (let l = 1; l < lvl; l++) t += need(l); return t; };
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
function cleanSave(o) {
  if (!isObj(o)) return null;
  const c = {}; for (const k of KEYS) if (o[k] !== undefined) c[k] = o[k];
  for (const k of ['coins', 'xp', 'pts', 'lvl']) if (typeof c[k] === 'number' && isFinite(c[k])) c[k] = Math.round(c[k]);
  if (c.st) for (const k of Object.keys(c.st)) if (typeof c.st[k] === 'number' && isFinite(c.st[k])) c.st[k] = Math.round(c.st[k]);
  if (!isInt(c.coins, 0, 5e7)) return null;
  if (c.lvl !== undefined && !isInt(c.lvl, 1, 1000)) return null;
  if (c.xp !== undefined && !isInt(c.xp, 0, 2500)) return null;
  if (c.pts !== undefined && !isInt(c.pts, 0, 5e7)) return null;
  if (c.st !== undefined) { if (!isObj(c.st)) return null; for (const v of Object.values(c.st)) if (!isInt(v, 0, 1e8)) return null; }
  for (const k of ['own', 'eq', 'up', 'inv', 'camp', 'sk', 'dq']) if (c[k] !== undefined && !isObj(c[k])) return null;
  if (c.own) for (const v of Object.values(c.own)) if (!isObj(v) || Object.keys(v).length > 60) return null;
  if (JSON.stringify(c).length > 30000) return null;
  return c;
}
// Progress allowed since the last accepted save: a generous base plus a fair rate per second.
/* Admin accounts (set ADMIN_USERS on Render to change; comma separated, case does not matter). The admin password is never stored here. */
const ADMINS = (process.env.ADMIN_USERS || 'alphang7').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const isAdmin = n => ADMINS.includes(String(n || '').toLowerCase());

function plausible(save, prev, now) {
  const xp = totalXP(save.lvl || 1, save.xp || 0), coins = save.coins;
  if (!prev) return coins <= 100000 && xp <= 300000;                       // first upload (progress made as a guest)
  const old = JSON.parse(prev.data), dt = Math.max(0, (now - (prev.at || prev.upd || now)) / 1000);
  return coins <= (old.coins || 0) + 3000 + 4 * dt && xp <= totalXP(old.lvl || 1, old.xp || 0) + 4000 + 3 * dt;
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = req.url.split('?')[0], ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (url === '/' || url === '/api/health') return send(res, 200, { ok: true, game: 'strikezone', storage: process.env.DATABASE_URL ? 'postgres' : 'file' });
    if (url === '/api/register' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const b = await body(req), name = String(b.user || ''), pw = String(b.pass || '');
      if (!NAME.test(name)) return send(res, 400, { error: 'Username must be 3 to 20 letters, numbers or underscores.' });
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: 'Password must be 8 to 100 characters.' });
      const salt = crypto.randomBytes(16).toString('hex'), id = await store.createUser(name, salt, await scrypt(pw, salt));
      if (!id) return send(res, 409, { error: 'That username is taken.' });
      return send(res, 200, { token: await startSession({ id }), user: name, admin: isAdmin(name) });
    }
    if (url === '/api/login' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const b = await body(req), u = await store.userByName(String(b.user || '').toLowerCase()), pw = String(b.pass || '');
      const ok = u && crypto.timingSafeEqual(Buffer.from(await scrypt(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
      if (!ok) return send(res, 401, { error: 'Wrong username or password.' });
      return send(res, 200, { token: await startSession(u), user: u.name, admin: isAdmin(u.name) });
    }
    if (url === '/api/logout' && req.method === 'POST') { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) await store.delSession(sha(h.slice(7))); return send(res, 200, { ok: true }); }
    if (url === '/api/save') {
      const u = await auth(req); if (!u) return send(res, 401, { error: 'Please log in again.' });
      if (req.method === 'GET') { const s = await store.getSave(u.id); return send(res, 200, { user: u.name, admin: isAdmin(u.name), save: s ? JSON.parse(s.data) : null, upd: s ? s.upd : 0 }); }
      if (req.method === 'PUT') {
        const b = await body(req), save = cleanSave(b.save); if (!save) return send(res, 400, { error: 'Invalid save.' });
        const now = Date.now(), prev = await store.getSave(u.id), upd = Math.min(Number(b.upd) || now, now + 60000);
        if (!isAdmin(u.name) && !plausible(save, prev, now)) return send(res, 422, { error: 'That save has progress that is not possible, so your last valid progress was restored.', save: prev ? JSON.parse(prev.data) : null, upd: prev ? prev.upd : 0 });
        await store.putSave(u.id, JSON.stringify(save), upd, now); return send(res, 200, { ok: true, upd });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e.message);
    send(res, e.message === 'too big' ? 413 : e.message === 'bad json' ? 400 : 500, { error: e.message === 'too big' ? 'Save too large.' : e.message === 'bad json' ? 'Bad request.' : 'Server error.' });
  }
});
store.init().then(() => server.listen(PORT, () => console.log('STRIKEZONE server on port ' + PORT + ' (' + (process.env.DATABASE_URL ? 'postgres' : 'file storage') + ')')))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
