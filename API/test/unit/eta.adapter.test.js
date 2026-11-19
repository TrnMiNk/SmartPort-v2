'use strict';

// The adapter is tested against local stand-ins for the provider. They check the adapter's contract handling only.
// They are NOT a real forecast service: with no provider configured the result is always UNAVAILABLE (decision D3).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEtaAdapter } = require('../../src/ai/etaAdapter');

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const good = { predicted_eta: '2026-12-01T06:30:00Z', confidence: 0.8, model_version: 'eta-1' };
const quiet = () => {};
const adapterFor = (fetchImpl) => createEtaAdapter({ url: 'http://provider.test/predict', fetchImpl, log: quiet });

test('no provider configured: UNAVAILABLE / NOT_CONFIGURED, nothing is invented', async () => {
  const a = createEtaAdapter({ log: quiet });
  assert.equal(a.configured, false);
  assert.deepEqual(await a.predict({}, { timeoutMs: 100 }), { status: 'UNAVAILABLE', reason: 'NOT_CONFIGURED' });
});

test('a valid provider answer is AVAILABLE with a Date, confidence and model version', async () => {
  const r = await adapterFor(reply(200, good)).predict({ voyage_code: 'V1' }, { timeoutMs: 1000 });
  assert.equal(r.status, 'AVAILABLE');
  assert.equal(r.predictedEta.toISOString(), '2026-12-01T06:30:00.000Z');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.modelVersion, 'eta-1');
});

test('malformed answers are UNAVAILABLE / INVALID_RESPONSE, never a forecast', async () => {
  const bad = [{ ...good, predicted_eta: '2026-12-01T06:30:00' }, { ...good, predicted_eta: 'soon' }, { ...good, confidence: 1.2 }, { ...good, confidence: -0.1 },
    { ...good, confidence: '0.8' }, { ...good, model_version: '' }, { ...good, model_version: 'x'.repeat(41) }, null, 'text', {}];
  for (const body of bad) {
    assert.deepEqual(await adapterFor(reply(200, body)).predict({}, { timeoutMs: 1000 }), { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' }, JSON.stringify(body));
  }
  assert.equal((await adapterFor(reply(200, { ...good, confidence: 0 })).predict({}, { timeoutMs: 1000 })).status, 'AVAILABLE', 'confidence 0 is a legal value');
  assert.equal((await adapterFor(reply(200, { ...good, confidence: 1 })).predict({}, { timeoutMs: 1000 })).status, 'AVAILABLE');
});

test('provider errors, unreachable provider and non-JSON answers are UNAVAILABLE with a reason', async () => {
  assert.deepEqual(await adapterFor(reply(503, {})).predict({}, { timeoutMs: 1000 }), { status: 'UNAVAILABLE', reason: 'PROVIDER_ERROR_503' });
  assert.deepEqual(await adapterFor(async () => { throw new TypeError('connect ECONNREFUSED'); }).predict({}, { timeoutMs: 1000 }), { status: 'UNAVAILABLE', reason: 'UNREACHABLE' });
  const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  assert.equal((await adapterFor(html).predict({}, { timeoutMs: 1000 })).status, 'UNAVAILABLE');
});

test('a provider that does not answer within the timeout is UNAVAILABLE / TIMEOUT, and the call is aborted', async () => {
  let aborted = false;
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const started = Date.now();
  const r = await adapterFor(hang).predict({}, { timeoutMs: 60 });
  assert.deepEqual(r, { status: 'UNAVAILABLE', reason: 'TIMEOUT' });
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000, 'the call returns promptly after the timeout');
});
