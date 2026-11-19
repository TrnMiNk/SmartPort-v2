'use strict';

// Authentication business rules for UC-001 (login) and UC-002 (logout, session expiry).
// Rules: wrong credentials give one generic message; lock after N consecutive failures (default 5);
// every outcome is audited; sessions are server-side and revocable; idle expiry is sliding.

const users = require('../repositories/usersRepository');
const sessions = require('../repositories/sessionsRepository');
const audit = require('../repositories/auditRepository');
const { hashPassword, verifyPasswordAsync } = require('../security/password');
const { newSessionToken, hashToken } = require('../security/tokens');
const { errors } = require('../errors');
const { permissionsFor } = require('../security/permissions');

// Used to keep timing similar when the username does not exist.
const DUMMY_HASH = hashPassword('not-a-real-password-' + Date.now());

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function login(db, policy, { username, password }) {
  const user = await users.findByUsername(db, username);
  const now = Date.now();

  if (!user) {
    await verifyPasswordAsync(password, DUMMY_HASH);
    await audit.insert(db, { actor: 'anonymous', action: 'LOGIN', entityType: 'AUTH_USER', entityId: null,
      outcome: 'FAILED', reason: 'UNKNOWN_USER' });
    throw errors.invalidCredentials();
  }

  // A lock that has run out starts a fresh count: five more failures are needed to lock again (UC-001 policy:
  // 5 consecutive failures, then a lock of SP_LOGIN_LOCK_MINUTES, default 15).
  if (user.locked_until && new Date(user.locked_until).getTime() <= now) {
    await users.resetFailedLogins(db, user.user_id);
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > now) {
    await audit.insert(db, { actor: user.username, action: 'LOGIN', entityType: 'AUTH_USER', entityId: user.user_id,
      outcome: 'DENIED', reason: 'ACCOUNT_LOCKED' });
    throw errors.accountLocked();
  }

  if (!user.is_active) {
    await audit.insert(db, { actor: user.username, action: 'LOGIN', entityType: 'AUTH_USER', entityId: user.user_id,
      outcome: 'DENIED', reason: 'ACCOUNT_INACTIVE' });
    throw errors.accountInactive();
  }

  if (!(await verifyPasswordAsync(password, user.password_hash))) {
    const after = await users.recordFailedLogin(db, user.user_id, policy.loginMaxFailures, policy.loginLockMinutes);
    await audit.insert(db, { actor: user.username, action: 'LOGIN', entityType: 'AUTH_USER', entityId: user.user_id,
      outcome: 'FAILED', reason: after.locked_until ? 'LOCKED_AFTER_FAILURES' : 'WRONG_PASSWORD' });
    if (after.locked_until) throw errors.accountLocked();
    throw errors.invalidCredentials();
  }

  await users.resetFailedLogins(db, user.user_id);
  const token = newSessionToken();
  const expiresAt = minutesFromNow(policy.sessionIdleMinutes);
  await sessions.create(db, { tokenHash: hashToken(token), userId: user.user_id, expiresAt });
  await audit.insert(db, { actor: user.username, action: 'LOGIN', entityType: 'AUTH_USER', entityId: user.user_id,
    outcome: 'SUCCESS' });

  return { token, expiresAt, user: toPublicUser({ userId: user.user_id, username: user.username,
    displayName: user.display_name, roles: await users.roleCodesFor(db, user.user_id) }) };
}

// The shape returned to clients. `permissions` is derived from the roles on the server (docs/api/contracts.md);
// the frontend uses it to choose what to show, while the API still checks every request itself.
function toPublicUser({ userId, username, displayName, roles }) {
  return { id: userId, username, displayName, roles, permissions: permissionsFor(roles) };
}

// Returns the authenticated principal, or throws UNAUTHENTICATED. Roles are read on every request so that
// a role change takes effect on the next request (UC-005 acceptance).
async function resolvePrincipal(db, policy, token) {
  if (!token) throw errors.unauthenticated();
  const tokenHash = hashToken(token);
  const session = await sessions.findActive(db, tokenHash);
  if (!session) throw errors.unauthenticated();
  await sessions.touch(db, tokenHash, minutesFromNow(policy.sessionIdleMinutes));
  return {
    userId: session.user_id,
    username: session.username,
    displayName: session.display_name,
    roles: await users.roleCodesFor(db, session.user_id),
    agentIds: await users.agentIdsFor(db, session.user_id),
  };
}

async function logout(db, principal, token) {
  if (token) {
    const revoked = await sessions.revoke(db, hashToken(token));
    await audit.insert(db, { actor: principal.username, action: 'LOGOUT', entityType: 'AUTH_USER',
      entityId: principal.userId, outcome: 'SUCCESS', reason: revoked ? null : 'ALREADY_REVOKED' });
  }
}

module.exports = { login, resolvePrincipal, logout, minutesFromNow, toPublicUser };
