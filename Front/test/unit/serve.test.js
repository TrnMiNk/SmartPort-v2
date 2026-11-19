'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, parseApiBase } = require('../../scripts/serve');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('serves pages and the entry redirect page', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + '/login.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await (await fetch(base + '/')).text(), /login\.html/);
  });
});

test('path traversal and hidden or internal folders are not served', async () => {
  await withServer({}, async (base) => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/node_modules/puppeteer-core/package.json',
      '/scripts/serve.js', '/test/unit/api.test.js', '/.gitignore']) {
      const res = await fetch(base + p);
      assert.notEqual(res.status, 200, p);
    }
  });
});

test('raw traversal paths (not normalized by fetch) are refused', async () => {
  const http = require('node:http');
  await withServer({}, async (base) => {
    const port = Number(new URL(base).port);
    const get = (rawPath) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    for (const p of ['/..%2fAPI%2fpackage.json', '/..%2f..%2fCLAUDE.md', '/%2e%2e%2f%2e%2e%2fdocs%2ftraceability.md', '/js/..%2f..%2fpackage.json']) {
      assert.equal(await get(p), 404, p);
    }
    // Regression: a NUL byte used to crash the process with an uncaught ERR_INVALID_ARG_VALUE.
    assert.equal(await get('/x%00.js'), 400);
    assert.equal(await get('/js/auth.js'), 200, 'server must keep serving after a malicious request');
  });
});

test('non-allow-listed file types such as package.json and README are not served', async () => {
  await withServer({}, async (base) => {
    for (const p of ['/package.json', '/README.md']) assert.equal((await fetch(base + p)).status, 404, p);
  });
});

test('non-GET methods are refused', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(base + '/login.html', { method: 'POST' })).status, 405);
  });
});

test('SP_API_BASE_URL generates config.js; without it the file on disk is served', async () => {
  await withServer({ apiBaseUrl: 'http://localhost:3101/some/path' }, async (base) => {
    const text = await (await fetch(base + '/js/config.js')).text();
    assert.match(text, /apiBaseUrl: "http:\/\/localhost:3101"/);
  });
  await withServer({}, async (base) => {
    assert.match(await (await fetch(base + '/js/config.js')).text(), /http:\/\/localhost:3000/);
  });
});

test('parseApiBase accepts http(s) origins only', () => {
  assert.equal(parseApiBase('https://api.example.com/x'), 'https://api.example.com');
  assert.throws(() => parseApiBase('javascript:alert(1)'));
  assert.throws(() => parseApiBase('not a url'));
});
