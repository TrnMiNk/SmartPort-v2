/* Session handling for UC-001 (login) and UC-002 (logout and session expiry).
   The session is a server-side cookie (HttpOnly), so this code never sees or stores a token or password.
   The API enforces authentication and roles on every request; role data here is for display only. */
(function (root) {
  'use strict';

  const SESSION_FLAG = 'sp-had-session'; // lets us tell "session expired" from "never signed in"
  const USERNAME = /^[A-Za-z0-9._-]{3,100}$/;
  const ROLE_LABELS = {
    QUAN_TRI_HE_THONG: 'System administrator',
    DIEU_PHOI_VIEN: 'Coordinator',
    DAI_LY_HANG_HAI: 'Shipping agent',
    BAN_QUAN_LY: 'Port management',
  };

  // Mirrors the API rules for fast feedback only; the API remains the authority.
  function validateCredentials(username, password) {
    const errors = {};
    if (typeof username !== 'string' || !USERNAME.test(username.trim())) {
      errors.username = 'Tên đăng nhập gồm 3–100 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.';
    }
    if (typeof password !== 'string' || password.length === 0) {
      errors.password = 'Vui lòng nhập mật khẩu.';
    } else if (password.length > 256) {
      errors.password = 'Mật khẩu quá dài.';
    }
    return errors;
  }

  // Page -> permission-matrix features (docs/use-cases/UC005.md §3). A user may open a page if they hold any action
  // on any listed feature. This only chooses what to show; the API checks every request itself.
  // Assumption A-6: overview and operations are POC/TOC dashboards (M7); "Vessels & berths" covers M1 and M2.
  const PAGE_FEATURES = {
    overview: ['M7_MONITORING'], operations: ['M7_MONITORING'], vessels: ['M1_VESSELS', 'M2_BERTHS'],
    cargo: ['M3_CARGO'], yard: ['M4_YARD'], services: ['M5_BILLING'], equipment: ['M6_IOT'],
    gis: ['M7_MONITORING'], admin: ['ADMIN'],
  };
  const PAGE_ORDER = ['overview', 'operations', 'vessels', 'cargo', 'yard', 'services', 'equipment', 'gis', 'admin'];

  function can(user, feature, action) {
    const granted = user && user.permissions && user.permissions[feature];
    return Array.isArray(granted) && (action === undefined ? granted.length > 0 : granted.includes(action));
  }

  function canViewPage(user, page) {
    return (PAGE_FEATURES[page] || []).some((feature) => can(user, feature));
  }

  // First page the user may open, used after sign-in. Falls back to the login page when nothing is allowed.
  function homeFor(user) {
    const page = PAGE_ORDER.find((p) => canViewPage(user, p));
    return page ? page + '.html' : 'login.html?reason=noaccess';
  }

  function roleLabel(roles) {
    if (!Array.isArray(roles) || roles.length === 0) return 'No role assigned';
    return roles.map((r) => ROLE_LABELS[r] || r).join(', ');
  }

  function initials(displayName) {
    const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
  }

  function createAuth({ api, storage, redirect, clearMarker }) {
    let user = null;

    const flag = {
      get() { try { return storage.getItem(SESSION_FLAG) === '1'; } catch (e) { return false; } },
      set(on) { try { if (on) storage.setItem(SESSION_FLAG, '1'); else storage.removeItem(SESSION_FLAG); } catch (e) { /* storage may be blocked */ } },
    };

    // Several requests can fail with 401 at the same moment (for example two catalog calls). Only the first one may
    // start the redirect; a second call would see the cleared flag and replace the "expired" notice with a plain login.
    let leaving = false;
    function goToLogin() {
      if (leaving) return;
      leaving = true;
      const expired = flag.get();
      flag.set(false);
      user = null;
      redirect('login.html' + (expired ? '?reason=expired' : ''));
    }

    async function login(username, password) {
      const data = await api.request('/api/v1/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password },
        notifyUnauthorized: false, // a 401 here means wrong credentials, not an expired session
      });
      user = data.user;
      flag.set(true);
      return user;
    }

    // Returns the signed-in user, or redirects to the login page on 401. Network errors are thrown so the
    // page can show a retry state instead of wrongly sending the user to sign in again.
    async function requireSession() {
      try {
        const data = await api.request('/api/v1/auth/me', { notifyUnauthorized: false });
        user = data.user;
        flag.set(true);
        return user;
      } catch (e) {
        if (e && e.status === 401) {
          goToLogin();
          return new Promise(() => {}); // the page is navigating away
        }
        throw e;
      }
    }

    // Used by the login page: is there already a valid session? Never redirects, never throws.
    async function peek() {
      try {
        const data = await api.request('/api/v1/auth/me', { notifyUnauthorized: false });
        return data.user;
      } catch (e) {
        return null;
      }
    }

    // Revokes the session on the server (UC-002). Returns { revoked }.
    // Alternative flow 4a: when the server cannot be reached (network error or 5xx), the browser session is cleared
    // by deleting the readable presence marker. The API refuses a session without it, so this browser is signed out
    // even though the HttpOnly token cannot be deleted from script; that token then expires by time on the server.
    async function logout() {
      try {
        await api.request('/api/v1/auth/logout', { method: 'DELETE', notifyUnauthorized: false });
      } catch (e) {
        if (e && (e.status === 0 || e.status >= 500)) {
          clearMarker();
          flag.set(false);
          user = null;
          redirect('login.html?reason=offline');
          return { revoked: false };
        }
        if (!e || e.status !== 401) throw e; // 401: already signed out, fall through
      }
      flag.set(false);
      user = null;
      redirect('login.html');
      return { revoked: true };
    }

    return {
      login, requireSession, peek, logout,
      handleUnauthorized: goToLogin,
      get user() { return user; },
    };
  }

  const exported = { validateCredentials, roleLabel, initials, createAuth, SESSION_FLAG, can, canViewPage, homeFor, PAGE_FEATURES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.SP_AUTH = createAuth({
      api: root.SP_API,
      storage: root.sessionStorage,
      redirect: (url) => root.location.replace(url),
      // Deletes the presence marker and checks it is gone. Reading document.cookie right after writing it makes the
      // browser apply the deletion before the next request leaves (the write is otherwise asynchronous, and a quick
      // request from the login page could still carry the marker). A second, explicit expiry covers stubborn cases.
      clearMarker: () => {
        const doc = root.document;
        doc.cookie = 'sp_auth=; Max-Age=0; Path=/; SameSite=Lax';
        if (/(?:^|;\s*)sp_auth=/.test(doc.cookie)) doc.cookie = 'sp_auth=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
      },
    });
    root.SP_AUTH_UTIL = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
