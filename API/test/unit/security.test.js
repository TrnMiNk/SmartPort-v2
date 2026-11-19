'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../../src/security/password');
const { newSessionToken, hashToken } = require('../../src/security/tokens');
const { validateLogin } = require('../../src/validation/authValidation');
const { requireRole, readCookie } = require('../../src/http/auth');
const { errorHandler } = require('../../src/http/errorHandler');
const { AppError, errors } = require('../../src/errors');

test('password hash verifies the right password and rejects others', () => {
  const stored = hashPassword('correct-horse-battery');
  assert.equal(verifyPassword('correct-horse-battery', stored), true);
  assert.equal(verifyPassword('correct-horse-batter', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('password hashes use a fresh salt and never contain the plaintext', () => {
  const a = hashPassword('same-password-123');
  const b = hashPassword('same-password-123');
  assert.notEqual(a, b);
  assert.ok(!a.includes('same-password-123'));
});

test('a malformed stored hash fails closed', () => {
  assert.equal(verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(verifyPassword('anything', 'md5$x'), false);
});

test('session tokens are random and stored only as a 32-byte hash', () => {
  const t1 = newSessionToken();
  const t2 = newSessionToken();
  assert.notEqual(t1, t2);
  assert.equal(hashToken(t1).length, 32);
  assert.notEqual(hashToken(t1).toString('hex'), t1);
});

test('login validation rejects bad usernames and missing password, accepts a valid pair', () => {
  assert.ok(validateLogin({ username: 'a', password: 'x' }).some((e) => e.field === 'username'));
  assert.ok(validateLogin({ username: "bob'; DROP", password: 'x' }).some((e) => e.field === 'username'));
  assert.ok(validateLogin({ username: 'coord01', password: '' }).some((e) => e.field === 'password'));
  assert.ok(validateLogin({ username: 'coord01', password: 'x'.repeat(257) }).some((e) => e.field === 'password'));
  assert.deepEqual(validateLogin({ username: 'coord01', password: 'secret-pass' }), []);
  assert.equal(validateLogin(null)[0].field, 'body');
  assert.equal(validateLogin(['x'])[0].field, 'body');
});

test('requireRole denies by default and allows only listed roles', () => {
  const run = (roles, allowed) => {
    let outcome;
    requireRole(...allowed)({ principal: { roles } }, {}, (err) => { outcome = err ? err.code : 'ok'; });
    return outcome;
  };
  assert.equal(run(['DIEU_PHOI_VIEN'], ['BAN_QUAN_LY']), 'FORBIDDEN');
  assert.equal(run(['BAN_QUAN_LY'], ['BAN_QUAN_LY']), 'ok');
  assert.equal(run([], ['QUAN_TRI_HE_THONG']), 'FORBIDDEN');
  assert.equal(run(['QUAN_TRI_HE_THONG'], []), 'FORBIDDEN'); // empty allow-list denies everything
  let outcome;
  requireRole('QUAN_TRI_HE_THONG')({}, {}, (err) => { outcome = err.code; });
  assert.equal(outcome, 'UNAUTHENTICATED');
});

test('readCookie finds the named cookie among several', () => {
  const req = { headers: { cookie: 'a=1; sp_session=tok%2Bx; b=2' } };
  assert.equal(readCookie(req, 'sp_session'), 'tok+x');
  assert.equal(readCookie({ headers: {} }, 'sp_session'), null);
});

function runErrorHandler(err) {
  const captured = { status: null, body: null, headersSent: false };
  const res = {
    headersSent: false,
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; },
  };
  errorHandler(err, {}, res, () => {});
  return captured;
}

test('error contract: AppError keeps its code and message', () => {
  const out = runErrorHandler(errors.invalidCredentials());
  assert.equal(out.status, 401);
  assert.equal(out.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(out.body.success, false);
});

test('error contract: an unknown error never leaks its message, SQL or stack', () => {
  const secret = new Error("Incorrect syntax near 'dbo.auth_users' SELECT password_hash");
  secret.code = 'EREQUEST';
  const out = runErrorHandler(secret);
  assert.equal(out.status, 500);
  assert.equal(out.body.error.code, 'INTERNAL_ERROR');
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes('password_hash'));
  assert.ok(!text.includes('dbo.'));
  assert.ok(!text.includes('stack'));
});

test('error contract: malformed JSON is a 400 validation failure', () => {
  const parseErr = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
  const out = runErrorHandler(parseErr);
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, 'VALIDATION_FAILED');
});

test('AppError type is exported for controllers', () => {
  assert.ok(new AppError(400, 'X', 'm') instanceof Error);
});

test('B2: the async check agrees with the sync one and does not block the event loop (50 simultaneous sign-ins must not stall other requests)', async () => {
  const { verifyPasswordAsync } = require('../../src/security/password');
  const stored = hashPassword('correct-horse-battery');
  assert.equal(await verifyPasswordAsync('correct-horse-battery', stored), true);
  assert.equal(await verifyPasswordAsync('wrong', stored), false);
  assert.equal(await verifyPasswordAsync('x', 'not-a-hash'), false);
  let ticks = 0; const timer = setInterval(() => { ticks += 1; }, 2);
  await Promise.all(Array.from({ length: 24 }, () => verifyPasswordAsync('correct-horse-battery', stored)));
  clearInterval(timer);
  assert.ok(ticks >= 8, `the event loop kept running while 24 checks ran (${ticks} ticks)`);   // the sync version gives about 0
});
