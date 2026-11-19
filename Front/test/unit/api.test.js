'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, ApiError } = require('../../js/api');

function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new Error('no body'); return body; } };
}

function client(handler, onUnauthorized) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { api: createClient({ baseUrl: 'http://api.test', fetchImpl, onUnauthorized }), calls };
}

test('sends credentials, no-store, JSON body and returns envelope data', async () => {
  const { api, calls } = client(() => fakeResponse(200, { success: true, data: { user: { id: 1 } } }));
  const data = await api.request('/api/v1/x', { method: 'POST', body: { a: 1 } });
  assert.deepEqual(data, { user: { id: 1 } });
  assert.equal(calls[0].url, 'http://api.test/api/v1/x');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"a":1}');
});

test('GET without body sends no Content-Type and no body', async () => {
  const { api, calls } = client(() => fakeResponse(200, { success: true, data: {} }));
  await api.request('/api/v1/health');
  assert.deepEqual(calls[0].init.headers, {});
  assert.equal(calls[0].init.body, undefined);
});

test('204 returns null', async () => {
  const { api } = client(() => ({ status: 204, ok: true, json: async () => { throw new Error('none'); } }));
  assert.equal(await api.request('/x', { method: 'DELETE' }), null);
});

test('error envelope becomes ApiError with status, code, message and details', async () => {
  const body = { success: false, error: { code: 'VALIDATION_FAILED', message: 'Sai', details: [{ field: 'username' }] } };
  const { api } = client(() => fakeResponse(400, body));
  await assert.rejects(() => api.request('/x'), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 400);
    assert.equal(e.code, 'VALIDATION_FAILED');
    assert.equal(e.message, 'Sai');
    assert.deepEqual(e.details, [{ field: 'username' }]);
    return true;
  });
});

test('error without a JSON body still yields a safe ApiError', async () => {
  const { api } = client(() => fakeResponse(500, undefined));
  await assert.rejects(() => api.request('/x'), (e) => e.status === 500 && e.code === 'HTTP_500' && e.message.length > 0);
});

test('network failure is status 0 NETWORK_ERROR', async () => {
  const api = createClient({ baseUrl: 'http://api.test', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => api.request('/x'), (e) => e.status === 0 && e.code === 'NETWORK_ERROR');
});

test('a 200 without the success envelope is rejected as INVALID_RESPONSE', async () => {
  const { api } = client(() => fakeResponse(200, { items: [] }));
  await assert.rejects(() => api.request('/x'), (e) => e.status === 502 && e.code === 'INVALID_RESPONSE');
});

test('401 calls onUnauthorized once, unless notifyUnauthorized is false', async () => {
  let notified = 0;
  const { api } = client(() => fakeResponse(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'x' } }), () => { notified += 1; });
  await assert.rejects(() => api.request('/protected'));
  assert.equal(notified, 1);
  await assert.rejects(() => api.request('/login', { notifyUnauthorized: false }));
  assert.equal(notified, 1);
});

test('other statuses (403, 423) never trigger the unauthorized handler', async () => {
  let notified = 0;
  const { api } = client(() => fakeResponse(403, { success: false, error: { code: 'FORBIDDEN', message: 'x' } }), () => { notified += 1; });
  await assert.rejects(() => api.request('/x'), (e) => e.code === 'FORBIDDEN');
  assert.equal(notified, 0);
});
