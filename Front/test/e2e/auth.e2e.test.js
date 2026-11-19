'use strict';

// Browser end-to-end test for UC-001 (login, role menus) and UC-002 (logout, session expiry) against the real API and
// SQL Server. Set-up lives in support.js. SP_E2E_DB must name a disposable, migrated and seeded database.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support');

const { skip, FRONT, API, API_LOOPBACK, newPage, onPage, signIn, loginOk, cookies } = S;
const users = {
  main: S.mkUser('main', `Điều phối viên ${S.SUFFIX}`, ['DIEU_PHOI_VIEN']),
  lock: S.mkUser('lock', 'Tài khoản khóa', ['DIEU_PHOI_VIEN']),
  tech: S.mkUser('tech', 'Kỹ thuật viên A', ['KY_THUAT_VIEN']),
  admin: S.mkUser('admin', 'Quản trị A', ['QUAN_TRI_HE_THONG']),
  manager: S.mkUser('mgr', 'Ban quản lý A', ['BAN_QUAN_LY']),
  yard: S.mkUser('yard', 'Nhân viên kho bãi A', ['NHAN_VIEN_KHO_BAI']),
  agent: S.mkUser('agent', 'Đại lý A', ['DAI_LY_HANG_HAI']),
};
// Tests below use db.pool / db.sql lazily, after set-up has opened the connection.
const db = { get pool() { return S.db().pool; }, get sql() { return S.db().sql; } };

test.before(() => S.start(users), { timeout: 90000 });
test.after(() => S.stop(users));

test('opening a protected page without a session redirects to login, with no mock credentials or SSO bypass', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await page.goto(`${FRONT}/overview.html`);
  await onPage(page, 'login.html');
  assert.ok(!page.url().includes('reason='), 'never signed in: no expired notice');
  assert.equal(await page.$eval('#le', (e) => e.value), '');
  assert.equal(await page.$eval('#lp', (e) => e.value), '');
  assert.equal(await page.$eval('#sso', (e) => e.disabled), true, 'SSO button must not bypass authentication');
  await context.close();
});

test('submitting an empty form shows field errors and sends no login request', { skip, timeout: 60000 }, async () => {
  const { page, context, requests } = await newPage();
  await page.goto(`${FRONT}/login.html`);
  await page.click('#lsub');
  await page.waitForFunction(() => document.querySelector('#e-le').textContent.length > 0 && document.querySelector('#e-lp').textContent.length > 0);
  assert.equal(requests.filter((r) => r.includes('/auth/login')).length, 0);
  assert.ok(page.url().endsWith('login.html'));
  await context.close();
});

test('wrong password shows the API message, clears the password field and keeps the user on login', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await signIn(page, users.main, 'definitely-wrong-password');
  await page.waitForFunction(() => !document.querySelector('#lmsg').hidden && document.querySelector('#lmsg').textContent.includes('không đúng'));
  assert.ok(page.url().endsWith('login.html'));
  assert.equal(await page.$eval('#lp', (e) => e.value), '');
  assert.equal(await page.$eval('#lsub', (e) => e.disabled), false, 'form usable again');
  await context.close();
});

test('successful login shows the real user and role; the session cookie is HttpOnly and no secret is stored in the page', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  assert.equal(await page.$eval('#meName', (e) => e.textContent), users.main.displayName);
  assert.equal(await page.$eval('#meRole', (e) => e.textContent), 'Coordinator');
  const session = (await cookies(page)).find((c) => c.name === 'sp_session');
  assert.ok(session, 'session cookie set');
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, 'Lax');
  const leaked = await page.evaluate((cookieValue, pw) => {
    const dump = JSON.stringify([document.cookie, { ...localStorage }, { ...sessionStorage }, document.documentElement.outerHTML]);
    return { cookieInJs: dump.includes(cookieValue), passwordInPage: dump.includes(pw) };
  }, session.value, users.main.password);
  assert.deepEqual(leaked, { cookieInJs: false, passwordInPage: false });
  await context.close();
});

test('reload keeps the session; visiting login while signed in goes to the dashboard', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  await page.reload();
  await page.waitForSelector('#meName');
  assert.ok(page.url().endsWith('overview.html'));
  await page.goto(`${FRONT}/login.html`);
  await onPage(page, 'overview.html');
  await context.close();
});

test('logout revokes the session on the server and blocks protected pages afterwards (UC-002)', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  const token = (await cookies(page)).find((c) => c.name === 'sp_session').value;
  assert.equal((await fetch(`${API_LOOPBACK}/api/v1/auth/me`, { headers: { Cookie: `sp_session=${token}; sp_auth=1` } })).status, 200);
  await page.click('#signout');
  await onPage(page, 'login.html');
  assert.ok(!page.url().includes('reason='), 'deliberate logout is not an expired session');
  await page.goto(`${FRONT}/vessels.html`);
  await onPage(page, 'login.html');
  const replay = await fetch(`${API_LOOPBACK}/api/v1/auth/me`, { headers: { Cookie: `sp_session=${token}; sp_auth=1` } });
  assert.equal(replay.status, 401, 'old token must be refused by the server');
  await context.close();
});

test('regression: Sign out stays reachable on a narrow screen (it used to be hidden below 860px)', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await page.setViewport({ width: 390, height: 800 });
  await loginOk(page, users.main);
  assert.equal(await page.$eval('#signout', (e) => e.getBoundingClientRect().width > 0), true, 'sign-out link must be visible');
  await page.click('#signout');
  await onPage(page, 'login.html');
  await context.close();
});

test('a session revoked on the server redirects to login with the expiry notice', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  await db.pool.request().input('u', db.sql.NVarChar(100), users.main.username).query(
    `UPDATE s SET revoked_at = SYSUTCDATETIME() FROM dbo.auth_sessions s
     JOIN dbo.auth_users u ON u.user_id = s.user_id WHERE u.username = @u AND s.revoked_at IS NULL`);
  await page.reload();
  await onPage(page, 'login.html');
  assert.ok(page.url().includes('reason=expired'));
  await page.waitForFunction(() => document.querySelector('#lmsg').textContent.includes('hết hạn'));
  await context.close();
});

test('when the server cannot be reached the page shows an error with Retry, not a false redirect', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  await page.setRequestInterception(true);
  let blockMe = true;
  page.on('request', (r) => { if (blockMe && r.url().includes('/auth/me')) r.abort(); else r.continue(); });
  await page.reload();
  await page.waitForSelector('#retry');
  assert.ok(page.url().endsWith('overview.html'));
  assert.match(await page.$eval('#mErr', (e) => e.textContent), /kết nối/);
  blockMe = false;
  await page.click('#retry');
  await page.waitForSelector('#meName');
  await context.close();
});

test('UC-002 4a: logout while the server cannot be reached clears the browser session; the server session expires by time', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  const token = (await cookies(page)).find((c) => c.name === 'sp_session').value;
  await page.setRequestInterception(true);
  const blockDelete = (r) => { if (r.method() === 'DELETE') r.abort(); else r.continue(); };
  page.on('request', blockDelete);
  await page.click('#signout');
  await onPage(page, 'login.html');
  assert.ok(page.url().includes('reason=offline'));
  try {
    await page.waitForFunction(() => { const m = document.querySelector('#lmsg'); return m && m.textContent.includes('tự hết hạn'); });
  } catch (e) {
    const state = await page.evaluate(() => ({ url: location.href, lmsg: document.querySelector('#lmsg') && document.querySelector('#lmsg').outerHTML, body: document.body.innerText.slice(0, 200), ready: document.readyState })).catch((x) => String(x));
    throw new Error('offline notice never appeared: ' + JSON.stringify(state));
  }
  // The browser is signed out: the readable marker is gone and the API refuses the browser's requests.
  const after = await cookies(page);
  assert.equal(after.find((c) => c.name === 'sp_auth'), undefined, 'presence marker deleted');
  assert.equal(await page.evaluate(() => document.cookie.includes('sp_auth')), false);
  assert.equal(await page.evaluate(async (api) => (await fetch(api + '/api/v1/auth/me', { credentials: 'include' })).status, API), 401);
  // Honest limit: the server did not receive the revoke request, so the token itself is still valid until it expires.
  assert.equal((await fetch(`${API_LOOPBACK}/api/v1/auth/me`, { headers: { Cookie: `sp_session=${token}; sp_auth=1` } })).status, 200);
  // Protected pages stay closed in this browser. Remove the handler before turning interception off.
  page.off('request', blockDelete);
  await page.setRequestInterception(false);
  await page.goto(`${FRONT}/overview.html`);
  await onPage(page, 'login.html');
  await context.close();
});

const navLinks = (page) => page.$$eval('#nav a', (as) => as.map((a) => a.dataset.r));

test('UC-001 AC-1: each role sees only the menu the SRS matrix allows, and lands on its first allowed page', { skip, timeout: 120000 }, async () => {
  const expectations = [
    ['tech', 'overview.html', ['overview', 'operations', 'equipment', 'gis'], false],
    ['admin', 'overview.html', ['overview', 'operations', 'vessels', 'cargo', 'yard', 'services', 'equipment', 'gis'], true],
    ['manager', 'overview.html', ['overview', 'operations', 'vessels', 'cargo', 'yard', 'services', 'equipment', 'gis'], false],
    ['yard', 'overview.html', ['overview', 'operations', 'vessels', 'cargo', 'yard', 'services', 'gis'], false],
    ['main', 'overview.html', ['overview', 'operations', 'vessels', 'cargo', 'yard', 'services', 'equipment', 'gis'], false],
    ['agent', 'vessels.html', ['vessels'], false],
  ];
  for (const [key, landing, expectedNav, hasAdmin] of expectations) {
    const { page, context } = await newPage();
    await signIn(page, users[key]);
    await onPage(page, landing);
    await page.waitForSelector('#nav');
    assert.deepEqual(await navLinks(page), expectedNav, `${key} menu`);
    assert.equal((await page.$('nav.admin')) !== null, hasAdmin, `${key} administration menu`);
    await context.close();
  }
});

test('opening a page the role may not use shows "Access not permitted" with a link to its workspace', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await signIn(page, users.tech);
  await onPage(page, 'overview.html');
  await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#gohome');
  assert.match(await page.$eval('.pend h2', (e) => e.textContent), /Access not permitted/);
  assert.ok((await page.$eval('#gohome', (a) => a.getAttribute('href'))).endsWith('overview.html'));
  await context.close();
});

test('a failed logout caused by a client error keeps the page and says so', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.main);
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.method() === 'DELETE') r.respond({ status: 403, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': FRONT, 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' } }) });
    else r.continue();
  });
  await page.click('#signout');
  await page.waitForFunction(() => !document.querySelector('#banner').hidden);
  assert.match(await page.$eval('#banner', (e) => e.textContent), /Không thể đăng xuất/);
  assert.ok(page.url().endsWith('overview.html'));
  await context.close();
});

test('five wrong passwords lock the account in the UI, and the right password is then refused', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await page.goto(`${FRONT}/login.html`);
  for (let i = 1; i <= 5; i += 1) {
    await page.type('#le', users.lock.username);
    await page.type('#lp', `wrong-password-${i}`);
    await page.click('#lsub');
    // The password field is cleared only after the API answered, so this waits for the response to this attempt.
    await page.waitForFunction(() => !document.querySelector('#lmsg').hidden && !document.querySelector('#lsub').disabled
      && document.querySelector('#lp').value === '');
    if (i < 5) await page.$eval('#le', (e) => { e.value = ''; });
  }
  assert.match(await page.$eval('#lmsg', (e) => e.textContent), /khóa/);
  await page.$eval('#le', (e) => { e.value = ''; });
  await page.type('#le', users.lock.username);
  await page.type('#lp', users.lock.password);
  await page.click('#lsub');
  await page.waitForFunction(() => document.querySelector('#lmsg').textContent.includes('khóa') && !document.querySelector('#lsub').disabled);
  assert.ok(page.url().endsWith('login.html'));
  await context.close();
});
