'use strict';

// HTTP integration tests for UC-001 and UC-002 against a real SQL Server test database.
// Runs only when SP_TEST_DB is set (disposable database; see schema.test.js). Each run creates users with a
// unique suffix and deletes its own rows at the end. The schema must already be migrated.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: HTTP auth integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };

let db;
let server;
let base;
const created = [];

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const config = loadConfig({ SP_DB_NAME: TEST_DB });
  const { sql, pool, connect } = createPool(config.db);
  db = { sql, pool: await connect() };
  const app = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 60000 });

test.after(async () => {
  if (!db) return;
  for (const username of created) {
    const u = await db.pool.request().input('u', db.sql.NVarChar(100), username)
      .query('SELECT user_id FROM dbo.auth_users WHERE username = @u');
    if (u.recordset[0]) {
      const id = u.recordset[0].user_id;
      await db.pool.request().input('id', db.sql.BigInt, id).query(`
        DELETE FROM dbo.auth_sessions WHERE user_id = @id;
        DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
        DELETE FROM dbo.auth_user_agents WHERE user_id = @id;
        DELETE FROM dbo.auth_users WHERE user_id = @id;`);
    }
  }
  await new Promise((resolve) => server.close(resolve));
  await db.pool.close();
});

async function newUser(label, roles = ['DIEU_PHOI_VIEN']) {
  const username = `t_${label}_${SUFFIX}`;
  created.push(username);
  await createUser(db, { username, displayName: `Test ${label}`, password: PASSWORD, roleCodes: roles });
  return username;
}

async function post(path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Returns the Cookie header a browser would send: the HttpOnly session token plus the presence marker.
function sessionCookie(res) {
  const raw = res.headers.get('set-cookie') ?? '';
  const match = raw.match(/sp_session=([^;]+)/);
  return match ? `sp_session=${match[1]}; sp_auth=1` : null;
}

test('login succeeds, sets an HttpOnly session cookie, and returns the user with roles', { skip }, async () => {
  const username = await newUser('ok');
  const res = await post('/api/v1/auth/login', { username, password: PASSWORD });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.user.username, username);
  assert.deepEqual(body.data.user.roles, ['DIEU_PHOI_VIEN']);
  assert.ok(!('password_hash' in body.data.user));
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/i);
});

test('wrong password and unknown user return the same generic message (no account enumeration)', { skip }, async () => {
  const username = await newUser('enum');
  const wrong = await post('/api/v1/auth/login', { username, password: 'not-the-password-xx' });
  const unknown = await post('/api/v1/auth/login', { username: `nobody_${SUFFIX}`, password: 'whatever-1234' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  const a = await wrong.json();
  const b = await unknown.json();
  assert.equal(a.error.code, 'INVALID_CREDENTIALS');
  assert.equal(a.error.message, b.error.message);
});

test('the fifth consecutive failure locks the account; the correct password is then refused', { skip }, async () => {
  const username = await newUser('lock');
  for (let i = 1; i <= 4; i += 1) {
    const r = await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' });
    assert.equal(r.status, 401, `attempt ${i}`);
  }
  const fifth = await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' });
  assert.equal(fifth.status, 423);
  assert.equal((await fifth.json()).error.code, 'ACCOUNT_LOCKED');
  const correct = await post('/api/v1/auth/login', { username, password: PASSWORD });
  assert.equal(correct.status, 423, 'locked account must not log in even with the right password');
});

test('a deactivated account cannot log in', { skip }, async () => {
  const username = await newUser('inactive');
  await db.pool.request().input('u', db.sql.NVarChar(100), username)
    .query('UPDATE dbo.auth_users SET is_active = 0 WHERE username = @u');
  const res = await post('/api/v1/auth/login', { username, password: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'ACCOUNT_INACTIVE');
});

test('me without a session is 401; with the session it returns the user', { skip }, async () => {
  const username = await newUser('me');
  const login = await post('/api/v1/auth/login', { username, password: PASSWORD });
  const cookie = sessionCookie(login);
  assert.ok(cookie, 'login must set a session cookie');
  const anon = await fetch(base + '/api/v1/auth/me');
  assert.equal(anon.status, 401);
  const me = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.user.username, username);
});

test('after logout the old token is rejected on the next request (UC-002)', { skip }, async () => {
  const username = await newUser('logout');
  const login = await post('/api/v1/auth/login', { username, password: PASSWORD });
  const cookie = sessionCookie(login);
  const out = await fetch(base + '/api/v1/auth/logout', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(out.status, 204);
  const after = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});

test('an idle session past its expiry is refused (UC-002 AC-3)', { skip }, async () => {
  const username = await newUser('idle');
  const cookie = sessionCookie(await post('/api/v1/auth/login', { username, password: PASSWORD }));
  // Simulate 30+ minutes of inactivity: the session was created two hours ago and expired a minute ago.
  await db.pool.request().input('u', db.sql.NVarChar(100), username).query(
    `UPDATE s SET created_at = DATEADD(HOUR, -2, SYSUTCDATETIME()), expires_at = DATEADD(MINUTE, -1, SYSUTCDATETIME())
     FROM dbo.auth_sessions s JOIN dbo.auth_users u ON u.user_id = s.user_id WHERE u.username = @u`);
  const res = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'UNAUTHENTICATED');
});

test('an accepted request extends the idle expiry (sliding timeout)', { skip }, async () => {
  const username = await newUser('slide');
  const cookie = sessionCookie(await post('/api/v1/auth/login', { username, password: PASSWORD }));
  const expiry = async () => (await db.pool.request().input('u', db.sql.NVarChar(100), username).query(
    `SELECT s.expires_at FROM dbo.auth_sessions s JOIN dbo.auth_users u ON u.user_id = s.user_id WHERE u.username = @u`)).recordset[0].expires_at;
  await db.pool.request().input('u', db.sql.NVarChar(100), username).query(
    `UPDATE s SET expires_at = DATEADD(MINUTE, 1, SYSUTCDATETIME())
     FROM dbo.auth_sessions s JOIN dbo.auth_users u ON u.user_id = s.user_id WHERE u.username = @u`);
  const before = await expiry();
  assert.equal((await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } })).status, 200);
  const after = await expiry();
  const minutesAhead = (after.getTime() - Date.now()) / 60000;
  assert.ok(after > before, 'expiry must move forward');
  assert.ok(minutesAhead > 25 && minutesAhead <= 30.5, `expected about 30 minutes ahead, got ${minutesAhead.toFixed(1)}`);
});

test('a forged session token is rejected', { skip }, async () => {
  const res = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: 'sp_session=forged-token-value; sp_auth=1' } });
  assert.equal(res.status, 401);
});

test('a valid session token without the presence marker is refused (UC-002 4a: browser-side sign-out)', { skip }, async () => {
  const username = await newUser('marker');
  const login = await post('/api/v1/auth/login', { username, password: PASSWORD });
  const cookie = sessionCookie(login);
  const tokenOnly = cookie.replace('; sp_auth=1', '');
  assert.equal((await fetch(base + '/api/v1/auth/me', { headers: { Cookie: tokenOnly } })).status, 401);
  assert.equal((await fetch(base + '/api/v1/auth/me', { headers: { Cookie: tokenOnly + '; sp_auth=0' } })).status, 401);
  // The server session was not revoked: with the marker it is still valid until it expires by time.
  assert.equal((await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } })).status, 200);
});

test('every accepted request re-issues both cookies with the idle lifetime (cookie slides with the session)', { skip }, async () => {
  const username = await newUser('refresh');
  const cookie = sessionCookie(await post('/api/v1/auth/login', { username, password: PASSWORD }));
  const res = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } });
  const setCookie = res.headers.getSetCookie();
  const session = setCookie.find((c) => c.startsWith('sp_session='));
  const marker = setCookie.find((c) => c.startsWith('sp_auth='));
  assert.ok(session && marker, 'both cookies re-issued');
  assert.match(session, /Max-Age=1800/);
  assert.match(marker, /Max-Age=1800/);
  assert.match(session, /HttpOnly/);
  assert.doesNotMatch(marker, /HttpOnly/, 'the marker must be readable by the frontend');
});

test('login and me return permissions derived from the roles; the matrix limits each role', { skip }, async () => {
  const coordinator = await newUser('perm_dpv', ['DIEU_PHOI_VIEN']);
  const technician = await newUser('perm_ktv', ['KY_THUAT_VIEN']);
  const admin = await newUser('perm_admin', ['QUAN_TRI_HE_THONG']);
  const dpv = (await (await post('/api/v1/auth/login', { username: coordinator, password: PASSWORD })).json()).data.user;
  assert.deepEqual(dpv.permissions.M1_VESSELS, ['edit', 'notice', 'view']);
  assert.equal(dpv.permissions.ADMIN, undefined);
  const ktv = (await (await post('/api/v1/auth/login', { username: technician, password: PASSWORD })).json()).data.user;
  assert.equal(ktv.permissions.M1_VESSELS, undefined, 'technicians have no vessel access');
  assert.deepEqual(ktv.permissions.M6_IOT, ['edit', 'view']);
  const adm = (await (await post('/api/v1/auth/login', { username: admin, password: PASSWORD })).json()).data.user;
  assert.deepEqual(adm.permissions.ADMIN, ['edit', 'view']);
  assert.deepEqual(adm.permissions.M1_VESSELS, ['view']);
});

test('UC-005 AC-3: a role change takes effect on the next request without signing in again', { skip }, async () => {
  const username = await newUser('rolechg', ['KY_THUAT_VIEN']);
  const cookie = sessionCookie(await post('/api/v1/auth/login', { username, password: PASSWORD }));
  const perms = async () => (await (await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } })).json()).data.user.permissions;
  assert.equal((await perms()).M1_VESSELS, undefined);
  await db.pool.request().input('u', db.sql.NVarChar(100), username).query(
    `INSERT INTO dbo.auth_user_roles (user_id, role_id) SELECT u.user_id, r.role_id FROM dbo.auth_users u, dbo.auth_roles r
     WHERE u.username = @u AND r.role_code = 'DIEU_PHOI_VIEN'`);
  assert.deepEqual((await perms()).M1_VESSELS, ['edit', 'notice', 'view'], 'granted role applies at once');
  await db.pool.request().input('u', db.sql.NVarChar(100), username).query(
    `DELETE ur FROM dbo.auth_user_roles ur JOIN dbo.auth_users u ON u.user_id = ur.user_id
     JOIN dbo.auth_roles r ON r.role_id = ur.role_id WHERE u.username = @u AND r.role_code = 'DIEU_PHOI_VIEN'`);
  assert.equal((await perms()).M1_VESSELS, undefined, 'removed role stops applying at once');
});

test('lock policy: fifth failure locks for about 15 minutes; after the lock ends the count starts again', { skip }, async () => {
  const username = await newUser('lockpol');
  for (let i = 1; i <= 5; i += 1) await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' });
  const row = (await db.pool.request().input('u', db.sql.NVarChar(100), username)
    .query(`SELECT failed_login_count AS n, DATEDIFF(SECOND, SYSUTCDATETIME(), locked_until) AS secs
            FROM dbo.auth_users WHERE username = @u`)).recordset[0];
  assert.equal(row.n, 5);
  assert.ok(row.secs > 14 * 60 && row.secs <= 15 * 60, `lock should last about 15 minutes, got ${row.secs}s`);
  // Simulate the end of the lock.
  await db.pool.request().input('u', db.sql.NVarChar(100), username)
    .query(`UPDATE dbo.auth_users SET locked_until = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE username = @u`);
  const afterLock = await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' });
  assert.equal(afterLock.status, 401, 'first failure after the lock is an ordinary failure, not an instant re-lock');
  for (let i = 2; i <= 4; i += 1) assert.equal((await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' })).status, 401);
  assert.equal((await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' })).status, 423, 'fifth new failure locks again');
});

test('after a lock ends, the correct password signs in and resets the counter', { skip }, async () => {
  const username = await newUser('lockok');
  for (let i = 1; i <= 5; i += 1) await post('/api/v1/auth/login', { username, password: 'wrong-password-xx' });
  await db.pool.request().input('u', db.sql.NVarChar(100), username)
    .query(`UPDATE dbo.auth_users SET locked_until = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE username = @u`);
  assert.equal((await post('/api/v1/auth/login', { username, password: PASSWORD })).status, 200);
  const n = (await db.pool.request().input('u', db.sql.NVarChar(100), username)
    .query('SELECT failed_login_count AS n FROM dbo.auth_users WHERE username = @u')).recordset[0].n;
  assert.equal(n, 0);
});

test('malformed JSON and invalid fields return 400 with the error contract', { skip }, async () => {
  const bad = await post('/api/v1/auth/login', '{not json');
  assert.equal(bad.status, 400);
  const invalid = await post('/api/v1/auth/login', { username: 'x', password: '' });
  assert.equal(invalid.status, 400);
  const body = await invalid.json();
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.ok(body.error.details.length >= 2);
});

test('health reports database ok without internal details', { skip }, async () => {
  const res = await fetch(base + '/api/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { status: 'ok', database: 'ok' });
});

test('unknown routes return the NOT_FOUND contract', { skip }, async () => {
  const res = await fetch(base + '/api/v1/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});
