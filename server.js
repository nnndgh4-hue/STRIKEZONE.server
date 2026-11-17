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
/* live events: the admin posts one, every player's game polls for new ones (kept in memory for 2 minutes) */
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
/* ---------- live play (WebSocket, no extra packages) ---------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAXT = 10, MAXP = 12;
const ROOMS = new Map();   // room id -> { id, pl: Map(pid -> client), host, nextId }
let roomN = 0;
const wsFrame = (str, op) => { const p = Buffer.from(str), n = p.length; let h; if (n < 126) h = Buffer.from([0x80 | (op || 1), n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | (op || 1); h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | (op || 1); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); } return Buffer.concat([h, p]); };
const tcOf = r => { const t = [0, 0]; for (const c of r.pl.values()) t[c.tm]++; return t; };
const wsOut = (c, o) => { if (c.dead) return; try { c.sock.write(wsFrame(JSON.stringify(o))); } catch (e) { } };
const roomOut = (r, o, skip) => { const f = wsFrame(JSON.stringify(o)); for (const c of r.pl.values()) if (c !== skip && !c.dead) { try { c.sock.write(f); } catch (e) { } } };
function findRoom(team) {
  for (const r of ROOMS.values()) if (r.pl.size < MAXP && tcOf(r)[team] < MAXT) return r;
  const r = { id: 'general-' + (++roomN), pl: new Map(), host: 0, nextId: 1 }; ROOMS.set(r.id, r); return r;
}
function wsDrop(c) {
  if (c.dead) return; c.dead = true; try { c.sock.destroy(); } catch (e) { }
  if (c.user) { if (USERS.get(c.user.id) === c) USERS.delete(c.user.id); }
  const r = c.room; if (!r) return; r.pl.delete(c.pid);
  if (!r.pl.size) { ROOMS.delete(r.id); return; }
  roomOut(r, { t: 'pl', id: c.pid }); roomOut(r, { t: 'tc', tc: tcOf(r) });
  if (r.host === c.pid) { r.host = r.pl.keys().next().value; roomOut(r, { t: 'h', host: r.host }); }
}
const num = (v, lim) => { v = Number(v); return Number.isFinite(v) ? Math.max(-lim, Math.min(lim, Math.round(v * 100) / 100)) : 0; };
const USERS = new Map();   // user id -> client (one connection per account)
function wsMsg(c, m) {
  if (c.dead || !m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return wsOut(c, { t: 'pong' });
  if (!c.room) {
    if (m.t !== 'join' || c.joining) return; c.joining = true;
    store.sessionUser(sha(String(m.token || ''))).then(u => {
      if (!u || c.dead) { wsOut(c, { t: 'err', m: 'Please log in again.' }); return wsDrop(c); }
      const old = USERS.get(u.id); if (old && old !== c) { wsOut(old, { t: 'err', m: 'You joined from another place.' }); wsDrop(old); }
      const team = m.team === 1 ? 1 : 0, r = findRoom(team), pid = r.nextId++;
      c.user = u; USERS.set(u.id, c); c.room = r; c.pid = pid; c.tm = tcOf(r)[team] < MAXT ? team : 1 - team; c.name = u.name; c.ch = Math.max(0, Math.min(99, m.ch | 0)); c.admin = isAdmin(u.name);
      if (!r.host) r.host = pid;
      const list = [...r.pl.values()].map(o => ({ id: o.pid, n: o.name, tm: o.tm, ch: o.ch }));
      r.pl.set(pid, c);
      wsOut(c, { t: 'w', id: pid, room: r.id, host: r.host, tm: c.tm, pl: list, tc: tcOf(r) });
      roomOut(r, { t: 'pj', p: { id: pid, n: c.name, tm: c.tm, ch: c.ch } }, c); roomOut(r, { t: 'tc', tc: tcOf(r) });
    }).catch(() => wsDrop(c));
    return;
  }
  const r = c.room, now = Date.now();
  if (m.t === 's') {
    if (now - c.ls < 30) return; c.ls = now;
    roomOut(r, { t: 's', i: c.pid, x: num(m.x, 200), y: num(m.y, 100), z: num(m.z, 200), yw: num(m.yw, 20), pt: num(m.pt, 4), a: m.a ? 1 : 0, c: m.c ? 1 : 0, v: num(m.v, 30) }, c);
  } else if (m.t === 'b' && r.host === c.pid && Array.isArray(m.d)) {
    if (now - c.lb < 60) return; c.lb = now;
    roomOut(r, { t: 'b', d: m.d.slice(0, 20).map(a => Array.isArray(a) ? [num(a[0], 200), num(a[1], 200), num(a[2], 20), num(a[3], 1e5), num(a[4], 2), a[5] | 0] : [0, 0, 0, 0, 0, 2]) }, c);
  }
}
function wsOpen(sock, head) {
  const c = { sock, dead: false, room: null, ls: 0, lb: 0, seen: Date.now() }; let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0), frag = null;
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
    if (url === '/api/events' && req.method === 'GET') {
      const since = Number((req.url.split('since=')[1] || '').split('&')[0]), now = Date.now();
      const list = EVS.filter(e => (since >= 0 ? e.seq > since : now - e.ts < 15000) && now - e.ts < 60000).map(e => ({ seq: e.seq, id: e.id, type: e.type, data: e.data, age: now - e.ts }));
      return send(res, 200, { seq: evSeq, events: list });
    }
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
server.on('upgrade', (req, sock, head) => {
  try {
    const key = req.headers['sec-websocket-key'];
    if (req.url.split('?')[0] !== '/ws' || !key) { sock.destroy(); return; }
    const acc = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    wsOpen(sock, head);
  } catch (e) { try { sock.destroy(); } catch (x) { } }
});
store.init().then(() => server.listen(PORT, () => console.log('STRIKEZONE server on port ' + PORT + ' (' + (process.env.DATABASE_URL ? 'postgres' : 'file storage') + ')')))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
