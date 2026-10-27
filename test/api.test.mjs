// Run against `wrangler dev --local` with --var SIGNUP_CODE:founder-code-123
import test from 'node:test';
import assert from 'node:assert/strict';
const B = process.env.CT_URL || 'http://localhost:8787';
const CODE = process.env.CT_SIGNUP || 'founder-code-123';
const j = async (method, path, body, token) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const rnd = Math.random().toString(36).slice(2, 8);
let a, b, c, invite;

test('signup creates a team; bad codes and weak passwords rejected', async () => {
  assert.equal((await j('POST', '/api/auth/signup', { email: `a${rnd}@x.com`, name: 'A', password: 'short', code: CODE })).status, 400);
  assert.equal((await j('POST', '/api/auth/signup', { email: `a${rnd}@x.com`, name: 'A', password: 'longenough123', code: 'nope' })).status, 403);
  const r = await j('POST', '/api/auth/signup', { email: `a${rnd}@x.com`, name: 'A', password: 'longenough123', code: CODE, teamName: 'Team A' });
  assert.equal(r.status, 200); a = r.data; assert.equal(a.user.role, 'owner'); assert.equal(a.user.team.name, 'Team A');
  assert.equal((await j('POST', '/api/auth/signup', { email: `a${rnd}@x.com`, name: 'A', password: 'longenough123', code: CODE })).status, 409);
});

test('invite lets a second user join the same team; members cannot invite', async () => {
  const inv = await j('POST', '/api/team/invites', { uses: 1 }, a.token);
  assert.equal(inv.status, 200); invite = inv.data.code;
  const r = await j('POST', '/api/auth/signup', { email: `b${rnd}@x.com`, name: 'B', password: 'longenough123', code: invite.toLowerCase() });
  assert.equal(r.status, 200); b = r.data; assert.equal(b.user.role, 'member'); assert.equal(b.user.team.id, a.user.team.id);
  assert.equal((await j('POST', '/api/team/invites', {}, b.token)).status, 403);
  // single-use invite is now spent
  assert.equal((await j('POST', '/api/auth/signup', { email: `z${rnd}@x.com`, name: 'Z', password: 'longenough123', code: invite })).status, 403);
  const t = await j('GET', '/api/team', null, a.token);
  assert.equal(t.data.members.length, 2);
});

test('login, wrong password, me, logout', async () => {
  assert.equal((await j('POST', '/api/auth/login', { email: `a${rnd}@x.com`, password: 'wrongwrongwrong' })).status, 401);
  const l = await j('POST', '/api/auth/login', { email: `A${rnd}@X.com`, password: 'longenough123' });
  assert.equal(l.status, 200);
  assert.equal((await j('GET', '/api/me', null, l.data.token)).data.user.email, `a${rnd}@x.com`);
  assert.equal((await j('POST', '/api/auth/logout', {}, l.data.token)).status, 200);
  assert.equal((await j('GET', '/api/me', null, l.data.token)).status, 401);
  assert.equal((await j('GET', '/api/sync')).status, 401);
});

test('sync is shared within a team, isolated between teams, LWW + seq', async () => {
  const put = (tok, id, name, at) => j('POST', '/api/sync', { docs: [{ kind: 'job', id, updatedAt: at, data: { uid: id, name } }] }, tok);
  assert.equal((await put(a.token, 'job1', 'First', 1000)).data.applied.length, 1);
  const pull = await j('GET', '/api/sync?since=0', null, b.token);          // teammate sees it
  assert.equal(pull.data.docs.length, 1); assert.equal(pull.data.docs[0].data.name, 'First');
  const older = await put(b.token, 'job1', 'Older', 500);
  assert.equal(older.data.applied.length, 0); assert.equal(older.data.rejected[0].reason, 'newer on server');
  assert.equal((await put(b.token, 'job1', 'Second', 2000)).data.applied.length, 1);
  const p2 = await j('GET', '/api/sync?since=' + pull.data.seq, null, a.token);
  assert.equal(p2.data.docs.length, 1); assert.equal(p2.data.docs[0].data.name, 'Second');
  assert.ok(p2.data.docs[0].seq > pull.data.seq);
  // a different team sees nothing
  const rc = await j('POST', '/api/auth/signup', { email: `c${rnd}@x.com`, name: 'C', password: 'longenough123', code: CODE });
  c = rc.data;
  assert.equal((await j('GET', '/api/sync?since=0', null, c.token)).data.docs.length, 0);
  // tombstones travel
  await j('POST', '/api/sync', { docs: [{ kind: 'job', id: 'job1', updatedAt: 3000, deleted: true, data: {} }] }, a.token);
  const p3 = await j('GET', '/api/sync?since=0', null, b.token);
  assert.equal(p3.data.docs[0].deleted, true);
  // invalid kind rejected
  assert.equal((await j('POST', '/api/sync', { docs: [{ kind: 'x', id: 'q', updatedAt: 1, data: {} }] }, a.token)).data.rejected.length, 1);
});

test('files are team-scoped; ?token= works for GET', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let r = await fetch(B + '/api/files/abc12345_plan.png', { method: 'PUT', headers: { Authorization: 'Bearer ' + a.token }, body: bytes });
  assert.equal(r.status, 200);
  assert.equal((await fetch(B + '/api/files/abc12345_plan.png', { method: 'HEAD', headers: { Authorization: 'Bearer ' + b.token } })).status, 200);
  assert.equal((await fetch(B + '/api/files/abc12345_plan.png', { method: 'HEAD', headers: { Authorization: 'Bearer ' + c.token } })).status, 404);
  r = await fetch(B + '/api/files/abc12345_plan.png?token=' + a.token);
  assert.equal(r.headers.get('content-type'), 'image/png'); assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal((await fetch(B + '/api/files/..%2Fx', { method: 'PUT', headers: { Authorization: 'Bearer ' + a.token }, body: bytes })).status, 400);
  assert.equal((await fetch(B + '/api/files/abc12345_plan.png')).status, 401);
});

test('change password signs out other sessions; owner removes member', async () => {
  const r = await j('POST', '/api/auth/password', { current: 'longenough123', next: 'brandnewpass99' }, b.token);
  assert.equal(r.status, 200);
  assert.equal((await j('GET', '/api/me', null, b.token)).status, 401);
  assert.equal((await j('GET', '/api/me', null, r.data.token)).status, 200);
  assert.equal((await j('DELETE', '/api/team/members/' + b.user.id, null, a.token)).status, 200);
  assert.equal((await j('GET', '/api/me', null, r.data.token)).status, 401);
});

test('login is throttled after repeated failures', async () => {
  const e = `t${rnd}@x.com`; let last;
  for (let i = 0; i < 11; i++) last = await j('POST', '/api/auth/login', { email: e, password: 'x' });
  assert.equal(last.status, 429);
});
