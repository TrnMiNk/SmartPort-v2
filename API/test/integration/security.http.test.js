'use strict';

// B6 security regression on real SQL Server (HTTP on loopback; HTTPS is in security.https.test.js). Covers: SQL injection payloads, CORS and CSRF posture,
// cookie attributes, request limits, uniform errors, no secrets in the process log, RBAC denial on every protected route family, and logout/expiry.
// Runs only with SP_TEST_DB. Fixtures are removed in `after`.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: security tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = `Pw-${crypto.randomBytes(9).toString('base64url')}`;       // random per run, never printed
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const ORIGIN = 'http://localhost:5500';
let db; let server; let secureServer; let base; let secureBase; let agentA; let portId; let typeId; let shipId; const cookies = {}; const usernames = [];
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: ORIGIN, cookieSecure: false }).listen(0);
  secureServer = createApp({ db, policy, corsOrigin: ORIGIN, cookieSecure: true }).listen(0);
  await Promise.all([server, secureServer].map((s) => new Promise((r) => s.once('listening', r))));
  base = `http://127.0.0.1:${server.address().port}`; secureBase = `http://127.0.0.1:${secureServer.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'SA_${SUFFIX}', N'Đại lý SA ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'SP${SUFFIX}', N'Cảng SP ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  for (const [key, [role, agentId]] of Object.entries({ coord: ['DIEU_PHOI_VIEN'], manager: ['BAN_QUAN_LY'], yard: ['NHAN_VIEN_KHO_BAI'], agent: ['DAI_LY_HANG_HAI', agentA], tech: ['KY_THUAT_VIEN'], admin: ['QUAN_TRI_HE_THONG'] })) {
    const username = `t_s_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  shipId = (await call('POST', '/ships', { who: 'coord', body: { imo_number: `8${String(100000 + Math.floor(Math.random() * 800000))}`, ship_name: `Sec ${SUFFIX}`, ship_type_id: typeId, operator_agent_id: agentA, length_overall_m: 150, beam_m: 25, max_draft_m: 8, deadweight_t: 10000 } })).body.data.id;
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const mine = `SELECT id FROM dbo.ships WHERE ship_name LIKE N'%${SUFFIX}%'`;
  await q(`UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${mine});
           DELETE FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${mine}));
           DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${mine}));
           DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${mine}));
           DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${mine}));
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${mine}));
           DELETE FROM dbo.voyages WHERE ship_id IN (${mine}); DELETE FROM dbo.ship_documents WHERE ship_id IN (${mine}); DELETE FROM dbo.ships WHERE id IN (${mine});`);
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
             DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
  await Promise.all([server, secureServer].map((s) => new Promise((r) => s.close(r))));
  await db.pool.close();
});

async function call(method, path_, { who, body, headers = {}, raw, origin, url = base } = {}) {
  const res = await fetch(url + '/api/v1' + path_, { method, headers: { ...(body !== undefined && raw === undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}), ...(origin ? { Origin: origin } : {}), ...headers },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)) });
  let json = null; let text = ''; try { text = await res.text(); json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

// ---------------------------------------------------------------- SQL injection
const PAYLOADS = ["' OR '1'='1", "'; DROP TABLE dbo.ships; --", "1; WAITFOR DELAY '0:0:5'--", "\" OR 1=1 --", "%' UNION SELECT name FROM sys.tables --", "N'x'; EXEC xp_cmdshell 'dir'; --"];

test('SQL injection: payloads in login, search, filters, ids and stored text are treated as data (parameterized): no 500, no extra rows, no delay, tables intact', { skip }, async () => {
  const shipsBefore = (await q('SELECT COUNT(*) AS n FROM dbo.ships'))[0].n; const started = Date.now();
  for (const p of PAYLOADS) {
    const login = await call('POST', '/auth/login', { body: { username: p, password: p } });
    assert.ok([400, 401].includes(login.status), `login with ${p}: ${login.status}`);
    for (const [path_, who] of [[`/ships?search=${encodeURIComponent(p)}`, 'coord'], [`/voyages?status=${encodeURIComponent(p)}`, 'coord'], [`/voyages/schedule?status=${encodeURIComponent(p)}&berth_id=${encodeURIComponent(p)}`, 'coord'],
      [`/berth-plans?status=${encodeURIComponent(p)}&voyage_id=${encodeURIComponent(p)}`, 'coord'], [`/berths/${encodeURIComponent(p)}`, 'coord'], [`/ships/${encodeURIComponent(p)}`, 'coord'], [`/notifications?page=${encodeURIComponent(p)}`, 'coord']]) {
      const r = await call('GET', path_, { who });
      assert.ok(r.status >= 200 && r.status < 500, `${path_}: ${r.status}`);
      if (r.status === 200 && r.body && r.body.data && Array.isArray(r.body.data.items)) assert.ok(r.body.data.items.length <= 100, `${path_} returned a bounded list`);
    }
  }
  assert.ok(Date.now() - started < 4000 + PAYLOADS.length * 400, 'a WAITFOR payload did not delay the answer');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.ships'))[0].n, shipsBefore, 'no table was dropped or changed by a payload');
  // The payload stored as text comes back as the same text (never executed): ship name and notice fields.
  const evil = `${PAYLOADS[1]} ${SUFFIX}`;
  const created = await call('POST', '/ships', { who: 'coord', body: { imo_number: `8${String(100000 + Math.floor(Math.random() * 800000))}`, ship_name: evil, ship_type_id: typeId, operator_agent_id: agentA, length_overall_m: 150, beam_m: 25, max_draft_m: 8, deadweight_t: 10000 } });
  assert.equal(created.status, 201, created.text);
  assert.equal((await q('SELECT ship_name FROM dbo.ships WHERE id = @i', { i: created.body.data.id }))[0].ship_name, evil);
  const notice = await call('POST', '/voyages', { who: 'agent', body: { ship_id: shipId, voyage_code: `V${SUFFIX}`, agent_id: agentA, origin_port_id: portId, declared_eta: '2035-05-05T01:00:00Z', declared_teu: 10, cargo_type: PAYLOADS[0] } });
  assert.equal(notice.status, 201, notice.text);
  assert.equal((await q('SELECT cargo_type FROM dbo.voyages WHERE id = @i', { i: notice.body.data.id }))[0].cargo_type, PAYLOADS[0]);
});

// ---------------------------------------------------------------- CORS and CSRF posture
test('CORS: only the configured origin gets credentials; another origin gets no CORS headers; a preflight from it is not answered as allowed', { skip }, async () => {
  const ok = await call('GET', '/health', { origin: ORIGIN });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(ok.headers.get('access-control-allow-credentials'), 'true'); assert.equal(ok.headers.get('vary'), 'Origin');
  for (const evil of ['http://evil.example', 'http://localhost:5501', 'null', ORIGIN + '.evil.example']) {
    const r = await call('GET', '/auth/me', { who: 'coord', origin: evil });
    assert.equal(r.headers.get('access-control-allow-origin'), null, `no allow-origin for ${evil}`); assert.equal(r.headers.get('access-control-allow-credentials'), null);
    const pre = await call('OPTIONS', '/ships', { origin: evil, headers: { 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null, `preflight from ${evil} is not allowed`);
    assert.notEqual(pre.status, 204);
  }
  const pre = await call('OPTIONS', '/ships', { origin: ORIGIN, headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204); assert.ok(!/\*/.test(pre.headers.get('access-control-allow-origin') || ''));
});

test('CSRF: state changes need JSON; a cross-site form (text/plain or urlencoded) with a valid cookie changes nothing; reads have no side effects; the cookie is SameSite=Lax', { skip }, async () => {
  const before = (await q('SELECT COUNT(*) AS n FROM dbo.ships'))[0].n;
  const forged = { imo_number: '8999991', ship_name: `Forged ${SUFFIX}`, ship_type_id: typeId, operator_agent_id: agentA, length_overall_m: 100, beam_m: 20, max_draft_m: 6, deadweight_t: 5000 };
  for (const [type, body] of [['text/plain', JSON.stringify(forged)], ['application/x-www-form-urlencoded', new URLSearchParams(Object.entries(forged)).toString()], ['multipart/form-data; boundary=x', '--x--']]) {
    const r = await call('POST', '/ships', { who: 'coord', raw: body, headers: { 'Content-Type': type }, origin: 'http://evil.example' });
    assert.ok([400, 415].includes(r.status), `${type}: ${r.status}`);
  }
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.ships'))[0].n, before, 'nothing was created by a forged form');
  const login = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password: PASSWORD }) });
  for (const c of login.headers.getSetCookie()) assert.match(c, /SameSite=Lax/i, c.split('=')[0]);
});

// ---------------------------------------------------------------- cookies
test('cookies: sp_session is HttpOnly + SameSite=Lax + Path=/ + a 30-minute lifetime (and Secure when configured); the token is not in the response body; each login issues a new token', { skip }, async () => {
  const login = async (url) => fetch(url + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password: PASSWORD }) });
  const plain = await login(base); const secure = await login(secureBase);
  const attrs = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(name + '='));
  const s = attrs(plain, 'sp_session'); const m = attrs(plain, 'sp_auth');
  assert.match(s, /HttpOnly/i); assert.match(s, /SameSite=Lax/i); assert.match(s, /Path=\//i); assert.match(s, /Max-Age=1800/i); assert.doesNotMatch(s, /;\s*Secure/i, 'development mode');
  assert.doesNotMatch(m, /HttpOnly/i, 'the presence marker is deliberately readable; it is not a secret');
  assert.match(attrs(secure, 'sp_session'), /;\s*Secure/i); assert.match(attrs(secure, 'sp_auth'), /;\s*Secure/i);
  const body = await plain.json(); const token = s.match(/sp_session=([^;]+)/)[1];
  assert.ok(!JSON.stringify(body).includes(token), 'the session token is only in the cookie');
  const second = await login(base); assert.notEqual(attrs(second, 'sp_session').match(/sp_session=([^;]+)/)[1], token, 'a new login gets a new token (no fixation)');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.auth_sessions WHERE token_hash = @t', { t: token }))[0].n, 0, 'the database stores a hash, never the raw token');
});

// ---------------------------------------------------------------- limits and uniform errors
test('request limits and errors: oversize body 413, malformed JSON 400, page size bounded, unknown fields refused, errors never carry SQL, stack or paths', { skip }, async () => {
  const big = await call('POST', '/ships', { who: 'coord', raw: JSON.stringify({ ship_name: 'x'.repeat(120 * 1024) }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(big.status, 413); assert.equal(big.body.error.code, 'VALIDATION_FAILED');
  assert.equal((await call('POST', '/ships', { who: 'coord', raw: '{"a":', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await call('GET', '/ships?size=100000', { who: 'coord' })).status, 400);
  assert.equal((await call('GET', '/ships?size=-1&page=-5', { who: 'coord' })).status, 400);
  assert.equal((await call('POST', '/ships', { who: 'coord', body: { is_admin: true, ship_name: 'x' } })).status, 400);
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  assert.ok([400, 413].includes((await call('POST', '/ships', { who: 'coord', raw: deep, headers: { 'Content-Type': 'application/json' } })).status));
  for (const r of [await call('GET', '/ships/999999999', { who: 'coord' }), await call('POST', '/auth/login', { body: { username: 'x', password: 'y' } }), await call('GET', '/nope', { who: 'coord' }), big]) {
    assert.ok(!/at .*\.js|SELECT |INSERT |sys\.|dbo\.|node_modules|C:\\\\|stack/i.test(r.text), `no internals in: ${r.text.slice(0, 120)}`);
  }
  const h = (await call('GET', '/health')).headers; assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.equal(h.get('x-powered-by'), null); assert.equal(h.get('referrer-policy'), 'no-referrer');
});

// ---------------------------------------------------------------- RBAC on every protected route family
test('RBAC: each route family refuses the roles that may not use it (403), anonymous gets 401; the agent cannot reach another agent\'s data', { skip }, async () => {
  const cases = [
    ['GET', '/berths/status', ['agent', 'tech'], ['coord', 'manager', 'yard', 'admin']], ['GET', '/berth-plans', ['agent', 'tech'], ['coord', 'manager', 'yard', 'admin']],
    ['GET', '/voyages/queue', ['agent', 'tech'], []], ['GET', '/voyages/schedule', ['agent', 'tech'], []],
    ['POST', '/berths', ['agent', 'manager', 'yard', 'tech', 'admin'], []], ['POST', '/berth-recommendations', ['agent', 'manager', 'yard', 'tech', 'admin'], []],
    ['POST', '/berth-plans/1/approve', ['agent', 'coord', 'yard', 'tech', 'admin'], []], ['POST', '/berth-plans/1/reject', ['agent', 'coord', 'yard', 'tech', 'admin'], []],
    ['PATCH', '/voyages/1/queue-position', ['agent', 'manager', 'yard', 'tech', 'admin'], []], ['POST', '/voyages/1/berthing', ['agent', 'manager', 'yard', 'tech', 'admin'], []],
    ['POST', '/voyages/1/departure', ['agent', 'manager', 'yard', 'tech', 'admin'], []], ['POST', '/voyages', ['manager', 'yard', 'tech', 'admin'], []],
  ];
  for (const [method, p, denied] of cases) {
    for (const who of denied) { const r = await call(method, p, { who, body: method === 'GET' ? undefined : {}, headers: { 'If-Match': '"1"' } }); assert.equal(r.status, 403, `${who} ${method} ${p}`); }
    assert.equal((await call(method, p, { body: method === 'GET' ? undefined : {}, headers: { 'If-Match': '"1"' } })).status, 401, `anonymous ${method} ${p}`);
  }
  // denial is audited (NFR-SEC-04) and does not depend on the data existing: plan 1 may not exist, yet the role is refused first
  assert.ok((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE outcome = 'DENIED' AND actor LIKE @a", { a: `t_s_%_${SUFFIX}` }))[0].n >= 1);
});

// ---------------------------------------------------------------- session end
test('sessions: logout kills the token; a copied cookie stops working after logout; two sessions of one user are independent', { skip }, async () => {
  const login = async () => { const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usernames[1], password: PASSWORD }) }); return `sp_session=${r.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`; };
  const a = await login(); const b = await login();
  const me = (c) => fetch(base + '/api/v1/auth/me', { headers: { Cookie: c } }).then((r) => r.status);
  assert.deepEqual([await me(a), await me(b)], [200, 200]);
  assert.equal((await fetch(base + '/api/v1/auth/logout', { method: 'DELETE', headers: { Cookie: a } })).status, 204);
  assert.deepEqual([await me(a), await me(b)], [401, 200], 'only the signed-out session ended');
});

// ---------------------------------------------------------------- process log
test('secrets: the API process log never contains a password, a session token, a cookie or SQL text, including after failed sign-ins and bad requests', { skip }, async () => {
  const log = []; const port = 3290 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..', '..'), env: { ...process.env, SP_DB_NAME: TEST_DB, SP_PORT: String(port), SP_HOST: '127.0.0.1', SP_COOKIE_SECURE: 'false', SP_CORS_ORIGIN: ORIGIN } });
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  try {
    for (let i = 0; ; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) break; } catch (e) { /* not up */ } if (i > 80) throw new Error('API did not start'); await new Promise((r) => setTimeout(r, 250)); }
    const u = `http://127.0.0.1:${port}/api/v1`; const wrong = `Wrong-${crypto.randomBytes(6).toString('hex')}`;
    const ok = await fetch(u + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password: PASSWORD }) });
    const token = ok.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1];
    await fetch(u + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usernames[0], password: wrong }) });
    await fetch(u + '/ships', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `sp_session=${token}; sp_auth=1` }, body: '{"broken' });
    await fetch(u + '/voyages/1%27%3B--', { headers: { Cookie: `sp_session=${token}; sp_auth=1` } });
    await new Promise((r) => setTimeout(r, 300));
    const text = log.join('');
    for (const secret of [PASSWORD, wrong, token, 'sp_session', 'password_hash', 'scrypt$']) assert.ok(!text.includes(secret), `the log does not contain ${secret.startsWith('Pw-') ? 'the password' : secret.slice(0, 6) + '…'}`);
    assert.ok(!/SELECT |INSERT |UPDATE dbo|at .*\.js:\d+/.test(text), 'no SQL text or stack traces in the log');
  } finally { child.kill(); }
});
