'use strict';

// B6 HTTPS behaviour in a local test environment: a throw-away self-signed certificate (made with openssl into a temp folder, deleted afterwards) is used by a
// TLS-terminating proxy in front of the API, which runs with cookieSecure=true like production behind a TLS proxy. The client TRUSTS that one certificate
// (pinned `ca`); certificate checking is never switched off. What this proves: the Secure/HttpOnly/SameSite attributes arrive over TLS, a session works over
// TLS, plain HTTP cannot talk to the TLS port, a client that does not trust the certificate is refused, and TLS 1.2 or newer is negotiated.
// What it does NOT prove: browser behaviour with Secure cookies, HSTS, certificate management, or a real proxy. Those depend on the production deployment.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-tls-'));
const keyFile = path.join(dir, 'key.pem'); const certFile = path.join(dir, 'cert.pem');
// An own minimal config: a machine-wide OPENSSL_CONF may point to a file that does not exist (seen on this host).
const cnf = path.join(dir, 'openssl.cnf');
fs.writeFileSync(cnf, ['[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3', '[dn]', 'CN=localhost', '[v3]', 'subjectAltName=DNS:localhost,IP:127.0.0.1', ''].join('\n'));
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-config', cnf, '-keyout', keyFile, '-out', certFile, '-days', '1'], { encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: cnf } });
const skip = !TEST_DB ? 'SP_TEST_DB not set: HTTPS tests not executed' : (made.status !== 0 ? 'unavailable: openssl could not create a test certificate' : false);
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = `Pw-${crypto.randomBytes(9).toString('base64url')}`;
let db; let apiServer; let tlsServer; let tlsPort; let username; let cert;

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  cert = fs.readFileSync(certFile);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  apiServer = createApp({ db, policy: { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 }, corsOrigin: 'https://localhost:5500', cookieSecure: true }).listen(0, '127.0.0.1');
  await new Promise((r) => apiServer.once('listening', r));
  // TLS-terminating proxy: decrypts and forwards to the API on loopback.
  tlsServer = https.createServer({ key: fs.readFileSync(keyFile), cert, minVersion: 'TLSv1.2' }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: apiServer.address().port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => tlsServer.once('listening', r));
  tlsPort = tlsServer.address().port;
  username = `t_tls_${SUFFIX}`;
  await createUser(db, { username, displayName: 'TLS test', password: PASSWORD, roleCodes: ['DIEU_PHOI_VIEN'], agentId: null });
}, { timeout: 60000 });

test.after(async () => {
  if (db) {
    await db.pool.request().query(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${username}');
      DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id; DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
    await Promise.all([apiServer, tlsServer].map((s) => new Promise((r) => s.close(r))));
    await db.pool.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const tls = (method, p, { body, cookie, ca = cert } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = https.request({ host: 'localhost', port: tlsPort, path: p, method, ca: ca === 'system' ? undefined : ca, servername: 'localhost', headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    const protocol = res.socket.getProtocol(); const cipher = res.socket.getCipher().name;   // read while the socket is attached
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), protocol, cipher }));
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});

test('HTTPS: TLS 1.2 or newer is negotiated; the login cookies are Secure + HttpOnly + SameSite=Lax; the session works over TLS and the token is not in the body', { skip }, async () => {
  const login = await tls('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
  assert.equal(login.status, 200); assert.match(login.protocol, /^TLSv1\.[23]$/); assert.ok(login.cipher.length > 0);
  const cookies = login.headers['set-cookie']; const s = cookies.find((c) => c.startsWith('sp_session=')); const m = cookies.find((c) => c.startsWith('sp_auth='));
  assert.match(s, /;\s*Secure/i); assert.match(s, /HttpOnly/i); assert.match(s, /SameSite=Lax/i); assert.match(m, /;\s*Secure/i);
  assert.ok(!login.text.includes(s.match(/sp_session=([^;]+)/)[1]), 'the token is only in the cookie');
  const jar = `sp_session=${s.match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  const me = await tls('GET', '/api/v1/auth/me', { cookie: jar });
  assert.equal(me.status, 200); const d = JSON.parse(me.text).data; assert.equal((d.user || d).username, username);
});

test('HTTPS: certificate checking stays on: a client that does not trust the certificate is refused; plain HTTP cannot talk to the TLS port; TLS 1.1 is refused', { skip }, async () => {
  await assert.rejects(() => tls('GET', '/api/v1/health', { ca: 'system' }), (e) => /self[- ]signed|unable to verify|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(`${e.code} ${e.message}`), 'an untrusted certificate is rejected, not ignored');
  const plain = await new Promise((resolve) => { const req = http.request({ host: '127.0.0.1', port: tlsPort, path: '/api/v1/health', method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }); req.on('error', (e) => resolve({ error: e.code || e.message })); req.setTimeout(3000, () => req.destroy(new Error('timeout'))); req.end(); });
  assert.ok(plain.error || plain.status >= 400, `plain HTTP to the TLS port gives no application data (${JSON.stringify(plain)})`);
  await assert.rejects(() => new Promise((resolve, reject) => { const r = https.request({ host: 'localhost', port: tlsPort, path: '/', ca: cert, servername: 'localhost', maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }, resolve); r.on('error', reject); r.end(); }), /protocol|version|alert|ERR_SSL|ECONNRESET|no protocols/i, 'TLS 1.1 is not accepted');
});
