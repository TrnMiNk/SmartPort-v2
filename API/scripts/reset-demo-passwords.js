'use strict';

// Resets the password of the six demo accounts created by scripts/demo-data.js, and nothing else.
//   Check only (no password, no writes):  SP_DB_NAME=<db> node scripts/reset-demo-passwords.js --check
//   Reset:  SP_DB_NAME=<db> SP_DEMO_PASSWORD=<new password, 12+ characters> node scripts/reset-demo-passwords.js --confirm-demo-reset
// Safety:
//  - Only these exact usernames are touched; the script stops if any of the six is missing. Other accounts, roles, data and the login code are not changed.
//  - The hash comes from the application's own hashPassword (src/security/password.js), the same function login verifies against.
//  - The reset also clears the failed-login counter and lock, and revokes open sessions of these six accounts only.
//  - One audit row per account (DEMO_PASSWORD_RESET, no password, no hash). The password is read from the environment and is never printed.
//  - After the commit it signs in to each account through the real login route (in-process) and reports ok or failed.
//  - Protected database names are refused by loadConfig.

const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/connection');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/security/password');
const audit = require('../src/repositories/auditRepository');

const USERS = ['demo_dieuphoi', 'demo_dieuphoi2', 'demo_quanly', 'demo_quanly2', 'demo_khobai', 'demo_daily'];

async function main() {
  const check = process.argv.includes('--check');
  if (!check && !process.argv.includes('--confirm-demo-reset')) throw new Error('Pass --check to inspect, or --confirm-demo-reset to reset the six demo passwords.');
  const password = process.env.SP_DEMO_PASSWORD;
  if (!check && (!password || password.length < 12)) throw new Error('SP_DEMO_PASSWORD (at least 12 characters) is required for the reset.');
  const config = loadConfig();
  const { sql, connect } = createPool(config.db);
  const db = { sql, pool: await connect() };
  const list = USERS.map((_, i) => `@u${i}`).join(', ');
  const bind = (req) => { USERS.forEach((u, i) => req.input(`u${i}`, sql.NVarChar(100), u)); return req; };
  const rows = (await bind(db.pool.request()).query(
    `SELECT u.user_id, u.username, u.is_active, u.failed_login_count, u.locked_until,
            (SELECT STRING_AGG(r.role_code, ',') FROM dbo.auth_user_roles ur JOIN dbo.auth_roles r ON r.role_id = ur.role_id WHERE ur.user_id = u.user_id) AS roles
     FROM dbo.auth_users u WHERE u.username IN (${list}) ORDER BY u.username`)).recordset;
  const missing = USERS.filter((u) => !rows.some((r) => r.username === u));
  process.stdout.write(`${config.db.database}: ${rows.length} of ${USERS.length} demo accounts found\n`);
  for (const r of rows) process.stdout.write(`  ${r.username.padEnd(16)} roles=${r.roles} active=${!!r.is_active} failed_logins=${r.failed_login_count} locked=${r.locked_until ? 'yes' : 'no'}\n`);
  if (missing.length) throw new Error(`Missing accounts: ${missing.join(', ')}. Nothing was changed.`);
  if (check) { await db.pool.close(); return; }

  const tx = new sql.Transaction(db.pool);
  await tx.begin();
  try {
    const req = bind(new sql.Request(tx)).input('hash', sql.VarChar(255), hashPassword(password));
    const done = await req.query(`UPDATE dbo.auth_users SET password_hash = @hash, password_changed_at = SYSUTCDATETIME(), failed_login_count = 0, locked_until = NULL WHERE username IN (${list})`);
    if (done.rowsAffected[0] !== USERS.length) throw new Error(`Expected ${USERS.length} rows, got ${done.rowsAffected[0]}. Rolled back.`);
    await bind(new sql.Request(tx)).query(`UPDATE dbo.auth_sessions SET revoked_at = SYSUTCDATETIME() WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM dbo.auth_users WHERE username IN (${list}))`);
    for (const r of rows) await audit.insert({ pool: tx, sql }, { actor: 'script:reset-demo-passwords', action: 'DEMO_PASSWORD_RESET', entityType: 'USER', entityId: r.user_id, outcome: 'SUCCESS', reason: r.username });
    await tx.commit();
  } catch (err) { await tx.rollback(); throw err; }
  process.stdout.write('Passwords reset for the six demo accounts.\n');

  const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
  const server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  let failed = 0;
  for (const username of USERS) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const body = await res.json().catch(() => null);
    const ok = res.status === 200 && body && body.success;
    if (!ok) failed += 1;
    process.stdout.write(`  login ${username.padEnd(16)} ${ok ? 'ok' : `FAILED (${res.status})`}\n`);
  }
  await new Promise((r) => server.close(r));
  await db.pool.close();
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { process.stderr.write(`reset-demo-passwords failed: ${err.message}\n`); process.exitCode = 1; });
