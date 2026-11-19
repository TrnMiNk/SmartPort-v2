'use strict';

// Browser end-to-end test for UC-016 display and history, Front -> API -> SQL Server.
// The ETA is asynchronous: the notice is queued at once on its declared ETA and the forecast arrives later. The ETA provider here is a LOCAL MOCK HTTP server written for this test (it answers after a delay with the declared ETA plus 2 hours). It proves that the screens show a valid answer
// and the failure state correctly. It is NOT an AI model, proves nothing about forecast quality, and is not evidence that a real provider works.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const S = require('./support');

const { skip, FRONT, newPage, loginOk } = S;
const sfx = S.SUFFIX;
let agentA; let portId; let typeId; let coordUserId; let stub; let mode = 'ok'; let delayMs = 1500;
const shipIds = [];
const users = { coord: S.mkUser('ecoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']) };
const q = async (text, params = {}) => { const d = S.db(); const req = d.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(async () => {
  if (skip) return;
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(() => {
      if (mode === 'fail') { res.writeHead(503); res.end('{}'); return; }
      const input = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ predicted_eta: new Date(Date.parse(input.declared_eta) + 2 * 3600e3).toISOString(), confidence: 0.7, model_version: 'mock-e2e-1' }));
    }, delayMs));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.SP_AI_ETA_URL = `http://127.0.0.1:${stub.address().port}/predict`;   // read by the API process that support.js starts
  await S.start(users, async (d) => {
    const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
    agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('EA_${sfx}', N'Đại lý E ${sfx}')`);
    portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('EP${sfx}', N'Cảng E ${sfx}')`);
    typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
  });
}, { timeout: 90000 });

test.after(async () => {
  if (stub) await new Promise((r) => stub.close(r));
  await S.stop(users, async (d) => {
    const ids = shipIds.length ? shipIds.join(',') : '0';
    const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
    await d.pool.request().query(`
      DELETE FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id IN (${mine});
      UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${ids});
      DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine});
      DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
      DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
      DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
      DELETE FROM dbo.ship_documents WHERE ship_id IN (${ids});
      DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});
      DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
  });
});

async function mkShip(label) {
  coordUserId = coordUserId || Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  const id = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES (@c, @i, @n, @t, 200, 30, 9, 50000)`, { c: `ES${sfx}${label}`, i: `3${String(100000 + Math.floor(Math.random() * 800000))}`, n: `Eta ${label} ${sfx}`, t: typeId }))[0].id;
  for (const type of ['REGISTRATION', 'INSURANCE']) {
    await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
      VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2035-01-01', @u, SYSUTCDATETIME())`, { s: id, t: type, k: `${sfx}${label}${type}`, u: coordUserId });
  }
  shipIds.push(id); return id;
}
const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const fill = async (page, id, value) => { await page.$eval(id, (e) => { e.value = ''; }); await page.type(id, String(value)); };
async function register(page, shipId, code) {
  await page.click('#addNotice'); await page.waitForSelector('#nf');
  await page.select('#f-ship_id', String(shipId)); await fill(page, '#f-voyage_code', code);
  await page.select('#f-agent_id', String(agentA)); await page.select('#f-origin_port_id', String(portId));
  await page.$eval('#f-declared_eta', (e) => { e.value = '2031-06-10T08:00'; });
  await fill(page, '#f-declared_teu', 100); await fill(page, '#f-cargo_type', 'Container');
  await page.click('#nf button[type=submit]'); await page.waitForSelector('#vresult .eta4');
}
const cell = (page, which) => page.$eval(`#vdlg [data-eta="${which}"]`, (e) => e.textContent.trim());
const settled = (page, status) => page.waitForFunction((st) => { const t = document.querySelector('#vEtaResult .eta4'); return t && t.getAttribute('data-eta-status') === st; }, { timeout: 12000 }, status);

test('asynchronous ETA in the browser (MOCK provider answering after 1.5 s): the notice is accepted and queued on the declared ETA at once with "đang chờ dự báo AI"; the screens then update by themselves to the four values in UTC+7, the effective ETA and the queue tag change, and the history records the effect', { skip, timeout: 180000 }, async () => {
  mode = 'ok'; delayMs = 1500;
  const { page, context } = await newPage();
  await loginOk(page, users.coord, 'overview.html'); await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#addNotice:not([hidden])'); await waitList(page, '#queueList');
  const code = `EV-${sfx}`;
  const t0 = Date.now();
  await register(page, await mkShip('A'), code);
  const shown = Date.now() - t0;
  process.stdout.write(`LATENCY notice-submit-to-result-dialog-with-slow-provider ${shown} ms\n`);
  assert.ok(shown < 1500, `the result dialog does not wait for the 1.5 s provider: ${shown} ms`);
  assert.equal(await page.$eval('#vresult .eta4', (e) => e.getAttribute('data-eta-status')), 'PENDING');
  const first = await page.$eval('#vresult', (e) => e.textContent);
  assert.ok(first.includes('đang chờ dự báo AI') && first.includes('ETA khai báo') && first.includes('WAITING_BERTH'), first);
  assert.equal(await cell(page, 'declared'), '2031-06-10 08:00');
  assert.equal(await cell(page, 'deviation'), '—'); assert.equal(await cell(page, 'confidence'), '—');
  assert.ok(!(await cell(page, 'predicted')).match(/\d{4}-\d{2}-\d{2}/), 'no predicted time while pending');
  const id = Number((await q('SELECT id FROM dbo.voyages WHERE voyage_code = @c', { c: code }))[0].id);
  // The queue shows the voyage on its declared ETA with the pending tag (the dialog stays open).
  await page.evaluate(() => VR.loadQueue({ silent: true }));
  await page.waitForFunction((v) => { const r = document.querySelector(`#queueList tr[data-queue="${v}"]`); return r && r.textContent.includes('2031-06-10 08:00') && r.querySelector('[data-eta-tag=PENDING]'); }, { timeout: 8000 }, id);
  // Then, without any click, the forecast arrives and the open dialog updates.
  await settled(page, 'AVAILABLE');
  assert.equal(await cell(page, 'predicted'), '2031-06-10 10:00', 'predicted = declared + 2 h (the mock rule), in UTC+7');
  assert.equal(await cell(page, 'deviation'), '+2 giờ', 'deviation = predicted minus declared, in hours');
  assert.ok((await cell(page, 'confidence')).startsWith('0.7') && (await cell(page, 'confidence')).includes('ý nghĩa chưa được định nghĩa'));
  assert.ok((await page.$eval('#vresult', (e) => e.textContent)).includes('mock-e2e-1'));
  await page.waitForFunction(() => document.querySelector('#vresult [data-queue-effect]'), { timeout: 8000 });
  assert.ok(['REORDERED', 'UNCHANGED'].includes(await page.$eval('#vresult [data-queue-effect]', (e) => e.getAttribute('data-queue-effect'))));
  const row = (await q('SELECT TOP 1 p.ai_status, p.eta_deviation_h, p.eta_confidence, p.model_version, p.queue_effect, p.attempts FROM dbo.voyage_eta_predictions p JOIN dbo.voyages v ON v.id = p.voyage_id WHERE v.voyage_code = @c', { c: code }))[0];
  assert.deepEqual([row.ai_status, Number(row.eta_deviation_h), Number(row.eta_confidence), row.model_version, row.attempts], ['AVAILABLE', 2, 0.7, 'mock-e2e-1', 1]);
  await page.click('#vresult [data-close]'); await dialogClosed(page);
  // the queue (refreshed by the hint) marks the forecast and uses it as the effective ETA
  await page.waitForFunction((v) => { const r = document.querySelector(`#queueList tr[data-queue="${v}"]`); return r && r.textContent.includes('2031-06-10 10:00') && r.querySelector('[data-eta-tag=AI]'); }, { timeout: 8000 }, id);
  // lifecycle dialog (schedule): latest values, history with the queue effect
  await page.select('#schStatus', 'WAITING_BERTH');
  await page.waitForFunction((c) => [...document.querySelectorAll('#schBody tr[data-sched]')].some((r) => r.textContent.includes(c)), { timeout: 8000 }, code);
  await page.click(`#schBody tr[data-sched="${id}"] [data-act=lifecycle]`); await page.waitForSelector('#vlife #vEta .eta4');
  assert.equal(await page.$eval('#vlife [data-eta="deviation"]', (e) => e.textContent.trim()), '+2 giờ');
  const hist = await page.$$eval('#vlife .eta-hist tbody tr', (rs) => rs.map((r) => r.textContent));
  assert.equal(hist.length, 1); assert.ok(hist[0].includes('mock-e2e-1') && hist[0].includes('2031-06-10 10:00') && hist[0].includes('AVAILABLE') && /sắp xếp lại|không đổi/.test(hist[0]), hist[0]);
  await context.close();
});

test('asynchronous ETA in the browser when the provider fails (MOCK 503): pending first, then "chưa có dự báo AI" with the reason; no predicted ETA, deviation or confidence appears; the voyage keeps its declared-ETA place; the history keeps the attempt', { skip, timeout: 180000 }, async () => {
  mode = 'fail'; delayMs = 800;
  const { page, context } = await newPage();
  await loginOk(page, users.coord, 'overview.html'); await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#addNotice:not([hidden])'); await waitList(page, '#queueList');
  const code = `EF-${sfx}`;
  await register(page, await mkShip('B'), code);
  assert.equal(await page.$eval('#vresult .eta4', (e) => e.getAttribute('data-eta-status')), 'PENDING');
  await settled(page, 'UNAVAILABLE');
  const text = await page.$eval('#vresult .eta4', (e) => e.textContent);
  assert.ok(text.includes('chưa có dự báo AI') && text.includes('PROVIDER_ERROR_503'), text);
  assert.equal(await cell(page, 'declared'), '2031-06-10 08:00');
  assert.equal(await cell(page, 'deviation'), '—'); assert.equal(await cell(page, 'confidence'), '—');
  assert.ok(!(await cell(page, 'predicted')).match(/\d{4}-\d{2}-\d{2}/), 'no predicted ETA is invented');
  await page.click('#vresult [data-close]'); await dialogClosed(page);
  const v = (await q('SELECT id, status FROM dbo.voyages WHERE voyage_code = @c', { c: code }))[0];
  assert.equal(v.status, 'WAITING_BERTH');
  await page.waitForFunction((id) => { const r = document.querySelector(`#queueList tr[data-queue="${id}"]`); return r && r.textContent.includes('2031-06-10 08:00') && r.querySelector('[data-eta-tag=DECLARED]'); }, { timeout: 8000 }, v.id);
  await page.select('#schStatus', 'WAITING_BERTH');
  await page.waitForFunction((c) => [...document.querySelectorAll('#schBody tr[data-sched]')].some((r) => r.textContent.includes(c)), { timeout: 8000 }, code);
  await page.click(`#schBody tr[data-sched="${v.id}"] [data-act=lifecycle]`); await page.waitForSelector('#vlife .eta-hist');
  const hist = await page.$$eval('#vlife .eta-hist tbody tr', (rs) => rs.map((r) => r.textContent));
  assert.equal(hist.length, 1); assert.ok(hist[0].includes('PROVIDER_ERROR_503') && hist[0].includes('chưa có dự báo AI'), hist[0]);
  await context.close();
});
