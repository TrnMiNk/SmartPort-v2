'use strict';

// Thin HTTP adapter for auth endpoints: parse input, call the service, shape the response.

const auth = require('../services/authService');
const { validateLogin } = require('../validation/authValidation');
const { setSessionCookies, clearSessionCookies } = require('../http/cookies');
const { AppError } = require('../errors');

function buildController({ db, policy, cookieSecure }) {
  return {
    async login(req, res) {
      const fieldErrors = validateLogin(req.body);
      if (fieldErrors.length) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Dữ liệu không hợp lệ.', fieldErrors);
      }
      const result = await auth.login(db, policy, req.body);
      setSessionCookies(res, result.token, { idleMinutes: policy.sessionIdleMinutes, secure: cookieSecure });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: { user: result.user } });
    },

    async me(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: { user: auth.toPublicUser(req.principal) } });
    },

    async logout(req, res) {
      await auth.logout(db, req.principal, req.token);
      clearSessionCookies(res, { secure: cookieSecure });
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
    },
  };
}

module.exports = { buildController };
