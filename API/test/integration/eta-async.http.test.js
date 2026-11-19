'use strict';

// Asynchronous ETA (UC-015 / UC-016, V2 design decision) on real SQL Server. A valid notice is queued at once on its declared ETA; the forecast is a durable job
// run by the ETA worker; a valid forecast moves the voyage in the queue under the queue lock. EVERY provider here is a local MOCK: it returns a fixed forecast after a
// chosen delay (or never, or garbage). These tests prove the workflow (latency independence, ordering, safety, reliability); they say nothing about real AI quality.
// Runs only with SP_TEST_DB. Voyages are created through the real API; plans and approval for the "left the queue" case also go through the real API.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');
const { createEtaAdapter } = require('../../src/ai/etaAdapter');
const { createEtaWorker } = require('../../src/jobs/etaWorker');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: asynchronous ETA integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const eta = (days) => new Date(Date.UTC(2031, 2, 1, 1, 0, 0) + days * 86400000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let db; let server; let base; let agentA; let portId; let typeId; let coordId;
const cookies = {}; const usernames = []; const shipIds = [];
let providerImpl = null;                    // the MOCK provider (a fetch stand-in); null means "no provider configured"
let providerCalls = 0;
const adapter = {
  get configured() { return Boolean(providerImpl); },
  predict: (input, opts) => { providerCalls += 1; return createEtaAdapter({ url: providerImpl ? 'http://provider.mock/predict' : undefined, fetchImpl: providerImpl, log: () => {} }).predict(input, opts); },
};
let liveWorker = null;                      // the worker that the API kicks; tests that need manual control leave it null
const kicker = { kick: () => { if (liveWorker) liveWorker.kick(); } };
const answer = (predictedEta, confidence = 0.6, model = 'mock-async') => async () => ({ ok: true, status: 200, json: async () => ({ predicted_eta: predictedEta, confidence, model_version: model }) });
const after = (ms, impl) => async (u, init) => { await sleep(ms); return impl(u, init); };
const never = () => new Promise(() => {});
const newWorker = (over = {}) => createEtaWorker({ db, etaAdapter: adapter, intervalMs: 25, log: () => {}, ...over });
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false, etaAdapter: adapter, etaWorker: kicker }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'YA_${SUFFIX}', N'Đại lý Y ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'YP${SUFFIX}', N'Cảng Y ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  for (const [key, roles] of Object.entries({ coord: ['DIEU_PHOI_VIEN'], manager: ['BAN_QUAN_LY'] })) {
    const username = `t_y_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: roles, agentId: null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  coordId = Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: `t_y_coord_${SUFFIX}` }))[0].user_id);
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  if (liveWorker) await liveWorker.stop();
  const ships = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ships})`;
  const ownBerths = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'Y${SUFFIX}%'`;
  const ownPlans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${ownBerths})`;
  await q(`DELETE FROM dbo.notifications WHERE (entity_type IN ('BERTH_PLAN') AND entity_id IN (${ownPlans})) OR (entity_type = 'VOYAGE' AND entity_id IN (${mine}))
             OR recipient_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 't_y_%_${SUFFIX}');
           DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${ownPlans});
           DELETE FROM dbo.berth_plans WHERE id IN (${ownPlans});
           UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${ships});
           DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.ship_documents WHERE ship_id IN (${ships});
           DELETE FROM dbo.voyages WHERE ship_id IN (${ships}); DELETE FROM dbo.ships WHERE id IN (${ships});
           DELETE FROM dbo.berths WHERE berth_code LIKE 'Y${SUFFIX}%';`);
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id; DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
  await new Promise((r) => server.close(r));
  await db.pool.close();
});

async function call(method, route, { who = 'coord', body, headers = {} } = {}) {
  const res = await fetch(base + '/api/v1' + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}
let n = 0;
async function newShip() {
  n += 1;
  const id = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id
    VALUES (@c, @i, @nm, @t, 200, 30, 9, 50000)`, { c: `YS${SUFFIX}${n}`, i: `4${String(100000 + Math.floor(Math.random() * 800000))}`, nm: `Async ${SUFFIX} ${n}`, t: typeId }))[0].id;
  for (const type of ['REGISTRATION', 'INSURANCE']) {
    await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
      VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2035-01-01', @u, SYSUTCDATETIME())`, { s: id, t: type, k: `${SUFFIX}${n}${type}`, u: coordId });
  }
  shipIds.push(id); return id;
}
const submit = async (declared, extra = {}) => {
  const t0 = Date.now();
  const res = await call('POST', '/voyages', { body: { ship_id: await newShip(), voyage_code: `Y${SUFFIX}${++n}`, agent_id: agentA, origin_port_id: portId, declared_eta: declared, declared_teu: 100, cargo_type: 'Container', ...extra } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body.data, ms: Date.now() - t0 };
};
const predictionOf = async (voyageId) => (await q('SELECT TOP 1 * FROM dbo.voyage_eta_predictions WHERE voyage_id = @v ORDER BY id DESC', { v: voyageId }))[0];
const settle = async (voyageId, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const p = await predictionOf(voyageId); if (p && p.ai_status !== 'PENDING') return p; if (Date.now() > end) throw new Error('still pending'); await sleep(25); }
};
const queueOf = async () => (await call('GET', '/voyages/queue')).body.data;
const orderOf = async (ids) => (await queueOf()).items.filter((i) => ids.includes(i.voyage_id)).map((i) => i.voyage_id);
const contiguous = async () => { const items = (await queueOf()).items; assert.deepEqual(items.map((i) => i.position), items.map((_, i) => i + 1), 'queue positions are 1..n'); return items; };
const position = async (id) => (await q('SELECT queue_position FROM dbo.voyages WHERE id = @v', { v: id }))[0].queue_position;
const withWorker = async (fn, over) => { liveWorker = newWorker(over); liveWorker.start(); try { return await fn(liveWorker); } finally { const w = liveWorker; liveWorker = null; await w.stop(); } };
const reset = () => { providerImpl = null; providerCalls = 0; };

test('no provider configured: the answer is known at once (UNAVAILABLE, NOT_CONFIGURED), no job is created, the voyage is queued on its declared ETA', { skip }, async () => {
  reset();
  const v = await submit(eta(10));
  assert.equal(v.status, 'WAITING_BERTH'); assert.ok(v.ms < 2000, `${v.ms} ms`);
  assert.deepEqual([v.validation.ai.status, v.validation.ai.reason, v.validation.ai.label], ['UNAVAILABLE', 'NOT_CONFIGURED', 'chưa có dự báo AI']);
  const p = await predictionOf(v.id);
  assert.deepEqual([p.ai_status, p.attempts, p.queue_effect, p.completed_at !== null], ['UNAVAILABLE', 0, 'UNCHANGED', true]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_eta_predictions WHERE voyage_id = @v AND ai_status = 'PENDING'", { v: v.id }))[0].n, 0, 'nothing is waiting for a worker');
  assert.equal(providerCalls, 0);
});

test('MOCK provider within 1 s: the notice answers at once on the declared ETA (PENDING); the forecast then arrives, the effective ETA changes, the voyage moves, and it is audited and recorded', { skip }, async () => {
  reset();
  const a = await (async () => { providerImpl = null; return submit(eta(10)); })();                 // already in the queue, no forecast
  const b = await (async () => { providerImpl = null; return submit(eta(12)); })();
  const c = await (async () => { providerImpl = null; return submit(eta(14)); })();
  assert.deepEqual(await orderOf([a.id, b.id, c.id]), [a.id, b.id, c.id]);
  await withWorker(async () => {
    providerImpl = after(700, answer(eta(5)));                                                       // the forecast says it arrives much earlier than declared
    const v = await submit(eta(20));
    assert.ok(v.ms < 1000, `UC-015 AC-1: the submission took ${v.ms} ms and did not wait for the provider (700 ms)`);
    assert.deepEqual([v.validation.ai.status, v.validation.ai.label], ['PENDING', 'đang chờ dự báo AI']);
    assert.deepEqual(await orderOf([a.id, b.id, c.id, v.id]), [a.id, b.id, c.id, v.id], 'queued on the declared ETA (20 days), behind the three earlier ones');
    assert.equal(v.validation.queue_position, await position(v.id), 'the position in the answer is the stored one');
    assert.equal((await predictionOf(v.id)).ai_status, 'PENDING');
    assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_eta_predictions WHERE voyage_id = @v AND ai_status = 'PENDING'", { v: v.id }))[0].n, 1);
    const t0 = Date.now();
    const p = await settle(v.id);
    process.stdout.write(`ASYNC-MEASURE provider 700 ms: submission ${v.ms} ms, forecast stored ${Date.now() - t0 + v.ms} ms after the request\n`);
    assert.deepEqual([p.ai_status, Number(p.eta_deviation_h), p.queue_effect, p.attempts, p.claim_token], ['AVAILABLE', -360, 'REORDERED', 1, null]);   // 5 minus 20 days = -15 days
    assert.deepEqual(await orderOf([a.id, b.id, c.id, v.id]), [v.id, a.id, b.id, c.id], 'effective ETA 5 days beats declared 10');
    const items = await contiguous();
    const entry = items.find((i) => i.voyage_id === v.id);
    assert.deepEqual([entry.eta_source, entry.eta_status, new Date(entry.effective_eta).toISOString(), new Date(entry.declared_eta).toISOString()], ['AI', 'AVAILABLE', eta(5), eta(20)], 'the declared ETA is preserved, the effective ETA is the forecast');
    const hist = (await call('GET', `/voyages/${v.id}/eta-predictions`)).body.data;
    assert.deepEqual([hist.total, hist.items[0].status, hist.items[0].queue_effect, hist.items[0].declared_eta], [1, 'AVAILABLE', 'REORDERED', eta(20)]);
    const [chg] = await q("SELECT from_position, to_position, actor, change_type FROM dbo.voyage_queue_changes WHERE voyage_id = @v", { v: v.id });
    assert.deepEqual([chg.actor, chg.change_type, chg.from_position > chg.to_position], ['system:eta', 'MOVE', true], 'moved forward');
    const [aud] = await q("SELECT outcome, new_json FROM dbo.audit_events WHERE action = 'VOYAGE_ETA_PREDICTION' AND entity_id = @e", { e: String(v.id) });
    const j = JSON.parse(aud.new_json);
    assert.deepEqual([aud.outcome, j.effect, j.position_before === chg.from_position, j.position_after === chg.to_position, j.predicted_eta], ['SUCCESS', 'REORDERED', true, true, eta(5)]);
    assert.ok((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id = @e AND title LIKE N'%đổi thứ tự%'", { e: v.id }))[0].n >= 1, 'the coordinators are told');
    // The voyage detail shows the preserved declared ETA and the latest forecast.
    const detail = (await call('GET', `/voyages/${v.id}`)).body.data;
    assert.deepEqual([detail.eta.status, detail.eta.predicted_eta, new Date(detail.declared_eta).toISOString()], ['AVAILABLE', eta(5), eta(20)]);
  });
  reset();
});

test('MOCK provider answering after 5.5 s: the submission is independent of it (well under the 5 s of AC-1); the queue changes only when the forecast arrives', { skip, timeout: 60000 }, async () => {
  reset();
  const other = await submit(eta(8));
  await withWorker(async () => {
    providerImpl = after(5500, answer(eta(2)));
    const v = await submit(eta(30));
    assert.ok(v.ms < 1500, `submission ${v.ms} ms`); assert.equal(v.validation.ai.status, 'PENDING'); assert.deepEqual(await orderOf([other.id, v.id]), [other.id, v.id]);
    await sleep(1500);
    assert.equal((await predictionOf(v.id)).ai_status, 'PENDING', 'still waiting for the slow provider');
    assert.deepEqual(await orderOf([other.id, v.id]), [other.id, v.id], 'no change before the forecast');
    const t0 = Date.now();
    const p = await settle(v.id);
    const total = v.ms + 1500 + (Date.now() - t0);
    process.stdout.write(`ASYNC-MEASURE provider 5500 ms: submission ${v.ms} ms (UC-015 AC-1 limit 5000 ms); forecast stored about ${total} ms after the request\n`);
    assert.ok(total >= 5400, 'the forecast arrived after the provider answered');
    assert.equal(p.queue_effect, 'REORDERED'); assert.deepEqual(await orderOf([other.id, v.id]), [v.id, other.id]); await contiguous();
  });
  reset();
});

test('MOCK provider that never answers: the 10 s limit closes the job as UNAVAILABLE / TIMEOUT; the submission was fast; the queue never changed', { skip, timeout: 60000 }, async () => {
  reset();
  assert.equal((await q("SELECT param_value FROM dbo.system_parameters WHERE param_key = 'AI_TIMEOUT_MS'"))[0].param_value, '10000', 'the specified timeout');
  const other = await submit(eta(8));
  await withWorker(async () => {
    providerImpl = (u, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
    const v = await submit(eta(30));
    assert.ok(v.ms < 1500, `submission ${v.ms} ms`);
    const t0 = Date.now();
    const p = await settle(v.id);
    const waited = Date.now() - t0 + v.ms;
    process.stdout.write(`ASYNC-MEASURE provider silent: submission ${v.ms} ms; timeout recorded after about ${waited} ms\n`);
    assert.ok(waited >= 9800 && waited < 13000, `the provider is abandoned at about 10 s, took ${waited} ms`);
    assert.deepEqual([p.ai_status, p.failure_reason, p.queue_effect], ['UNAVAILABLE', 'TIMEOUT', 'UNCHANGED']);
    assert.deepEqual(await orderOf([other.id, v.id]), [other.id, v.id]);
  });
  reset();
});

test('malformed answers, HTTP errors and unreachable providers become UNAVAILABLE with the reason; the queue is untouched and no forecast exists', { skip }, async () => {
  const cases = [['INVALID_RESPONSE', async () => ({ ok: true, status: 200, json: async () => ({ predicted_eta: 'soon', confidence: 3, model_version: '' }) })],
    ['PROVIDER_ERROR_500', async () => ({ ok: false, status: 500, json: async () => ({}) })], ['UNREACHABLE', async () => { throw new TypeError('ECONNREFUSED'); }]];
  for (const [reason, impl] of cases) {
    reset();
    await withWorker(async () => {
      providerImpl = impl;
      const v = await submit(eta(9));
      const p = await settle(v.id);
      assert.deepEqual([p.ai_status, p.failure_reason, p.predicted_eta, p.eta_confidence, p.queue_effect], ['UNAVAILABLE', reason, null, null, 'UNCHANGED'], reason);
      assert.equal(new Date((await queueOf()).items.find((i) => i.voyage_id === v.id).effective_eta).toISOString(), eta(9));
    });
  }
  reset();
});

test('two predictions finishing at the same time change the order correctly: the final order is the one the rules give, positions are 1..n, and each move is recorded', { skip }, async () => {
  reset();
  const a = await submit(eta(10)); const b = await submit(eta(11)); const c = await submit(eta(12));
  await withWorker(async () => {
    providerImpl = async (u, init) => { await sleep(300); const input = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ predicted_eta: input.declared_eta === eta(13) ? eta(5) : eta(6), confidence: 0.5, model_version: 'mock-async' }) }; };
    const x = await submit(eta(13));          // forecast 5 days
    const y = await submit(eta(14));          // forecast 6 days (two jobs run at once: concurrency 4)
    await Promise.all([settle(x.id), settle(y.id)]);
    assert.deepEqual(await orderOf([a.id, b.id, c.id, x.id, y.id]), [x.id, y.id, a.id, b.id, c.id]);
    await contiguous();
    for (const id of [x.id, y.id]) assert.equal((await predictionOf(id)).ai_status, 'AVAILABLE');
    assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE actor = 'system:eta' AND voyage_id IN (@x, @y)", { x: x.id, y: y.id }))[0].n, 2);
  });
  reset();
});

test('queue priority is kept: a vessel with a priority class stays ahead of a standard vessel even when the standard vessel gets a much earlier forecast', { skip }, async () => {
  reset();
  const main = await submit(eta(40), { priority_class: 'MAIN_LINE' });
  await withWorker(async () => {
    providerImpl = after(100, answer(eta(1)));
    const std = await submit(eta(50));
    await settle(std.id);
    const order = await orderOf([main.id, std.id]);
    assert.deepEqual(order, [main.id, std.id], 'priority first, then effective ETA (UC-020 order rules)');
    assert.ok((await position(main.id)) < (await position(std.id)), 'the standard vessel may move among standard vessels, never past the priority tier');
    await contiguous();
  });
  reset();
});

test('a voyage that a person moved by hand is left where the person put it (KEPT_MANUAL_POSITION); its forecast is still stored', { skip }, async () => {
  reset();
  const first = await submit(eta(10)); const second = await submit(eta(12));
  await withWorker(async () => {
    providerImpl = after(1200, answer(eta(1)));
    const v = await submit(eta(20));
    const queue = await queueOf();
    const to = (await call('PATCH', `/voyages/${v.id}/queue-position`, { body: { to_position: queue.items.findIndex((i) => i.voyage_id === v.id) + 1 - 1, reason: 'Điều phối viên chuyển thủ công' }, headers: { 'If-Match': `"${queue.revision}"` } }));
    assert.equal(to.status, 200, JSON.stringify(to.body));
    const placed = await position(v.id);
    const p = await settle(v.id);
    assert.deepEqual([p.ai_status, p.queue_effect], ['AVAILABLE', 'KEPT_MANUAL_POSITION']);
    assert.equal(await position(v.id), placed, 'the person decision is respected');
    await contiguous();
    void first; void second;
  });
  reset();
});

test('a voyage that left the queue before the forecast returned is never touched: its status, its approved plan and the other positions stay (NOT_APPLIED_LEFT_QUEUE)', { skip, timeout: 60000 }, async () => {
  reset();
  const bystander = await submit(eta(8));
  await withWorker(async () => {
    providerImpl = after(2500, answer(eta(1)));
    const v = await submit(eta(30));
    // meanwhile: hazard fact, berth, plan, submit, approval by another account: the voyage becomes BERTH_ASSIGNED and leaves the queue
    assert.equal((await call('PUT', `/voyages/${v.id}/cargo-hazard`, { body: { cargo_hazard: 'NONE', basis: 'Bảng kê đã đối chiếu' } })).status, 200);
    const berth = (await call('POST', '/berths', { body: { berth_code: `Y${SUFFIX}b`, berth_type: 'CONTAINER', length_m: 450, max_depth_m: 14, available_cranes: 4, allows_dangerous: false } })).body.data;
    const plan = (await call('POST', '/berth-plans', { body: { voyage_id: v.id, berth_id: berth.id, position_start_m: 0, position_end_m: 210, planned_start: '2031-07-10T01:00:00Z', planned_end: '2031-07-10T13:00:00Z', required_cranes: 2 } })).body.data;
    const sub = (await call('POST', `/berth-plans/${plan.id}/submit`, { body: {}, headers: { 'If-Match': `"${plan.revision}"` } })).body.data;
    const ap = await call('POST', `/berth-plans/${plan.id}/approve`, { who: 'manager', body: { confirm: true }, headers: { 'If-Match': `"${sub.revision}"` } });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal((await predictionOf(v.id)).ai_status, 'PENDING', 'the forecast is still on its way');
    const bystanderPos = await position(bystander.id);
    const p = await settle(v.id);
    assert.deepEqual([p.ai_status, p.queue_effect], ['AVAILABLE', 'NOT_APPLIED_LEFT_QUEUE'], 'the forecast is kept in the history but not applied');
    const row = (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: v.id }))[0];
    assert.deepEqual([row.status, row.queue_position], ['BERTH_ASSIGNED', null], 'never put back in the waiting queue');
    assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @p', { p: plan.id }))[0].plan_status, 'APPROVED', 'the approved plan is untouched');
    assert.equal(await position(bystander.id), bystanderPos); await contiguous();
    assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v AND actor = 'system:eta'", { v: v.id }))[0].n, 0);
  });
  reset();
});

test('duplicate and stale results: a claim that expired is taken by another worker; the late result of the first one and a repeated result change nothing; the history holds one answer', { skip }, async () => {
  reset();
  const other = await submit(eta(8));
  providerImpl = answer(eta(2));                      // configured, but no worker is running: the job stays pending
  const v = await submit(eta(30));
  assert.equal((await predictionOf(v.id)).ai_status, 'PENDING');
  const wA = newWorker(); const wB = newWorker();
  const [jobA] = await wA.claim(1);
  assert.equal(jobA.voyage_id, v.id); assert.equal(jobA.attempts, 1);
  assert.equal((await wB.claim(1)).length, 0, 'a held lease is not claimed again');
  await q('UPDATE dbo.voyage_eta_predictions SET claimed_until = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE id = @i', { i: jobA.id });   // the lease of worker A expired (it is slow or dead)
  const [jobB] = await wB.claim(1);
  assert.deepEqual([jobB.id, jobB.attempts], [jobA.id, 2]); assert.notEqual(jobB.claim_token, jobA.claim_token);
  providerCalls = 0;
  const done = await wB.process(jobB);
  assert.equal(done.stored, true);
  const stale = await wA.process(jobA);                // worker A answers late with its old claim
  assert.equal(stale.stored, false, 'the stale result is ignored');
  assert.equal((await wB.process(jobB)).stored, false, 'a repeated result is ignored');
  const p = await predictionOf(v.id);
  assert.deepEqual([p.ai_status, p.attempts, p.queue_effect], ['AVAILABLE', 2, 'REORDERED']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: v.id }))[0].n, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v AND actor = 'system:eta'", { v: v.id }))[0].n, 1, 'one move, not three');
  assert.deepEqual(await orderOf([other.id, v.id]), [v.id, other.id]); await contiguous();
  reset();
});

test('several workers at once never run the same job twice: six pending jobs, two workers racing, six provider calls and six stored answers', { skip }, async () => {
  reset();
  providerImpl = after(50, answer(eta(3)));
  const vs = []; for (let i = 0; i < 6; i += 1) vs.push(await submit(eta(30 + i)));
  providerCalls = 0;
  const w1 = newWorker({ concurrency: 3 }); const w2 = newWorker({ concurrency: 3 });
  let done = 0;
  for (let round = 0; round < 4 && done < 6; round += 1) { const r = await Promise.all([w1.runOnce(), w2.runOnce()]); done += r[0] + r[1]; }
  assert.equal(done, 6); assert.equal(providerCalls, 6, 'each job ran once');
  for (const v of vs) assert.deepEqual([(await predictionOf(v.id)).ai_status, (await predictionOf(v.id)).attempts], ['AVAILABLE', 1]);
  await contiguous();
  reset();
});

test('a job claimed too many times without finishing is closed as UNAVAILABLE / ABANDONED without calling the provider; the voyage keeps its declared-ETA place', { skip }, async () => {
  reset();
  providerImpl = answer(eta(2));
  const v = await submit(eta(30));
  await q('UPDATE dbo.voyage_eta_predictions SET attempts = 3, claimed_until = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE voyage_id = @v', { v: v.id });
  providerCalls = 0;
  const w = newWorker({ maxAttempts: 3 });
  assert.equal(await w.runOnce(), 1);
  const p = await predictionOf(v.id);
  assert.deepEqual([p.ai_status, p.failure_reason, p.attempts, p.queue_effect, providerCalls], ['UNAVAILABLE', 'ABANDONED', 4, 'UNCHANGED', 0]);
  reset();
});

test('restart: a job claimed by a process that is killed stays pending; after its lease a new worker finishes it (attempt 2) and applies the forecast', { skip, timeout: 60000 }, async () => {
  reset();
  const other = await submit(eta(8));
  providerImpl = answer(eta(2));                      // configured for the API; the helper process uses its own hanging stand-in
  const v = await submit(eta(30));
  assert.equal((await predictionOf(v.id)).ai_status, 'PENDING');
  const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'eta-worker-crash.js')], { env: { ...process.env, SP_DB_NAME: TEST_DB, UV_THREADPOOL_SIZE: '8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('helper did not claim: ' + out)), 20000); child.stdout.on('data', (d) => { out += d; if (/CLAIMED \d+/.test(out)) { clearTimeout(t); resolve(); } }); child.on('error', reject); });
  assert.match(out, new RegExp(`CLAIMED ${(await predictionOf(v.id)).id}`));
  child.kill('SIGKILL');                               // the process dies with the job unfinished
  await new Promise((r) => child.once('exit', r));
  const mid = await predictionOf(v.id);
  assert.deepEqual([mid.ai_status, mid.attempts], ['PENDING', 1]); assert.notEqual(mid.claim_token, null);
  await sleep(1700);                                   // the 1.5 s lease of the dead process ends
  const w = newWorker();
  assert.equal(await w.runOnce(), 1);
  const p = await predictionOf(v.id);
  assert.deepEqual([p.ai_status, p.attempts, p.queue_effect], ['AVAILABLE', 2, 'REORDERED']);
  assert.deepEqual(await orderOf([other.id, v.id]), [v.id, other.id]); await contiguous();
  reset();
});
