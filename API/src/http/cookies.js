'use strict';

// Session cookies.
//  - sp_session: the opaque session token. HttpOnly, so scripts cannot read, change or delete it.
//  - sp_auth:    a presence marker ("1"), readable by the frontend. The API refuses a session unless the marker
//                is present. This lets the browser end its own session by deleting the marker when the server
//                cannot be reached during logout (UC-002 alternative flow 4a); the server session then simply
//                expires by time. The marker is NOT a secret and NOT a security control: it only records that this
//                browser has chosen to sign out.
// Both cookies are re-issued on every accepted request so the browser-side lifetime slides with the server session.

const SESSION_COOKIE = 'sp_session';
const MARKER_COOKIE = 'sp_auth';

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch (e) { return null; }
    }
  }
  return null;
}

function setSessionCookies(res, token, { idleMinutes, secure }) {
  const common = { sameSite: 'lax', secure, path: '/', maxAge: idleMinutes * 60 * 1000 };
  res.cookie(SESSION_COOKIE, token, { ...common, httpOnly: true });
  res.cookie(MARKER_COOKIE, '1', { ...common, httpOnly: false });
}

function clearSessionCookies(res, { secure }) {
  const common = { sameSite: 'lax', secure, path: '/' };
  res.clearCookie(SESSION_COOKIE, { ...common, httpOnly: true });
  res.clearCookie(MARKER_COOKIE, { ...common, httpOnly: false });
}

module.exports = { SESSION_COOKIE, MARKER_COOKIE, readCookie, setSessionCookies, clearSessionCookies };
