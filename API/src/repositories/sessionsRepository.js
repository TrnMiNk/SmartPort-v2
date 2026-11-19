'use strict';

// Session storage keyed by the SHA-256 hash of the token. Revocation is a row update, so it takes effect
// on the next request (UC-002: a revoked token is not accepted).

async function create(db, { tokenHash, userId, expiresAt }) {
  await db.pool.request()
    .input('tokenHash', db.sql.VarBinary(32), tokenHash)
    .input('userId', db.sql.BigInt, userId)
    .input('expiresAt', db.sql.DateTime2(3), expiresAt)
    .query(`INSERT INTO dbo.auth_sessions (token_hash, user_id, expires_at)
            VALUES (@tokenHash, @userId, @expiresAt)`);
}

// Returns the session only if it is not revoked, not expired, and its user is active.
async function findActive(db, tokenHash) {
  const r = await db.pool.request()
    .input('tokenHash', db.sql.VarBinary(32), tokenHash)
    .query(`SELECT s.user_id, s.expires_at, u.username, u.display_name
            FROM dbo.auth_sessions s JOIN dbo.auth_users u ON u.user_id = s.user_id
            WHERE s.token_hash = @tokenHash AND s.revoked_at IS NULL
              AND s.expires_at > SYSUTCDATETIME() AND u.is_active = 1`);
  return r.recordset[0] ?? null;
}

// Sliding idle timeout: each accepted request extends expiry.
async function touch(db, tokenHash, expiresAt) {
  await db.pool.request()
    .input('tokenHash', db.sql.VarBinary(32), tokenHash)
    .input('expiresAt', db.sql.DateTime2(3), expiresAt)
    .query(`UPDATE dbo.auth_sessions SET last_seen_at = SYSUTCDATETIME(), expires_at = @expiresAt
            WHERE token_hash = @tokenHash AND revoked_at IS NULL`);
}

async function revoke(db, tokenHash) {
  const r = await db.pool.request()
    .input('tokenHash', db.sql.VarBinary(32), tokenHash)
    .query(`UPDATE dbo.auth_sessions SET revoked_at = SYSUTCDATETIME()
            WHERE token_hash = @tokenHash AND revoked_at IS NULL`);
  return r.rowsAffected[0] > 0;
}

module.exports = { create, findActive, touch, revoke };
