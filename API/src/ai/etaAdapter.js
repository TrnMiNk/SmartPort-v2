'use strict';

// ETA forecast adapter (UC-016, called by UC-015 step 3). No provider is chosen yet (decision D3), so with no URL
// configured the adapter answers UNAVAILABLE / NOT_CONFIGURED. It never invents a forecast: an unreachable, slow or
// malformed provider is also UNAVAILABLE, with the reason, and the caller continues with the declared ETA (3a).
// The HTTP call, timeout, key handling and logging are in providerHttp.js; this file owns the contract and the response check.
//
// Provider contract v1 (proposed, to be confirmed with the provider owner; see docs/architecture/ai-integration-readiness.md):
//   POST {url}  JSON { voyage_code, imo_number, origin_port_code?, declared_eta }
//   200 JSON    { predicted_eta: ISO 8601 with offset, confidence: number 0..1, model_version: string (1 to 40 characters) }
// A response is only a forecast after it passes validateEtaResponse(). Passing it proves the answer has the right shape, not that the
// forecast is accurate: accuracy is measured offline against actual arrival times (NFR-ACC-04, MAE below the declared ETA's deviation).

const { callProvider } = require('./providerHttp');

const UNAVAILABLE = (reason) => ({ status: 'UNAVAILABLE', reason });

function validateEtaResponse(body) {
  const eta = new Date(body && body.predicted_eta);
  const ok = body && typeof body.predicted_eta === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(body.predicted_eta) && !Number.isNaN(eta.getTime())
    && typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1
    && typeof body.model_version === 'string' && body.model_version.length > 0 && body.model_version.length <= 40;
  return ok ? { status: 'AVAILABLE', predictedEta: eta, confidence: body.confidence, modelVersion: body.model_version } : UNAVAILABLE('INVALID_RESPONSE');
}

function createEtaAdapter({ url, apiKey, fetchImpl = globalThis.fetch, log } = {}) {
  return {
    configured: Boolean(url),
    async predict(input, { timeoutMs }) {
      if (!url) return UNAVAILABLE('NOT_CONFIGURED');
      const r = await callProvider({ name: 'eta', url, apiKey, body: input, timeoutMs, fetchImpl, log });
      return r.ok ? validateEtaResponse(r.json) : UNAVAILABLE(r.reason);
    },
  };
}

module.exports = { createEtaAdapter, validateEtaResponse };
