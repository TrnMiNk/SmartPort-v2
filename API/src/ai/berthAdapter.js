'use strict';

// Berth recommendation adapter (UC-027, FR-BRT-05). Provider-independent preparation only: the contract, the checks and the
// UNAVAILABLE behaviour. No provider is chosen (decision D3) and nothing calls this adapter yet; the use case itself (request
// assembly from the queue and berth states, the UC-026 recheck of every proposal, storage, screens) is not built.
//
// Contract v1 (proposed, to be confirmed with the provider owner; see docs/architecture/ai-integration-readiness.md):
//   POST {url}  JSON request:
//     { request_id, as_of (ISO 8601 with offset), rules_version,
//       vessels: [ { voyage_id, voyage_code, loa_m, draft_m, ship_type, cargo_class, cargo_hazard, priority_class, effective_eta, required_cranes? } ]   (1 to 20)
//       berths:  [ { berth_id, berth_code, berth_type, length_m, max_depth_m, available_cranes, allows_dangerous, state,
//                    busy: [ { from, to, position_start_m, position_end_m } ], maintenance: [ { from, to } ] } ] }
//   200 JSON response:
//     { model_version (1 to 40 characters),
//       proposals: [ { voyage_id, rank (1 to 3), berth_id, position_start_m, planned_start, planned_end, expected_wait_h, score (0..1) } ] }
//   A vessel with no feasible placement simply has no proposal; no proposal at all is NO_FEASIBLE_PLACEMENT.
// A response is accepted only if every proposal refers to a vessel and a berth of the request and has plausible values. That is a shape and
// consistency check. Whether a proposal obeys the placement rules (UC-026, BR-1) is decided afterwards by the placement service, never trusted
// from the provider; and whether the proposals are GOOD is a model-quality question, measured offline (NFR-ACC-04), not by this adapter.

const { callProvider } = require('./providerHttp');

const MAX_VESSELS = 20;      // NFR-PER-02
const MAX_PER_VESSEL = 3;    // UC-027: 1 to 3 ranked placements
const UNAVAILABLE = (reason) => ({ status: 'UNAVAILABLE', reason });
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const isoDate = (v) => (typeof v === 'string' && ISO_OFFSET.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Errors found in a request before any call. The service answers VALIDATION_FAILED with them (UC-027: more than 20 vessels).
function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object') return [{ field: 'request', message: 'Yêu cầu phải là đối tượng.' }];
  if (!Array.isArray(request.vessels) || request.vessels.length < 1) errors.push({ field: 'vessels', message: 'Cần chọn ít nhất một tàu.' });
  else if (request.vessels.length > MAX_VESSELS) errors.push({ field: 'vessels', message: `Chỉ được chọn tối đa ${MAX_VESSELS} tàu.` });
  else if (new Set(request.vessels.map((v) => v && v.voyage_id)).size !== request.vessels.length) errors.push({ field: 'vessels', message: 'Có tàu bị chọn nhiều lần.' });
  if (!Array.isArray(request.berths) || request.berths.length < 1) errors.push({ field: 'berths', message: 'Không có bến nào để đề xuất.' });
  if (!isoDate(request.as_of)) errors.push({ field: 'as_of', message: 'Thời điểm yêu cầu phải là ISO 8601 có múi giờ.' });
  return errors;
}

function validateBerthResponse(body, request) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.proposals)) return UNAVAILABLE('INVALID_RESPONSE');
  if (typeof body.model_version !== 'string' || body.model_version.length < 1 || body.model_version.length > 40) return UNAVAILABLE('INVALID_RESPONSE');
  const berths = new Map(request.berths.map((b) => [b.berth_id, b]));
  const vessels = new Set(request.vessels.map((v) => v.voyage_id));
  const ranks = new Map();
  const proposals = [];
  for (const p of body.proposals) {
    if (!p || typeof p !== 'object') return UNAVAILABLE('INVALID_RESPONSE');
    const berth = berths.get(p.berth_id);
    const start = isoDate(p.planned_start); const end = isoDate(p.planned_end);
    const ok = vessels.has(p.voyage_id) && berth && Number.isInteger(p.rank) && p.rank >= 1 && p.rank <= MAX_PER_VESSEL
      && finite(p.position_start_m) && p.position_start_m >= 0 && p.position_start_m <= Number(berth.length_m)
      && start && end && start < end
      && finite(p.expected_wait_h) && p.expected_wait_h >= 0 && finite(p.score) && p.score >= 0 && p.score <= 1;
    if (!ok) return UNAVAILABLE('INVALID_RESPONSE');
    const seen = ranks.get(p.voyage_id) || new Set();
    if (seen.has(p.rank)) return UNAVAILABLE('INVALID_RESPONSE');   // two proposals with one rank
    seen.add(p.rank); ranks.set(p.voyage_id, seen);
    proposals.push({ voyageId: p.voyage_id, rank: p.rank, berthId: p.berth_id, positionStartM: p.position_start_m, plannedStart: start, plannedEnd: end, expectedWaitH: p.expected_wait_h, score: p.score });
  }
  for (const seen of ranks.values()) {                                // ranks must run 1..k without gaps
    for (let r = 1; r <= seen.size; r += 1) if (!seen.has(r)) return UNAVAILABLE('INVALID_RESPONSE');
  }
  if (!proposals.length) return UNAVAILABLE('NO_FEASIBLE_PLACEMENT');
  proposals.sort((a, b) => a.voyageId - b.voyageId || a.rank - b.rank);
  return { status: 'AVAILABLE', modelVersion: body.model_version, proposals };
}

function createBerthAdapter({ url, apiKey, fetchImpl = globalThis.fetch, log } = {}) {
  return {
    configured: Boolean(url),
    async recommend(request, { timeoutMs }) {
      if (!url) return UNAVAILABLE('NOT_CONFIGURED');
      if (validateRequest(request).length) return UNAVAILABLE('INVALID_REQUEST');
      const r = await callProvider({ name: 'berth', url, apiKey, body: request, timeoutMs, fetchImpl, log });
      return r.ok ? validateBerthResponse(r.json, request) : UNAVAILABLE(r.reason);
    },
  };
}

module.exports = { createBerthAdapter, validateRequest, validateBerthResponse, MAX_VESSELS, MAX_PER_VESSEL };
