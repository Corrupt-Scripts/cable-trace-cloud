// Data layer: pulls every document into memory, saves edits with last-write-wins.
const KEY = 'ct_token';
export const state = { token: localStorage.getItem(KEY) || '', user: null, seq: 0, docs: new Map(), online: true };
const subs = new Set();
export const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const emit = () => subs.forEach((f) => f());
const k = (kind, id) => `${kind}:${id}`;

export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { Authorization: 'Bearer ' + state.token, ...(opts.headers || {}) } });
  if (r.status === 401) { const e = new Error('unauthorised'); e.status = 401; throw e; }
  if (!r.ok) {
    let msg = `${path}: ${r.status}`;
    try { msg = (await r.clone().json()).error || msg; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}

export async function pull() {
  let more = true;
  while (more) {
    const j = await (await api(`/api/sync?since=${state.seq}`)).json();
    for (const d of j.docs) state.docs.set(k(d.kind, d.id), d);
    state.seq = j.seq; more = j.more;
  }
  state.online = true;
  emit();
}

async function authCall(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Error ${r.status}`); e.status = r.status; throw e; }
  state.token = j.token; state.user = j.user; state.seq = 0; state.docs.clear();
  localStorage.setItem(KEY, j.token);
  await pull();
}
export const login = (email, password) => authCall('/api/auth/login', { email, password });
export const signup = (fields) => authCall('/api/auth/signup', fields);
export async function loadMe() { state.user = (await (await api('/api/me')).json()).user; }
export async function logout() {
  try { if (state.token) await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token } }); } catch {}
  localStorage.removeItem(KEY); state.token = ''; state.user = null; state.docs.clear(); state.seq = 0; emit();
}
export async function changePassword(current, next) {
  const j = await (await api('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }) })).json();
  state.token = j.token; localStorage.setItem(KEY, j.token);
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
export const get = (kind, id) => { const d = state.docs.get(k(kind, id)); return d && !d.deleted ? { id, ...d.data } : null; };
export const list = (kind) => [...state.docs.values()].filter((d) => d.kind === kind && !d.deleted).map((d) => ({ id: d.id, ...d.data }));

export async function save(kind, id, data) {
  const { id: _drop, ...clean } = data;
  const doc = { kind, id, data: clean, updatedAt: Date.now(), deleted: false };
  state.docs.set(k(kind, id), doc);
  emit();
  const r = await (await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs: [doc] }) })).json();
  if (r.rejected?.length) await pull();
  return id;
}

export async function remove(kind, id) {
  const cur = state.docs.get(k(kind, id));
  if (!cur) return;
  const doc = { kind, id, data: cur.data, updatedAt: Date.now(), deleted: true };
  state.docs.set(k(kind, id), doc);
  emit();
  await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs: [doc] }) });
}

export const fileUrl = (name) => `/api/files/${encodeURIComponent(name)}?token=${encodeURIComponent(state.token)}`;

/** Downscales big photos (max 3000 px), uploads, returns the stored file name. */
export async function uploadImage(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const name = `${hash}.jpg`;
  await api(`/api/files/${name}`, { method: 'PUT', body: blob });
  return { name, width: c.width, height: c.height };
}

setInterval(() => { if (state.token) pull().catch((e) => { if (e.status !== 401) { state.online = false; emit(); } }); }, 10000);
