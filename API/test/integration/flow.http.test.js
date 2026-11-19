'use strict';

// HTTP integration tests for the arrival workflow on real SQL Server: draft -> submit -> automatic validation (UC-015)
// -> berth queue (UC-020). Runs only with SP_TEST_DB set (disposable, migrated and seeded database; the seed provides
// the policy UC015-POLICY-V1). Files run one at a time because these tests change global state (policy, parameters,
// queue) and restore it. Rows created here are removed in `after`.
//
// The ETA provider is replaced by local stand-ins that go through the real adapter code. They test the adapter and the
// fallback behavior only. They are not a real forecast service; with no provider the forecast is UNAVAILABLE.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');
const { createEtaAdapter } = require('../../src/ai/etaAdapter');
const { createEtaWorker } = require('../../src/jobs/etaWorker');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: workflow integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };

let db; let server; let base; let typeId; let agentA; let agentB; let portId; let coordId;
const cookies = {};
const usernames = [];
const imos = [];
const testPolicies = [];
let imoCounter = 100000 + Math.floor(Math.random() * 700000);
const nextImo = () => { const v = '6' + String(imoCounter++).padStart(6, '0'); imos.push(v); return v; };

// Switchable ETA provider. `fetchImpl` is the stand-in for the provider's HTTP endpoint.
let providerFetch = null;
let providerCalls = 0;
// `configured` is true only while a stand-in is installed, as for the real adapter (no URL, not configured).
const etaAdapter = {
  get configured() { return Boolean(providerFetch); },
  predict: (input, opts) => {
    providerCalls += 1;
    return createEtaAdapter({ url: providerFetch ? 'http://provider.stand-in/predict' : undefined, fetchImpl: providerFetch, log: () => {} }).predict(input, opts);
  },
};
let etaWorker = null;
// The forecast is asynchronous: wait until the voyage's latest prediction is no longer PENDING (the worker runs in this process).
const settle = async (voyageId, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const row = (await q('SELECT TOP 1 ai_status FROM dbo.voyage_eta_predictions WHERE voyage_id = @v ORDER BY id DESC', { v: voyageId }))[0];
    if (row && row.ai_status !== 'PENDING') return row.ai_status;
    if (Date.now() > end) throw new Error('prediction still pending after ' + ms + ' ms');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const q = async (text, params = {}) => {
  const req = db.pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(text)).recordset;
};

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  etaWorker = createEtaWorker({ db, etaAdapter, intervalMs: 25, log: () => {} }); etaWorker.start();
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false, etaAdapter, etaWorker }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'FA_${SUFFIX}', N'Đại lý FA ${SUFFIX}'`);
  agentB = await mk('agents', 'agent_code, agent_name', `'FB_${SUFFIX}', N'Đại lý FB ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'FP${SUFFIX}', N'Cảng FP ${SUFFIX}'`);
  const defs = { coord: ['DIEU_PHOI_VIEN'], agentA: ['DAI_LY_HANG_HAI', agentA], agentB: ['DAI_LY_HANG_HAI', agentB],
    tech: ['KY_THUAT_VIEN'], yard: ['NHAN_VIEN_KHO_BAI'], manager: ['BAN_QUAN_LY'] };
  for (const [key, [role, agentId]] of Object.entries(defs)) {
    const username = `t_f_${key}_${SUFFIX}`;
    usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  coordId = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: usernames[0] }))[0].user_id;
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  if (etaWorker) await etaWorker.stop();
  const shipIds = (await q(`SELECT id FROM dbo.ships WHERE imo_number IN (${imos.map((i) => `'${i}'`).join(',') || "''"})`)).map((r) => r.id);
  const owners = `SELECT user_id FROM dbo.auth_users WHERE username IN (${usernames.map((u) => `N'${u}'`).join(',')})`;
  if (shipIds.length) {
    const ids = shipIds.join(',');
    const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
    await q(`UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${ids});
             UPDATE dbo.voyage_drafts SET submitted_voyage_id = NULL, status = 'DISCARDED' WHERE submitted_voyage_id IN (${mine});
             DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
             DELETE FROM dbo.ship_documents WHERE ship_id IN (${ids});
             DELETE FROM dbo.vessel_restrictions WHERE ship_id IN (${ids});
             DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});`);
  }
  await q(`DELETE FROM dbo.voyage_drafts WHERE owner_user_id IN (${owners});`);
  for (const v of testPolicies) await q('DELETE FROM dbo.validation_policies WHERE version = @v', { v });
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
             DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id IN (${agentA}, ${agentB}); DELETE FROM dbo.ports WHERE id = ${portId};`);
  await new Promise((r) => server.close(r));
  await db.pool.close();
});

async function call(method, path, { who, body, headers = {} } = {}) {
  const res = await fetch(base + '/api/v1' + path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 204 */ }
  return { status: res.status, body: json, etag: res.headers.get('etag') };
}

const addDoc = (shipId, type, over = {}) => q(`INSERT INTO dbo.ship_documents (ship_id, voyage_id, document_type_code, original_filename, storage_key, mime_type,
    file_size_bytes, review_status, valid_from, valid_until, reviewed_by_user_id, reviewed_at)
  VALUES (@s, @v, @t, N'f.pdf', @k, 'application/pdf', 1000, @st, @from, @until, ${over.status === 'PENDING' ? 'NULL' : '@u'}, ${over.status === 'PENDING' ? 'NULL' : 'SYSUTCDATETIME()'})`,
{ s: shipId, v: over.voyageId ?? null, t: type, k: crypto.randomBytes(8).toString('hex'), st: over.status ?? 'APPROVED', from: over.from ?? null, until: over.until === undefined ? '2030-01-01' : over.until, u: coordId });
const addStandardDocs = async (shipId, over) => { await addDoc(shipId, 'REGISTRATION', over); await addDoc(shipId, 'INSURANCE', over); };

async function newShip({ docs = true, operator = agentA, name } = {}) {
  const res = await call('POST', '/ships', { who: 'coord', body: { imo_number: nextImo(), ship_name: name || `Flow ${SUFFIX}`, ship_type_id: typeId, operator_agent_id: operator,
    length_overall_m: 180, beam_m: 30, max_draft_m: 10, deadweight_t: 20000 } });
  assert.equal(res.status, 201);
  if (docs) await addStandardDocs(res.body.data.id);
  return res.body.data;
}
const eta = (days) => new Date(Date.UTC(2027, 2, 1, 1, 0, 0) + days * 86400000).toISOString();
const notice = (shipId, over = {}) => ({ ship_id: shipId, voyage_code: `F${crypto.randomBytes(3).toString('hex')}`, agent_id: agentA, origin_port_id: portId,
  declared_eta: eta(2), declared_teu: 100, cargo_type: 'Container', ...over });
const submit = (who, shipId, over, extra) => call('POST', '/voyages', { who, body: notice(shipId, over), ...extra });
const runsOf = (voyageId) => q('SELECT * FROM dbo.voyage_validation_runs WHERE voyage_id = @v ORDER BY id', { v: voyageId });
const historyOf = async (voyageId) => (await q('SELECT from_status, to_status FROM dbo.voyage_status_history WHERE voyage_id = @v ORDER BY id', { v: voyageId })).map((h) => [h.from_status, h.to_status]);
const queueOf = async () => (await call('GET', '/voyages/queue', { who: 'coord' })).body.data;
const order = (queue, ids) => queue.items.filter((i) => ids.includes(i.voyage_id)).map((i) => i.voyage_id);

async function withPolicy(config, fn) {
  const version = `T-${SUFFIX}-${testPolicies.length + 1}`;
  const json = JSON.stringify(config);
  testPolicies.push(version);
  await q(`INSERT INTO dbo.validation_policies (version, config_json, checksum, effective_from) VALUES (@v, @j, @c, DATEADD(SECOND, -1, SYSUTCDATETIME()))`,
    { v: version, j: json, c: crypto.createHash('sha256').update(json, 'utf8').digest('hex') });
  try { return await fn(version); } finally {
    await q('UPDATE dbo.validation_policies SET effective_until = SYSUTCDATETIME() WHERE version = @v', { v: version });
  }
}

async function withNoEffectivePolicy(fn) {
  const rows = await q(`SELECT version, effective_until FROM dbo.validation_policies WHERE effective_from <= SYSUTCDATETIME() AND (effective_until IS NULL OR effective_until > SYSUTCDATETIME())`);
  await q(`UPDATE dbo.validation_policies SET effective_until = DATEADD(SECOND, 1, effective_from)
           WHERE effective_from <= SYSUTCDATETIME() AND (effective_until IS NULL OR effective_until > SYSUTCDATETIME())`);
  try { return await fn(); } finally {
    for (const r of rows) await q('UPDATE dbo.validation_policies SET effective_until = @u WHERE version = @v', { u: r.effective_until, v: r.version });
  }
}

// ================================================================ UC-015 outcomes
test('UC-015 valid notice: one request saves, validates and queues it; status history, run, audit, notification and timing', { skip }, async () => {
  const ship = await newShip();
  const started = Date.now();
  const res = await submit('coord', ship.id);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 201);
  const v = res.body.data;
  assert.equal(v.status, 'WAITING_BERTH');
  assert.equal(v.validation.state, 'COMPLETED');
  assert.equal(v.validation.outcome, 'VALID');
  assert.equal(v.validation.policy_version, 'UC015-POLICY-V1');
  assert.ok(v.queue_position >= 1);
  assert.equal(v.validation.queue_position, v.queue_position);
  assert.ok(elapsed < 5000, `UC-013 AC-4 / UC-015 AC-1: queued within 5 seconds, took ${elapsed} ms`);
  const ai = v.validation.ai;
  assert.deepEqual([ai.status, ai.label, ai.reason, ai.predicted_eta, ai.deviation_h, ai.confidence, ai.confidence_meaning, ai.model_version], ['UNAVAILABLE', 'chưa có dự báo AI', 'NOT_CONFIGURED', null, null, null, null, null], 'no forecast, no deviation, no confidence: nothing is invented');
  assert.deepEqual([ai.source, ai.sequence], [{ kind: 'NONE', reason: 'NOT_CONFIGURED' }, 1]);
  assert.ok(ai.declared_eta && ai.requested_at, 'the declared ETA and the time of the request are shown even without a forecast');
  assert.deepEqual(await historyOf(v.id), [[null, 'ANNOUNCED'], ['ANNOUNCED', 'VALIDATED'], ['VALIDATED', 'WAITING_BERTH']]);
  const runs = await runsOf(v.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'VALID');
  assert.equal(runs[0].trigger_source, 'SUBMIT');
  assert.equal(runs[0].actor, usernames[0]);
  assert.equal(runs[0].ai_status, 'UNAVAILABLE');
  assert.equal(runs[0].queue_position, v.queue_position);
  const snapshot = JSON.parse(runs[0].input_snapshot);
  assert.equal(snapshot.voyage.id, v.id);
  assert.equal(snapshot.policy.version, 'UC015-POLICY-V1');
  assert.equal(snapshot.documents.length, 2);
  assert.deepEqual(JSON.parse(runs[0].rule_results).rules.map((r) => [r.id, r.status]), ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'].map((id) => [id, 'PASS']));
  const pred = (await q('SELECT ai_status, failure_reason, predicted_eta FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: v.id }))[0];
  assert.deepEqual([pred.ai_status, pred.failure_reason, pred.predicted_eta], ['UNAVAILABLE', 'NOT_CONFIGURED', null], 'a failed forecast is stored as unavailable, never as a forecast');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'VOYAGE_VALIDATE' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(v.id) }))[0].n, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE recipient_role_code = 'DIEU_PHOI_VIEN' AND entity_type = 'VOYAGE' AND entity_id = @e", { e: v.id }))[0].n, 1);
  const detail = (await call('GET', `/voyages/${v.id}`, { who: 'coord' })).body.data;
  assert.equal(detail.last_validation.outcome, 'VALID');
  assert.equal(detail.last_validation.ai_label, 'chưa có dự báo AI');
  assert.equal(detail.last_validation.rules.length, 6);
});

test('UC-015 missing documents: MISSING_DOCUMENTS with reasons, not queued, no forecast requested', { skip }, async () => {
  const ship = await newShip({ docs: false });
  providerCalls = 0;
  const res = await submit('coord', ship.id);
  const v = res.body.data;
  assert.equal(res.status, 201);
  assert.equal(v.status, 'MISSING_DOCUMENTS');
  assert.equal(v.validation.outcome, 'MISSING_DOCUMENTS');
  assert.equal(v.validation.reason_code, 'DOCUMENT_MISSING');
  assert.match(v.validation.reason, /INSURANCE\/SHIP/);
  assert.equal(v.queue_position, null);
  assert.equal(v.validation.ai, null);
  assert.equal(providerCalls, 0, 'the AI is not called for an invalid notice');
  assert.deepEqual(await historyOf(v.id), [[null, 'ANNOUNCED'], ['ANNOUNCED', 'MISSING_DOCUMENTS']]);
  assert.ok(!(await queueOf()).items.some((i) => i.voyage_id === v.id), 'BR-04: only valid notices enter the queue');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: v.id }))[0].n, 0);
});

test('UC-015 resubmission: after the documents are supplied the same notice becomes VALID; a retry changes nothing', { skip }, async () => {
  const ship = await newShip({ docs: false });
  const v = (await submit('coord', ship.id)).body.data;
  assert.equal(v.status, 'MISSING_DOCUMENTS');
  await addStandardDocs(ship.id);
  const again = await call('POST', `/voyages/${v.id}/validate`, { who: 'coord' });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.status, 'WAITING_BERTH');
  assert.equal(again.body.data.validation.outcome, 'VALID');
  assert.equal(again.body.data.validation.replayed, false);
  assert.deepEqual(await historyOf(v.id), [[null, 'ANNOUNCED'], ['ANNOUNCED', 'MISSING_DOCUMENTS'], ['MISSING_DOCUMENTS', 'VALIDATED'], ['VALIDATED', 'WAITING_BERTH']]);
  const runsBefore = (await runsOf(v.id)).length;
  const position = again.body.data.queue_position;
  const retry = await call('POST', `/voyages/${v.id}/validate`, { who: 'coord' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.validation.replayed, true, 'a retry on a decided notice is a replay');
  assert.equal(retry.body.data.queue_position, position);
  assert.equal((await runsOf(v.id)).length, runsBefore, 'no new run, no duplicate history, no second queue entry');
  assert.equal((await historyOf(v.id)).length, 4);
  assert.equal((await runsOf(v.id))[0].trigger_source, 'SUBMIT');
  assert.equal((await runsOf(v.id))[1].trigger_source, 'REVALIDATE');
});

test('UC-015 expired required document: REJECTED, final (no human step, no re-run), reason names the document', { skip }, async () => {
  const ship = await newShip({ docs: false });
  await addDoc(ship.id, 'REGISTRATION', { until: '2027-02-28' });
  await addDoc(ship.id, 'INSURANCE');
  const v = (await submit('coord', ship.id, { declared_eta: '2027-03-01T08:00:00+07:00' })).body.data;
  assert.equal(v.status, 'REJECTED');
  assert.equal(v.validation.reason_code, 'DOCUMENT_EXPIRED');
  assert.match(v.validation.reason, /REGISTRATION\/SHIP/);
  assert.equal(v.queue_position, null);
  await addDoc(ship.id, 'REGISTRATION'); // a valid document supplied afterwards does not reopen a rejected notice
  const retry = await call('POST', `/voyages/${v.id}/validate`, { who: 'coord' });
  assert.equal(retry.body.data.status, 'REJECTED');
  assert.equal(retry.body.data.validation.replayed, true);
  assert.equal((await runsOf(v.id)).length, 1);
});

test('UC-015 document validity boundaries are checked on the ETA date in UTC+7', { skip }, async () => {
  const lastDay = await newShip({ docs: false });
  await addDoc(lastDay.id, 'REGISTRATION', { until: '2027-03-01' });
  await addDoc(lastDay.id, 'INSURANCE');
  assert.equal((await submit('coord', lastDay.id, { declared_eta: '2027-03-01T23:30:00+07:00' })).body.data.validation.outcome, 'VALID', 'valid on its last day');
  const nextDay = await newShip({ docs: false });
  await addDoc(nextDay.id, 'REGISTRATION', { until: '2027-03-01' });
  await addDoc(nextDay.id, 'INSURANCE');
  const late = (await submit('coord', nextDay.id, { declared_eta: '2027-03-01T17:30:00Z' })).body.data; // 2027-03-02 00:30 in UTC+7
  assert.equal(late.validation.outcome, 'REJECTED');
  assert.equal(late.validation.reason_code, 'DOCUMENT_EXPIRED');
  const notYet = await newShip({ docs: false });
  await addDoc(notYet.id, 'REGISTRATION', { from: '2027-03-05' });
  await addDoc(notYet.id, 'INSURANCE');
  assert.equal((await submit('coord', notYet.id, { declared_eta: '2027-03-01T08:00:00+07:00' })).body.data.validation.reason_code, 'DOCUMENT_NOT_YET_VALID');
});

test('UC-015 pending or rejected document review counts as missing; restricted vessel is rejected', { skip }, async () => {
  const pending = await newShip({ docs: false });
  await addDoc(pending.id, 'REGISTRATION', { status: 'PENDING' });
  await addDoc(pending.id, 'INSURANCE');
  const p = (await submit('coord', pending.id)).body.data;
  assert.deepEqual([p.status, p.validation.reason_code], ['MISSING_DOCUMENTS', 'DOCUMENT_NOT_APPROVED']);
  const banned = await newShip();
  await q(`INSERT INTO dbo.vessel_restrictions (ship_id, restriction_type, reason, valid_from, created_by) VALUES (@s, 'PROHIBITED', N'Lệnh cấm thử nghiệm', '2020-01-01', N'test')`, { s: banned.id });
  const b = (await submit('coord', banned.id)).body.data;
  assert.deepEqual([b.status, b.validation.outcome, b.validation.reason_code], ['REJECTED', 'REJECTED', 'VESSEL_PROHIBITED']);
  assert.match(b.validation.reason, /Lệnh cấm thử nghiệm/);
});

test('UC-015 voyage-specific documents: a voyage-level requirement is met only by a document attached to that voyage', { skip }, async () => {
  await withPolicy({ requiredDocuments: [{ type: 'CARGO_MANIFEST', scope: 'VOYAGE' }] }, async (version) => {
    const ship = await newShip({ docs: false });
    await addDoc(ship.id, 'CARGO_MANIFEST'); // standing ship-level manifest does not count
    const v = (await submit('coord', ship.id)).body.data;
    assert.equal(v.validation.policy_version, version, 'the newest effective policy version is recorded');
    assert.deepEqual([v.status, v.validation.reason_code], ['MISSING_DOCUMENTS', 'DOCUMENT_MISSING']);
    await addDoc(ship.id, 'CARGO_MANIFEST', { voyageId: v.id });
    const ok = (await call('POST', `/voyages/${v.id}/validate`, { who: 'coord' })).body.data;
    assert.equal(ok.validation.outcome, 'VALID');
    assert.equal(ok.validation.policy_version, version);
  });
});

test('UC-015 determinism: equal inputs under one policy version give the same outcome, reasons and rule results', { skip }, async () => {
  const a = await newShip({ docs: false });
  const b = await newShip({ docs: false });
  for (const s of [a, b]) { await addDoc(s.id, 'REGISTRATION'); await addDoc(s.id, 'INSURANCE', { status: 'PENDING' }); }
  const va = (await submit('coord', a.id)).body.data;
  const vb = (await submit('coord', b.id)).body.data;
  const detail = async (v) => (await call('GET', `/voyages/${v.id}`, { who: 'coord' })).body.data.last_validation;
  const [da, db2] = [await detail(va), await detail(vb)];
  assert.equal(va.validation.reason, vb.validation.reason);
  assert.deepEqual(va.validation.reason_codes, vb.validation.reason_codes);
  assert.deepEqual(da.rules, db2.rules);
  assert.equal(da.policy_version, db2.policy_version);
});

// ================================================================ policy and AI failure behavior
test('UC-015 policy unavailable (none effective, or corrupt): the notice is kept ANNOUNCED, nothing valid is recorded, retry works', { skip }, async () => {
  const ship = await newShip();
  const lastRunId = async () => (await q('SELECT ISNULL(MAX(id), 0) AS n FROM dbo.voyage_validation_runs'))[0].n;
  const before = await lastRunId();
  const none = await withNoEffectivePolicy(() => submit('coord', ship.id));
  assert.equal(none.status, 201, 'the intake itself succeeds');
  assert.equal(none.body.data.status, 'ANNOUNCED');
  assert.deepEqual([none.body.data.validation.state, none.body.data.validation.code], ['NOT_RUN', 'POLICY_UNAVAILABLE']);
  assert.equal(none.body.data.queue_position, null);
  assert.equal(none.body.data.validation_result, null, 'no VALID is invented');
  assert.deepEqual(await historyOf(none.body.data.id), [[null, 'ANNOUNCED']]);
  assert.equal(await lastRunId(), before, 'no run record');

  // A corrupt policy (checksum mismatch) also fails closed.
  const corrupt = await q('SELECT TOP 1 version, checksum FROM dbo.validation_policies WHERE effective_until IS NULL AND effective_from <= SYSUTCDATETIME() ORDER BY effective_from DESC');
  await q("UPDATE dbo.validation_policies SET checksum = REPLICATE('f', 64) WHERE version = @v", { v: corrupt[0].version });
  let bad;
  try { bad = await call('POST', `/voyages/${none.body.data.id}/validate`, { who: 'coord' }); } finally {
    await q('UPDATE dbo.validation_policies SET checksum = @c WHERE version = @v', { c: corrupt[0].checksum, v: corrupt[0].version });
  }
  assert.equal(bad.body.data.validation.code, 'POLICY_UNAVAILABLE');
  assert.equal(bad.body.data.status, 'ANNOUNCED');

  const recovered = await call('POST', `/voyages/${none.body.data.id}/validate`, { who: 'coord' });
  assert.equal(recovered.body.data.status, 'WAITING_BERTH', 'a retry after the policy is back completes the validation');
  assert.equal((await runsOf(none.body.data.id)).length, 1);
});

test('UC-015 AI: unreachable, slow or malformed providers never give a forecast; the notice still enters the queue with the label', { skip }, async () => {
  const timeoutBefore = (await q("SELECT param_value FROM dbo.system_parameters WHERE param_key = 'AI_TIMEOUT_MS'"))[0].param_value;
  try {
    await q("UPDATE dbo.system_parameters SET param_value = N'150' WHERE param_key = 'AI_TIMEOUT_MS'");
    const scenarios = [
      ['TIMEOUT', (u, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }))],
      ['INVALID_RESPONSE', async () => ({ ok: true, status: 200, json: async () => ({ predicted_eta: 'soon', confidence: 3, model_version: '' }) })],
      ['UNREACHABLE', async () => { throw new TypeError('ECONNREFUSED'); }],
      ['PROVIDER_ERROR_500', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ];
    for (const [reason, impl] of scenarios) {
      providerFetch = impl;
      const ship = await newShip();
      const res = await submit('coord', ship.id);
      assert.equal(res.body.data.status, 'WAITING_BERTH', reason);
      assert.deepEqual([res.body.data.validation.ai.status, res.body.data.validation.ai.label], ['PENDING', 'đang chờ dự báo AI'], 'the notice is queued at once; the forecast is pending');
      assert.equal(await settle(res.body.data.id), 'UNAVAILABLE');
      const settled = (await call('GET', `/voyages/${res.body.data.id}/eta-predictions`, { who: 'coord' })).body.data.items[0];
      assert.deepEqual([settled.status, settled.reason, settled.label, settled.predicted_eta], ['UNAVAILABLE', reason, 'chưa có dự báo AI', null]);
      const row = (await q('SELECT ai_status, predicted_eta, failure_reason FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: res.body.data.id }))[0];
      assert.deepEqual([row.ai_status, row.predicted_eta, row.failure_reason], ['UNAVAILABLE', null, reason]);
    }
  } finally {
    providerFetch = null;
    await q("UPDATE dbo.system_parameters SET param_value = @v WHERE param_key = 'AI_TIMEOUT_MS'", { v: timeoutBefore });
  }
});

test('UC-015 AI success path through the adapter (local provider stand-in): forecast stored, deviation computed, queue uses it', { skip }, async () => {
  try {
    providerFetch = async (url, init) => {
      const input = JSON.parse(init.body);
      assert.ok(input.voyage_code && input.imo_number && input.declared_eta, 'the provider receives the voyage facts');
      return { ok: true, status: 200, json: async () => ({ predicted_eta: eta(1), confidence: 0.75, model_version: 'stand-in-1' }) };
    };
    const ship = await newShip();
    const res = await submit('coord', ship.id, { declared_eta: eta(10) });
    assert.equal(res.body.data.validation.ai.status, 'PENDING');
    assert.equal(await settle(res.body.data.id), 'AVAILABLE');
    const ai = (await call('GET', `/voyages/${res.body.data.id}/eta-predictions`, { who: 'coord' })).body.data.items[0];
    assert.equal(ai.status, 'AVAILABLE');
    assert.equal(ai.label, null);
    assert.equal(ai.predicted_eta, eta(1));
    assert.equal(ai.confidence, 0.75);
    const row = (await q('SELECT eta_deviation_h, model_version FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: res.body.data.id }))[0];
    assert.equal(Number(row.eta_deviation_h), -216, 'predicted minus declared, in hours (1 - 10 days)');
    assert.equal(row.model_version, 'stand-in-1');
    const entry = (await queueOf()).items.find((i) => i.voyage_id === res.body.data.id);
    assert.equal(entry.eta_source, 'AI');
    assert.equal(new Date(entry.effective_eta).toISOString(), eta(1));
  } finally { providerFetch = null; }
});

// ================================================================ UC-013 drafts
test('UC-013 drafts: save a partial draft, edit it with revisions, it is private, and it is not a notice', { skip }, async () => {
  const ship = await newShip();
  const created = await call('POST', '/voyage-drafts', { who: 'coord', body: { ship_id: ship.id, cargo_type: 'Container' } });
  assert.equal(created.status, 201);
  const d = created.body.data;
  assert.deepEqual([d.status, d.revision, d.payload], ['OPEN', 1, { ship_id: ship.id, cargo_type: 'Container' }]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id = @s', { s: ship.id }))[0].n, 0, 'a draft is not a notice and is not validated');
  assert.ok((await call('GET', '/voyage-drafts', { who: 'coord' })).body.data.items.some((x) => x.id === d.id));
  const upd = await call('PUT', `/voyage-drafts/${d.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_id: ship.id, cargo_type: 'Bulk', voyage_code: 'DRAFT-1' } });
  assert.equal(upd.status, 200);
  assert.deepEqual([upd.body.data.revision, upd.body.data.payload.cargo_type], [2, 'Bulk']);
  assert.equal(upd.etag, '"2"');
  const stale = await call('PUT', `/voyage-drafts/${d.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { cargo_type: 'x' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.current_revision, 2);
  assert.equal((await call('PUT', `/voyage-drafts/${d.id}`, { who: 'coord', body: { cargo_type: 'x' } })).status, 400, 'If-Match is required');
  // private to the owner
  for (const [m, p, body] of [['GET', `/voyage-drafts/${d.id}`], ['PUT', `/voyage-drafts/${d.id}`, { cargo_type: 'x' }], ['DELETE', `/voyage-drafts/${d.id}`], ['POST', `/voyage-drafts/${d.id}/submit`]]) {
    assert.equal((await call(m, p, { who: 'agentB', body, headers: { 'If-Match': '"2"' } })).status, 404, `${m} by another user`);
  }
  assert.ok(!(await call('GET', '/voyage-drafts', { who: 'agentB' })).body.data.items.some((x) => x.id === d.id));
});

test('UC-013 drafts: invalid drafts and unauthorized roles are refused', { skip }, async () => {
  assert.equal((await call('POST', '/voyage-drafts', { who: 'coord', body: {} })).status, 400, 'empty draft');
  assert.equal((await call('POST', '/voyage-drafts', { who: 'coord', body: { cargo_type: '' } })).status, 400, 'only empty values');
  const unknown = await call('POST', '/voyage-drafts', { who: 'coord', body: { cargo_type: 'x', status: 'BERTHED' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.details[0].field, 'status');
  assert.equal((await call('POST', '/voyage-drafts', { who: 'coord', body: { cargo_type: { a: 1 } } })).status, 400, 'objects are not stored');
  assert.equal((await call('POST', '/voyage-drafts', { who: 'coord', body: { service_request: 'x'.repeat(1001) } })).status, 400);
  for (const who of ['tech', 'yard', 'manager']) {
    assert.equal((await call('POST', '/voyage-drafts', { who, body: { cargo_type: 'x' } })).status, 403, who);
    assert.equal((await call('GET', '/voyage-drafts', { who })).status, 403, who);
  }
  assert.equal((await call('POST', '/voyage-drafts', { body: { cargo_type: 'x' } })).status, 401);
  assert.equal((await call('GET', '/voyage-drafts/abc', { who: 'coord' })).status, 404);
});

test('UC-013 submit draft: incomplete draft stays open with field errors; complete draft becomes a notice and is validated at once', { skip }, async () => {
  const ship = await newShip();
  const incomplete = (await call('POST', '/voyage-drafts', { who: 'coord', body: { ship_id: ship.id } })).body.data;
  const refused = await call('POST', `/voyage-drafts/${incomplete.id}/submit`, { who: 'coord' });
  assert.equal(refused.status, 400);
  assert.ok(refused.body.error.details.map((x) => x.field).includes('voyage_code'));
  assert.equal((await call('GET', `/voyage-drafts/${incomplete.id}`, { who: 'coord' })).body.data.status, 'OPEN');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id = @s', { s: ship.id }))[0].n, 0);

  const full = (await call('POST', '/voyage-drafts', { who: 'coord', body: notice(ship.id) })).body.data;
  const started = Date.now();
  const ok = await call('POST', `/voyage-drafts/${full.id}/submit`, { who: 'coord' });
  assert.equal(ok.status, 201);
  assert.ok(Date.now() - started < 5000);
  assert.equal(ok.body.data.status, 'WAITING_BERTH');
  assert.equal(ok.body.data.validation.outcome, 'VALID');
  const stored = await call('GET', `/voyage-drafts/${full.id}`, { who: 'coord' });
  assert.deepEqual([stored.body.data.status, stored.body.data.submitted_voyage_id], ['SUBMITTED', ok.body.data.id]);
  assert.ok(!(await call('GET', '/voyage-drafts', { who: 'coord' })).body.data.items.some((x) => x.id === full.id), 'a submitted draft leaves the open list');
});

test('UC-013 submit draft is idempotent: repeating it, or sending it twice at once, creates exactly one notice and one validation', { skip }, async () => {
  const ship = await newShip();
  const draft = (await call('POST', '/voyage-drafts', { who: 'coord', body: notice(ship.id) })).body.data;
  const [a, b] = await Promise.all([call('POST', `/voyage-drafts/${draft.id}/submit`, { who: 'coord' }), call('POST', `/voyage-drafts/${draft.id}/submit`, { who: 'coord' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.data.id, b.body.data.id);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id = @s', { s: ship.id }))[0].n, 1);
  const again = await call('POST', `/voyage-drafts/${draft.id}/submit`, { who: 'coord' });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.id, a.body.data.id);
  assert.equal((await runsOf(a.body.data.id)).length, 1, 'validated once');
  assert.deepEqual(await historyOf(a.body.data.id), [[null, 'ANNOUNCED'], ['ANNOUNCED', 'VALIDATED'], ['VALIDATED', 'WAITING_BERTH']]);
  // invalid transitions
  assert.equal((await call('PUT', `/voyage-drafts/${draft.id}`, { who: 'coord', headers: { 'If-Match': '"2"' }, body: { cargo_type: 'late' } })).body.error.details.rule, 'DRAFT_NOT_OPEN');
  assert.equal((await call('DELETE', `/voyage-drafts/${draft.id}`, { who: 'coord', headers: { 'If-Match': '"2"' } })).body.error.details.rule, 'DRAFT_NOT_OPEN');
});

test('UC-013 discarded drafts cannot be edited or submitted; an agent cannot submit outside its scope and the draft stays open', { skip }, async () => {
  const ship = await newShip();
  const d = (await call('POST', '/voyage-drafts', { who: 'coord', body: notice(ship.id) })).body.data;
  const discarded = await call('DELETE', `/voyage-drafts/${d.id}`, { who: 'coord', headers: { 'If-Match': '"1"' } });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.data.status, 'DISCARDED');
  assert.equal((await call('POST', `/voyage-drafts/${d.id}/submit`, { who: 'coord' })).body.error.details.rule, 'DRAFT_NOT_OPEN');
  assert.equal((await call('PUT', `/voyage-drafts/${d.id}`, { who: 'coord', headers: { 'If-Match': '"2"' }, body: { cargo_type: 'x' } })).status, 409);

  const foreign = await newShip({ operator: agentB });
  const ad = (await call('POST', '/voyage-drafts', { who: 'agentA', body: notice(foreign.id) })).body.data;
  const denied = await call('POST', `/voyage-drafts/${ad.id}/submit`, { who: 'agentA' });
  assert.equal(denied.status, 403);
  assert.equal((await call('GET', `/voyage-drafts/${ad.id}`, { who: 'agentA' })).body.data.status, 'OPEN');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id = @s', { s: foreign.id }))[0].n, 0);
});

test('UC-013 agent flow: an agent submits a draft for its own vessel and the workflow completes', { skip }, async () => {
  const ship = await newShip({ operator: agentA });
  const d = (await call('POST', '/voyage-drafts', { who: 'agentA', body: notice(ship.id, { agent_id: agentA }) })).body.data;
  const res = await call('POST', `/voyage-drafts/${d.id}/submit`, { who: 'agentA' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.validation.outcome, 'VALID');
  assert.equal(res.body.data.priority_class, 'STANDARD');
});

// ================================================================ authorization of the validation endpoint
test('authorization: validation and queue endpoints follow the role matrix and the agent scope', { skip }, async () => {
  const ship = await newShip({ docs: false });
  const v = (await submit('coord', ship.id)).body.data;
  const cases = [
    ['tech', 'POST', `/voyages/${v.id}/validate`, 403], ['yard', 'POST', `/voyages/${v.id}/validate`, 403], ['manager', 'POST', `/voyages/${v.id}/validate`, 403],
    ['agentB', 'POST', `/voyages/${v.id}/validate`, 404], ['agentA', 'POST', `/voyages/${v.id}/validate`, 200], [undefined, 'POST', `/voyages/${v.id}/validate`, 401],
    ['coord', 'POST', '/voyages/999999999/validate', 404], ['coord', 'POST', '/voyages/abc/validate', 404],
    ['agentA', 'GET', '/voyages/queue', 403], ['tech', 'GET', '/voyages/queue', 403], [undefined, 'GET', '/voyages/queue', 401],
    ['yard', 'GET', '/voyages/queue', 200], ['manager', 'GET', '/voyages/queue', 200], ['coord', 'GET', '/voyages/queue', 200],
    ['yard', 'PATCH', `/voyages/${v.id}/queue-position`, 403], ['manager', 'PATCH', `/voyages/${v.id}/queue-position`, 403], ['agentA', 'PATCH', `/voyages/${v.id}/queue-position`, 403],
  ];
  for (const [who, method, path, expected] of cases) {
    const res = await call(method, path, { who, body: method === 'GET' ? undefined : {}, headers: { 'If-Match': '"1"' } });
    assert.equal(res.status, expected, `${who ?? 'anonymous'} ${method} ${path}`);
  }
});

// ================================================================ UC-020 queue
test('UC-020 ordering: priority first, then effective ETA, then entry time; equal inputs give one order whatever the submission order', { skip }, async () => {
  const specs = [
    ['A', 'STANDARD', 3], ['B', 'STANDARD', 1], ['C', 'MAIN_LINE', 5], ['D', 'REEFER_OR_HAZARD', 4], ['E', 'STANDARD', 1],
  ];
  const runBatch = async (sequence) => {
    const ids = {};
    for (const name of sequence) {
      const [, priority, days] = specs.find((s) => s[0] === name);
      const ship = await newShip();
      ids[name] = (await submit('coord', ship.id, { priority_class: priority, declared_eta: eta(days) })).body.data.id;
    }
    return ids;
  };
  const first = await runBatch(['A', 'B', 'C', 'D', 'E']);
  const queue1 = await queueOf();
  const byId1 = Object.fromEntries(Object.entries(first).map(([k, id]) => [id, k]));
  assert.deepEqual(order(queue1, Object.values(first)).map((id) => byId1[id]), ['D', 'C', 'B', 'E', 'A'],
    'priority tier (main line and reefer/hazard) first, then ETA; B before E: same ETA, B entered first');
  const positions = queue1.items.map((i) => i.position);
  assert.deepEqual(positions, positions.map((_, i) => i + 1), 'positions are contiguous from 1 with no gaps or duplicates');
  // A different submission order gives the same relative order for the same inputs (E and B swapped: the tie-break follows entry time).
  const second = await runBatch(['E', 'A', 'D', 'C', 'B']);
  const queue2 = await queueOf();
  const byId2 = Object.fromEntries(Object.entries(second).map(([k, id]) => [id, k]));
  assert.deepEqual(order(queue2, Object.values(second)).map((id) => byId2[id]), ['D', 'C', 'E', 'B', 'A']);
  const e1 = queue2.items.find((i) => i.voyage_id === first.D); const e2 = queue2.items.find((i) => i.voyage_id === second.D);
  assert.ok(e1.position < e2.position, 'with the same priority and ETA the earlier entry stays first (deterministic tie-break)');
  const mineAll = [...Object.values(first), ...Object.values(second)];
  assert.ok(queue2.items.filter((i) => mineAll.includes(i.voyage_id)).every((i) => i.eta_source === 'DECLARED'), 'no AI forecast is available, so the declared ETA is used');
});

test('UC-020 a forecast that is earlier than the declared ETA moves the vessel ahead of vessels with later effective ETAs', { skip }, async () => {
  const slow = await newShip();
  const later = (await submit('coord', slow.id, { declared_eta: eta(30) })).body.data;
  try {
    providerFetch = async () => ({ ok: true, status: 200, json: async () => ({ predicted_eta: eta(20), confidence: 0.6, model_version: 'stand-in-1' }) });
    const ship = await newShip();
    const ahead = (await submit('coord', ship.id, { declared_eta: eta(40) })).body.data;
    assert.equal(await settle(ahead.id), 'AVAILABLE');
    const queue = await queueOf();
    assert.deepEqual(order(queue, [later.id, ahead.id]), [ahead.id, later.id], 'effective ETA 20 beats declared ETA 30');
    assert.equal(queue.items.find((i) => i.voyage_id === ahead.id).eta_source, 'AI');
  } finally { providerFetch = null; }
});

test('UC-020 simultaneous submissions: every valid notice gets its own position and the queue stays contiguous', { skip }, async () => {
  const ships = [];
  for (let i = 0; i < 6; i += 1) ships.push(await newShip());
  const results = await Promise.all(ships.map((s, i) => submit('coord', s.id, { declared_eta: eta(50 + (i % 3)) })));
  assert.ok(results.every((r) => r.status === 201 && r.body.data.status === 'WAITING_BERTH'),
    JSON.stringify(results.map((r) => [r.status, r.body.error ? r.body.error.code : r.body.data.validation])));
  const queue = await queueOf();
  const positions = queue.items.map((i) => i.position);
  assert.deepEqual(positions, positions.map((_, i) => i + 1), 'no duplicate or missing positions');
  const ids = results.map((r) => r.body.data.id);
  const mine = order(queue, ids);
  const etas = mine.map((id) => queue.items.find((i) => i.voyage_id === id).effective_eta);
  assert.deepEqual(etas, [...etas].sort(), 'equal priority: the final order follows ETA even though the requests were concurrent');
});

test('UC-020 move: reason, actor and positions are stored; the queue stays contiguous; the revision protects against stale views', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await submit('coord', (await newShip()).id, { declared_eta: eta(60 + i) })).body.data.id);
  let queue = await call('GET', '/voyages/queue', { who: 'coord' });
  const revision = queue.body.data.revision;
  assert.equal(queue.etag, `"${revision}"`);
  const last = ids[2];
  const posBefore = queue.body.data.items.find((i) => i.voyage_id === last).position;
  const moved = await call('PATCH', `/voyages/${last}/queue-position`, { who: 'coord', headers: { 'If-Match': `"${revision}"` }, body: { to_position: 1, reason: 'Tàu tuyến chính cần ưu tiên' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.revision, revision + 1);
  const items = moved.body.data.items;
  assert.equal(items.find((i) => i.voyage_id === last).position, 1);
  assert.deepEqual(items.map((i) => i.position), items.map((_, i) => i + 1));
  assert.deepEqual(items.filter((i) => i.voyage_id !== last && ids.includes(i.voyage_id)).map((i) => i.voyage_id), [ids[0], ids[1]], 'the others keep their relative order');
  const change = (await q('SELECT * FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: last }))[0];
  assert.deepEqual([change.from_position, change.to_position, change.reason, change.actor], [posBefore, 1, 'Tàu tuyến chính cần ưu tiên', usernames[0]]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'QUEUE_MOVE' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(last) }))[0].n, 1);
  // stale view: the old revision is refused and the current one is returned
  const stale = await call('PATCH', `/voyages/${ids[0]}/queue-position`, { who: 'coord', headers: { 'If-Match': `"${revision}"` }, body: { to_position: 2, reason: 'x' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.rule, 'QUEUE_CHANGED');
  assert.equal(stale.body.error.details.current_revision, revision + 1);
  assert.equal((await call('PATCH', `/voyages/${ids[0]}/queue-position`, { who: 'coord', body: { to_position: 2, reason: 'x' } })).status, 400, 'If-Match is required');
  assert.ok((await call('PATCH', `/voyages/${ids[0]}/queue-position`, { who: 'coord', headers: { 'If-Match': `"${revision + 1}"` }, body: { to_position: 2, reason: 'ok' } })).status === 200);
});

test('UC-020 move: reason is mandatory, positions are bounded, only queued voyages move, and refusals leave the queue unchanged', { skip }, async () => {
  const v = (await submit('coord', (await newShip()).id, { declared_eta: eta(70) })).body.data;
  const missing = (await submit('coord', (await newShip({ docs: false })).id)).body.data;
  const state = async () => (await call('GET', '/voyages/queue', { who: 'coord' })).body.data;
  const before = await state();
  const move = (id, body, rev = before.revision) => call('PATCH', `/voyages/${id}/queue-position`, { who: 'coord', headers: { 'If-Match': `"${rev}"` }, body });
  for (const [body, field] of [[{ to_position: 1 }, 'reason'], [{ to_position: 1, reason: '' }, 'reason'], [{ to_position: 1, reason: '   ' }, 'reason'],
    [{ to_position: 1, reason: 'x'.repeat(501) }, 'reason'], [{ to_position: 0, reason: 'x' }, 'to_position'], [{ to_position: -1, reason: 'x' }, 'to_position'],
    [{ to_position: 1.5, reason: 'x' }, 'to_position'], [{ to_position: '1', reason: 'x' }, 'to_position'], [{ to_position: before.items.length + 1, reason: 'x' }, 'to_position']]) {
    const res = await move(v.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.details.some((d) => d.field === field), JSON.stringify(body));
  }
  const same = await move(v.id, { to_position: v.queue_position, reason: 'same place' });
  assert.equal(same.status, 400);
  const notQueued = await move(missing.id, { to_position: 1, reason: 'x' });
  assert.equal(notQueued.status, 409);
  assert.equal(notQueued.body.error.details.rule, 'NOT_IN_QUEUE');
  assert.equal((await move(v.id, { to_position: 1, reason: 'x', extra: 1 })).status, 400, 'unknown fields are refused');
  assert.equal((await move(999999999, { to_position: 1, reason: 'x' })).status, 409);
  const after = await state();
  assert.equal(after.revision, before.revision, 'nothing was changed by the refused requests');
  assert.deepEqual(after.items.map((i) => i.voyage_id), before.items.map((i) => i.voyage_id));
});

test('UC-020 two coordinators moving at once with the same queue revision: one succeeds, one must reload (UC-020 6a)', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await submit('coord', (await newShip()).id, { declared_eta: eta(80 + i) })).body.data.id);
  const rev = (await queueOf()).revision;
  const attempts = await Promise.all([
    call('PATCH', `/voyages/${ids[2]}/queue-position`, { who: 'coord', headers: { 'If-Match': `"${rev}"` }, body: { to_position: 1, reason: 'A' } }),
    call('PATCH', `/voyages/${ids[1]}/queue-position`, { who: 'coord', headers: { 'If-Match': `"${rev}"` }, body: { to_position: 1, reason: 'B' } }),
  ]);
  assert.deepEqual(attempts.map((a) => a.status).sort(), [200, 409]);
  const queue = await queueOf();
  assert.deepEqual(queue.items.map((i) => i.position), queue.items.map((_, i) => i + 1), 'the queue is still a clean 1..n sequence');
  assert.equal(queue.revision, rev + 1);
});

// ================================================================ UC-016 display and history (MOCK providers where a forecast is needed)
// A forecast here comes from a local stand-in written for the test. It proves that a valid answer is stored, computed and shown correctly; it says nothing about
// the quality of any real model. With no stand-in (the real state of the system) the answer is always UNAVAILABLE.
const etaHistory = (id, who = 'coord') => call('GET', `/voyages/${id}/eta-predictions`, { who });

test('UC-016 no provider: the history shows UNAVAILABLE with the label and the reason, and no predicted ETA, deviation or confidence; the voyage detail carries the same', { skip }, async () => {
  const v = (await submit('coord', (await newShip()).id)).body.data;
  const h = (await etaHistory(v.id)).body.data;
  assert.equal(h.total, 1);
  const p = h.items[0];
  assert.deepEqual([p.status, p.label, p.reason, p.predicted_eta, p.deviation_h, p.confidence, p.confidence_meaning, p.model_version], ['UNAVAILABLE', 'chưa có dự báo AI', 'NOT_CONFIGURED', null, null, null, null, null]);
  assert.deepEqual([p.source, p.sequence], [{ kind: 'NONE', reason: 'NOT_CONFIGURED' }, 1]);
  assert.match(p.requested_at, /^\d{4}-\d{2}-\d{2}T.*Z$/); assert.equal(p.declared_eta, v.declared_eta, 'the declared ETA at the time of the request');
  assert.equal(p.input_hash.length, 64);
  const detail = (await call('GET', `/voyages/${v.id}`, { who: 'coord' })).body.data;
  assert.deepEqual([detail.eta.status, detail.eta.sequence, detail.eta.predicted_eta], ['UNAVAILABLE', 1, null]);
});

test('UC-016 MOCK provider answer: the four values are shown together (declared ETA, predicted ETA, deviation = predicted minus declared in hours, confidence as reported with its meaning stated), with source and order number', { skip }, async () => {
  try {
    providerFetch = async () => ({ ok: true, status: 200, json: async () => ({ predicted_eta: eta(1.5), confidence: 0.62, model_version: 'stand-in-2' }) });
    const v = (await submit('coord', (await newShip()).id, { declared_eta: eta(1) })).body.data;
    assert.equal(v.validation.ai.status, 'PENDING');
    await settle(v.id);
    const ai = (await call('GET', `/voyages/${v.id}/eta-predictions`, { who: 'coord' })).body.data.items[0];
    assert.deepEqual([ai.declared_eta, ai.predicted_eta, ai.deviation_h, ai.confidence, ai.model_version, ai.sequence], [eta(1), eta(1.5), 12, 0.62, 'stand-in-2', 1]);
    assert.match(ai.confidence_meaning, /chưa định nghĩa/, 'the SRS does not define confidence, and the data says so');
    assert.deepEqual(ai.source, { kind: 'EXTERNAL_AI', model_version: 'stand-in-2' });
    assert.equal((await etaHistory(v.id)).body.data.items[0].deviation_h, 12);
    // A replay of the stored result (the voyage is already VALID) shows the same forecast, not a blank.
    const again = (await call('POST', `/voyages/${v.id}/validate`, { who: 'coord', body: {} })).body.data.validation;
    assert.equal(again.replayed, true);
    assert.deepEqual([again.ai.predicted_eta, again.ai.deviation_h, again.ai.confidence, again.ai.status], [eta(1.5), 12, 0.62, 'AVAILABLE']);
    assert.equal((await etaHistory(v.id)).body.data.total, 1, 'a replay does not add a prediction');
  } finally { providerFetch = null; }
});

test('UC-016 history: predictions are append-only, listed newest first with their order number, never overwritten (later rows are fixtures: no use case issues a second prediction yet, UC-018 is not built)', { skip }, async () => {
  const v = (await submit('coord', (await newShip()).id)).body.data;
  const first = (await q('SELECT id FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: v.id }))[0].id;
  const add = (status, predicted, dev, conf, model, fail, seed) => q(`INSERT INTO dbo.voyage_eta_predictions (voyage_id, declared_eta, ai_status, predicted_eta, eta_deviation_h, eta_confidence, model_version, failure_reason, input_hash, input_json)
    VALUES (@v, @d, @s, @p, @dev, @c, @m, @f, REPLICATE(@h, 64), N'{}')`, { v: v.id, d: new Date(v.declared_eta), s: status, p: predicted, dev, c: conf, m: model, f: fail, h: seed });
  await add('AVAILABLE', new Date(Date.parse(v.declared_eta) + 3 * 3600e3), 3, 0.5, 'fixture-1', null, 'a');
  await add('UNAVAILABLE', null, null, null, null, 'TIMEOUT', 'b');
  const h = (await etaHistory(v.id)).body.data;
  assert.equal(h.total, 3);
  assert.deepEqual(h.items.map((x) => [x.sequence, x.status, x.reason]), [[3, 'UNAVAILABLE', 'TIMEOUT'], [2, 'AVAILABLE', null], [1, 'UNAVAILABLE', 'NOT_CONFIGURED']]);
  assert.equal(h.items[1].deviation_h, 3); assert.equal(h.items[1].confidence, 0.5);
  assert.equal(h.items[2].id, Number(first), 'the first prediction is unchanged');
  assert.ok(h.items[0].requested_at >= h.items[1].requested_at && h.items[1].requested_at >= h.items[2].requested_at);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_eta_predictions WHERE voyage_id = @v', { v: v.id }))[0].n, 3);
  await assert.rejects(() => q('UPDATE dbo.voyage_eta_predictions SET eta_confidence = 2 WHERE id = @i', { i: first }), /CK_vep_confidence|CK_vep_result/, 'the database refuses an impossible confidence');
  await assert.rejects(() => q("INSERT INTO dbo.voyage_eta_predictions (voyage_id, declared_eta, ai_status, input_hash, input_json) VALUES (@v, @d, 'AVAILABLE', REPLICATE('c', 64), N'{}')", { v: v.id, d: new Date(v.declared_eta) }), /CK_vep_result/, 'an AVAILABLE row needs a forecast, confidence and model');
});

test('UC-016 history access: the coordinator and the voyage own agent read it; another agent, an unknown voyage and a malformed id get 404; no session 401; roles with view access read it; others 403', { skip }, async () => {
  const v = (await submit('coord', (await newShip()).id)).body.data;
  assert.equal((await etaHistory(v.id, 'agentA')).status, 200);
  assert.equal((await etaHistory(v.id, 'agentB')).status, 404, 'another agent does not learn that the voyage exists');
  assert.equal((await etaHistory(999999999)).status, 404); assert.equal((await etaHistory('abc')).status, 404);
  assert.equal((await call('GET', `/voyages/${v.id}/eta-predictions`)).status, 401);
  for (const who of ['yard', 'manager']) assert.equal((await etaHistory(v.id, who)).status, 200, who);
  assert.equal((await etaHistory(v.id, 'tech')).status, 403, 'no M1 permission');
});

test('UC-016 failure reasons are kept in the history for timeout, malformed answer, unreachable and provider error (MOCK providers), and the business flow continues each time', { skip }, async () => {
  const timeoutBefore = (await q("SELECT param_value FROM dbo.system_parameters WHERE param_key = 'AI_TIMEOUT_MS'"))[0].param_value;
  try {
    await q("UPDATE dbo.system_parameters SET param_value = N'150' WHERE param_key = 'AI_TIMEOUT_MS'");
    const cases = [['TIMEOUT', (u, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }))],
      ['INVALID_RESPONSE', async () => ({ ok: true, status: 200, json: async () => ({ predicted_eta: 'soon', confidence: 3, model_version: '' }) })],
      ['UNREACHABLE', async () => { throw new TypeError('ECONNREFUSED'); }], ['PROVIDER_ERROR_503', async () => ({ ok: false, status: 503, json: async () => ({}) })]];
    for (const [reason, impl] of cases) {
      providerFetch = impl;
      const v = (await submit('coord', (await newShip()).id)).body.data;
      assert.equal(v.status, 'WAITING_BERTH', `${reason}: the voyage continues with the declared ETA`);
      await settle(v.id);
      const p = (await etaHistory(v.id)).body.data.items[0];
      assert.deepEqual([p.status, p.reason, p.label, p.predicted_eta, p.confidence], ['UNAVAILABLE', reason, 'chưa có dự báo AI', null, null], reason);
      assert.equal((await queueOf()).items.find((i) => i.voyage_id === v.id).eta_source, 'DECLARED');
    }
  } finally { providerFetch = null; await q("UPDATE dbo.system_parameters SET param_value = @v WHERE param_key = 'AI_TIMEOUT_MS'", { v: timeoutBefore }); }
});

// ================================================================ A2: refresh hints for validation and queue changes (UC-015, UC-020)
// Opens the real SSE channels as signed-in users and collects the frames. A hint only says "re-read"; it never carries data.
async function listen(who, path = '/realtime/m2/events') {
  const ac = new AbortController(); const frames = [];
  const res = await fetch(base + '/api/v1' + path, { headers: { Cookie: cookies[who] }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) return;
        buf += dec.decode(value);
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = raw.match(/^id: (\d+)\nevent: refresh\ndata: (.*)$/m);
          if (m) frames.push({ id: Number(m[1]), data: JSON.parse(m[2]), at: Date.now() });
        }
      }
    } catch (e) { /* aborted */ }
  })();
  const waitFor = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { const f = frames.find(pred); if (f) return f; if (Date.now() > end) throw new Error('no matching refresh hint within ' + ms + ' ms: ' + JSON.stringify(frames.map((x) => x.data))); await new Promise((r) => setTimeout(r, 10)); }
  };
  return { frames, waitFor, stop: () => ac.abort() };
}

test('A2: a notice that is validated and queued sends one refresh hint (type and voyage id only) to the coordinator within 5 s; ids increase', { skip }, async () => {
  const ch = await listen('coord');
  try {
    const ship = await newShip();
    const t0 = Date.now();
    const r = await submit('agentA', ship.id);
    assert.equal(r.status, 201);
    const id = r.body.data.id;
    const hint = await ch.waitFor((f) => f.data.type === 'VOYAGE_VALIDATED' && f.data.voyage_id === id);
    assert.ok(hint.at - t0 < 5000, `hint after ${hint.at - t0} ms`);
    assert.deepEqual(Object.keys(hint.data).sort(), ['type', 'voyage_id'], 'the hint carries no vessel, agent or cargo data');
    assert.equal(ch.frames.filter((f) => f.data.type === 'VOYAGE_VALIDATED' && f.data.voyage_id === id).length, 1, 'exactly one hint for the action');
    assert.ok(ch.frames.every((f, i) => i === 0 || f.id > ch.frames[i - 1].id), 'frame ids are strictly increasing');
    assert.ok((await queueOf()).items.some((i) => i.voyage_id === id), 'the voyage is in the queue the hint tells clients to re-read');
  } finally { ch.stop(); }
});

test('A2: a failed validation (missing documents) also changes the result and sends a hint; the agent channel and a non-berth role get nothing from it', { skip }, async () => {
  const ch = await listen('coord'); const agentCh = await listen('agentA', '/realtime/notifications'); const yardCh = await listen('yard', '/realtime/notifications');
  try {
    const ship = await newShip({ docs: false });
    const r = await submit('agentA', ship.id);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, 'MISSING_DOCUMENTS');
    await ch.waitFor((f) => f.data.type === 'VOYAGE_VALIDATED' && f.data.voyage_id === r.body.data.id);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(agentCh.frames.length + yardCh.frames.length, 0, 'the notification channel only carries notification hints, never validation hints');
  } finally { ch.stop(); agentCh.stop(); yardCh.stop(); }
});

test('A2: a manual queue move sends QUEUE_MOVED to open coordinator screens after the commit; a refused (stale) move sends nothing', { skip }, async () => {
  const s1 = await newShip(); const s2 = await newShip();
  const a = (await submit('agentA', s1.id, { declared_eta: eta(30) })).body.data; const b = (await submit('agentA', s2.id, { declared_eta: eta(31) })).body.data;
  const ch = await listen('coord');
  try {
    const qv = await queueOf();
    const stale = await call('PATCH', `/voyages/${b.id}/queue-position`, { who: 'coord', body: { to_position: 1, reason: 'stale' }, headers: { 'If-Match': `"${Number(qv.revision) - 1}"` } });
    assert.equal(stale.status, 409);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(ch.frames.filter((f) => f.data.type === 'QUEUE_MOVED').length, 0, 'a refused move changes nothing and sends no hint');
    const t0 = Date.now();
    const pos = qv.items.find((i) => i.voyage_id === b.id).position;
    const moved = await call('PATCH', `/voyages/${b.id}/queue-position`, { who: 'coord', body: { to_position: pos > 1 ? pos - 1 : 2, reason: 'A2 test' }, headers: { 'If-Match': `"${qv.revision}"` } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const hint = await ch.waitFor((f) => f.data.type === 'QUEUE_MOVED' && f.data.voyage_id === b.id);
    assert.ok(hint.at - t0 < 5000);
    assert.deepEqual(Object.keys(hint.data).sort(), ['type', 'voyage_id']);
    void a;
  } finally { ch.stop(); }
});

test('A2: the berth channel stays closed to the agent and to anonymous clients', { skip }, async () => {
  assert.equal((await fetch(base + '/api/v1/realtime/m2/events', { headers: { Cookie: cookies.agentA } })).status, 403);
  assert.equal((await fetch(base + '/api/v1/realtime/m2/events')).status, 401);
});
