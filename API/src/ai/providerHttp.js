'use strict';

// One safe way to call an external AI provider (UC-016 ETA forecast, UC-027 berth recommendation).
//  - A hard timeout (NFR-PER-06: 10 s) that aborts the request.
//  - An optional bearer key. The key is only ever placed in the Authorization header; it is never logged, stored or returned.
//  - A size cap on the answer, so a misbehaving provider cannot exhaust memory.
//  - One structured log line per call (adapter, outcome, reason, duration). The line carries no URL query, no credentials, no
//    request payload and no response body, only the provider's origin and path, so it is safe to keep in logs.
// Every failure becomes { ok: false, reason }; the callers turn it into UNAVAILABLE and the business flow continues (UC-015 3a, UC-027 3a).

// shortcut: only the declared Content-Length is capped; a chunked answer without that header is not, upgrade to a streaming byte count when a real provider is chosen.
const MAX_RESPONSE_BYTES = 1024 * 1024;

function describe(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch (e) { return '(invalid url)'; }
}

const defaultLog = (line) => process.stderr.write(JSON.stringify(line) + '\n');

async function callProvider({ name, url, apiKey, body, timeoutMs, fetchImpl = globalThis.fetch, log = defaultLog, now = Date.now }) {
  const started = now();
  const finish = (result) => {
    try {
      log({ event: 'ai_call', adapter: name, provider: describe(url), outcome: result.ok ? 'OK' : 'UNAVAILABLE', reason: result.ok ? null : result.reason,
        http_status: result.httpStatus ?? null, duration_ms: now() - started });
    } catch (e) { /* logging must never change the business result */ }
    return result;
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST', signal: controller.signal, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!res.ok) return finish({ ok: false, reason: 'PROVIDER_ERROR_' + res.status, httpStatus: res.status });
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return finish({ ok: false, reason: 'RESPONSE_TOO_LARGE', httpStatus: res.status });
    const json = await res.json();
    return finish({ ok: true, json, httpStatus: res.status });
  } catch (e) {
    return finish({ ok: false, reason: e && e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callProvider, describe, MAX_RESPONSE_BYTES };
