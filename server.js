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
      await pool.query(`CREATE TABLE IF NOT EXISTS lb(uid INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, pts BIGINT NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '', dpts BIGINT NOT NULL DEFAULT 0)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS titles(lname TEXT PRIMARY KEY, name TEXT NOT NULL, txt TEXT NOT NULL, col TEXT NOT NULL)`);
      const miss = await pool.query('SELECT u.id,u.name,s.data FROM saves s JOIN users u ON u.id=s.uid WHERE u.id NOT IN (SELECT uid FROM lb)');
      for (const r of miss.rows) { let p = 0; try { p = Math.max(0, Math.round(JSON.parse(r.data).pts || 0)); } catch (e) { } await pool.query('INSERT INTO lb(uid,name,pts) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [r.id, r.name, p]); }
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, uid INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp BIGINT NOT NULL)`);
    },
    async userByName(l) { const r = await pool.query('SELECT * FROM users WHERE lname=$1', [l]); return r.rows[0] || null; },
    async createUser(name, salt, hash) { try { const r = await pool.query('INSERT INTO users(name,lname,salt,hash,created) VALUES($1,$2,$3,$4,$5) RETURNING id', [name, name.toLowerCase(), salt, hash, Date.now()]); return r.rows[0].id; } catch (e) { if (e.code === '23505') return null; throw e; } },
    async addSession(th, uid, exp) { await pool.query('INSERT INTO sessions(th,uid,exp) VALUES($1,$2,$3)', [th, uid, exp]); await pool.query('DELETE FROM sessions WHERE exp<$1 OR th IN (SELECT th FROM sessions WHERE uid=$2 ORDER BY exp DESC OFFSET 10)', [Date.now(), uid]); },
    async sessionUser(th) { const r = await pool.query('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.uid WHERE s.th=$1 AND s.exp>$2', [th, Date.now()]); return r.rows[0] || null; },
    async delSession(th) { await pool.query('DELETE FROM sessions WHERE th=$1', [th]); },
    async getSave(uid) { const r = await pool.query('SELECT data,upd,at FROM saves WHERE uid=$1', [uid]); return r.rows[0] ? { data: r.rows[0].data, upd: Number(r.rows[0].upd), at: Number(r.rows[0].at || r.rows[0].upd) } : null; },
    async putSave(uid, data, upd, at) { await pool.query('INSERT INTO saves(uid,data,upd,at) VALUES($1,$2,$3,$4) ON CONFLICT(uid) DO UPDATE SET data=$2,upd=$3,at=$4', [uid, data, upd, at]); },
    async lbSet(uid, name, pts, delta, day) {
      await pool.query(`INSERT INTO lb(uid,name,pts,day,dpts) VALUES($1,$2,$3,$4,$5) ON CONFLICT(uid) DO UPDATE SET name=$2, pts=$3, dpts=(CASE WHEN lb.day=$4 THEN lb.dpts ELSE 0 END)+$5, day=$4`, [uid, name, pts, day, delta]);
    },
    async lbTop(n) { const r = await pool.query('SELECT uid,name,pts FROM lb ORDER BY pts DESC, uid ASC LIMIT $1', [n]); return r.rows.map(x => ({ uid: x.uid, n: x.name, p: Number(x.pts) })); },
    async lbDay(day, n) { const r = await pool.query('SELECT uid,name,dpts FROM lb WHERE day=$1 AND dpts>0 ORDER BY dpts DESC, uid ASC LIMIT $2', [day, n]); return r.rows.map(x => ({ uid: x.uid, n: x.name, p: Number(x.dpts) })); },
    async lbMe(uid, day) { const r = await pool.query('SELECT pts,day,dpts FROM lb WHERE uid=$1', [uid]); const m = r.rows[0]; if (!m) return null; const a = await pool.query('SELECT COUNT(*) c FROM lb WHERE pts>$1', [m.pts]); const dp = m.day === day ? Number(m.dpts) : 0; let dr = 0; if (dp > 0) { const b = await pool.query('SELECT COUNT(*) c FROM lb WHERE day=$1 AND dpts>$2', [day, dp]); dr = Number(b.rows[0].c) + 1; } return { rank: Number(a.rows[0].c) + 1, pts: Number(m.pts), drank: dr, dpts: dp }; },
    async titlesAll() { const r = await pool.query('SELECT lname,name,txt,col FROM titles'); return r.rows; },
    async titleSet(lname, name, txt, col) { await pool.query('INSERT INTO titles(lname,name,txt,col) VALUES($1,$2,$3,$4) ON CONFLICT(lname) DO UPDATE SET name=$2,txt=$3,col=$4', [lname, name, txt, col]); },
    async titleDel(lname) { await pool.query('DELETE FROM titles WHERE lname=$1', [lname]); },
    async delSave(uid) { await pool.query('DELETE FROM saves WHERE uid=$1', [uid]); },
    async lbDel(uid) { await pool.query('DELETE FROM lb WHERE uid=$1', [uid]); },
    async listUsers(q, n) { const r = await pool.query('SELECT u.name, COALESCE(l.pts,0) pts FROM users u LEFT JOIN lb l ON l.uid=u.id WHERE u.lname LIKE $1 ORDER BY COALESCE(l.pts,0) DESC, u.id ASC LIMIT $2', ['%' + q.replace(/[%_\\]/g, '') + '%', n]); return r.rows.map(x => ({ n: x.name, p: Number(x.pts) })); },
    async kvGet(k) { const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; },
    async kvSet(k, v) { await pool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2', [k, v]); },
    async kvDel(k) { await pool.query('DELETE FROM kv WHERE k=$1', [k]); }
  };
} else {
  let db = { n: 1, users: {}, saves: {}, sessions: {} };
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  db.lb = db.lb || {}; db.titles = db.titles || {}; db.kv = db.kv || {};
  let t = null; const flush = () => { clearTimeout(t); t = setTimeout(() => { try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('save failed', e.message); } }, 300); };
  store = {
    async init() {},
    async userByName(l) { return db.users[l] || null; },
    async createUser(name, salt, hash) { const l = name.toLowerCase(); if (db.users[l]) return null; const id = db.n++; db.users[l] = { id, name, lname: l, salt, hash, created: Date.now() }; flush(); return id; },
    async addSession(th, uid, exp) { db.sessions[th] = { uid, exp }; const mine = Object.entries(db.sessions).filter(([, s]) => s.uid === uid).sort((a, b) => b[1].exp - a[1].exp); mine.slice(10).forEach(([k]) => delete db.sessions[k]); flush(); },
    async sessionUser(th) { const s = db.sessions[th]; if (!s || s.exp < Date.now()) return null; const u = Object.values(db.users).find(x => x.id === s.uid); return u ? { id: u.id, name: u.name } : null; },
    async delSession(th) { delete db.sessions[th]; flush(); },
    async getSave(uid) { return db.saves[uid] || null; },
    async putSave(uid, data, upd, at) { db.saves[uid] = { data, upd, at }; flush(); },
    async lbSet(uid, name, pts, delta, day) { const o = db.lb[uid] || { day: '', dpts: 0 }; db.lb[uid] = { name, pts, day, dpts: (o.day === day ? o.dpts : 0) + delta }; flush(); },
    async lbTop(n) { return Object.entries(db.lb).map(([u, x]) => ({ uid: Number(u), n: x.name, p: x.pts })).sort((a, b) => b.p - a.p || a.uid - b.uid).slice(0, n); },
    async lbDay(day, n) { return Object.entries(db.lb).filter(([, x]) => x.day === day && x.dpts > 0).map(([u, x]) => ({ uid: Number(u), n: x.name, p: x.dpts })).sort((a, b) => b.p - a.p || a.uid - b.uid).slice(0, n); },
    async lbMe(uid, day) { const m = db.lb[uid]; if (!m) return null; const all = Object.values(db.lb); const dp = m.day === day ? m.dpts : 0; return { rank: all.filter(x => x.pts > m.pts).length + 1, pts: m.pts, drank: dp > 0 ? all.filter(x => x.day === day && x.dpts > dp).length + 1 : 0, dpts: dp }; },
    async titlesAll() { return Object.entries(db.titles).map(([l, x]) => ({ lname: l, name: x.name, txt: x.txt, col: x.col })); },
    async titleSet(lname, name, txt, col) { db.titles[lname] = { name, txt, col }; flush(); },
    async titleDel(lname) { delete db.titles[lname]; flush(); },
    async delSave(uid) { delete db.saves[uid]; flush(); },
    async lbDel(uid) { delete db.lb[uid]; flush(); },
    async listUsers(q, n) { return Object.values(db.users).filter(u => u.lname.includes(q)).map(u => ({ n: u.name, p: (db.lb[u.id] || {}).pts || 0 })).sort((a, b) => b.p - a.p).slice(0, n); },
    async kvGet(k) { return Object.prototype.hasOwnProperty.call(db.kv, k) ? db.kv[k] : null; },
    async kvSet(k, v) { db.kv[k] = v; flush(); },
    async kvDel(k) { delete db.kv[k]; flush(); }
  };
  for (const [l, u] of Object.entries(db.users)) { const sv = db.saves[u.id]; if (sv && !db.lb[u.id]) { let p = 0; try { p = Math.max(0, Math.round(JSON.parse(sv.data).pts || 0)); } catch (e) { } db.lb[u.id] = { name: u.name, pts: p, day: '', dpts: 0 }; } }
}

/* ---------- helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400' };
const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)); res.end(JSON.stringify(obj)); };
const body = req => new Promise((res, rej) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > MAX_BODY) { rej(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (e) { rej(new Error('bad json')); } }); req.on('error', rej); });
const hits = new Map();   // simple per-IP limit on login/register
/* live events: the admin posts one, every player's game polls for new ones (kept in memory for 2 minutes) */
let LIVE = null;   // { n: name, end: ms timestamp, set: ms timestamp } or null
const EVS = [], EVT = new Set(['boss','superspeed','supergravity','enlarge','meteor','coinrain','disco','tacoparty','infammo','ufo','dev']);
let evSeq = 0, lastEv = 0;
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
  if (c.lvl !== undefined && !isInt(c.lvl, 1, 100000)) return null;
  if (c.xp !== undefined && !isInt(c.xp, 0, 2500)) return null;
  if (c.pts !== undefined && !isInt(c.pts, 0, 5e7)) return null;
  if (c.st !== undefined) { if (!isObj(c.st)) return null; for (const v of Object.values(c.st)) if (!isInt(v, 0, 1e8)) return null; }
  for (const k of ['own', 'eq', 'up', 'inv', 'camp', 'sk', 'dq']) if (c[k] !== undefined && !isObj(c[k])) return null;
  if (c.own) for (const v of Object.values(c.own)) if (!isObj(v) || Object.keys(v).length > 2000) return null;
  if (JSON.stringify(c).length > 150000) return null;
  return c;
}
// Progress allowed since the last accepted save: a generous base plus a fair rate per second.
/* Admin accounts (set ADMIN_USERS on Render to change; comma separated, case does not matter). The admin password is never stored here. */
const ADMINS = (process.env.ADMIN_USERS || 'alphang7').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const isAdmin = n => ADMINS.includes(String(n || '').toLowerCase());
/* "today" for the daily leaderboard follows Adelaide time (set LB_TZ on Render to change) */
const LB_TZ = process.env.LB_TZ || 'Australia/Adelaide';
const dayKey = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: LB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } };
const TITLES = new Map();
/* bans: lowercase usernames, kept in kv 'bans'. A banned account keeps its save but is hidden from the leaderboard and cannot play. */
const BANS = new Set();
const isBanned = n => BANS.has(String(n || '').toLowerCase());
const saveBans = () => store.kvSet('bans', JSON.stringify([...BANS]));
const BANNED_MSG = 'You have been banned.';
/* reset: wipes the save and leaderboard row; the stamp makes every device of that account wipe its local copy too */
async function resetUser(name) {
  const u = await store.userByName(String(name || '').toLowerCase()); if (!u) return null;
  await store.delSave(u.id); await store.lbDel(u.id); await store.kvSet('rst:' + u.name.toLowerCase(), String(Date.now())); lbCache = null; return u;
}
const titleOf = n => { const t = TITLES.get(String(n || '').toLowerCase()); return t ? [t.t, t.c] : null; };   // lowercase username -> { n, t, c }
/* roles: read live from the name tag beside a player's name, so a tag added later counts straight away. admin > developer > tester. Capital letters do not matter. */
const roleOf = n => { if (isAdmin(n)) return 'admin'; const t = TITLES.get(String(n || '').toLowerCase()), x = t ? String(t.t || '') : ''; return /\bdeveloper\b/i.test(x) ? 'dev' : /\btester\b/i.test(x) ? 'tester' : ''; };
/* commands. Testers and developers can use the base five on ANY server; the extra sets only inside the TEST server. Everything else is for the admin account only. */
const AC_BASE = ['god', 'killred', 'heal', 'ammo', 'freeze'];
const AC_TEST = { tester: ['superspeed', 'supergravity', 'infammo'], dev: ['taco', 'minigun', 'infammo', 'supergravity', 'superspeed', 'enlarge', 'dropgun', 'boss'] };
const acAllowed = (role, cmd, inTest) => role === 'admin' || (AC_BASE.includes(cmd) && (role === 'tester' || role === 'dev')) || (inTest && !!AC_TEST[role] && AC_TEST[role].includes(cmd));
const HEX = /^#[0-9a-fA-F]{6}$/;
function rolePush(t) { const c = USERS.get(t.id); if (!c || c.dead) return; c.role = roleOf(t.name); wsOut(c, { t: 'role', role: c.role }); if (c.room && c.room.test && !c.role) { wsOut(c, { t: 'err', m: 'The test server is only for testers and developers.', soft: 1 }); setTimeout(() => wsDrop(c), 300); } }
let lbCache = null, lbCacheAt = 0;

function plausible(save, prev, now) {
  const xp = totalXP(save.lvl || 1, save.xp || 0), coins = save.coins;
  if (!prev) return coins <= 100000 && xp <= 300000;                       // first upload (progress made as a guest)
  const old = JSON.parse(prev.data), dt = Math.max(0, (now - (prev.at || prev.upd || now)) / 1000);
  return coins <= (old.coins || 0) + 3000 + 4 * dt && xp <= totalXP(old.lvl || 1, old.xp || 0) + 4000 + 3 * dt;
}

/* ---------- routes ---------- */
/* ---------- live play (WebSocket, no extra packages) ---------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAXT = 10, MAXP = 12;
const ROOMS = new Map();   // room id -> { id, pl: Map(pid -> client), host, nextId }
let roomN = 0;
const wsFrame = (str, op) => { const p = Buffer.from(str), n = p.length; let h; if (n < 126) h = Buffer.from([0x80 | (op || 1), n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | (op || 1); h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | (op || 1); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); } return Buffer.concat([h, p]); };
const tcOf = r => { const t = [0, 0]; for (const c of r.pl.values()) t[c.tm]++; return t; };
const wsOut = (c, o) => { if (c.dead) return; try { c.sock.write(wsFrame(JSON.stringify(o))); } catch (e) { } };
const roomOut = (r, o, skip) => { const f = wsFrame(JSON.stringify(o)); for (const c of r.pl.values()) if (c !== skip && !c.dead) { try { c.sock.write(f); } catch (e) { } } if (r.sp) for (const c of r.sp) if (!c.dead) { try { c.sock.write(f); } catch (e) { } } };
const CODES = new Map();   // private code -> room
function newRoom(id, name, code) { const r = { id, name, code: code || '', priv: !!code, pl: new Map(), host: 0, nextId: 1, t0: Date.now(), sc: [0, 0], map: 'arena', ph: 'vote', vend: Date.now() + VOTE_MS, votes: new Map() }; ROOMS.set(id, r); if (code) CODES.set(code, r); return r; }
function newGeneral() { let n = 1; while (ROOMS.has('general-' + n)) n++; return newRoom('general-' + n, 'GENERAL ' + n, ''); }
function testRoom() { let r = ROOMS.get('test-room'); if (!r) { r = newRoom('test-room', 'TEST SERVER', ''); r.priv = true; r.test = 1; r.ph = 'play'; r.vend = Infinity; r.evs = {}; } return r; }
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (let k = 0; k < 50; k++) { let c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; if (!CODES.has(c)) return c; } return null; }
function findRoom(team) {
  let best = null; for (const r of ROOMS.values()) if (!r.priv && r.pl.size < MAXP && tcOf(r)[team] < MAXT && (!best || r.pl.size > best.pl.size)) best = r;
  return best || newGeneral();
}
const lbOf = r => [...r.pl.values()].map(o => [o.pid, o.k | 0, o.d | 0]);
/* Update 4: the six maps. Every room votes between the same six; the game itself loads the small PvP version or the large main version */
const MAPS = ['arena', 'dock', 'metro', 'neon', 'frost', 'outpost'], PVMAPS = MAPS, mapsOf = r => (r.pvp ? PVMAPS : MAPS), VOTE_MS = Number(process.env.VOTE_MS) || 10000, RES_MS = Number(process.env.RES_MS) || 6000;
const vcount = r => { const v = {}; mapsOf(r).forEach(k => { v[k] = 0; }); for (const m of r.votes.values()) if (v[m] !== undefined) v[m]++; return v; };
function endRound(r, win) {
  if (r.ph !== 'play') return;
  roomOut(r, { t: 'end', win, sc: r.sc, lb: lbOf(r), rs: RES_MS, vl: RES_MS + VOTE_MS });
  r.ph = 'vote'; r.vend = Date.now() + RES_MS + VOTE_MS; r.votes.clear(); r.evs = {}; for (const o of r.pl.values()) { o.god = 0; o.os = 0; }
}
function startRound(r) {
  const v = vcount(r), ml = mapsOf(r), top = Math.max(...ml.map(k => v[k]));
  if (top > 0) { const c = ml.filter(m => v[m] === top); r.map = c[Math.floor(Math.random() * c.length)]; }
  r.ph = 'play'; r.votes.clear(); roomReset(r); r.hs = Date.now();
  if (r.pvp) r.rn++;
  if (r.co) r.cw = 0;
  roomOut(r, { t: 'go', map: r.map, rn: r.rn | 0, rw: r.rw || [0, 0] });
}
function roomReset(r) { r.t0 = Date.now(); r.sc = [0, 0]; r.evs = {}; for (const o of r.pl.values()) { o.god = 0; o.os = 0; } for (const o of r.pl.values()) { if (!r.pvp) { o.k = 0; o.d = 0; } o.pa = true; } }
/* ---------- PvP queues: 1v1 / 2v2 / 3v3, no bots, one life per round, first to 3 round wins ---------- */
const PVP_RT = Number(process.env.PVP_RT) || 120000, PVP_BREAK = Number(process.env.PVP_BREAK) || 10000, PVP_WINS = 3, PVP_MAXR = 9;
let pvpN = 0;
function pvpRoom(n) {
  for (const r of ROOMS.values()) if (r.pvp === n && r.ph === 'wait' && r.pl.size < 2 * n) return r;
  const r = newRoom('pvp-' + (++pvpN), 'PVP ' + n + 'V' + n, ''); r.pvp = n; r.map = 'arena'; r.priv = true; r.ph = 'wait'; r.rw = [0, 0]; r.rn = 0; return r;
}
const pvpAlive = (r, t) => { let n = 0; for (const o of r.pl.values()) if (o.tm === t && o.pa) n++; return n; };
function pvpEnd(r, win, force) {
  if (r.ph !== 'play') return;
  if (win >= 0) r.rw[win]++;
  const fin = force || (win >= 0 && r.rw[win] >= PVP_WINS) || r.rn >= PVP_MAXR;
  if (fin) {
    const w = r.rw[0] > r.rw[1] ? 0 : r.rw[1] > r.rw[0] ? 1 : -1;
    roomOut(r, { t: 'end', win: w, sc: r.rw, lb: lbOf(r), rs: 0, vl: 0, pvp: 1, fin: 1, rw: r.rw, rn: r.rn }); r.ph = 'done'; setTimeout(() => { for (const c of [...r.pl.values()]) wsDrop(c); }, 120000).unref();
  } else {
    roomOut(r, { t: 'end', win, sc: r.rw, lb: lbOf(r), rs: PVP_BREAK, vl: 0, pvp: 1, fin: 0, rw: r.rw, rn: r.rn }); r.ph = 'break'; r.vend = Date.now() + PVP_BREAK;
  }
}
function pvpCheck(r) {
  if (!r.pvp || r.ph !== 'play') return;
  const p = [0, 0]; for (const o of r.pl.values()) p[o.tm]++;
  if (!p[0] && !p[1]) return; if (!p[0]) return pvpEnd(r, 1, true); if (!p[1]) return pvpEnd(r, 0, true);
  const a0 = pvpAlive(r, 0), a1 = pvpAlive(r, 1);
  if (!a0 && !a1) pvpEnd(r, -1); else if (!a0) pvpEnd(r, 1); else if (!a1) pvpEnd(r, 0);
}
/* ---------- CO-OP waves: up to 6 players, all on one team, one life each, everybody down = restart from wave 1 ---------- */
const COMAX = 6; let coN = 0;
function coRoom() {
  for (const r of ROOMS.values()) if (r.co && !r.code && r.pl.size < COMAX && r.ph !== 'done') return r;
  const r = newRoom('co-' + (++coN), 'CO-OP WAVES ' + coN, ''); r.co = 1; r.priv = true; r.cw = 0; return r;
}
function coWipe(r) { if (!r.co || r.ph !== 'play') return; r.ph = 'break'; r.vend = Date.now() + 5000; roomOut(r, { t: 'cx', w: r.cw | 0 }); }
function coCheck(r) { if (!r.co || r.ph !== 'play' || !r.pl.size) return; for (const o of r.pl.values()) if (o.pa) return; coWipe(r); }
function pvpQ(r) { roomOut(r, { t: 'pq', have: r.pl.size, need: 2 * r.pvp, names: [...r.pl.values()].map(o => o.name) }); }
function pvpFull(r) { r.ph = 'vote'; r.vend = Date.now() + VOTE_MS; r.votes.clear(); r.rw = [0, 0]; r.rn = 0; roomOut(r, { t: 'pv', vl: VOTE_MS, need: 2 * r.pvp }); }
function wsDrop(c) {
  if (c.dead) return; c.dead = true; try { c.sock.destroy(); } catch (e) { }
  if (c.user) { if (USERS.get(c.user.id) === c) USERS.delete(c.user.id); if (SOLOS.get(c.user.id) === c) SOLOS.delete(c.user.id); }
  const r = c.room; if (!r) return; if (c.spec) { if (r.sp) r.sp.delete(c); return; } r.pl.delete(c.pid);
  if (!r.pl.size) { if (r.sp) for (const sp of [...r.sp]) { wsOut(sp, { t: 'err', m: 'That match has ended.', soft: 1 }); setTimeout(() => wsDrop(sp), 300); } ROOMS.delete(r.id); if (r.code) CODES.delete(r.code); return; }
  roomOut(r, { t: 'pl', id: c.pid }); roomOut(r, { t: 'tc', tc: tcOf(r) });
  if (r.pvp) { if (r.ph === 'wait') pvpQ(r); else pvpCheck(r); }
  if (r.co) coCheck(r);
  if (r.host === c.pid) { r.host = r.pl.keys().next().value; r.hs = Date.now(); roomOut(r, { t: 'h', host: r.host }); }
}
function fixHost(r) { const h = r.pl.get(r.host); if (!h || h.vis !== 0) return; const n = [...r.pl.values()].find(o => o.vis !== 0); if (n) { r.host = n.pid; r.hs = Date.now(); roomOut(r, { t: 'h', host: n.pid }); } }
const num = (v, lim) => { v = Number(v); return Number.isFinite(v) ? Math.max(-lim, Math.min(lim, Math.round(v * 100) / 100)) : 0; };
const USERS = new Map();   // user id -> client (one connection per account)
/* ---------- chat filter: swear words become hashtags (####) for everybody ---------- */
const LEET = { a: '[a@4*]', e: '[e3*]', i: '[i1!|*]', o: '[o0*]', u: '[uv*]', s: '[s$5]', t: '[t7+]', l: '[l1|]', b: '[b8]', g: '[g9]' };
const swPat = w => [...w].map(ch => (LEET[ch] || ch) + '+').join('[.\\-_*]?');
const SW_OPEN = ['fuck', 'shit', 'bitch', 'cunt', 'bullshit', 'motherfucker'], SW_WHOLE = ['dick', 'cock', 'pussy', 'whore', 'slut', 'prick', 'twat', 'wank', 'wanker', 'bollocks', 'asshole', 'ass', 'arse', 'bastard', 'nigger', 'nigga', 'fag', 'faggot', 'retard', 'piss', 'damn', 'crap', 'douche', 'jackass', 'dumbass', 'cum', 'tits'];
const SW_RE = new RegExp('(?<![a-z0-9])(?:' + SW_OPEN.map(w => swPat(w) + '[a-z]*').join('|') + '|(?:' + SW_WHOLE.map(swPat).join('|') + ')(?:s|es|ed|ing|er|ers|y)?)(?![a-z0-9])', 'gi');
const cleanChat = tx => tx.replace(SW_RE, m => '#'.repeat(m.length));
const GCHAT = [], GC_LAST = new Map(); let gcSeq = 0;   /* global chat (see /api/gchat) */
/* ---------- presence: everybody who has the game open (even on the home page) ---------- */
const PRES = new Map();
function presN() { const t = Date.now(); for (const [k, v] of PRES) if (t - v > 50000) PRES.delete(k); return PRES.size; }
function onlineInfo() {
  const rooms = [], pq = [];
  for (const r of ROOMS.values()) {
    if (r.code || r.test || !r.pl.size || (r.pvp && r.ph === 'wait')) continue;
    rooms.push({ id: r.id, name: r.name, kind: r.solo ? 'solo' : r.pvp ? 'pvp' : r.co ? 'co' : 'gen', map: r.map, ph: r.ph, n: r.pl.size, tc: tcOf(r), rw: r.rw || [0, 0], rn: r.rn | 0, sp: r.sp ? r.sp.size : 0, pl: [...r.pl.values()].map(o => ({ id: o.pid, n: o.name, tm: o.tm })) });
  }
  for (const n of [1, 2, 3]) { let w = null; for (const r of ROOMS.values()) if (r.pvp === n && r.ph === 'wait') { w = r; break; } pq.push({ n, have: w ? w.pl.size : 0, need: 2 * n, names: w ? [...w.pl.values()].map(o => o.name) : [] }); }
  const tr = ROOMS.get('test-room'); return { n: presN(), rooms, pq, test: tr ? tr.pl.size : 0 };
}
/* solo reporter: a player in an offline mode streams position only, so others can watch from the ONLINE list */
const SOLOS = new Map();
function soloJoin(c, m) {
  if (c.joining) return; c.joining = true;
  store.sessionUser(sha(String(m.token || ''))).then(u => {
    if (!u || c.dead || isBanned(u.name)) return wsDrop(c);
    const oldc = SOLOS.get(u.id); if (oldc && oldc !== c) wsDrop(oldc);
    const r = newRoom('solo-' + u.id + '-' + Date.now().toString(36), u.name + ' (SOLO)', '');
    r.priv = true; r.solo = 1; r.ph = 'play'; r.t0 = Date.now(); r.map = String(m.map || 'arena').replace(/[^\w]/g, '').slice(0, 12) || 'arena'; r.mode = String(m.mode || '').replace(/[^\w ]/g, '').slice(0, 16);
    c.user = u; c.room = r; c.pid = 1; c.tm = 0; c.pa = true; c.name = u.name; c.ch = Math.max(0, Math.min(99, m.ch | 0)); c.pr = 0; c.k = 0; c.d = 0; c.solo = true; r.nextId = 2; r.host = 1; r.hs = Date.now(); r.pl.set(1, c); SOLOS.set(u.id, c);
    wsOut(c, { t: 'solo', ok: 1 });
  }).catch(() => wsDrop(c));
}
function wsMsg(c, m) {
  if (c.dead || !m || typeof m.t !== 'string') return;
  c.seen = Date.now();
  if (m.t === 'ping') return wsOut(c, { t: 'pong' });
  if (!c.room) {
    if (m.t === 'solo') return soloJoin(c, m);
    if (m.t !== 'join' || c.joining) return; c.joining = true;
    store.sessionUser(sha(String(m.token || ''))).then(async u => {
      if (!u || c.dead) { wsOut(c, { t: 'err', m: 'Please log in again.' }); return wsDrop(c); }
      if (isBanned(u.name)) { wsOut(c, { t: 'err', m: BANNED_MSG }); return wsDrop(c); }
      let pr = 0; try { const sv = await store.getSave(u.id); if (sv && sv.data) pr = Math.max(0, Math.min(10, Math.floor((Number(JSON.parse(sv.data).lvl) || 1) / 100))); } catch (e) { }
      const adm = isAdmin(u.name), old = USERS.get(u.id);
      const soft = txt => { wsOut(c, { t: 'err', m: txt, soft: 1 }); setTimeout(() => wsDrop(c), 300); };
      const team = m.team === 1 ? 1 : 0;
      if (m.spec) {
        const sr = ROOMS.get(String(m.spec).slice(0, 40));
        if (!sr || sr.code || sr.test || (sr.pvp && sr.ph === 'wait')) return soft('That match is not available to watch.');
        c.user = u; c.room = sr; c.spec = true; c.pid = -1; c.name = u.name; c.tm = 0; (sr.sp = sr.sp || new Set()).add(c);
        const sl = [...sr.pl.values()].map(o => ({ id: o.pid, n: o.name, tm: o.tm, ch: o.ch, pr: o.pr | 0 }));
        return wsOut(c, { t: 'w', id: -1, spec: 1, room: sr.id, name: sr.name, priv: 0, code: '', co: sr.co ? 1 : 0, cw: sr.cw | 0, host: sr.host, tm: 0, pl: sl, tc: tcOf(sr), el: Date.now() - sr.t0, sc: sr.sc, lb: lbOf(sr), map: sr.map, ph: sr.ph, vl: Math.max(0, sr.vend - Date.now()), vt: vcount(sr), pvp: sr.pvp | 0, need: sr.pvp ? 2 * sr.pvp : 0, rw: sr.rw || [0, 0], rn: sr.rn | 0 });
      }
      let r = null;
      if (m.test) { if (!roleOf(u.name)) return soft('The test server is only for testers and developers.'); r = testRoom(); }
      else if (m.create) { let code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (m.code && (code.length < 3 || code.length > 10)) return soft('The code must be 3 to 10 letters or numbers.'); if (code && CODES.has(code)) return soft('That code is already taken. Choose another one.'); if (!code) code = newCode(); if (!code) return soft('Could not make a private server. Try again.'); r = newRoom('private-' + code, 'PRIVATE ' + code, code); if (m.co) { r.co = 1; r.cw = 0; r.name = 'CO-OP ' + code; } }
      else if (m.code) { r = CODES.get(String(m.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); if (!r) return soft('No private server has that code.'); }
      else if (m.room) { r = ROOMS.get(String(m.room).slice(0, 40)); if (!r || r.priv) return soft('That server no longer exists.'); }
      else if (m.co) r = coRoom();
      else if (m.pvp) { const pn = m.pvp | 0; if (![1, 2, 3].includes(pn)) return soft('Pick 1v1, 2v2 or 3v3.'); r = pvpRoom(pn); }
      else r = findRoom(team);
      if (r.pl.size >= (r.co ? COMAX : MAXP)) { if (m.create) ROOMS.delete(r.id); return soft('That server is full.'); }
      if (old && old !== c && !adm) { wsOut(old, { t: 'err', m: 'You joined from another place.' }); wsDrop(old); }
      const pid = r.nextId++;
      c.user = u; USERS.set(u.id, c); c.room = r; c.pid = pid; c.tm = r.co ? 0 : r.pvp ? (tcOf(r)[0] <= tcOf(r)[1] ? 0 : 1) : (tcOf(r)[team] < MAXT ? team : 1 - team); c.pa = true; c.name = u.name; c.ch = Math.max(0, Math.min(99, m.ch | 0)); c.admin = adm; c.role = roleOf(u.name); c.pr = pr; c.k = 0; c.d = 0;
      if (!r.host) { r.host = pid; r.hs = Date.now(); }
      const list = [...r.pl.values()].map(o => ({ id: o.pid, n: o.name, tm: o.tm, ch: o.ch, pr: o.pr | 0 }));
      r.pl.set(pid, c);
      wsOut(c, { t: 'w', id: pid, room: r.id, name: r.name, priv: (r.priv && r.code) ? 1 : 0, code: r.code, co: r.co ? 1 : 0, cw: r.cw | 0, host: r.host, tm: c.tm, pl: list, tc: tcOf(r), el: Date.now() - r.t0, sc: r.sc, lb: lbOf(r), map: r.map, ph: r.ph, vl: Math.max(0, r.vend - Date.now()), vt: vcount(r), pvp: r.pvp | 0, need: r.pvp ? 2 * r.pvp : 0, rw: r.rw || [0, 0], rn: r.rn | 0, role: c.role, test: r.test ? 1 : 0 });
      if (r.evs && Object.keys(r.evs).length) wsOut(c, { t: 'acs', evs: r.evs });
      roomOut(r, { t: 'pj', p: { id: pid, n: c.name, tm: c.tm, ch: c.ch, pr: c.pr | 0 } }, c); roomOut(r, { t: 'tc', tc: tcOf(r) });
      if (r.pvp && r.ph === 'wait') { pvpQ(r); if (r.pl.size >= 2 * r.pvp) pvpFull(r); }
    }).catch(() => wsDrop(c));
    return;
  }
  if (c.spec) return;   /* spectators only watch */
  if (c.solo && m.t !== 's' && m.t !== 'fx') return;
  const r = c.room, now = Date.now();
  if (m.t === 's') {
    if (now - c.ls < 30) return; c.ls = now;
    c.ps = { x: num(m.x, 200), y: num(m.y, 100), z: num(m.z, 200), yw: num(m.yw, 20), t: now };
    roomOut(r, { t: 's', i: c.pid, x: num(m.x, 200), y: num(m.y, 100), z: num(m.z, 200), yw: num(m.yw, 20), pt: num(m.pt, 4), a: m.a ? 1 : 0, c: m.c ? 1 : 0, v: num(m.v, 30), w: Math.max(0, Math.min(63, m.w | 0)), k: typeof m.k === 'string' ? m.k.replace(/[^\w-]/g, '').slice(0, 24) : '', sl: m.sl ? 1 : 0 }, c);
  } else if (m.t === 'sync') {
    /* a client that is stuck on the vote screen asks where the room is: start the round if it is overdue, or send it the current round */
    if (now - (c.lsy || 0) < 2000) return; c.lsy = now;
    if ((r.ph === 'vote' || r.ph === 'break') && now >= r.vend && !r.solo) { try { startRound(r); if (r.pvp) pvpCheck(r); } catch (e) { console.error('sync start', e); } }
    else if (r.ph === 'play' && !r.solo) wsOut(c, { t: 'go', map: r.map, rn: r.rn | 0, rw: r.rw || [0, 0], sync: 1 });
  } else if (m.t === 'adm') {
    const cm = String(m.c || ''); c.role = roleOf(c.name); c.admin = c.role === 'admin';
    if (!c.admin && !(['freeze', 'killred'].includes(cm) && (c.role === 'tester' || c.role === 'dev'))) return;
    if (cm === 'time') { r.t0 = Math.min(Date.now() - 1000, r.t0 - 60000); if (Date.now() - r.t0 > 570000) r.t0 = Date.now() - 570000; roomOut(r, { t: 'clk', el: Date.now() - r.t0 }); return; }
    if (!['freeze', 'killred', 'auto', 'follow', 'hold', 'attack', 'defend', 'spread'].includes(cm) || r.host === c.pid) return;
    const h = r.pl.get(r.host); if (h) wsOut(h, { t: 'adm', c: cm, tm: c.tm, from: c.pid });
  } else if (m.t === 'ac') {
    /* room-scoped command. The server checks the sender's role from their name tag every time. */
    const cm = String(m.c || '').replace(/[^\w]/g, '').slice(0, 20); c.role = roleOf(c.name); c.admin = c.role === 'admin';
    if (!cm || !acAllowed(c.role, cm, !!r.test) || r.solo) return;
    if (now - (c.lac || 0) < 150) return; c.lac = now;
    const a = (m.a && typeof m.a === 'object') ? JSON.parse(JSON.stringify(m.a)) : {}; if (JSON.stringify(a).length > 600) return;
    if (m.to !== undefined) { if (!c.admin) return; }
    const tg = Array.isArray(m.to) ? m.to.slice(0, 24).map(x => x | 0) : (m.to === 'all' ? 'all' : null);
    const tl = tg === 'all' ? [...r.pl.values()] : (tg || []).map(x => r.pl.get(x)).filter(Boolean);
    if (c.admin) {
      /* server-side effects that must not be fakeable by the victim's client */
      if (cm === 'godon' || cm === 'inf') for (const o of tl) { o.god = 1; }
      if (cm === 'godoff') for (const o of tl) { o.god = 0; }
      if (cm === 'oneshot') for (const o of tl) o.os = a.on === false ? 0 : 1;
      if (cm === 'oneshotall' && a.on === false) for (const o of r.pl.values()) o.os = 0;
      if (cm === 'stopall') { r.evs = {}; for (const o of r.pl.values()) { o.god = 0; o.os = 0; } }
      else if (r.evs && a.round && a.on !== false) r.evs[cm] = { a, by: c.pid };
      else if (r.evs && a.on === false) delete r.evs[cm];
      if (cm === 'oneshotall' && a.on !== false) for (const o of r.pl.values()) o.os = 1;
    }
    roomOut(r, { t: 'ac', i: c.pid, c: cm, a, to: tg });
  } else if (m.t === 'pd') {
    if (r.co) { if (r.ph !== 'play') return; c.pa = false; coCheck(r); return; }
    if (!r.pvp || r.ph !== 'play') return; c.pa = false; pvpCheck(r);
  } else if (m.t === 'wv') {
    if (!r.co || r.host !== c.pid) return; const w = Math.max(0, Math.min(999, m.w | 0)); r.cw = w; if (m.p === 's') for (const o of r.pl.values()) o.pa = true;
    roomOut(r, { t: 'wv', w, l: Math.max(0, Math.min(999, m.l | 0)), a: Math.max(0, Math.min(20, m.a | 0)), p: m.p === 's' ? 's' : 'h' }, c);
  } else if (m.t === 'vis') {
    c.vis = m.v ? 1 : 0; fixHost(r);
  } else if (m.t === 'vote') {
    if (r.ph !== 'vote' || !mapsOf(r).includes(m.m)) return; r.votes.set(c.pid, m.m); roomOut(r, { t: 'vt', v: vcount(r) });
  } else if (m.t === 'nd') {
    if (now - (c.lg || 0) < 150) return; c.lg = now;
    roomOut(r, { t: 'nd', i: c.pid, tm: c.tm, k: m.k === 'sm' ? 'sm' : 'gr', x: num(m.x, 200), y: num(m.y, 50), z: num(m.z, 200), vx: num(m.vx, 60), vy: num(m.vy, 60), vz: num(m.vz, 60) }, c);
  } else if (m.t === 'nx') {
    if (now - (c.lx || 0) < 100) return; c.lx = now;
    roomOut(r, { t: 'nx', i: c.pid, tm: c.tm, x: num(m.x, 200), z: num(m.z, 200) }, c);
  } else if (m.t === 'ev') {
    if (now - (c.le0 || 0) > 1000) { c.le0 = now; c.len = 0; } if (++c.len > 60) return;
    roomOut(r, { t: 'ev', i: c.pid, k: m.k === 'b' ? 'b' : 'w', x: num(m.x, 200), y: num(m.y, 50), z: num(m.z, 200), a: m.a ? 1 : 0, px: num(m.px, 200), py: num(m.py, 50), pz: num(m.pz, 200), nx: num(m.nx, 2), ny: num(m.ny, 2), nz: num(m.nz, 2) }, c);
  } else if (m.t === 'dr') {
    if (now - (c.ld0 || 0) > 1000) { c.ld0 = now; c.ldn = 0; } if (++c.ldn > 80) return;
    const id = String(m.id || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20); if (!id) return;
    roomOut(r, { t: 'dr', i: c.pid, id, k: m.k === 'c' ? 'c' : 'g', v: Math.max(0, Math.min(60, m.v | 0)), x: num(m.x, 200), z: num(m.z, 200), y: num(m.y, 50) }, c);
  } else if (m.t === 'dp') {
    const id = String(m.id || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20); if (!id) return;
    roomOut(r, { t: 'dp', i: c.pid, id }, c);
  } else if (m.t === 'fx') {
    if (now - (c.lf || 0) < 40) return; c.lf = now;
    roomOut(r, { t: 'fx', i: c.pid, w: Math.max(0, Math.min(63, m.w | 0)) }, c);
  } else if (m.t === 'c') {
    const tx = cleanChat(String(m.m || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120));
    if (!tx || now - (c.lc || 0) < 700) return; c.lc = now;
    roomOut(r, { t: 'c', i: c.pid, n: c.name, tm: c.tm, m: tx });
  } else if (m.t === 'hit') {
    /* hits are spaced 12 ms apart, except that one shotgun volley (up to 10 pellets) arrives at once and every pellet counts */
    if (now - c.lh < 12) { if ((c.lb = (c.lb || 0) + 1) > 10) return; } else { c.lh = now; c.lb = 1; }
    if (r.pvp && r.ph !== 'play') return;
    const v = r.pl.get(m.to | 0), d = Math.round(Number(m.d));
    if (!v || v === c || (v.tm === c.tm && !r.test) || !(d >= 1 && d <= (r.pvp ? 500 : 1000))) return;
    let dd = d;
    if (m.bs && r.pvp) { const k = bsCheck(c, v, now, m.bs | 0); if (k === 0) return; if (k === 2) dd = Math.min(dd, 50); }
    if (v.god) return;
    if (r.evs && r.evs.hsonly && !m.hs) return;
    if (c.os) dd = 1000;
    wsOut(v, { t: 'hit', from: c.pid, d: dd, hs: m.hs ? 1 : 0 });
  } else if (m.t === 'hit2' && r.host === c.pid) {
    const v = r.pl.get(m.to | 0), d = Math.round(Number(m.d));
    if (!v || !(d >= 1 && d <= 60)) return;
    wsOut(v, { t: 'hit', from: -1, d, bn: String(m.bn || 'BOT').slice(0, 30) });
  } else if (m.t === 'bh' && r.host !== c.pid) {
    const h = r.pl.get(r.host), d = Math.round(Number(m.d)), i = m.i | 0;
    if (!h || i < 0 || i > 19 || !(d >= 1 && d <= 1000)) return;
    wsOut(h, { t: 'bh', from: c.pid, i, d, hs: m.hs ? 1 : 0 });
  } else if (m.t === 'kl') {
    if (r.ph !== 'play') return;
    const kt = m.kt === 1 ? 1 : 0; if (r.co) { const q = r.pl.get(m.kp | 0); if (q && kt === 0) q.k++; if (m.vp) c.d++; roomOut(r, { t: 'kl', src: c.pid, kp: (m.kp | 0), kt, kn: String(m.kn || '').slice(0, 30), vn: String(m.vn || '').slice(0, 30), hs: m.hs ? 1 : 0, vp: m.vp ? 1 : 0, sc: [0, 0], lb: lbOf(r) }); return; }
    r.sc[kt]++;
    const kc = r.pl.get(m.kp | 0); if (kc && kc.tm === kt) kc.k++; if (m.vp) c.d++;
    roomOut(r, { t: 'kl', src: c.pid, kp: (m.kp | 0), kt, kn: String(m.kn || '').slice(0, 30), vn: String(m.vn || '').slice(0, 30), hs: m.hs ? 1 : 0, vp: m.vp ? 1 : 0, sc: r.sc, lb: lbOf(r) });
    if (!r.pvp && r.sc[kt] >= 50) endRound(r, kt);
  } else if (m.t === 'b' && r.host === c.pid && Array.isArray(m.d)) {
    if (now - c.lb < 60) return; c.lb = now;
    roomOut(r, { t: 'b', d: m.d.slice(0, 20).map(a => Array.isArray(a) ? [num(a[0], 200), num(a[1], 200), num(a[2], 20), num(a[3], 1e5), num(a[4], 2), a[5] | 0, Math.max(0, Math.min(6000, a[6] | 0)), Math.max(0, Math.min(300, a[7] | 0)), num(a[8], 30)] : [0, 0, 0, 0, 0, 2, 0, 0, 0]) }, c);
  }
}
/* backstab check: 1 = fine, 2 = not a real backstab (counts as a plain knife hit), 0 = the same activation again */
function bsCheck(a, v, now, id) {
  if (id && id === a.bsId && now - (a.bsT || 0) < 2000) return 0;
  const quick = now - (a.bsT || 0) < 450;
  a.bsId = id; a.bsT = now;
  if (quick) return 2;
  const A = a.ps, V = v.ps;
  if (!A || !V || now - A.t > 2000 || now - V.t > 2000) return 2;
  const dx = A.x - V.x, dz = A.z - V.z, d = Math.hypot(dx, dz) || 1;
  if (d > 4.6 || Math.abs(A.y - V.y) > 2.6) return 2;
  if ((dx * -Math.sin(V.yw) + dz * -Math.cos(V.yw)) / d > 0.05) return 2;   /* the attacker must be in the back half of the victim */
  if (((-dx) * -Math.sin(A.yw) + (-dz) * -Math.cos(A.yw)) / d < 0.2) return 2; /* and look at them */
  return 1;
}
setInterval(() => {
  const n = Date.now();
  for (const r of ROOMS.values()) {
   try {
    if (r.solo || r.test) continue;
    if (r.co) { if ((r.ph === 'vote' || r.ph === 'break') && n >= r.vend) startRound(r); continue; }
    if (r.pvp) {
      if (r.ph === 'play' && n - r.t0 >= PVP_RT) { const a0 = pvpAlive(r, 0), a1 = pvpAlive(r, 1); pvpEnd(r, a0 > a1 ? 0 : a1 > a0 ? 1 : r.sc[0] > r.sc[1] ? 0 : r.sc[1] > r.sc[0] ? 1 : -1); }
      else if ((r.ph === 'vote' || r.ph === 'break') && n >= r.vend) { startRound(r); pvpCheck(r); }
      continue;
    }
    if (r.ph === 'play' && n - r.t0 >= 603000) endRound(r, r.sc[0] > r.sc[1] ? 0 : r.sc[1] > r.sc[0] ? 1 : -1);
    else if (r.ph === 'vote' && n >= r.vend) startRound(r);
   } catch (e) { console.error('room loop', r.id, e); }
  }
}, 500).unref();
/* players whose connection died without a goodbye (closed laptop, killed tab) would stay in the room forever: drop them after 90 s of silence (the game pings every 10 s) */
setInterval(() => {
  const n = Date.now();
  for (const r of [...ROOMS.values()]) {
    if (r.solo) continue;
    for (const c of [...r.pl.values()]) { if (!c.seen) c.seen = n; if (n - c.seen > (Number(process.env.GHOST_MS) || 90000)) { try { wsDrop(c); } catch (e) { } } }
  }
}, 10000).unref();
/* if the host stops sending bots (hidden window, frozen tab) hand the bots to a player who is still actively playing */
setInterval(() => {
  const n = Date.now();
  for (const r of ROOMS.values()) {
    if (r.pvp || r.pl.size < 2 || r.ph !== 'play') continue; const h = r.pl.get(r.host); if (!h) continue;
    if (n - Math.max(h.lb || 0, r.hs || 0) < 5000) continue;
    const cand = [...r.pl.values()].find(o => o !== h && n - (o.ls || 0) < 1500);
    if (cand) { r.host = cand.pid; r.hs = n; roomOut(r, { t: 'h', host: cand.pid }); }
  }
}, 2000).unref();
function wsOpen(sock, head) {
  const c = { sock, dead: false, room: null, ls: 0, lb: 0, lh: 0, seen: Date.now() }; let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0), frag = null;
  sock.setNoDelay(true); sock.setTimeout(0);
  const t0 = setTimeout(() => { if (!c.room) wsDrop(c); }, 8000);
  const eat = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > 65536) return wsDrop(c);
      if (buf.length < off + 4 + len) return;
      const mk = buf.subarray(off, off + 4), p = Buffer.from(buf.subarray(off + 4, off + 4 + len)); for (let i = 0; i < len; i++) p[i] ^= mk[i & 3];
      buf = buf.subarray(off + 4 + len); c.seen = Date.now();
      if (op === 8) { try { sock.write(wsFrame('', 8)); } catch (e) { } return wsDrop(c); }
      if (op === 9) { try { sock.write(wsFrame(p.toString(), 10)); } catch (e) { } continue; }
      if (op === 10) continue;
      if (op === 0 || op === 1) {
        frag = op === 1 ? p : Buffer.concat([frag || Buffer.alloc(0), p]); if (frag.length > 65536) return wsDrop(c);
        if (fin) { let m = null; try { m = JSON.parse(frag.toString()); } catch (e) { } frag = null; if (m) wsMsg(c, m); }
      }
    }
  };
  sock.on('data', d => { buf = Buffer.concat([buf, d]); try { eat(); } catch (e) { wsDrop(c); } });
  sock.on('close', () => { clearTimeout(t0); wsDrop(c); }); sock.on('error', () => wsDrop(c));
  c.timer = setInterval(() => { if (c.dead) return clearInterval(c.timer); if (Date.now() - c.seen > 40000) wsDrop(c); }, 10000); c.timer.unref();
  eat();
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = req.url.split('?')[0], ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (url === '/' || url === '/api/health') return send(res, 200, { ok: true, game: 'strikezone', storage: process.env.DATABASE_URL ? 'postgres' : 'file', rooms: ROOMS.size, online: USERS.size });
    if (url === '/api/online' && req.method === 'GET') {
      const id = (new URL(req.url, 'http://x').searchParams.get('id') || '').replace(/[^\w-]/g, '').slice(0, 24);
      if (id && new URL(req.url, 'http://x').searchParams.get('bye')) PRES.delete(id);
      else if (id && (PRES.has(id) || PRES.size < 5000)) PRES.set(id, Date.now());
      return send(res, 200, onlineInfo());
    }
    /* global chat: one shared room for everybody, in a match or on the home page. Anyone can read it; you need to be logged in to write. The last 100 messages are kept in memory only. */
    if (url === '/api/gchat' && req.method === 'GET') {
      let since = Math.max(0, Number(new URL(req.url, 'http://x').searchParams.get('since')) | 0); if (since > gcSeq) since = 0;   /* the server restarted: start again */
      const list = since ? GCHAT.filter(m => m.id > since).slice(-50) : GCHAT.slice(-30);
      return send(res, 200, { msgs: list, last: gcSeq });
    }
    if (url === '/api/gchat' && req.method === 'POST') {
      const u = await auth(req); if (!u) return send(res, 401, { error: 'Log in to use global chat.' });
      if (isBanned(u.name)) return send(res, 403, { error: BANNED_MSG, banned: true });
      const b = await body(req), t = Date.now(), k = String(u.name).toLowerCase();
      const tx = cleanChat(String(b.m || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120));
      if (!tx) return send(res, 400, { error: 'Type something first.' });
      const last = GC_LAST.get(k) || { t: 0, m: '' };
      if (t - last.t < 1500) return send(res, 429, { error: 'Slow down a little.' });
      if (last.m === tx && t - last.t < 15000) return send(res, 429, { error: 'You just said that.' });
      GC_LAST.set(k, { t, m: tx }); if (GC_LAST.size > 5000) GC_LAST.delete(GC_LAST.keys().next().value);
      const m = { id: ++gcSeq, n: u.name, m: tx, ts: t, a: isAdmin(u.name) ? 1 : 0 };
      GCHAT.push(m); while (GCHAT.length > 100) GCHAT.shift();
      return send(res, 200, { ok: true, id: m.id });
    }
    if (url === '/api/rooms' && req.method === 'GET') {
      const now = Date.now(), list = [...ROOMS.values()].filter(r => !r.priv).map(r => ({ id: r.id, name: r.name, n: r.pl.size, tc: tcOf(r), el: now - r.t0, sc: r.sc, ph: r.ph, map: r.map }));
      if (!list.some(r => r.n < MAXP)) list.push({ id: '', name: 'NEW GENERAL SERVER', n: 0, tc: [0, 0], el: 0, sc: [0, 0] });
      return send(res, 200, { rooms: list, max: MAXP, maxTeam: MAXT });
    }
    if (url === '/api/register' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const b = await body(req), name = String(b.user || ''), pw = String(b.pass || '');
      if (!NAME.test(name)) return send(res, 400, { error: 'Username must be 3 to 20 letters, numbers or underscores.' });
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: 'Password must be 8 to 100 characters.' });
      const salt = crypto.randomBytes(16).toString('hex'), id = await store.createUser(name, salt, await scrypt(pw, salt));
      if (!id) return send(res, 409, { error: 'That username is taken.' });
      return send(res, 200, { token: await startSession({ id }), user: name, admin: isAdmin(name), role: roleOf(name) });
    }
    if (url === '/api/login' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const b = await body(req), u = await store.userByName(String(b.user || '').toLowerCase()), pw = String(b.pass || '');
      const ok = u && crypto.timingSafeEqual(Buffer.from(await scrypt(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
      if (!ok) return send(res, 401, { error: 'Wrong username or password.' });
      if (isBanned(u.name)) return send(res, 403, { error: BANNED_MSG, banned: true });
      return send(res, 200, { token: await startSession(u), user: u.name, admin: isAdmin(u.name), role: roleOf(u.name) });
    }
    if (url === '/api/me' && req.method === 'GET') { const u = await auth(req); if (!u) return send(res, 401, { error: 'Please log in again.' }); return send(res, 200, { user: u.name, admin: isAdmin(u.name), role: roleOf(u.name) }); }
    if (url === '/api/logout' && req.method === 'POST') { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) await store.delSession(sha(h.slice(7))); return send(res, 200, { ok: true }); }
    if (url === '/api/event' && req.method === 'POST') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const b = await body(req), type = String(b.type || '');
      if (!EVT.has(type)) return send(res, 400, { error: 'Unknown event.' });
      if (Date.now() - lastEv < 250) return send(res, 429, { error: 'Slow down.' });
      lastEv = Date.now();
      const d = b.data && typeof b.data === 'object' ? b.data : {};
      const data = { on: !!d.on, team: d.team === 1 ? 1 : 0, text: type === 'dev' ? String(d.text || '').slice(0, 140) : '' };
      const e = { seq: ++evSeq, id: String(b.id || '').slice(0, 40) || 's' + evSeq, type, data, ts: Date.now() };
      EVS.push(e); while (EVS.length > 100 || (EVS.length && e.ts - EVS[0].ts > 120000)) EVS.shift();
      return send(res, 200, { ok: true, seq: evSeq });
    }
    /* the event timer: the admin starts a named countdown, everybody's home screen polls GET /api/live. It is saved in the database so it survives restarts. */
    if (url === '/api/live' && req.method === 'GET') return send(res, 200, { now: Date.now(), ev: LIVE });
    if (url === '/api/live' && req.method === 'POST') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const b = await body(req);
      if (b.action === 'stop') { LIVE = null; await store.kvDel('live'); return send(res, 200, { ok: true, now: Date.now(), ev: null }); }
      if (b.action !== 'start') return send(res, 400, { error: 'Unknown action.' });
      const nm = String(b.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!nm) return send(res, 400, { error: 'Type a name for the event.' });
      const ms = Math.round(Number(b.ms));
      if (!(ms >= 0) || ms > 366 * 864e5) return send(res, 400, { error: 'The timer must be between 0 and 366 days.' });
      LIVE = { n: nm, end: Date.now() + ms, set: Date.now() };
      await store.kvSet('live', JSON.stringify(LIVE));
      return send(res, 200, { ok: true, now: Date.now(), ev: LIVE });
    }
    if (url === '/api/events' && req.method === 'GET') {
      const since = Number((req.url.split('since=')[1] || '').split('&')[0]), now = Date.now();
      const list = EVS.filter(e => (since >= 0 ? e.seq > since : now - e.ts < 15000) && now - e.ts < 60000).map(e => ({ seq: e.seq, id: e.id, type: e.type, data: e.data, age: now - e.ts }));
      return send(res, 200, { seq: evSeq, events: list });
    }
    if (url === '/api/leaderboard' && req.method === 'GET') {
      const day = dayKey(), nowt = Date.now();
      if (!lbCache || lbCache.day !== day || nowt - lbCacheAt > 20000) { lbCache = { day, g: (await store.lbTop(100 + BANS.size)).filter(x => !isBanned(x.n)).slice(0, 100), d: (await store.lbDay(day, 10 + BANS.size)).filter(x => !isBanned(x.n)).slice(0, 10) }; lbCacheAt = nowt; }
      const out = { day, g: lbCache.g.map(x => ({ n: x.n, p: x.p, t: titleOf(x.n) })), d: lbCache.d.map(x => ({ n: x.n, p: x.p, t: titleOf(x.n) })), me: null };
      const u = await auth(req); if (u && !isBanned(u.name)) out.me = await store.lbMe(u.id, day);
      return send(res, 200, out);
    }
    if (url === '/api/titles' && req.method === 'GET') { const t = {}; for (const [k, v] of TITLES) t[k] = [v.t, v.c]; return send(res, 200, { titles: t }); }
    if (url === '/api/title' && req.method === 'POST') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const b = await body(req), un = String(b.user || '').trim();
      if (!NAME.test(un)) return send(res, 400, { error: 'Type the exact username of the player.' });
      const target = await store.userByName(un.toLowerCase()); if (!target) return send(res, 404, { error: 'No player has that username.' });
      const txt = String(b.text || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
      if (!txt) { await store.titleDel(un.toLowerCase()); TITLES.delete(un.toLowerCase()); rolePush(target); return send(res, 200, { ok: true, removed: true }); }
      const col = HEX.test(String(b.color || '')) ? String(b.color).toLowerCase() : '#ffd400';
      await store.titleSet(un.toLowerCase(), target.name, txt, col); TITLES.set(un.toLowerCase(), { n: target.name, t: txt, c: col }); rolePush(target);
      return send(res, 200, { ok: true, user: target.name, text: txt, color: col });
    }
    /* admin coin gifts: the admin gives coins to a username, they wait in the database until that player's game claims them */
    if (url === '/api/admin/users' && req.method === 'GET') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const q = String((new URL(req.url, 'http://x')).searchParams.get('q') || '').toLowerCase().slice(0, 30);
      const list = await store.listUsers(q, 60); return send(res, 200, { users: list.map(x => ({ n: x.n, p: x.p, b: isBanned(x.n) })), banned: [...BANS] });
    }
    if (url === '/api/admin/ban' && req.method === 'POST') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const b = await body(req), un = String(b.user || '').trim(), t = await store.userByName(un.toLowerCase()); if (!t) return send(res, 404, { error: 'No player has that username.' });
      if (isAdmin(t.name)) return send(res, 400, { error: 'You cannot ban an admin.' });
      if (b.banned) BANS.add(t.name.toLowerCase()); else BANS.delete(t.name.toLowerCase());
      await saveBans(); lbCache = null; return send(res, 200, { ok: true, user: t.name, banned: !!b.banned });
    }
    if (url === '/api/admin/reset' && req.method === 'POST') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const b = await body(req), t = await resetUser(String(b.user || '').trim()); if (!t) return send(res, 404, { error: 'No player has that username.' });
      return send(res, 200, { ok: true, user: t.name });
    }
    if (url === '/api/gift' && req.method === 'POST') {
      const u = await auth(req); if (!u || !isAdmin(u.name)) return send(res, 403, { error: 'Admins only.' });
      const b = await body(req), un = String(b.user || '').trim(), n = Math.round(Number(b.amount));
      if (!NAME.test(un)) return send(res, 400, { error: 'Type the exact username of the player.' });
      if (!(n >= 1) || n > 1000000) return send(res, 400, { error: 'The amount must be between 1 and 1,000,000 coins.' });
      const target = await store.userByName(un.toLowerCase()); if (!target) return send(res, 404, { error: 'No player has that username.' });
      const k = 'gift:' + target.name.toLowerCase(), cur = Math.max(0, Math.round(Number(await store.kvGet(k)) || 0));
      await store.kvSet(k, String(Math.min(cur + n, 5e7)));
      return send(res, 200, { ok: true, user: target.name, amount: n });
    }
    if (url === '/api/gift' && req.method === 'GET') {
      const u = await auth(req); if (!u) return send(res, 401, { error: 'Please log in again.' });
      return send(res, 200, { n: Math.max(0, Math.round(Number(await store.kvGet('gift:' + u.name.toLowerCase())) || 0)) });
    }
    if (url === '/api/gift/claim' && req.method === 'POST') {
      const u = await auth(req); if (!u) return send(res, 401, { error: 'Please log in again.' });
      const k = 'gift:' + u.name.toLowerCase(), n = Math.max(0, Math.round(Number(await store.kvGet(k)) || 0));
      if (!n) return send(res, 200, { n: 0 });
      await store.kvDel(k);
      try { const prev = await store.getSave(u.id); if (prev) { const d = JSON.parse(prev.data); d.coins = Math.min(5e7, Math.round((d.coins || 0) + n)); await store.putSave(u.id, JSON.stringify(d), prev.upd, prev.at); } } catch (e) { console.error('gift', e.message); }
      return send(res, 200, { n });
    }
    if (url === '/api/save') {
      const u = await auth(req); if (!u) return send(res, 401, { error: 'Please log in again.' });
      if (req.method === 'PUT') { const cc = USERS.get(u.id); if (cc && cc.room && cc.room.test) return send(res, 200, { ok: true, upd: Date.now(), test: 1 }); }   /* nothing played in the test server is ever saved */
      if (isBanned(u.name)) return send(res, 403, { error: BANNED_MSG, banned: true });
      const rst = await store.kvGet('rst:' + u.name.toLowerCase());
      if (req.method === 'GET') { const s = await store.getSave(u.id); return send(res, 200, { user: u.name, admin: isAdmin(u.name), save: s ? JSON.parse(s.data) : null, upd: s ? s.upd : 0, rst: rst || '' }); }
      if (req.method === 'PUT') {
        const b = await body(req), save = cleanSave(b.save); if (!save) return send(res, 400, { error: 'Invalid save.' });
        if (rst && String(b.rst || '') !== rst) return send(res, 409, { error: 'This account was reset.', rst });
        const now = Date.now(), prev = await store.getSave(u.id), upd = Math.min(Number(b.upd) || now, now + 60000);
        if (!isAdmin(u.name) && !plausible(save, prev, now)) return send(res, 422, { error: 'That save has progress that is not possible, so your last valid progress was restored.', save: prev ? JSON.parse(prev.data) : null, upd: prev ? prev.upd : 0 });
        await store.putSave(u.id, JSON.stringify(save), upd, now);
        try { const np = Math.max(0, Math.round(save.pts || 0)), op = prev ? Math.max(0, Math.round(JSON.parse(prev.data).pts || 0)) : np; await store.lbSet(u.id, u.name, np, Math.max(0, Math.min(np - op, 200000)), dayKey()); lbCache = null; } catch (e) { console.error('lb', e.message); }
        return send(res, 200, { ok: true, upd });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e.message);
    send(res, e.message === 'too big' ? 413 : e.message === 'bad json' ? 400 : 500, { error: e.message === 'too big' ? 'Save too large.' : e.message === 'bad json' ? 'Bad request.' : 'Server error.' });
  }
});
server.on('upgrade', (req, sock, head) => {
  try {
    const key = req.headers['sec-websocket-key'];
    if (req.url.split('?')[0] !== '/ws' || !key) { sock.destroy(); return; }
    const acc = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    wsOpen(sock, head);
  } catch (e) { try { sock.destroy(); } catch (x) { } }
});
store.init().then(async () => { try { for (const n of JSON.parse(await store.kvGet('bans') || '[]')) BANS.add(String(n).toLowerCase()); for (const n of ['nate', 'nihdih']) if (!(await store.kvGet('autoreset1:' + n))) { const r = await resetUser(n); console.log('reset', n, r ? 'done' : 'no such user yet'); if (r) await store.kvSet('autoreset1:' + n, '1'); } } catch (e) { console.error('boot', e.message); } for (const r of await store.titlesAll()) TITLES.set(r.lname, { n: r.name, t: r.txt, c: r.col }); try { const l = JSON.parse(await store.kvGet('live') || 'null'); if (l && typeof l.n === 'string' && Number.isFinite(l.end)) LIVE = l; } catch (e) { } }).then(() => server.listen(PORT, () => console.log('STRIKEZONE server on port ' + PORT + ' (' + (process.env.DATABASE_URL ? 'postgres' : 'file storage') + ')')))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
