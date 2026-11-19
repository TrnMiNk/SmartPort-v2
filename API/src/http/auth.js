'use strict';

// Express middleware: session authentication and default-deny authorization (rule 04).
// Frontend checks are usability only; every protected route passes through these.

const { resolvePrincipal } = require('../services/authService');
const { errors } = require('../errors');
const { can } = require('../security/permissions');
const audit = require('../repositories/auditRepository');
const { SESSION_COOKIE, MARKER_COOKIE, readCookie, setSessionCookies } = require('./cookies');

// A request is authenticated only with the session token AND the presence marker (see cookies.js).
function requireSession(deps) {
  return async (req, res, next) => {
    try {
      const token = readCookie(req, SESSION_COOKIE);
      const marker = readCookie(req, MARKER_COOKIE);
      if (!token || marker !== '1') throw errors.unauthenticated();
      req.token = token;
      req.principal = await resolvePrincipal(deps.db, deps.policy, token);
      setSessionCookies(res, token, { idleMinutes: deps.policy.sessionIdleMinutes, secure: deps.cookieSecure });
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Allows the request only if the principal holds one of the listed roles. An empty list denies everything.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.principal) return next(errors.unauthenticated());
    if (allowedRoles.length === 0) return next(errors.forbidden());
    const ok = req.principal.roles.some((role) => allowedRoles.includes(role));
    return ok ? next() : next(errors.forbidden());
  };
}

// Allows the request only if the roles grant one of `actions` on `feature` in the permission matrix.
// A denial is audited (rule 04: every attempted state change records its outcome) when `auditAction` is given.
function requirePermission({ db }, feature, actions, auditAction) {
  return async (req, res, next) => {
    if (!req.principal) return next(errors.unauthenticated());
    if (can(req.principal.roles, feature, ...actions)) return next();
    if (auditAction) {
      try {
        await audit.insert(db, { actor: req.principal.username, action: auditAction, entityType: feature,
          entityId: null, outcome: 'DENIED', reason: 'NO_PERMISSION' });
      } catch (e) { /* an audit failure must not turn a denial into a server error */ }
    }
    return next(errors.forbidden());
  };
}

module.exports = { requireSession, requireRole, requirePermission, readCookie, COOKIE_NAME: SESSION_COOKIE };
