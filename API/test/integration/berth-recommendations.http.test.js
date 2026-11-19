'use strict';

// HTTP integration tests for UC-027 local berth recommendations (policy UC027-OPT-V2) on real SQL Server. Needs migration 0006 in the test database.
// Voyages in the queue and ships are inserted as fixtures (CONSTRUCTED, not real port data); everything else goes through the real API: the
// recommendation, UC-026 checks, plan drafts, submission and approval by another account. Runs only with SP_TEST_DB.
// What these tests show: the feature works, obeys UC-026, is reproducible and fast enough. They do NOT show that the placements are good for a real port.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');
const { recommend, metrics } = require('../../src/policy/berthOptimizer');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: recommendation integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const CODE = (n) => `R${SUFFIX}${n}`;

let db; let server; let base; let agentA; let portId; let typeId; let bulkId; let coordId;
const cookies = {}; const usernames = []; const shipIds = [];
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3);

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'RA_${SUFFIX}', N'Đại lý R ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'RP${SUFFIX}', N'Cảng R ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  bulkId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'BULK'"))[0].id;
  const defs = { coord: [['DIEU_PHOI_VIEN']], coord2: [['DIEU_PHOI_VIEN']], manager: [['BAN_QUAN_LY']], yard: [['NHAN_VIEN_KHO_BAI']], agentUser: [['DAI_LY_HANG_HAI'], agentA], tech: [['KY_THUAT_VIEN']] };
  for (const [key, [roles, agentId]] of Object.entries(defs)) {
    const username = `t_r_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: roles, agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  coordId = Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: `t_r_coord_${SUFFIX}` }))[0].user_id);
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const ships = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ships})`;
  const ownBerths = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'R${SUFFIX}%'`;
  const ownPlans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${ownBerths})`;
  await q(`DELETE FROM dbo.berth_plan_decisions WHERE voyage_id IN (${mine});
           DELETE FROM dbo.notifications WHERE (entity_type = 'BERTH_PLAN' AND entity_id IN (${ownPlans})) OR recipient_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 't_r_%_${SUFFIX}');
           DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${ownPlans});
           DELETE FROM dbo.berth_plans WHERE id IN (${ownPlans});
           DELETE FROM dbo.berth_plan_inference_vessels WHERE voyage_id IN (${mine});
           DELETE FROM dbo.berth_plan_proposals WHERE voyage_id IN (${mine});
           DELETE FROM dbo.berth_plan_inferences WHERE requested_by_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 't_r_%_${SUFFIX}');
           DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${ownBerths});
           DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyages WHERE ship_id IN (${ships}); DELETE FROM dbo.ships WHERE id IN (${ships});
           DELETE FROM dbo.berths WHERE berth_code LIKE 'R${SUFFIX}%';`);
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
             DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
  await new Promise((r) => server.close(r));
  await db.pool.close();
});

async function call(method, path, { who = 'coord', body, headers = {} } = {}) {
  const res = await fetch(base + '/api/v1' + path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}
const ifMatch = (rev) => ({ 'If-Match': `"${rev}"` });
let n = 0;
const newBerth = async (over = {}) => { n += 1; const r = await call('POST', '/berths', { body: { berth_code: CODE(n), berth_type: 'CONTAINER', length_m: 450, max_depth_m: 14, available_cranes: 4, allows_dangerous: false, ...over } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; };
async function ship(over = {}) {
  n += 1;
  const id = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id
    VALUES (@c, @i, @nm, @t, @loa, 30, @d, 50000)`, { c: `RS${SUFFIX}${n}`, i: `5${String(100000 + Math.floor(Math.random() * 800000))}`, nm: `Rec ${SUFFIX} ${n}`, t: over.bulk ? bulkId : typeId, loa: over.loa ?? 200, d: over.draft ?? 9 }))[0].id;
  shipIds.push(id); return id;
}
// A voyage waiting in the queue (fixture). hazard: 'NONE', 'DANGEROUS' or null (not verified).
async function queued({ loa, draft, bulk, hazard = 'NONE', teu = 800, etaH = 6 } = {}) {
  const shipId = await ship({ loa, draft, bulk }); n += 1;
  const next = Number((await q("SELECT ISNULL(MAX(queue_position), 0) + 1 AS p FROM dbo.voyages WHERE status = 'WAITING_BERTH'"))[0].p);
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at,
      validation_result, validated_at, validation_policy_version${hazard ? ', cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at' : ''})
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, @eta, @teu, N'x', @pos, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V'${hazard ? ", @h, N'fixture', @u, SYSUTCDATETIME()" : ''})`,
  { s: shipId, c: `RV-${n}-${SUFFIX}`, a: agentA, p: portId, eta: hoursFromNow(etaH), teu, pos: next, h: hazard, u: coordId }))[0].id;
}
const recommendFor = (ids, who = 'coord') => call('POST', '/berth-recommendations', { who, body: ids === undefined ? {} : { voyage_ids: ids } });
const asPlan = (voyageId, p, extra = {}) => ({ voyage_id: voyageId, berth_id: p.berth_id, position_start_m: p.position_start_m, position_end_m: p.position_end_m, planned_start: p.planned_start, planned_end: p.planned_end, required_cranes: p.required_cranes, proposal_id: p.proposal_id, ...extra });
const planRow = async (id) => (await q('SELECT plan_status, source, proposal_id, revision FROM dbo.berth_plans WHERE id = @i', { i: id }))[0];
const decisions = (planId) => q('SELECT decision, proposal_id, plan_id FROM dbo.berth_plan_decisions WHERE plan_id = @i', { i: planId });
const voyageRow = async (id) => (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @i', { i: id }))[0];

test('UC-027 main flow: ranked proposals with explanations, each one a UC-026 PASS; request, answer, vessels and proposals stored; engine labelled as not machine learning', { skip }, async () => {
  const b1 = await newBerth(); const b2 = await newBerth({ length_m: 350 });
  const v1 = await queued({ loa: 220, teu: 900 }); const v2 = await queued({ loa: 180, teu: 500, etaH: 8 });
  const r = await recommendFor([v1, v2]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.data;
  assert.deepEqual([d.status, d.policy_version, d.engine.kind, d.engine.is_machine_learning, d.engine.predictive_ai], ['RECOMMENDED', 'UC027-OPT-V2', 'LOCAL_OPTIMIZER', false, 'UNAVAILABLE']);
  assert.match(d.engine.note, /không phải mô hình học máy/i);
  assert.equal(d.vessels.length, 2);
  for (const v of d.vessels) {
    assert.equal(v.outcome, 'RECOMMENDED'); assert.ok(v.proposals.length >= 1 && v.proposals.length <= 3);
    assert.deepEqual(v.proposals.map((p) => p.rank), v.proposals.map((_, i) => i + 1));
    for (const p of v.proposals) {
      assert.equal(p.uc026.outcome, 'PASS', 'a shown proposal is a UC-026 PASS'); assert.ok(p.uc026.rules.length === 9);
      assert.ok(p.reasons.length >= 4 && p.score > 0 && p.score <= 1 && p.expected_wait_h >= 0 && p.required_cranes >= 1);
      assert.equal((await call('POST', '/berth-plan-checks', { body: { voyage_id: v.voyage_id, berth_id: p.berth_id, position_start_m: p.position_start_m, position_end_m: p.position_end_m,
        planned_start: p.planned_start, planned_end: p.planned_end, required_cranes: p.required_cranes } })).body.data.outcome, 'PASS', 'an independent UC-026 check agrees');
    }
  }
  const [inf] = await q('SELECT * FROM dbo.berth_plan_inferences WHERE id = @i', { i: d.id });
  assert.deepEqual([inf.engine_kind, inf.model_version, inf.ai_status, inf.snapshot_hash.length], ['LOCAL_OPTIMIZER', 'UC027-OPT-V2', 'AVAILABLE', 64]);
  assert.ok(JSON.parse(inf.request_json).vessels.length === 2 && JSON.parse(inf.response_json).vessels.length === 2 && inf.duration_ms >= 0);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plan_inference_vessels WHERE inference_id = @i', { i: d.id }))[0].n, 2);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plan_proposals WHERE inference_id = @i', { i: d.id }))[0].n, d.summary.proposals);
  const [a] = await q("SELECT outcome, new_json FROM dbo.audit_events WHERE action = 'BERTH_RECOMMEND' AND entity_id = @e", { e: String(d.id) });
  assert.deepEqual([a.outcome, JSON.parse(a.new_json).policy_version], ['SUCCESS', 'UC027-OPT-V2']);
  const got = await call('GET', `/berth-recommendations/${d.id}`, { who: 'manager' });
  assert.equal(got.status, 200); assert.equal(got.body.data.summary.proposals, d.summary.proposals);
  assert.equal((await call('GET', '/berth-recommendations/999999999')).status, 404);
  void b1; void b2;
  // Nothing was planned, approved or moved by asking.
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id IN (@a, @b)', { a: v1, b: v2 }))[0].n, 0);
  assert.deepEqual([(await voyageRow(v1)).status, (await voyageRow(v2)).status], ['WAITING_BERTH', 'WAITING_BERTH']);
});

test('UC-027 unschedulable vessels: explicit result with reasons; unverified cargo is never treated as safe; no feasible vessel at all is NO_FEASIBLE_PLACEMENT (3a) and the manual path stays open', { skip }, async () => {
  await newBerth();
  const tooLong = await queued({ loa: 900 }); const unverified = await queued({ hazard: null }); const noTeu = await queued({ teu: 0 });
  const r = await recommendFor([tooLong, unverified, noTeu]);
  assert.equal(r.status, 201);
  const by = Object.fromEntries(r.body.data.vessels.map((v) => [v.voyage_id, v]));
  assert.ok(by[tooLong].outcome === 'UNSCHEDULABLE' && by[tooLong].reasons.some((x) => x.code === 'LOA_FIT'));
  assert.ok(by[unverified].outcome === 'UNSCHEDULABLE' && by[unverified].reasons.some((x) => x.code === 'DANGEROUS_GOODS_MISSING'));
  assert.ok(by[noTeu].outcome === 'UNSCHEDULABLE' && by[noTeu].reasons.some((x) => x.code === 'MISSING_DATA' && /TEU/.test(x.text)));
  assert.equal(r.body.data.status, 'NO_FEASIBLE_PLACEMENT'); assert.equal(r.body.data.summary.proposals, 0);
  const [inf] = await q('SELECT ai_status, failure_reason FROM dbo.berth_plan_inferences WHERE id = @i', { i: r.body.data.id });
  assert.deepEqual([inf.ai_status, inf.failure_reason], ['UNAVAILABLE', 'NO_FEASIBLE_PLACEMENT']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plan_inference_vessels WHERE inference_id = @i AND outcome = \'UNSCHEDULABLE\'', { i: r.body.data.id }))[0].n, 3, 'each outcome is stored');
  // Manual planning still works for a vessel the engine could not place (UC-028 unchanged).
  const berth = await newBerth();
  const m = await call('POST', '/berth-plans', { body: { voyage_id: noTeu, berth_id: berth.id, position_start_m: 0, position_end_m: 240, planned_start: hoursFromNow(30).toISOString(), planned_end: hoursFromNow(42).toISOString(), required_cranes: 2 } });
  assert.equal(m.status, 201, JSON.stringify(m.body)); assert.equal((await planRow(m.body.data.id)).source, 'MANUAL');
});

test('UC-027 request checks and authorization: at most 20 distinct queued voyages (refused before any work), only the coordinator asks, others 403 with audit, no session 401', { skip }, async () => {
  const before = Number((await q('SELECT COUNT(*) AS n FROM dbo.berth_plan_inferences'))[0].n);
  const bad = async (body) => { const r = await call('POST', '/berth-recommendations', { body }); assert.equal(r.status, 400, JSON.stringify(body)); return r.body.error.details.map((x) => x.field); };
  assert.ok((await bad({ voyage_ids: Array.from({ length: 21 }, (_, i) => i + 1) })).includes('voyage_ids'), '21 vessels refused');
  assert.ok((await bad({ voyage_ids: [] })).includes('voyage_ids')); assert.ok((await bad({ voyage_ids: [1, 1] })).includes('voyage_ids'));
  assert.ok((await bad({ voyage_ids: ['x'] })).includes('voyage_ids')); assert.ok((await bad({ extra: 1 })).includes('extra'));
  assert.ok((await bad({ voyage_ids: [999999999] })).includes('voyage_ids'), 'not in the queue');
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM dbo.berth_plan_inferences'))[0].n), before, 'no work and nothing stored for a refused request');
  for (const who of ['manager', 'yard', 'agentUser', 'tech']) assert.equal((await recommendFor(undefined, who)).status, 403, who);
  assert.equal((await call('POST', '/berth-recommendations', { who: null, body: {} })).status, 401);
  assert.ok(Number((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_RECOMMEND' AND outcome = 'DENIED' AND actor LIKE @a", { a: `t_r_%_${SUFFIX}` }))[0].n) >= 4);
  const v = await queued(); await newBerth();
  const ok = await recommendFor([v]); assert.equal(ok.status, 201);
  assert.equal((await call('GET', `/berth-recommendations/${ok.body.data.id}`, { who: 'agentUser' })).status, 403);
  assert.equal((await call('POST', `/berth-recommendations/${ok.body.data.id}/ignore`, { who: 'manager', body: { voyage_id: v } })).status, 403);
});

test('UC-027 reproducible: the stored snapshot replayed through the engine gives the same proposals; equal snapshots hash equally', { skip }, async () => {
  await newBerth(); await newBerth({ length_m: 300 });
  const ids = [await queued({ loa: 210 }), await queued({ loa: 170, teu: 400 }), await queued({ loa: 250, teu: 1200 })];
  const r = (await recommendFor(ids)).body.data;
  const [inf] = await q('SELECT request_json, snapshot_hash FROM dbo.berth_plan_inferences WHERE id = @i', { i: r.id });
  const snapshot = JSON.parse(inf.request_json);
  const replay = await recommend(snapshot);      // without UC-026 verification: the candidates before the check
  const key = (v) => v.proposals.map((p) => [p.berth_id, p.position_start_m, p.planned_start, p.planned_end, p.cost]);
  for (const v of r.vessels) {
    const again = replay.vessels.find((x) => x.voyage_id === v.voyage_id);
    assert.deepEqual(v.proposals.map((p) => [p.berth_id, p.position_start_m, p.planned_start, p.planned_end, p.cost]), key(again).slice(0, v.proposals.length), `vessel ${v.voyage_code}`);
  }
  assert.deepEqual(await recommend(snapshot), replay, 'two replays are identical');
  assert.equal(inf.snapshot_hash, crypto.createHash('sha256').update(require('../../src/services/berthRecommendationService').canonical(snapshot)).digest('hex'), 'the hash is of the stored snapshot');
});

test('UC-027 human decision (FR-BRT-12): a draft from a proposal is checked again by UC-026 and recorded ACCEPTED; edited it becomes AI_ADJUSTED and MODIFIED, edited back ACCEPTED; ignoring is recorded; nothing is approved automatically', { skip }, async () => {
  await newBerth(); await newBerth();
  const v1 = await queued({ loa: 200 }); const v2 = await queued({ loa: 190, etaH: 9 }); const v3 = await queued({ loa: 180, etaH: 10 });
  const rec = (await recommendFor([v1, v2, v3])).body.data;
  const p1 = rec.vessels.find((v) => v.voyage_id === v1).proposals[0];
  // source and proposal_id together are refused; a proposal of another voyage is refused; an unknown proposal is refused.
  const other = rec.vessels.find((v) => v.voyage_id === v2).proposals[0];
  assert.equal((await call('POST', '/berth-plans', { body: asPlan(v1, p1, { source: 'AI' }) })).status, 400);
  assert.equal((await call('POST', '/berth-plans', { body: asPlan(v1, { ...p1, proposal_id: other.proposal_id }) })).status, 400);
  assert.equal((await call('POST', '/berth-plans', { body: asPlan(v1, { ...p1, proposal_id: 999999999 }) })).status, 400);
  // accept as proposed
  const d = await call('POST', '/berth-plans', { body: asPlan(v1, p1) });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const planId = d.body.data.id;
  assert.deepEqual([(await planRow(planId)).source, Number((await planRow(planId)).proposal_id), (await planRow(planId)).plan_status], ['LOCAL_OPTIMIZER', p1.proposal_id, 'DRAFT']);
  assert.deepEqual((await decisions(planId)).map((x) => x.decision), ['ACCEPTED']);
  assert.deepEqual([(await voyageRow(v1)).status], ['WAITING_BERTH'], 'a draft does not move the voyage');
  // edit: another crane count makes it AI_ADJUSTED / MODIFIED, editing back makes it AI / ACCEPTED again
  const edit = await call('PUT', `/berth-plans/${planId}`, { body: asPlan(v1, p1, { required_cranes: Math.max(1, p1.required_cranes - 1) }), headers: ifMatch(d.body.data.revision) });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual([(await planRow(planId)).source, (await decisions(planId))[0].decision], ['LOCAL_OPTIMIZER_ADJUSTED', 'MODIFIED']);
  const back = await call('PUT', `/berth-plans/${planId}`, { body: asPlan(v1, p1), headers: ifMatch(edit.body.data.revision) });
  assert.equal(back.status, 200); assert.deepEqual([(await planRow(planId)).source, (await decisions(planId))[0].decision], ['LOCAL_OPTIMIZER', 'ACCEPTED']);
  // submit: UC-026 runs again; approval stays a separate human step by another account
  const sub = await call('POST', `/berth-plans/${planId}/submit`, { headers: ifMatch(back.body.data.revision) });
  assert.equal(sub.status, 200, JSON.stringify(sub.body)); assert.equal((await planRow(planId)).plan_status, 'PENDING_APPROVAL');
  // modify a proposal when making the draft
  const mod = await call('POST', '/berth-plans', { body: asPlan(v2, other, { required_cranes: other.required_cranes + 0 === 1 ? 2 : 1 }) });
  assert.equal(mod.status, 201, JSON.stringify(mod.body));
  assert.deepEqual([(await planRow(mod.body.data.id)).source, (await decisions(mod.body.data.id))[0].decision], ['LOCAL_OPTIMIZER_ADJUSTED', 'MODIFIED']);
  // ignore, then plan by hand: the ignore is recorded; the manual plan has no decision row
  const ig = await call('POST', `/berth-recommendations/${rec.id}/ignore`, { body: { voyage_id: v3, reason: 'Ưu tiên tàu khác' } });
  assert.equal(ig.status, 200, JSON.stringify(ig.body));
  assert.deepEqual(ig.body.data.vessels.find((v) => v.voyage_id === v3).decision.map((x) => [x.decision, x.reason]), [['IGNORED', 'Ưu tiên tàu khác']]);
  assert.equal((await call('POST', `/berth-recommendations/${rec.id}/ignore`, { body: { voyage_id: v3 } })).status, 409, 'ignored once');
  assert.equal((await call('POST', `/berth-recommendations/${rec.id}/ignore`, { body: { voyage_id: 999999999 } })).status, 400);
  assert.equal((await call('POST', `/berth-recommendations/${rec.id}/ignore`, { body: {} })).status, 400);
  const manualBerth = await newBerth();
  const man = await call('POST', '/berth-plans', { body: { voyage_id: v3, berth_id: manualBerth.id, position_start_m: 0, position_end_m: 200, planned_start: hoursFromNow(60).toISOString(), planned_end: hoursFromNow(70).toISOString(), required_cranes: 2 } });
  assert.equal(man.status, 201); assert.deepEqual([(await planRow(man.body.data.id)).source, (await decisions(man.body.data.id)).length], ['MANUAL', 0]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE plan_status IN ('APPROVED') AND voyage_id IN (@a, @b, @c)", { a: v1, b: v2, c: v3 }))[0].n, 0, 'nothing was approved');
  assert.ok(Number((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_RECOMMEND_IGNORE' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(rec.id) }))[0].n) === 1);
});

test('UC-027 rules are checked again at save, submit and approval: a change after the recommendation is caught (UC-026 BR-01), the override path and the approval recheck still hold', { skip }, async () => {
  const berth = await newBerth({ length_m: 400 });
  const v1 = await queued({ loa: 200 }); const v2 = await queued({ loa: 200, etaH: 7 });
  const rec = (await recommendFor([v1])).body.data;
  const p = rec.vessels[0].proposals[0];
  assert.ok(p, 'a proposal exists');
  berth.id = p.berth_id;   // the berth the engine chose (the database also holds the berths of the other tests)
  // Meanwhile a coordinator plans another vessel on the same stretch and time and it gets approved (by the manager).
  const clash = await call('POST', '/berth-plans', { who: 'coord2', body: { voyage_id: v2, berth_id: berth.id, position_start_m: p.position_start_m, position_end_m: p.position_end_m, planned_start: p.planned_start, planned_end: p.planned_end, required_cranes: p.required_cranes } });
  assert.equal(clash.status, 201); const cs = await call('POST', `/berth-plans/${clash.body.data.id}/submit`, { who: 'coord2', headers: ifMatch(1) }); assert.equal(cs.status, 200);
  assert.equal((await call('POST', `/berth-plans/${clash.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(cs.body.data.revision) })).status, 200);
  // Saving the old proposal now is refused by UC-026 (overlap), unless overridden with a reason: it is not valid any more.
  const late = await call('POST', '/berth-plans', { body: asPlan(v1, p) });
  assert.equal(late.status, 409, JSON.stringify(late.body)); assert.equal(late.body.error.details.rule, 'CONSTRAINT_VIOLATION');
  assert.ok(late.body.error.details.check.rules.some((r) => r.id === 'OVERLAP'));
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plan_decisions WHERE voyage_id = @v", { v: v1 }))[0].n, 0, 'a refused draft leaves no decision');
  // A fresh recommendation now avoids the reservation (and still passes UC-026).
  const again = (await recommendFor([v1])).body.data;
  for (const x of again.vessels[0].proposals) assert.equal(x.uc026.outcome, 'PASS');
  const fresh = again.vessels[0].proposals[0];
  assert.ok(fresh.berth_id !== berth.id || fresh.planned_start >= clash.body.data.planned_end || fresh.position_start_m !== p.position_start_m, 'the new proposal does not repeat the stale placement');
  // Approval recheck: a draft from a proposal, submitted; a clash approved first; approving the draft is refused.
  const dr = await call('POST', '/berth-plans', { body: asPlan(v1, fresh) }); assert.equal(dr.status, 201, JSON.stringify(dr.body));
  const sb = await call('POST', `/berth-plans/${dr.body.data.id}/submit`, { headers: ifMatch(1) }); assert.equal(sb.status, 200, JSON.stringify(sb.body));
  const v3 = await queued({ loa: 200, etaH: 5 });
  const over = await call('POST', '/berth-plans', { who: 'coord2', body: { voyage_id: v3, berth_id: fresh.berth_id, position_start_m: fresh.position_start_m, position_end_m: fresh.position_end_m, planned_start: fresh.planned_start, planned_end: fresh.planned_end, required_cranes: fresh.required_cranes, override_reason: 'Thử ghi đè khi hai kế hoạch trùng' } });
  assert.equal(over.status, 201, JSON.stringify(over.body));
  const os = await call('POST', `/berth-plans/${over.body.data.id}/submit`, { who: 'coord2', headers: ifMatch(1) }); assert.equal(os.status, 200, JSON.stringify(os.body));
  const ap = await call('POST', `/berth-plans/${dr.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(sb.body.data.revision) });
  assert.equal(ap.status, 200, JSON.stringify(ap.body)); assert.equal((await voyageRow(v1)).status, 'BERTH_ASSIGNED', 'a valid plan from a proposal is approved only by this human step');
  const refused = await call('POST', `/berth-plans/${over.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(os.body.data.revision) });
  assert.deepEqual([refused.status, refused.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL'], 'the overridden clashing plan is refused at approval: the rules are checked again then');
  assert.equal((await voyageRow(v3)).status, 'WAITING_BERTH');
});

test('UC-027 concurrency: two simultaneous requests both succeed; three simultaneous drafts from one proposal give exactly one plan and one decision', { skip }, async () => {
  await newBerth(); await newBerth();
  const ids = [await queued(), await queued({ etaH: 8 })];
  const both = await Promise.all([recommendFor(ids), recommendFor(ids, 'coord2')]);
  assert.deepEqual(both.map((r) => r.status), [201, 201]); assert.notEqual(both[0].body.data.id, both[1].body.data.id);
  const p = both[0].body.data.vessels[0].proposals[0]; const v = both[0].body.data.vessels[0].voyage_id;
  const rs = await Promise.all([call('POST', '/berth-plans', { body: asPlan(v, p) }), call('POST', '/berth-plans', { who: 'coord2', body: asPlan(v, p) }), call('POST', '/berth-plans', { body: asPlan(v, p) })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal(Number((await q("SELECT COUNT(*) AS n FROM dbo.berth_plan_decisions WHERE voyage_id = @v AND decision IN ('ACCEPTED', 'MODIFIED')", { v }))[0].n), 1);
  assert.equal(Number((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v AND plan_status = 'DRAFT'", { v }))[0].n), 1);
});

test('UC-027 performance and quality with 20 waiting voyages on 8 berths (CONSTRUCTED fixture): latency under 10 s, zero UC-026 violations in proposals, optimized versus first-fit baseline measured', { skip, timeout: 120000 }, async () => {
  const berths = [await newBerth({ length_m: 450, available_cranes: 5 }), await newBerth({ length_m: 400 }), await newBerth({ length_m: 350 }), await newBerth({ length_m: 300, available_cranes: 3 }), await newBerth({ length_m: 300, available_cranes: 3 }),
    await newBerth({ length_m: 300, available_cranes: 2 }), await newBerth({ berth_type: 'BULK', length_m: 280, available_cranes: 2 }), await newBerth({ berth_type: 'BULK', length_m: 260, available_cranes: 2, allows_dangerous: true })];
  // Two reservations and a maintenance window make the snapshot non-trivial.
  const holder = await queued({ loa: 150, etaH: 1 }); const holder2 = await queued({ loa: 150, etaH: 1 });
  for (const [vid, b, s, e] of [[holder, berths[0], 0, 18], [holder2, berths[1], 2, 14]]) {
    const dr = await call('POST', '/berth-plans', { body: { voyage_id: vid, berth_id: b.id, position_start_m: 0, position_end_m: 160, planned_start: hoursFromNow(s + 1).toISOString(), planned_end: hoursFromNow(e + 1).toISOString(), required_cranes: 2 } });
    assert.equal(dr.status, 201, JSON.stringify(dr.body));
    const sb = await call('POST', `/berth-plans/${dr.body.data.id}/submit`, { headers: ifMatch(1) }); assert.equal(sb.status, 200);
    assert.equal((await call('POST', `/berth-plans/${dr.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(sb.body.data.revision) })).status, 200);
  }
  await q("INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, reason, status, created_by) VALUES (@b, @s, @e, N'bảo trì thử', 'ACTIVE', N'test')", { b: berths[2].id, s: hoursFromNow(8), e: hoursFromNow(26) });
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push(await queued({ loa: 140 + (i * 17) % 120, draft: 8 + (i % 5) * 0.8, teu: 400 + (i * 137) % 1400, etaH: 2 + i * 2, bulk: i % 5 === 4, hazard: i % 7 === 3 ? 'DANGEROUS' : 'NONE' }));
  const t0 = Date.now();
  const r = await recommendFor(ids);
  const wall = Date.now() - t0;
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  const d = r.body.data;
  assert.ok(wall < 10000, `UC-027 AC-1: ${wall} ms for 20 queued voyages`);
  assert.equal(d.vessels.length, 20);
  let violations = 0; let proposals = 0;
  for (const v of d.vessels) for (const p of v.proposals) { proposals += 1; if (p.uc026.outcome !== 'PASS') violations += 1; }
  assert.equal(violations, 0, 'every proposal labelled valid passed UC-026'); assert.equal(proposals, d.summary.proposals);
  assert.ok(d.vessels.filter((v) => v.outcome === 'UNSCHEDULABLE').every((v) => v.reasons.length > 0));
  // Quality against a documented baseline on the SAME stored snapshot: simulated first-fit (earliest start, berth code order). This is a model of a manual
  // coordinator, not real manual data, so it is a fixture-based comparison and not evidence of improvement in a real port.
  const snapshot = JSON.parse((await q('SELECT request_json FROM dbo.berth_plan_inferences WHERE id = @i', { i: d.id }))[0].request_json);
  const opt = metrics(await recommend(snapshot)); const base = metrics(await recommend(snapshot, { selection: 'FIRST_FIT' }));
  process.stdout.write(`METRICS20 engine_ms=${d.duration_ms} wall_ms=${wall} vessels=20 recommended=${d.summary.recommended} unschedulable=${d.summary.unschedulable} proposals=${proposals} rejected_by_uc026=${d.summary.rejected_by_uc026} violations=${violations}\n`);
  process.stdout.write(`METRICS20 optimized=${JSON.stringify(opt)} first_fit=${JSON.stringify(base)}\n`);
  assert.equal(opt.vessels, 20); assert.equal(base.vessels, 20);
});

// ---------------------------------------------------------------- UC-027 hardening: actual occupancy (UC-022, UC-025 A-5, UC-026)
// A vessel that is BERTHED occupies its stretch until it actually departs, even when its planned departure has passed.
async function berthed({ berth, loa = 200, fromH = -10, toH = -2, ataH = -9 }) {
  const v = await queued({ loa, etaH: ataH });
  const d = await call('POST', '/berth-plans', { body: { voyage_id: v, berth_id: berth.id, position_start_m: 0, position_end_m: loa, planned_start: hoursFromNow(fromH).toISOString(), planned_end: hoursFromNow(toH).toISOString(), required_cranes: 2 } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await call('POST', `/berth-plans/${d.body.data.id}/submit`, { headers: ifMatch(1) }); assert.equal(s.status, 200, JSON.stringify(s.body));
  const a = await call('POST', `/berth-plans/${d.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(s.body.data.revision) }); assert.equal(a.status, 200, JSON.stringify(a.body));
  const rev = Number((await q('SELECT revision FROM dbo.voyages WHERE id = @v', { v }))[0].revision);
  const b = await call('POST', `/voyages/${v}/berthing`, { body: { berth_id: berth.id, actual_time: hoursFromNow(ataH).toISOString(), reason: 'Nhập bổ sung cho kiểm thử' }, headers: ifMatch(rev) });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  return { voyageId: v, planId: d.body.data.id };
}

test('UC-027 occupancy: a BERTHED vessel whose planned departure has passed still occupies its stretch; no recommendation, UC-026 check or draft treats it as free', { skip }, async () => {
  const berth = await newBerth({ length_m: 300 });
  const a = await berthed({ berth });                                   // planned to leave 2 h ago, no departure recorded
  assert.equal((await call('GET', '/berths/status')).body.data.items.find((x) => x.id === berth.id).state, 'IN_USE', 'UC-025: the berth is in use');
  const b = await queued({ loa: 200, etaH: 0 });
  const r = await recommendFor([b]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = r.body.data.vessels[0];
  assert.ok(v.proposals.every((p) => p.berth_id !== berth.id), 'A physically occupies this berth (300 m, no room beside A): nothing may be proposed on it, whatever else exists');
  // UC-026 itself agrees: the same placement is an OVERLAP now, and a manual draft is refused.
  const placementNow = { voyage_id: b, berth_id: berth.id, position_start_m: 0, position_end_m: 200, planned_start: hoursFromNow(1).toISOString(), planned_end: hoursFromNow(9).toISOString(), required_cranes: 2 };
  const chk = await call('POST', '/berth-plan-checks', { body: placementNow });
  assert.ok(chk.body.data.rules.find((x) => x.id === 'OVERLAP').outcome === 'VIOLATION', 'UC-026 reports OVERLAP with the berthed vessel');
  assert.equal((await call('POST', '/berth-plans', { body: placementNow })).status, 409);
  // After the actual departure the stretch is free again, from the departure time.
  const rev = Number((await q('SELECT revision FROM dbo.voyages WHERE id = @v', { v: a.voyageId }))[0].revision);
  assert.equal((await call('POST', `/voyages/${a.voyageId}/departure`, { body: {}, headers: ifMatch(rev) })).status, 200);
  const after = await call('POST', '/berth-plan-checks', { body: placementNow });
  assert.equal(after.body.data.rules.find((x) => x.id === 'OVERLAP').outcome, 'PASS', 'after the departure UC-026 sees the stretch free');
  const again = (await recommendFor([b])).body.data.vessels[0];
  assert.equal(again.outcome, 'RECOMMENDED'); assert.ok(again.proposals.every((p) => p.uc026.outcome === 'PASS'));
});

test('UC-027 occupancy: a BERTHED vessel before its planned departure keeps its plan interval; a recommendation on another stretch or later is allowed and passes UC-026', { skip }, async () => {
  const berth = await newBerth({ length_m: 600 });
  await berthed({ berth, fromH: -4, toH: 20, ataH: -3 });
  const b = await queued({ loa: 200, etaH: 1 });
  const v = (await recommendFor([b])).body.data.vessels[0];
  assert.equal(v.outcome, 'RECOMMENDED');
  for (const p of v.proposals) {
    assert.equal(p.uc026.outcome, 'PASS');
    const overlapsInTime = Date.parse(p.planned_start) < hoursFromNow(20).getTime();
    if (p.berth_id === berth.id && overlapsInTime) assert.ok(p.position_start_m >= 200 + 15, 'beside A with the safety buffer (15 m by default), never on top of it');
  }
});

// ---------------------------------------------------------------- UC-027 hardening: cargo hazard consistency (UC-026 BR-03 versus P-7)
test('UC-027 hazard consistency: unverified cargo is never "safe", dangerous cargo only at a labelled berth; the same answer at recommendation, draft save, submission and approval', { skip }, async () => {
  const ordinary = await newBerth({ length_m: 450 }); const labelled = await newBerth({ length_m: 450, allows_dangerous: true });
  const unverified = await queued({ hazard: null, etaH: 4 }); const safe = await queued({ hazard: 'NONE', etaH: 5 }); const dangerous = await queued({ hazard: 'DANGEROUS', etaH: 6 });
  const r = (await recommendFor([unverified, safe, dangerous])).body.data;
  const by = Object.fromEntries(r.vessels.map((v) => [v.voyage_id, v]));
  const berthsOf = (v) => [...new Set(v.proposals.map((p) => p.berth_id))];
  const labelledIds = new Set((await q('SELECT id FROM dbo.berths WHERE allows_dangerous = 1')).map((x) => x.id));   // every labelled berth in the database
  assert.ok(labelledIds.has(labelled.id));
  assert.ok(by[unverified].proposals.length && berthsOf(by[unverified]).every((id) => labelledIds.has(id)), 'unverified cargo: only labelled berths (UC-026 needs no fact there; elsewhere it is MISSING_DATA)');
  assert.ok(by[dangerous].proposals.length && berthsOf(by[dangerous]).every((id) => labelledIds.has(id)), 'dangerous cargo: only labelled berths');
  assert.ok(berthsOf(by[safe]).some((id) => !labelledIds.has(id)), 'verified safe cargo may go to an ordinary berth');
  // Draft save: the same answer from UC-026. Unverified on the ordinary berth is missing data (cannot be saved at all, not even with an override).
  const at = (voyage, berth, extra = {}) => ({ voyage_id: voyage, berth_id: berth.id, position_start_m: 0, position_end_m: 200, planned_start: hoursFromNow(30).toISOString(), planned_end: hoursFromNow(40).toISOString(), required_cranes: 2, ...extra });
  const missing = await call('POST', '/berth-plans', { body: at(unverified, ordinary, { override_reason: 'thử ghi đè' }) });
  assert.deepEqual([missing.status, missing.body.error.details.rule], [409, 'INSUFFICIENT_DATA'], 'missing data can never be overridden');
  assert.equal((await call('POST', '/berth-plans', { body: at(unverified, labelled) })).status, 201, 'the labelled berth needs no fact');
  // Dangerous cargo on the ordinary berth: a violation that needs an override, and the override never survives approval.
  const viol = await call('POST', '/berth-plans', { body: at(dangerous, ordinary) });
  assert.deepEqual([viol.status, viol.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION']);
  const forced = await call('POST', '/berth-plans', { body: at(dangerous, ordinary, { override_reason: 'Thử ghi đè hàng nguy hiểm' }) });
  assert.equal(forced.status, 201, JSON.stringify(forced.body));
  const fs = await call('POST', `/berth-plans/${forced.body.data.id}/submit`, { headers: ifMatch(1) }); assert.equal(fs.status, 200, JSON.stringify(fs.body));
  const fa = await call('POST', `/berth-plans/${forced.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(fs.body.data.revision) });
  assert.deepEqual([fa.status, fa.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL'], 'approval refuses the dangerous cargo on an ordinary berth');
  // A change of the verified hazard after a recommendation: a draft from the old proposal is submitted, the cargo is then verified DANGEROUS, approval refuses.
  const p = by[safe].proposals.find((x) => !labelledIds.has(x.berth_id));
  const d = await call('POST', '/berth-plans', { body: asPlan(safe, p) }); assert.equal(d.status, 201, JSON.stringify(d.body));
  const ds = await call('POST', `/berth-plans/${d.body.data.id}/submit`, { headers: ifMatch(1) }); assert.equal(ds.status, 200);
  assert.equal((await call('PUT', `/voyages/${safe}/cargo-hazard`, { body: { cargo_hazard: 'DANGEROUS', basis: 'Xác minh lại: có hàng nguy hiểm' } })).status, 200);
  const da = await call('POST', `/berth-plans/${d.body.data.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(ds.body.data.revision) });
  assert.deepEqual([da.status, da.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL'], 'the hazard recheck at approval catches the change');
  assert.equal((await voyageRow(safe)).status, 'WAITING_BERTH');
  // And a fresh recommendation for the same vessel now follows the new verified fact.
  assert.ok(berthsOf((await recommendFor([safe])).body.data.vessels[0]).every((id) => labelledIds.has(id)));
});
