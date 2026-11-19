'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCredentials, roleLabel, initials, createAuth, SESSION_FLAG, can, canViewPage, homeFor, PAGE_FEATURES } = require('../../js/auth');
const { ApiError } = require('../../js/api');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
}

function setup(handler, storage = memoryStorage()) {
  const redirects = [];
  const calls = [];
  const api = { request: async (path, opts) => { calls.push({ path, opts }); return handler(path, opts); } };
  let cleared = 0;
  const auth = createAuth({ api, storage, redirect: (u) => redirects.push(u), clearMarker: () => { cleared += 1; } });
  return { auth, redirects, calls, storage, markerCleared: () => cleared };
}

const USER = { id: 3, username: 'coord01', displayName: 'Điều phối viên 1', roles: ['DIEU_PHOI_VIEN'] };
const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'x');

test('validateCredentials: accepts a valid pair', () => {
  assert.deepEqual(validateCredentials('coord01', 'secret'), {});
  assert.deepEqual(validateCredentials('a.b-c_d', 'x'), {});
});

test('validateCredentials: rejects short, long, illegal username and empty or oversized password', () => {
  assert.ok(validateCredentials('ab', 'x').username);
  assert.ok(validateCredentials('a'.repeat(101), 'x').username);
  assert.ok(validateCredentials("bob'; DROP", 'x').username);
  assert.ok(validateCredentials('coord01', '').password);
  assert.ok(validateCredentials('coord01', 'x'.repeat(257)).password);
  assert.deepEqual(Object.keys(validateCredentials('', '')).sort(), ['password', 'username']);
  assert.ok(validateCredentials(null, null).username);
});

test('boundary: username of exactly 3 and 100 characters is accepted', () => {
  assert.deepEqual(validateCredentials('abc', 'x'), {});
  assert.deepEqual(validateCredentials('a'.repeat(100), 'x'), {});
});

test('roleLabel maps known role codes, keeps unknown ones, handles none', () => {
  assert.equal(roleLabel(['BAN_QUAN_LY']), 'Port management');
  assert.equal(roleLabel(['DIEU_PHOI_VIEN', 'DAI_LY_HANG_HAI']), 'Coordinator, Shipping agent');
  assert.equal(roleLabel(['NEW_ROLE']), 'NEW_ROLE');
  assert.equal(roleLabel([]), 'No role assigned');
  assert.equal(roleLabel(undefined), 'No role assigned');
});

test('initials: first and last word, single word, empty', () => {
  assert.equal(initials('Điều phối viên 1'), 'Đ1');
  assert.equal(initials('Emma van Dijk'), 'ED');
  assert.equal(initials('Admin'), 'A');
  assert.equal(initials('   '), '?');
});

test('login posts trimmed username without redirect, sets the session flag, returns the user', async () => {
  const { auth, calls, redirects, storage } = setup(async () => ({ user: USER }));
  const user = await auth.login('  coord01 ', 'secret');
  assert.deepEqual(user, USER);
  assert.equal(calls[0].path, '/api/v1/auth/login');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { username: 'coord01', password: 'secret' });
  assert.equal(calls[0].opts.notifyUnauthorized, false);
  assert.equal(storage.getItem(SESSION_FLAG), '1');
  assert.deepEqual(redirects, []);
});

test('login failure (wrong credentials) is thrown, does not redirect or set the flag, and stores no password', async () => {
  const { auth, redirects, storage } = setup(async () => { throw new ApiError(401, 'INVALID_CREDENTIALS', 'Sai'); });
  await assert.rejects(() => auth.login('coord01', 'bad-password'), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.deepEqual(redirects, []);
  assert.equal(storage.getItem(SESSION_FLAG), null);
  assert.ok(!JSON.stringify(storage.data).includes('bad-password'));
});

test('requireSession returns the user when the API confirms the session', async () => {
  const { auth, calls } = setup(async () => ({ user: USER }));
  assert.deepEqual(await auth.requireSession(), USER);
  assert.equal(calls[0].path, '/api/v1/auth/me');
  assert.deepEqual(auth.user, USER);
});

test('requireSession 401 without a previous session goes to plain login (no expired notice)', async () => {
  const { auth, redirects } = setup(async () => { throw unauthenticated(); });
  auth.requireSession(); // never resolves while navigating
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(redirects, ['login.html']);
});

test('requireSession 401 after a previous session goes to login with reason=expired and clears the flag', async () => {
  const { auth, redirects, storage } = setup(async () => { throw unauthenticated(); }, memoryStorage({ [SESSION_FLAG]: '1' }));
  auth.requireSession();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(redirects, ['login.html?reason=expired']);
  assert.equal(storage.getItem(SESSION_FLAG), null);
});

test('requireSession network error is thrown (retry state), not turned into a login redirect', async () => {
  const { auth, redirects } = setup(async () => { throw new ApiError(0, 'NETWORK_ERROR', 'down'); });
  await assert.rejects(() => auth.requireSession(), (e) => e.status === 0);
  assert.deepEqual(redirects, []);
});

test('requireSession server error 500 is thrown, no redirect', async () => {
  const { auth, redirects } = setup(async () => { throw new ApiError(500, 'INTERNAL_ERROR', 'x'); });
  await assert.rejects(() => auth.requireSession(), (e) => e.status === 500);
  assert.deepEqual(redirects, []);
});

test('handleUnauthorized (from any API call) behaves like an expired session', async () => {
  const { auth, redirects } = setup(async () => ({ user: USER }), memoryStorage({ [SESSION_FLAG]: '1' }));
  auth.handleUnauthorized();
  assert.deepEqual(redirects, ['login.html?reason=expired']);
});

test('regression: two simultaneous 401 responses redirect once, keeping the expired notice', () => {
  const { auth, redirects } = setup(async () => ({ user: USER }), memoryStorage({ [SESSION_FLAG]: '1' }));
  auth.handleUnauthorized();
  auth.handleUnauthorized(); // the second call used to redirect to a plain login.html, hiding the notice
  assert.deepEqual(redirects, ['login.html?reason=expired']);
});

test('peek returns the user or null and never redirects or throws', async () => {
  const ok = setup(async () => ({ user: USER }));
  assert.deepEqual(await ok.auth.peek(), USER);
  const no = setup(async () => { throw unauthenticated(); });
  assert.equal(await no.auth.peek(), null);
  const down = setup(async () => { throw new ApiError(0, 'NETWORK_ERROR', 'x'); });
  assert.equal(await down.auth.peek(), null);
  assert.deepEqual([ok.redirects, no.redirects, down.redirects], [[], [], []]);
});

test('logout calls DELETE, clears the flag and redirects to login', async () => {
  const { auth, calls, redirects, storage } = setup(async () => null, memoryStorage({ [SESSION_FLAG]: '1' }));
  await auth.logout();
  assert.equal(calls[0].path, '/api/v1/auth/logout');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.equal(storage.getItem(SESSION_FLAG), null);
  assert.deepEqual(redirects, ['login.html']);
});

test('logout when the session is already gone (401) still completes', async () => {
  const { auth, redirects } = setup(async () => { throw unauthenticated(); });
  await auth.logout();
  assert.deepEqual(redirects, ['login.html']);
});

test('UC-002 4a: logout with the server unreachable clears the browser session (marker) and goes to login', async () => {
  const { auth, redirects, storage, markerCleared } = setup(async () => { throw new ApiError(0, 'NETWORK_ERROR', 'down'); }, memoryStorage({ [SESSION_FLAG]: '1' }));
  assert.deepEqual(await auth.logout(), { revoked: false });
  assert.equal(markerCleared(), 1, 'presence marker deleted so the API refuses this browser');
  assert.equal(storage.getItem(SESSION_FLAG), null);
  assert.deepEqual(redirects, ['login.html?reason=offline']);
});

test('UC-002 4a also applies to a server error (5xx) on logout', async () => {
  const { auth, redirects, markerCleared } = setup(async () => { throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'x'); });
  assert.deepEqual(await auth.logout(), { revoked: false });
  assert.equal(markerCleared(), 1);
  assert.deepEqual(redirects, ['login.html?reason=offline']);
});

test('a client error (403) on logout is thrown and does not pretend the user is signed out', async () => {
  const { auth, redirects, markerCleared } = setup(async () => { throw new ApiError(403, 'FORBIDDEN', 'x'); });
  await assert.rejects(() => auth.logout(), (e) => e.status === 403);
  assert.equal(markerCleared(), 0);
  assert.deepEqual(redirects, []);
});

test('a normal logout does not touch the marker and reports revoked', async () => {
  const { auth, markerCleared } = setup(async () => null);
  assert.deepEqual(await auth.logout(), { revoked: true });
  assert.equal(markerCleared(), 0);
});

const permsOf = (permissions) => ({ permissions });
test('canViewPage follows the permission matrix and hides pages without any action', () => {
  const technician = permsOf({ M6_IOT: ['edit', 'view'], M7_MONITORING: ['view'], M8_REPORTS: ['view'] });
  const visible = Object.keys(PAGE_FEATURES).filter((p) => canViewPage(technician, p));
  assert.deepEqual(visible.sort(), ['equipment', 'gis', 'operations', 'overview']);
  const admin = permsOf({ ADMIN: ['edit', 'view'], M1_VESSELS: ['view'], M2_BERTHS: ['view'], M3_CARGO: ['view'], M4_YARD: ['view'], M5_BILLING: ['view'], M6_IOT: ['edit', 'view'], M7_MONITORING: ['view'] });
  assert.equal(Object.keys(PAGE_FEATURES).every((p) => canViewPage(admin, p)), true);
  const agent = permsOf({ M1_VESSELS: ['notice', 'view_own'] });
  assert.deepEqual(Object.keys(PAGE_FEATURES).filter((p) => canViewPage(agent, p)), ['vessels']);
});

test('canViewPage and can deny when permissions are missing or malformed (default deny)', () => {
  for (const user of [null, undefined, {}, { permissions: null }, { permissions: { M1_VESSELS: [] } }, { permissions: { M1_VESSELS: 'view' } }]) {
    assert.equal(canViewPage(user, 'vessels'), false);
  }
  assert.equal(canViewPage(permsOf({ M1_VESSELS: ['view'] }), 'nonexistent-page'), false);
  assert.equal(can(permsOf({ M1_VESSELS: ['view'] }), 'M1_VESSELS', 'edit'), false);
  assert.equal(can(permsOf({ M1_VESSELS: ['view'] }), 'M1_VESSELS', 'view'), true);
});

test('homeFor picks the first allowed page, or the no-access login notice', () => {
  assert.equal(homeFor(permsOf({ M7_MONITORING: ['view'] })), 'overview.html');
  assert.equal(homeFor(permsOf({ M1_VESSELS: ['notice', 'view_own'] })), 'vessels.html');
  assert.equal(homeFor(permsOf({ M6_IOT: ['view'] })), 'equipment.html');
  assert.equal(homeFor(permsOf({})), 'login.html?reason=noaccess');
  assert.equal(homeFor(null), 'login.html?reason=noaccess');
});

test('blocked storage (private mode) does not break login or logout', async () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const { auth, redirects } = setup(async () => ({ user: USER }), broken);
  await auth.login('coord01', 'secret');
  await auth.logout();
  assert.deepEqual(redirects, ['login.html']);
});
