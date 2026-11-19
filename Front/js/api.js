/* Centralized API client (rule 03: every backend call goes through here).
   Pages never call fetch directly. Responses follow the API envelope (docs/api/contracts.md §1):
   success -> { success:true, data }, failure -> { success:false, error:{ code, message, details? } }.
   Works in the browser (window.SP_API) and in Node tests (module.exports). */
(function (root) {
  'use strict';

  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status; // 0 means the server could not be reached
      this.code = code;
      this.details = details;
    }
  }

  function createClient({ baseUrl, fetchImpl, onUnauthorized }) {
    async function request(path, opts = {}) {
      const { method = 'GET', body, notifyUnauthorized = true, headers: extraHeaders = {} } = opts;
      let res;
      try {
        res = await fetchImpl(baseUrl + path, {
          method,
          credentials: 'include', // session cookie (HttpOnly) travels with the request
          cache: 'no-store',
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ. Vui lòng thử lại.');
      }

      if (res.status === 204) return null;

      let payload = null;
      try { payload = await res.json(); } catch (e) { payload = null; }

      if (!res.ok) {
        const err = payload && payload.error ? payload.error : null;
        const error = new ApiError(
          res.status,
          err && err.code ? err.code : 'HTTP_' + res.status,
          err && err.message ? err.message : 'Yêu cầu không thành công. Vui lòng thử lại.',
          err ? err.details : undefined
        );
        if (res.status === 401 && notifyUnauthorized && onUnauthorized) onUnauthorized(error);
        throw error;
      }

      if (!payload || payload.success !== true) {
        throw new ApiError(502, 'INVALID_RESPONSE', 'Máy chủ trả về dữ liệu không hợp lệ.');
      }
      return payload.data;
    }
    return { request };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createClient, ApiError };
  } else {
    root.SP_API = createClient({
      baseUrl: root.SP_CONFIG.apiBaseUrl,
      fetchImpl: root.fetch.bind(root),
      // Any protected request that returns 401 means the session ended. SP_AUTH is defined by auth.js.
      onUnauthorized: () => { if (root.SP_AUTH) root.SP_AUTH.handleUnauthorized(); },
    });
    root.SP_ApiError = ApiError;
  }
})(typeof window !== 'undefined' ? window : globalThis);
