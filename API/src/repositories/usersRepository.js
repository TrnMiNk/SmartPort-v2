'use strict';

// Data access for users and roles. SQL only; no business decisions here.

async function findByUsername(db, username) {
  const r = await db.pool.request()
    .input('username', db.sql.NVarChar(100), username)
    .query(`SELECT user_id, username, display_name, password_hash, is_active, failed_login_count, locked_until
            FROM dbo.auth_users WHERE username = @username`);
  return r.recordset[0] ?? null;
}

async function findById(db, userId) {
  const r = await db.pool.request()
    .input('userId', db.sql.BigInt, userId)
    .query(`SELECT user_id, username, display_name, is_active FROM dbo.auth_users WHERE user_id = @userId`);
  return r.recordset[0] ?? null;
}

// Atomically counts one failed attempt. Locks the account when the count reaches maxFailures.
async function recordFailedLogin(db, userId, maxFailures, lockMinutes) {
  const r = await db.pool.request()
    .input('userId', db.sql.BigInt, userId)
    .input('maxFailures', db.sql.Int, maxFailures)
    .input('lockMinutes', db.sql.Int, lockMinutes)
    .query(`UPDATE dbo.auth_users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= @maxFailures
                                    THEN DATEADD(MINUTE, @lockMinutes, SYSUTCDATETIME()) ELSE locked_until END
            OUTPUT inserted.failed_login_count, inserted.locked_until
            WHERE user_id = @userId`);
  return r.recordset[0];
}

async function resetFailedLogins(db, userId) {
  await db.pool.request()
    .input('userId', db.sql.BigInt, userId)
    .query(`UPDATE dbo.auth_users SET failed_login_count = 0, locked_until = NULL WHERE user_id = @userId`);
}

async function roleCodesFor(db, userId) {
  const r = await db.pool.request()
    .input('userId', db.sql.BigInt, userId)
    .query(`SELECT r.role_code FROM dbo.auth_user_roles ur
            JOIN dbo.auth_roles r ON r.role_id = ur.role_id WHERE ur.user_id = @userId`);
  return r.recordset.map((row) => row.role_code);
}

async function agentIdsFor(db, userId) {
  const r = await db.pool.request()
    .input('userId', db.sql.BigInt, userId)
    .query(`SELECT agent_id FROM dbo.auth_user_agents WHERE user_id = @userId`);
  return r.recordset.map((row) => row.agent_id);
}

module.exports = { findByUsername, findById, recordFailedLogin, resetFailedLogins, roleCodesFor, agentIdsFor };
