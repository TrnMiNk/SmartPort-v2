'use strict';

// CONTRACT TESTS WITH MOCKED PROVIDERS. Every "provider" here is a local stand-in written for the test. These tests prove that the adapters
// check, bound and log provider answers correctly. They do NOT prove that any real AI works, that any forecast or placement is good, or that
// a provider can answer in time (no provider exists, decision D3). Real-provider results must be reported separately.

const test = require('node:test');
const assert = require('node:assert/strict');
const { callProvider, describe, MAX_RESPONSE_BYTES } = require('../../src/ai/providerHttp');
const { createEtaAdapter } = require('../../src/ai/etaAdapter');
const { createBerthAdapter, validateRequest, validateBerthResponse } = require('../../src/ai/berthAdapter');

const reply = (status, body, headers = {}) => async () => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const lines = []; const log = (l) => lines.push(l);

// ---------------------------------------------------------------- providerHttp
test('MOCK providerHttp: the key goes only into the Authorization header; the log line carries no key, query, payload or body', async () => {
  const seen = {};
  const spy = async (url, init) => { seen.url = url; seen.init = init; return reply(200, { secret_in_body: 'BODY-SECRET' })(); };
  lines.length = 0;
  const r = await callProvider({ name: 't', url: 'https://ai.example.test/predict?token=URL-SECRET', apiKey: 'KEY-SECRET', body: { imo_number: 'PAYLOAD-SECRET' }, timeoutMs: 1000, fetchImpl: spy, log });
  assert.equal(r.ok, true);
  assert.equal(seen.init.headers.Authorization, 'Bearer KEY-SECRET');
  assert.equal(lines.length, 1);
  const text = JSON.stringify(lines);
  for (const secret of ['KEY-SECRET', 'URL-SECRET', 'PAYLOAD-SECRET', 'BODY-SECRET']) assert.ok(!text.includes(secret), `the log does not contain ${secret}`);
  assert.deepEqual([lines[0].event, lines[0].adapter, lines[0].provider, lines[0].outcome, lines[0].http_status], ['ai_call', 't', 'https://ai.example.test/predict', 'OK', 200]);
  assert.equal(typeof lines[0].duration_ms, 'number');
  const none = await callProvider({ name: 't', url: 'http://x.test/p', body: {}, timeoutMs: 1000, fetchImpl: spy, log });
  assert.equal(none.ok, true); assert.equal(seen.init.headers.Authorization, undefined, 'no key configured: no Authorization header');
});

test('MOCK providerHttp: every failure is a reason and one log line; a failing logger never changes the result', async () => {
  lines.length = 0;
  const bad = [[reply(500, {}), 'PROVIDER_ERROR_500'], [async () => { throw new TypeError('ECONNREFUSED'); }, 'UNREACHABLE'],
    [reply(200, {}, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }), 'RESPONSE_TOO_LARGE']];
  for (const [impl, reason] of bad) assert.deepEqual((await callProvider({ name: 't', url: 'http://x.test/p', body: {}, timeoutMs: 500, fetchImpl: impl, log })).reason, reason);
  assert.deepEqual(lines.map((l) => l.reason), bad.map((b) => b[1]));
  const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; reject(e); }));
  assert.equal((await callProvider({ name: 't', url: 'http://x.test/p', body: {}, timeoutMs: 30, fetchImpl: hang, log })).reason, 'TIMEOUT');
  const boom = () => { throw new Error('log sink down'); };
  assert.equal((await callProvider({ name: 't', url: 'http://x.test/p', body: {}, timeoutMs: 500, fetchImpl: reply(200, {}), log: boom })).ok, true);
  assert.equal(describe('not a url'), '(invalid url)');
});

test('MOCK eta adapter: the key reaches the provider and a valid answer is AVAILABLE; without a URL it stays NOT_CONFIGURED even with a key', async () => {
  let auth; const impl = async (u, init) => { auth = init.headers.Authorization; return reply(200, { predicted_eta: '2026-12-01T06:30:00Z', confidence: 0.5, model_version: 'm1' })(); };
  const a = createEtaAdapter({ url: 'http://x.test/p', apiKey: 'K', fetchImpl: impl, log });
  assert.equal((await a.predict({}, { timeoutMs: 500 })).status, 'AVAILABLE'); assert.equal(auth, 'Bearer K');
  assert.deepEqual(await createEtaAdapter({ apiKey: 'K', log }).predict({}, { timeoutMs: 500 }), { status: 'UNAVAILABLE', reason: 'NOT_CONFIGURED' });
});

// ---------------------------------------------------------------- berth adapter
const request = () => ({ request_id: 'r1', as_of: '2026-12-01T00:00:00Z', rules_version: 'UC026-RULES-V2',
  vessels: [{ voyage_id: 1, voyage_code: 'V1', loa_m: 200 }, { voyage_id: 2, voyage_code: 'V2', loa_m: 180 }],
  berths: [{ berth_id: 10, berth_code: 'B10', length_m: 400 }, { berth_id: 11, berth_code: 'B11', length_m: 300 }] });
const prop = (over = {}) => ({ voyage_id: 1, rank: 1, berth_id: 10, position_start_m: 0, planned_start: '2026-12-01T08:00:00Z', planned_end: '2026-12-01T20:00:00Z', expected_wait_h: 8, score: 0.9, ...over });
const ok = (proposals) => ({ model_version: 'berth-1', proposals });

test('MOCK berth request: 1 to 20 distinct vessels, at least one berth, a timestamp with zone', () => {
  assert.deepEqual(validateRequest(request()), []);
  const f = (r) => validateRequest(r).map((e) => e.field).sort();
  assert.deepEqual(f({ ...request(), vessels: [] }), ['vessels']);
  const twenty = Array.from({ length: 20 }, (_, i) => ({ voyage_id: i + 1 }));
  assert.deepEqual(validateRequest({ ...request(), vessels: twenty }), [], '20 vessels is the limit and is allowed');
  assert.deepEqual(f({ ...request(), vessels: [...twenty, { voyage_id: 21 }] }), ['vessels'], '21 vessels is refused before any call');
  assert.deepEqual(f({ ...request(), vessels: [{ voyage_id: 1 }, { voyage_id: 1 }] }), ['vessels']);
  assert.deepEqual(f({ ...request(), berths: [] }), ['berths']);
  assert.deepEqual(f({ ...request(), as_of: '2026-12-01T00:00:00' }), ['as_of']);
  assert.deepEqual(f(null), ['request']);
});

test('MOCK berth response: one to three ranked proposals per vessel are normalized and sorted; vessels without a proposal are fine', () => {
  const r = validateBerthResponse(ok([prop({ voyage_id: 2, rank: 1 }), prop({ rank: 2, berth_id: 11, score: 0.5 }), prop({ rank: 1 })]), request());
  assert.equal(r.status, 'AVAILABLE'); assert.equal(r.modelVersion, 'berth-1');
  assert.deepEqual(r.proposals.map((p) => [p.voyageId, p.rank, p.berthId]), [[1, 1, 10], [1, 2, 11], [2, 1, 10]]);
  assert.ok(r.proposals[0].plannedStart instanceof Date && r.proposals[0].plannedStart < r.proposals[0].plannedEnd);
  assert.equal(validateBerthResponse(ok([prop()]), request()).proposals.length, 1, 'only one feasible placement is accepted (4a)');
});

test('MOCK berth response: anything inconsistent is INVALID_RESPONSE, never a partial result; no proposal is NO_FEASIBLE_PLACEMENT', () => {
  const bad = [prop({ voyage_id: 99 }), prop({ berth_id: 99 }), prop({ rank: 0 }), prop({ rank: 4 }), prop({ rank: 1.5 }), prop({ position_start_m: -1 }), prop({ position_start_m: 401 }),
    prop({ planned_end: '2026-12-01T08:00:00Z' }), prop({ planned_start: '2026-12-01T08:00:00' }), prop({ expected_wait_h: -1 }), prop({ expected_wait_h: null }),
    prop({ score: 1.2 }), prop({ score: -0.1 }), prop({ score: '0.9' }), null, 'x'];
  for (const p of bad) assert.deepEqual(validateBerthResponse(ok([p]), request()), { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' }, JSON.stringify(p));
  assert.equal(validateBerthResponse(ok([prop(), prop({ berth_id: 11 })]), request()).reason, 'INVALID_RESPONSE', 'two proposals with the same rank');
  assert.equal(validateBerthResponse(ok([prop({ rank: 2 })]), request()).reason, 'INVALID_RESPONSE', 'ranks must start at 1 without gaps');
  for (const body of [null, {}, { model_version: 'm', proposals: 'x' }, { proposals: [] }, { model_version: '', proposals: [] }, { model_version: 'x'.repeat(41), proposals: [] }]) {
    assert.equal(validateBerthResponse(body, request()).reason, 'INVALID_RESPONSE', JSON.stringify(body));
  }
  assert.deepEqual(validateBerthResponse(ok([]), request()), { status: 'UNAVAILABLE', reason: 'NO_FEASIBLE_PLACEMENT' });
});

test('MOCK berth adapter: no provider means NOT_CONFIGURED and no call; an invalid request makes no call; provider failures are UNAVAILABLE', async () => {
  let calls = 0; const counting = async (...a) => { calls += 1; return reply(200, ok([prop()]))(...a); };
  assert.deepEqual(await createBerthAdapter({ fetchImpl: counting, log }).recommend(request(), { timeoutMs: 500 }), { status: 'UNAVAILABLE', reason: 'NOT_CONFIGURED' });
  const a = createBerthAdapter({ url: 'http://x.test/recommend', apiKey: 'K', fetchImpl: counting, log });
  assert.equal(a.configured, true);
  assert.deepEqual(await a.recommend({ ...request(), vessels: [] }, { timeoutMs: 500 }), { status: 'UNAVAILABLE', reason: 'INVALID_REQUEST' });
  assert.equal(calls, 0, 'nothing was sent');
  assert.equal((await a.recommend(request(), { timeoutMs: 500 })).status, 'AVAILABLE'); assert.equal(calls, 1);
  const down = createBerthAdapter({ url: 'http://x.test/r', fetchImpl: reply(502, {}), log });
  assert.deepEqual(await down.recommend(request(), { timeoutMs: 500 }), { status: 'UNAVAILABLE', reason: 'PROVIDER_ERROR_502' });
});
