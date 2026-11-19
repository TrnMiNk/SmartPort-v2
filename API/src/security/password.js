'use strict';

// Password hashing with scrypt from node:crypto (no extra dependency). Stored format:
//   scrypt$N$r$p$<saltBase64>$<hashBase64>
// Plaintext passwords are never stored, logged or returned (UC-001 business rule).

const crypto = require('node:crypto');

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

function hashPassword(plaintext) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(plaintext, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plaintext, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(plaintext, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Same check without blocking the event loop: scrypt runs on the libuv thread pool. The synchronous version made 50 simultaneous sign-ins
// answer together after about 1.5 s and stalled every other request meanwhile (B2 load test). Used by the login path.
const scryptAsync = require('node:util').promisify(crypto.scrypt);
async function verifyPasswordAsync(plaintext, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(plaintext, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync };
