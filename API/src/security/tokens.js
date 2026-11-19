'use strict';

// Opaque session tokens. The client receives the raw token once (HttpOnly cookie). The database stores only
// its SHA-256 hash, so a database read does not reveal a usable session.

const crypto = require('node:crypto');

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

module.exports = { newSessionToken, hashToken };
