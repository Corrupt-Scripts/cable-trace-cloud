// Cable Trace on Cloudflare: Worker + D1 (database) + R2 (files). No dependencies.
// Accounts are email + password. A site-wide SIGNUP_CODE creates a new team; the team
// owner then hands out invite codes so staff join that team. Everyone in a team shares jobs.

const enc = new TextEncoder();
const KINDS = new Set(['job', 'run', 'samples', 'drawing']);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_DOC = 1_800_000;          // D1 rows max out at 2 MB
const MAX_FILE = 25 * 1024 * 1024;
const PBKDF2_ITER = 100000;         // Workers' maximum
const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
const fail = (status, error) => json({ error }, status);

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITER }, key, 256));
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256hex(a), sha256hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

async function readJson(request, limit = 3_000_000) {
  const text = await request.text();
  if (text.length > limit) throw Object.assign(new Error('too large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

// ---- login throttling: 10 failures per 15 minutes per email and per IP ----
async function throttled(env, keys) {
  const now = Date.now();
  for (const k of keys) {
    const r = await env.DB.prepare('SELECT count, window_start FROM attempts WHERE key = ?').bind(k).first();
    if (r && now - r.window_start < 15 * 60 * 1000 && r.count >= 10) return true;
  }
  return false;
}
async function noteFailure(env, keys) {
  const now = Date.now();
  for (const k of keys) {
    await env.DB.prepare(
      `INSERT INTO attempts(key, count, window_start) VALUES(?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN ? - window_start >= 900000 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ? - window_start >= 900000 THEN ? ELSE window_start END`
    ).bind(k, now, now, now, now).run();
  }
}
const clearFailures = (env, key) => env.DB.prepare('DELETE FROM attempts WHERE key = ?').bind(key).run();

// ---- sessions ----
async function newSession(env, userId) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)')
    .bind(await sha256hex(token), userId, Date.now() + SESSION_MS).run();
  // tidy expired sessions now and then
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  return token;
}

async function authenticate(request, env, url) {
  let token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  // <img> tags can't send headers, so file GETs also accept ?token=
  if (!token && request.method === 'GET' && url.pathname.startsWith('/api/files/')) token = url.searchParams.get('token') || '';
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.team_id, u.role, t.name AS team_name
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN teams t ON t.id = u.team_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256hex(token), Date.now()).first();
  return row || null;
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, team: { id: u.team_id, name: u.team_name } });

// ---- auth handlers ----
async function signup(request, env) {
  const b = await readJson(request);
  const email = normEmail(b.email), name = String(b.name || '').trim().slice(0, 80), password = String(b.password || '');
  const code = String(b.code || '').trim();
  if (!validEmail(email)) return fail(400, 'Enter a valid email address');
  if (!name) return fail(400, 'Enter your name');
  if (password.length < 10) return fail(400, 'Password must be at least 10 characters');
  if (!code) return fail(400, 'Enter an invite code');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const keys = [`signup:ip:${ip}`];
  if (await throttled(env, keys)) return fail(429, 'Too many attempts. Try again later.');

  let teamId, role, inviteId = null;
  if (env.SIGNUP_CODE && (await safeEqual(code, env.SIGNUP_CODE))) {
    teamId = crypto.randomUUID(); role = 'owner';
  } else {
    const inv = await env.DB.prepare('SELECT id, team_id FROM invites WHERE code_hash = ? AND expires_at > ? AND uses_left > 0')
      .bind(await sha256hex(code.toUpperCase()), Date.now()).first();
    if (!inv) { await noteFailure(env, keys); return fail(403, 'That invite code is not valid or has expired'); }
    teamId = inv.team_id; role = 'member'; inviteId = inv.id;
  }
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) return fail(409, 'An account with that email already exists');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const userId = crypto.randomUUID(), now = Date.now();
  const stmts = [];
  if (role === 'owner') {
    stmts.push(env.DB.prepare('INSERT INTO teams(id, name, created_at) VALUES(?,?,?)')
      .bind(teamId, String(b.teamName || '').trim().slice(0, 80) || `${name}'s team`, now));
  }
  stmts.push(env.DB.prepare('INSERT INTO users(id, email, name, pw_hash, pw_salt, team_id, role, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(userId, email, name, await hashPassword(password, salt), b64(salt), teamId, role, now));
  if (inviteId) stmts.push(env.DB.prepare('UPDATE invites SET uses_left = uses_left - 1 WHERE id = ?').bind(inviteId));
  await env.DB.batch(stmts);

  const token = await newSession(env, userId);
  const u = await env.DB.prepare('SELECT u.id,u.email,u.name,u.team_id,u.role,t.name AS team_name FROM users u JOIN teams t ON t.id=u.team_id WHERE u.id=?').bind(userId).first();
  return json({ token, user: publicUser(u) });
}

async function login(request, env) {
  const b = await readJson(request);
  const email = normEmail(b.email), password = String(b.password || '');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const keys = [`login:email:${email}`, `login:ip:${ip}`];
  if (await throttled(env, keys)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
  const u = await env.DB.prepare(
    'SELECT u.id,u.email,u.name,u.team_id,u.role,u.pw_hash,u.pw_salt,t.name AS team_name FROM users u JOIN teams t ON t.id=u.team_id WHERE u.email = ?'
  ).bind(email).first();
  // hash even when the user doesn't exist so timing doesn't reveal which emails have accounts
  const salt = u ? unb64(u.pw_salt) : new Uint8Array(16);
  const hash = await hashPassword(password, salt);
  if (!u || !(await safeEqual(hash, u.pw_hash))) { await noteFailure(env, keys); return fail(401, 'Wrong email or password'); }
  await clearFailures(env, keys[0]);
  return json({ token: await newSession(env, u.id), user: publicUser(u) });
}

async function changePassword(request, env, me) {
  const b = await readJson(request);
  const row = await env.DB.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').bind(me.id).first();
  if (!(await safeEqual(await hashPassword(String(b.current || ''), unb64(row.pw_salt)), row.pw_hash))) return fail(403, 'Current password is wrong');
  const next = String(b.next || '');
  if (next.length < 10) return fail(400, 'New password must be at least 10 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').bind(await hashPassword(next, salt), b64(salt), me.id),
    // sign every other device out; the caller gets a fresh session
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(me.id),
  ]);
  return json({ token: await newSession(env, me.id) });
}

// ---- team ----
async function teamInfo(env, me) {
  const members = (await env.DB.prepare('SELECT id, email, name, role, created_at FROM users WHERE team_id = ? ORDER BY created_at').bind(me.team_id).all()).results;
  const invites = me.role === 'owner'
    ? (await env.DB.prepare('SELECT id, created_at, expires_at, uses_left FROM invites WHERE team_id = ? AND expires_at > ? AND uses_left > 0 ORDER BY created_at DESC').bind(me.team_id, Date.now()).all()).results
    : [];
  return json({ team: { id: me.team_id, name: me.team_name }, members, invites });
}

async function createInvite(request, env, me) {
  if (me.role !== 'owner') return fail(403, 'Only the team owner can create invite codes');
  const b = await readJson(request);
  const uses = Math.max(1, Math.min(20, Number(b.uses) || 5));
  const days = Math.max(1, Math.min(60, Number(b.days) || 14));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...crypto.getRandomValues(new Uint8Array(10))].map((v) => alphabet[v % alphabet.length]).join('');
  await env.DB.prepare('INSERT INTO invites(id, code_hash, team_id, created_by, created_at, expires_at, uses_left) VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), await sha256hex(code), me.team_id, me.id, Date.now(), Date.now() + days * 86400000, uses).run();
  return json({ code, uses, days });
}

// ---- sync ----
async function syncGet(env, me, url) {
  const since = Number(url.searchParams.get('since') || 0) || 0;
  const rows = (await env.DB.prepare('SELECT kind, id, data, updated_at, deleted, seq FROM docs WHERE team_id = ? AND seq > ? ORDER BY seq LIMIT 500')
    .bind(me.team_id, since).all()).results;
  const docs = rows.map((r) => ({ kind: r.kind, id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq }));
  return json({ docs, seq: rows.length ? rows[rows.length - 1].seq : since, more: rows.length === 500 });
}

async function syncPost(request, env, me) {
  const body = await readJson(request, 20_000_000);
  const applied = [], rejected = [], stmts = [], meta = [];
  for (const d of body.docs || []) {
    if (!KINDS.has(d.kind) || typeof d.id !== 'string' || !d.id || d.id.length > 80 || typeof d.updatedAt !== 'number') {
      rejected.push({ kind: d.kind, id: d.id, reason: 'invalid' }); continue;
    }
    const data = JSON.stringify(d.data ?? {});
    if (data.length > MAX_DOC) { rejected.push({ kind: d.kind, id: d.id, reason: 'too large' }); continue; }
    // seq is assigned in the same statement; the WHERE keeps last-write-wins
    stmts.push(env.DB.prepare(
      `INSERT INTO docs(team_id, kind, id, data, updated_at, deleted, seq)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM docs WHERE team_id = ?1))
       ON CONFLICT(team_id, kind, id) DO UPDATE SET
         data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq
       WHERE docs.updated_at <= excluded.updated_at`
    ).bind(me.team_id, d.kind, d.id, data, d.updatedAt, d.deleted ? 1 : 0));
    meta.push({ kind: d.kind, id: d.id });
  }
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    res.forEach((r, i) => (r.meta.changes > 0 ? applied : rejected).push(r.meta.changes > 0 ? meta[i] : { ...meta[i], reason: 'newer on server' }));
  }
  return json({ applied, rejected });
}

// ---- files (R2), namespaced per team ----
async function files(request, env, me, name) {
  if (!SAFE_NAME.test(name) || name.startsWith('.')) return fail(400, 'bad file name');
  const key = `${me.team_id}/${name}`;
  if (request.method === 'PUT') {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_FILE) return fail(413, 'too large');
    await env.FILES.put(key, buf, { httpMetadata: { contentType: request.headers.get('Content-Type') || contentTypeFor(name) } });
    return json({ ok: true, size: buf.byteLength });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const obj = request.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key);
    if (!obj) return fail(404, 'not found');
    const headers = { 'Content-Type': contentTypeFor(name), 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
    return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
  }
  return fail(405, 'method not allowed');
}

function contentTypeFor(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }[ext] || 'application/octet-stream';
}

// ---- router ----
async function handleApi(request, env, url) {
  const p = url.pathname, m = request.method;
  if (p === '/api/ping') return json({ ok: true, name: 'cable-trace', version: 2, accounts: true, signupCodeSet: !!env.SIGNUP_CODE });
  if (p === '/api/auth/signup' && m === 'POST') return signup(request, env);
  if (p === '/api/auth/login' && m === 'POST') return login(request, env);

  const me = await authenticate(request, env, url);
  if (!me) return fail(401, 'unauthorised');

  if (p === '/api/me' && m === 'GET') return json({ user: publicUser(me) });
  if (p === '/api/auth/logout' && m === 'POST') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
    return json({ ok: true });
  }
  if (p === '/api/auth/password' && m === 'POST') return changePassword(request, env, me);
  if (p === '/api/team' && m === 'GET') return teamInfo(env, me);
  if (p === '/api/team/invites' && m === 'POST') return createInvite(request, env, me);

  let mm = p.match(/^\/api\/team\/invites\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    if (me.role !== 'owner') return fail(403, 'Only the team owner can do that');
    await env.DB.prepare('DELETE FROM invites WHERE id = ? AND team_id = ?').bind(mm[1], me.team_id).run();
    return json({ ok: true });
  }
  mm = p.match(/^\/api\/team\/members\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    if (me.role !== 'owner') return fail(403, 'Only the team owner can remove people');
    if (mm[1] === me.id) return fail(400, 'You can\'t remove yourself');
    await env.DB.prepare('DELETE FROM users WHERE id = ? AND team_id = ?').bind(mm[1], me.team_id).run();
    return json({ ok: true });
  }

  if (p === '/api/sync' && m === 'GET') return syncGet(env, me, url);
  if (p === '/api/sync' && m === 'POST') return syncPost(request, env, me);
  mm = p.match(/^\/api\/files\/([^/]+)$/);
  if (mm) return files(request, env, me, decodeURIComponent(mm[1]));
  return fail(404, 'not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e.status) return fail(e.status, e.message);
      console.error(e);
      return fail(500, 'server error');
    }
  },
};
