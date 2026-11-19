'use strict';

// HTTP integration tests for manual berth plans on real SQL Server: save and edit a draft (UC-028) and submit it for approval
// (UC-029), with the placement check (UC-026), overrides, concurrency and the database safeguards. Runs only with SP_TEST_DB set.
// Voyages in the queue come from UC-013..UC-020 in the product; here they are inserted directly. Approval (UC-030) does not exist,
// so APPROVED plans used as neighbors are fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');
const { can } = require('../../src/security/permissions');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: berth plan integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const CODE = (n) => `P${SUFFIX}${n}`;

let db; let server; let base; let agentA; let portId; let typeId; let coordId; let managerId; let shipId;
const cookies = {}; const usernames = [];
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const H = (h, day = 0) => new Date(Date.UTC(2032, 0, 10 + day, h)).toISOString();

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'PA_${SUFFIX}', N'Đại lý PA ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'PP${SUFFIX}', N'Cảng PP ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const defs = { coord: ['DIEU_PHOI_VIEN'], manager: ['BAN_QUAN_LY'], yard: ['NHAN_VIEN_KHO_BAI'], agentA: ['DAI_LY_HANG_HAI', agentA], tech: ['KY_THUAT_VIEN'] };
  for (const [key, [role, agentId]] of Object.entries(defs)) {
    const username = `t_p_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  const idOf = async (u) => (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u }))[0].user_id;
  coordId = Number(await idOf(usernames[0])); managerId = Number(await idOf(usernames[1]));
  shipId = await mk('ships', 'ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t', `'PC${SUFFIX}', '2${String(100000 + Math.floor(Math.random() * 800000))}', N'Plan ${SUFFIX}', ${typeId}, 250, 32, 10, 60000`);
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id = ${shipId}`;
  const ownBerths = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'P${SUFFIX}%'`;
  const ownPlans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${ownBerths})`;
  await q(`DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (${ownPlans});
           DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${ownPlans});
           DELETE FROM dbo.berth_plans WHERE id IN (${ownPlans});
           DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${ownBerths});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyages WHERE ship_id = ${shipId}; DELETE FROM dbo.ships WHERE id = ${shipId};
           DELETE FROM dbo.berths WHERE berth_code LIKE 'P${SUFFIX}%';`);
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
  return { status: res.status, body: json, etag: res.headers.get('etag') };
}
const berthN = { n: 0 };
const newBerth = async (over = {}) => {
  berthN.n += 1;
  const r = await call('POST', '/berths', { body: { berth_code: CODE(berthN.n), berth_type: 'CONTAINER', length_m: 600, max_depth_m: 12, available_cranes: 3, allows_dangerous: false, ...over } });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data;
};
let voyageN = 0;
async function voyage(over = {}) {
  voyageN += 1;
  const hz = over.hazard === null ? 'NULL, NULL, NULL, NULL' : "@hz, N'test fixture', @u, SYSUTCDATETIME()";
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at,
      validation_result, validated_at, validation_policy_version, cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, @st, @a, @p, '2032-01-10', 1, N'x', ${over.status && over.status !== 'WAITING_BERTH' ? 'NULL, NULL' : '9998, SYSUTCDATETIME()'}, 'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1', ${hz})`,
  { s: shipId, c: `PV-${voyageN}-${SUFFIX}`, st: over.status || 'WAITING_BERTH', a: agentA, p: portId, hz: over.hazard || 'NONE', u: coordId }))[0].id;
}
const body = (voyageId, berthId, over = {}) => ({ voyage_id: voyageId, berth_id: berthId, position_start_m: 0, position_end_m: 260, planned_start: H(8), planned_end: H(20), required_cranes: 2, ...over });
const draft = async (over = {}, voyageOver = {}) => {
  const b = over.berth || await newBerth(); const v = over.voyage || await voyage(voyageOver);
  const r = await call('POST', '/berth-plans', { body: body(v, b.id, over.placement) });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return { plan: r.body.data, berth: b, voyageId: v, etag: r.etag };
};
const ifMatch = (rev) => ({ 'If-Match': `"${rev}"` });
const planRow = async (id) => { const r = await planRowRaw(id); return { ...r, revision: Number(r.revision) }; };
const planRowRaw = async (id) => (await q('SELECT plan_status, revision, override_reason, override_by_user_id, JSON_VALUE(constraint_check_json, \'$.passed\') AS passed, JSON_VALUE(constraint_check_json, \'$.outcome\') AS outcome FROM dbo.berth_plans WHERE id = @i', { i: id }))[0];
const voyageRow = async (id) => (await q('SELECT status, queue_position, revision FROM dbo.voyages WHERE id = @i', { i: id }))[0];
const audits = (action, id) => q('SELECT outcome, reason, old_json, new_json FROM dbo.audit_events WHERE action = @a AND entity_id = @e ORDER BY id', { a: action, e: String(id) });
const insertPlan = (voyageId, berthId, status, { start = 0, end = 250, from = H(8), to = H(20), submitted = coordId, approved = null } = {}) => q(
  `INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json,
      submitted_by_user_id, submitted_at, approved_by_user_id, approved_at) OUTPUT inserted.id
   VALUES (@v, @b, @st, 'MANUAL', @ps, @pe, @f, @t, 1, 15, N'TEST', N'{"passed":true,"outcome":"PASS"}', @sub, SYSUTCDATETIME(), @ap, ${approved ? 'SYSUTCDATETIME()' : 'NULL'})`,
  { v: voyageId, b: berthId, st: status, ps: start, pe: end, f: new Date(from), t: new Date(to), sub: submitted, ap: approved });

test('permission matrix: only the coordinator may save, submit and override berth plans', { skip }, () => {
  assert.equal(can(['DIEU_PHOI_VIEN'], 'M2_BERTHS', 'override'), true);
  for (const role of ['BAN_QUAN_LY', 'NHAN_VIEN_KHO_BAI', 'QUAN_TRI_HE_THONG', 'KY_THUAT_VIEN', 'DAI_LY_HANG_HAI']) assert.equal(can([role], 'M2_BERTHS', 'override'), false, role);
  assert.equal(can(['BAN_QUAN_LY'], 'M2_BERTHS', 'edit'), false);
});

// ---------------------------------------------------------------- UC-028
test('UC-028: a manual draft is saved with its check result, history and audit; the voyage and the queue are untouched', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  const before = await voyageRow(v);
  const r = await call('POST', '/berth-plans', { body: body(v, b.id) });
  assert.equal(r.status, 201);
  const p = r.body.data;
  assert.deepEqual([p.plan_status, p.source, p.proposal_id, p.revision, p.position_end_m, p.required_cranes, p.override_reason, p.created_by_user_id], ['DRAFT', 'MANUAL', null, 1, 260, 2, null, coordId]);
  assert.deepEqual([p.check.outcome, p.check.passed, p.check.rules_version, p.policy_version, p.buffer_m], ['PASS', true, 'UC026-RULES-V2', 'UC026-RULES-V2', 15]);
  assert.equal(r.etag, '"1"');
  assert.deepEqual(await voyageRow(v), before, 'drafting does not change the voyage or its queue position');
  const got = await call('GET', `/berth-plans/${p.id}`, { who: 'manager' });
  assert.deepEqual([got.status, got.body.data.history.map((h) => h.to_status)], [200, ['DRAFT']]);
  const list = await call('GET', `/berth-plans?status=DRAFT&voyage_id=${v}`);
  assert.deepEqual(list.body.data.items.map((x) => x.id), [p.id]);
  const [a] = await audits('BERTH_PLAN_CREATE', p.id);
  assert.equal(a.outcome, 'SUCCESS');
  assert.equal(JSON.parse(a.new_json).berth_code, b.berth_code);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @i", { i: p.id }))[0].n, 0, 'a draft notifies nobody');
});

test('UC-028 validation and eligibility: bad input, AI source, unknown or unqueued voyage, one draft per voyage', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  const bad = async (over, field) => { const r = await call('POST', '/berth-plans', { body: { ...body(v, b.id), ...over } }); assert.equal(r.status, 400, JSON.stringify(over)); assert.ok(r.body.error.details.some((d) => d.field === field), field); };
  await bad({ position_end_m: 0 }, 'position_end_m');
  await bad({ planned_end: H(8) }, 'planned_end');
  await bad({ planned_start: '2032-01-10' }, 'planned_start');
  await bad({ source: 'AI' }, 'source');
  await bad({ override_reason: '' }, 'override_reason');
  await bad({ override_reason: 'x'.repeat(501) }, 'override_reason');
  await bad({ dangerous_goods: false }, 'dangerous_goods');
  await bad({ berth_id: 999999999 }, 'berth_id');
  await bad({ voyage_id: 999999999 }, 'voyage_id');
  const announced = await voyage({ status: 'ANNOUNCED' });
  const nq = await call('POST', '/berth-plans', { body: body(announced, b.id) });
  assert.deepEqual([nq.status, nq.body.error.details.rule], [409, 'VOYAGE_NOT_IN_QUEUE']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id IN (@a, @b)', { a: announced, b: v }))[0].n, 0, 'nothing is stored by a refusal');
  const first = await call('POST', '/berth-plans', { body: body(v, b.id) });
  assert.equal(first.status, 201);
  const second = await call('POST', '/berth-plans', { body: body(v, b.id) });
  assert.deepEqual([second.status, second.body.error.details.rule, second.body.error.details.plan_id], [409, 'DRAFT_EXISTS', first.body.data.id]);
});

test('UC-028 3a / AC-1 / AC-2: a violation is always warned; it is saved only with a reason, whose record is kept; passed stays false', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  const tooShort = body(v, b.id, { position_end_m: 200 });         // LOA 250 m does not fit
  const warn = await call('POST', '/berth-plans', { body: tooShort });
  assert.deepEqual([warn.status, warn.body.error.code, warn.body.error.details.rule, warn.body.error.details.requires_override], [409, 'BUSINESS_RULE_VIOLATION', 'CONSTRAINT_VIOLATION', true]);
  assert.equal(warn.body.error.details.check.rules.find((r) => r.id === 'LOA_FIT').outcome, 'VIOLATION');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v', { v }))[0].n, 0, 'the warning stored nothing');
  const ok = await call('POST', '/berth-plans', { body: { ...tooShort, override_reason: 'Tàu neo chéo, đã thống nhất với hoa tiêu' } });
  assert.equal(ok.status, 201);
  const p = ok.body.data;
  assert.deepEqual([p.check.passed, p.check.outcome, p.override_reason, p.override_by_user_id, p.override_rules], [false, 'VIOLATION', 'Tàu neo chéo, đã thống nhất với hoa tiêu', coordId, ['LOA_FIT']]);
  assert.ok(p.override_at);
  const [ov] = await audits('BERTH_PLAN_OVERRIDE', p.id);
  assert.deepEqual([ov.outcome, ov.reason, JSON.parse(ov.new_json).overridden_rules], ['SUCCESS', 'Tàu neo chéo, đã thống nhất với hoa tiêu', ['LOA_FIT']]);
  assert.equal((await planRow(p.id)).passed, 'false', 'the evaluation keeps its meaning');
  // A reason sent with a placement that passes is not stored as an override.
  const b2 = await newBerth(); const v2 = await voyage();
  const clean = await call('POST', '/berth-plans', { body: { ...body(v2, b2.id), override_reason: 'không cần' } });
  assert.deepEqual([clean.status, clean.body.data.override_reason, clean.body.data.check.passed], [201, null, true]);
});

test('UC-028: missing data and an out-of-service berth can never be overridden', { skip }, async () => {
  const b = await newBerth();
  const noCranes = await voyage(); const p1 = body(noCranes, b.id); delete p1.required_cranes;
  const r1 = await call('POST', '/berth-plans', { body: { ...p1, override_reason: 'bỏ qua' } });
  assert.deepEqual([r1.status, r1.body.error.details.rule], [409, 'INSUFFICIENT_DATA']);
  const unknownCargo = await voyage({ hazard: null });
  const r2 = await call('POST', '/berth-plans', { body: { ...body(unknownCargo, b.id), override_reason: 'chắc chắn không nguy hiểm' } });
  assert.deepEqual([r2.status, r2.body.error.details.rule], [409, 'INSUFFICIENT_DATA'], 'an unverified cargo cannot be overridden into a plan');
  assert.equal(r2.body.error.details.check.rules.some((x) => x.id === 'DANGEROUS_GOODS' && x.outcome === 'MISSING_DATA'), true);
  const oos = await newBerth(); const vo = await voyage();
  await call('PATCH', `/berths/${oos.id}`, { body: { operational_status: 'OUT_OF_SERVICE' }, headers: ifMatch(1) });
  const r3 = await call('POST', '/berth-plans', { body: { ...body(vo, oos.id), override_reason: 'khẩn cấp' } });
  assert.deepEqual([r3.status, r3.body.error.details.rule], [409, 'NOT_OVERRIDABLE']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id IN (@a, @b, @c)', { a: noCranes, b: unknownCargo, c: vo }))[0].n, 0);
  // Verifying the cargo makes the same plan possible.
  assert.equal((await call('PUT', `/voyages/${unknownCargo}/cargo-hazard`, { body: { cargo_hazard: 'NONE', basis: 'Danh mục hàng hóa 7' } })).status, 200);
  assert.equal((await call('POST', '/berth-plans', { body: body(unknownCargo, b.id) })).status, 201);
});

test('UC-028 authorization: only the coordinator writes; management and warehouse read; agent and technician are refused', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  for (const who of ['manager', 'yard', 'agentA', 'tech']) assert.equal((await call('POST', '/berth-plans', { who, body: body(v, b.id) })).status, 403, who);
  assert.equal((await call('POST', '/berth-plans', { who: null, body: body(v, b.id) })).status, 401);
  const { plan } = await draft({ berth: b, voyage: v });
  assert.equal((await call('GET', '/berth-plans', { who: 'yard' })).status, 200);
  assert.equal((await call('GET', `/berth-plans/${plan.id}`, { who: 'agentA' })).status, 403);
  assert.equal((await call('PUT', `/berth-plans/${plan.id}`, { who: 'manager', body: body(v, b.id), headers: ifMatch(1) })).status, 403);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_PLAN_CREATE' AND outcome = 'DENIED' AND actor LIKE @a", { a: `t_p_%_${SUFFIX}` }))[0].n >= 4, true, 'denials are audited');
});

test('UC-028 5a: editing a draft re-checks it, needs the current revision, and only drafts can be edited', { skip }, async () => {
  const { plan, berth, voyageId } = await draft();
  const moved = await call('PUT', `/berth-plans/${plan.id}`, { body: body(voyageId, berth.id, { position_start_m: 100, position_end_m: 360 }), headers: ifMatch(1) });
  assert.deepEqual([moved.status, moved.body.data.revision, moved.body.data.position_start_m, moved.body.data.check.passed], [200, 2, 100, true]);
  const [upd] = await audits('BERTH_PLAN_UPDATE', plan.id);
  assert.deepEqual([JSON.parse(upd.old_json).position_start_m, JSON.parse(upd.new_json).position_start_m], [0, 100]);
  const stale = await call('PUT', `/berth-plans/${plan.id}`, { body: body(voyageId, berth.id), headers: ifMatch(1) });
  assert.deepEqual([stale.status, stale.body.error.details.current_revision], [409, 2]);
  assert.equal((await call('PUT', `/berth-plans/${plan.id}`, { body: body(voyageId, berth.id) })).status, 400, 'If-Match is required');
  const viol = await call('PUT', `/berth-plans/${plan.id}`, { body: body(voyageId, berth.id, { position_end_m: 200 }), headers: ifMatch(2) });
  assert.deepEqual([viol.status, viol.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION'], 'a drag that breaks a rule is warned again');
  assert.equal((await planRow(plan.id)).revision, 2, 'refusals change nothing');
  const other = await berthAndMove(plan, voyageId);
  assert.equal(other.status, 200);
  assert.equal((await call('PUT', `/berth-plans/${plan.id}`, { body: body(await voyage(), berth.id), headers: ifMatch(other.body.data.revision) })).status, 400, 'a plan cannot change voyage');
  const sub = await call('POST', `/berth-plans/${plan.id}/submit`, { headers: ifMatch(other.body.data.revision) });
  assert.equal(sub.status, 200);
  const late = await call('PUT', `/berth-plans/${plan.id}`, { body: body(voyageId, berth.id), headers: ifMatch(sub.body.data.revision) });
  assert.deepEqual([late.status, late.body.error.details.rule], [409, 'NOT_DRAFT']);
});
async function berthAndMove(plan, voyageId) { const b2 = await newBerth(); return call('PUT', `/berth-plans/${plan.id}`, { body: body(voyageId, b2.id), headers: ifMatch(2) }); }

// ---------------------------------------------------------------- UC-029
test('UC-029 main flow: a clean draft becomes PENDING_APPROVAL with submitter, history, audit and a notice for management; nothing else changes', { skip }, async () => {
  const { plan, voyageId, berth } = await draft();
  const before = await voyageRow(voyageId);
  const r = await call('POST', `/berth-plans/${plan.id}/submit`, { headers: ifMatch(1) });
  assert.equal(r.status, 200);
  const p = r.body.data;
  assert.deepEqual([p.plan_status, p.submitted_by_user_id, p.revision, p.approved_by_user_id, p.override_reason], ['PENDING_APPROVAL', coordId, 2, null, null]);
  assert.ok(p.submitted_at);
  assert.deepEqual(await voyageRow(voyageId), before, 'submission does not change the voyage or the queue');
  const h = (await call('GET', `/berth-plans/${plan.id}`)).body.data.history;
  assert.deepEqual(h.map((x) => `${x.from_status}>${x.to_status}`), ['null>DRAFT', 'DRAFT>PENDING_APPROVAL']);
  const note = await q("SELECT recipient_role_code, title, body FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @i", { i: plan.id });
  assert.equal(note.length, 1);
  assert.equal(note[0].recipient_role_code, 'BAN_QUAN_LY');
  assert.match(note[0].body, new RegExp(berth.berth_code));
  const [a] = await audits('BERTH_PLAN_SUBMIT', plan.id);
  assert.equal(a.outcome, 'SUCCESS');
  assert.equal((await planRow(plan.id)).plan_status, 'PENDING_APPROVAL', 'never approved automatically');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v AND plan_status = 'APPROVED'", { v: voyageId }))[0].n, 0);
  // BR-1 and the open-plan rule.
  const again = await call('POST', `/berth-plans/${plan.id}/submit`, { headers: ifMatch(2) });
  assert.deepEqual([again.status, again.body.error.details.rule], [409, 'NOT_DRAFT']);
  const second = await call('POST', '/berth-plans', { body: body(voyageId, berth.id) });
  assert.deepEqual([second.status, second.body.error.details.rule], [409, 'VOYAGE_HAS_OPEN_PLAN']);
});

test('UC-029 2a / AC-3: a rule that fails at submission without an override refuses it; with an override reason it is accepted and recorded; MISSING data never', { skip }, async () => {
  const { plan, berth } = await draft();
  // Maintenance is added after the draft was saved.
  const m = await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) OUTPUT inserted.id VALUES (@b, @f, @t, 'ACTIVE', N'Nạo vét', N'test')`, { b: berth.id, f: new Date(H(19)), t: new Date(H(23)) });
  const refused = await call('POST', `/berth-plans/${plan.id}/submit`, { headers: ifMatch(1) });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details.rule], [409, 'BUSINESS_RULE_VIOLATION', 'CONSTRAINT_VIOLATION']);
  assert.equal(refused.body.error.details.check.rules.find((r) => r.id === 'MAINTENANCE').outcome, 'VIOLATION');
  const after = await planRow(plan.id);
  assert.deepEqual([after.plan_status, after.revision], ['DRAFT', 1], 'the plan stays a draft');
  assert.equal((await audits('BERTH_PLAN_SUBMIT', plan.id))[0].outcome, 'FAILED', 'the refusal is audited');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @i", { i: plan.id }))[0].n, 0);
  const ok = await call('POST', `/berth-plans/${plan.id}/submit`, { body: { override_reason: 'Bảo trì sẽ kết thúc sớm, đã xác nhận với đội kỹ thuật' }, headers: ifMatch(1) });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.plan_status, ok.body.data.check.passed, ok.body.data.check.outcome, ok.body.data.override_rules, ok.body.data.override_by_user_id], ['PENDING_APPROVAL', false, 'VIOLATION', ['MAINTENANCE'], coordId]);
  const row = await planRow(plan.id);
  assert.deepEqual([row.passed, row.outcome, row.override_reason], ['false', 'VIOLATION', 'Bảo trì sẽ kết thúc sớm, đã xác nhận với đội kỹ thuật']);
  const [ov] = await audits('BERTH_PLAN_OVERRIDE', plan.id);
  assert.equal(ov.reason, 'Bảo trì sẽ kết thúc sớm, đã xác nhận với đội kỹ thuật');
  const note = await q("SELECT body FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @i", { i: plan.id });
  assert.match(note[0].body, /ghi đè/, 'management is told that the plan carries an override');
  void m;
  // Data that became incomplete after the draft: the submission refuses, whatever the reason says.
  const d2 = await draft(); await q('UPDATE dbo.voyages SET cargo_hazard = NULL, cargo_hazard_basis = NULL, cargo_hazard_verified_by_user_id = NULL, cargo_hazard_verified_at = NULL WHERE id = @v', { v: d2.voyageId });
  const r2 = await call('POST', `/berth-plans/${d2.plan.id}/submit`, { body: { override_reason: 'vẫn gửi' }, headers: ifMatch(1) });
  assert.deepEqual([r2.status, r2.body.error.details.rule], [409, 'INSUFFICIENT_DATA']);
});

test('UC-029: an override saved with the draft is dropped when the placement passes again; stale revisions and wrong roles are refused', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  const m = (await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) OUTPUT inserted.id VALUES (@b, @f, @t, 'ACTIVE', N'x', N'test')`, { b: b.id, f: new Date(H(19)), t: new Date(H(23)) }))[0].id;
  const d = await call('POST', '/berth-plans', { body: { ...body(v, b.id), override_reason: 'chấp nhận tạm' } });
  assert.equal(d.status, 201);
  await q("UPDATE dbo.berth_maintenance SET status = 'CANCELLED' WHERE id = @i", { i: m });
  const sub = await call('POST', `/berth-plans/${d.body.data.id}/submit`, { headers: ifMatch(1) });
  assert.equal(sub.status, 200);
  assert.deepEqual([sub.body.data.check.passed, sub.body.data.override_reason, sub.body.data.override_by_user_id], [true, null, null]);
  const e = await draft();
  for (const who of ['manager', 'yard', 'agentA', 'tech']) assert.equal((await call('POST', `/berth-plans/${e.plan.id}/submit`, { who, headers: ifMatch(1) })).status, 403, who);
  assert.equal((await call('POST', `/berth-plans/${e.plan.id}/submit`, {})).status, 400, 'If-Match is required');
  const stale = await call('POST', `/berth-plans/${e.plan.id}/submit`, { headers: ifMatch(7) });
  assert.deepEqual([stale.status, stale.body.error.details.current_revision], [409, 1]);
  assert.equal((await call('POST', '/berth-plans/999999999/submit', { headers: ifMatch(1) })).status, 404);
  assert.equal((await planRow(e.plan.id)).plan_status, 'DRAFT');
});

test('UC-029: a placement that overlaps an approved plan cannot be submitted silently, and the approved plan is untouched', { skip }, async () => {
  const b = await newBerth(); const other = await voyage();
  const approvedId = (await insertPlan(other, b.id, 'APPROVED', { start: 100, end: 350, approved: managerId }))[0].id;
  const before = await planRow(approvedId);
  const { plan } = await draft({ berth: b, placement: { position_start_m: 0, position_end_m: 260 } }).catch(() => ({ plan: null }));
  assert.equal(plan, null, 'the draft itself is already warned (UC-028 3a)');
  const v = await voyage();
  const forced = await call('POST', '/berth-plans', { body: { ...body(v, b.id), override_reason: 'cần gấp' } });
  assert.equal(forced.status, 201);
  assert.deepEqual(forced.body.data.override_rules.sort(), ['OVERLAP']);
  const sub = await call('POST', `/berth-plans/${forced.body.data.id}/submit`, { headers: ifMatch(1) });
  assert.equal(sub.status, 200, 'with the stored override reason the submission is accepted and recorded');
  assert.equal(sub.body.data.check.passed, false);
  assert.deepEqual(await planRow(approvedId), before, 'the approved plan is not touched');
  const clean = await voyage();
  const refused = await call('POST', '/berth-plans', { body: body(clean, b.id) });
  assert.equal(refused.body.error.details.check.rules.find((r) => r.id === 'OVERLAP').outcome, 'VIOLATION');
});

// ---------------------------------------------------------------- concurrency
test('concurrency: simultaneous drafts for one voyage give one draft; simultaneous submissions of overlapping plans let only one pass', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  const rs = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/berth-plans', { body: body(v, b.id) })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v AND plan_status = 'DRAFT'", { v }))[0].n, 1);

  const v1 = await voyage(); const v2 = await voyage(); const shared = await newBerth();
  const d1 = await call('POST', '/berth-plans', { body: body(v1, shared.id) });
  const d2 = await call('POST', '/berth-plans', { body: body(v2, shared.id) });   // drafts reserve nothing, so both exist
  assert.deepEqual([d1.status, d2.status], [201, 201]);
  const subs = await Promise.all([call('POST', `/berth-plans/${d1.body.data.id}/submit`, { headers: ifMatch(1) }), call('POST', `/berth-plans/${d2.body.data.id}/submit`, { headers: ifMatch(1) })]);
  assert.deepEqual(subs.map((r) => r.status).sort(), [200, 409]);
  const loser = subs.find((r) => r.status === 409);
  assert.equal(loser.body.error.details.rule, 'CONSTRAINT_VIOLATION');
  assert.equal(loser.body.error.details.check.rules.find((r) => r.id === 'OVERLAP').outcome, 'VIOLATION');
  const states = (await q("SELECT plan_status FROM dbo.berth_plans WHERE berth_id = @b ORDER BY plan_status", { b: shared.id })).map((r) => r.plan_status);
  assert.deepEqual(states, ['DRAFT', 'PENDING_APPROVAL']);

  const d3 = await draft();
  const twice = await Promise.all([1, 2, 3].map(() => call('POST', `/berth-plans/${d3.plan.id}/submit`, { headers: ifMatch(1) })));
  assert.deepEqual(twice.map((r) => r.status).sort(), [200, 409, 409], 'one submission of the same draft');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @i", { i: d3.plan.id }))[0].n, 1, 'one notice');
  const d4 = await draft();
  const edits = await Promise.all([1, 2, 3].map(() => call('PUT', `/berth-plans/${d4.plan.id}`, { body: body(d4.voyageId, d4.berth.id), headers: ifMatch(1) })));
  assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409, 409], 'the revision decides between simultaneous edits');
});

// ---------------------------------------------------------------- database safeguards
test('database safeguards: a submitted plan needs a pass or a valid override; override columns are all-or-nothing; no self-approval; one draft per voyage', { skip }, async () => {
  const b = await newBerth();
  const fails = async (fn, name) => { await assert.rejects(fn, (e) => { assert.match(String(e.message), new RegExp(name), e.message); return true; }); };
  const v1 = await voyage();
  const bare = (voyageId, status, json, extra = '') => q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json, submitted_by_user_id, submitted_at ${extra ? ', ' + extra.cols : ''})
    VALUES (@v, @b, @st, 'MANUAL', 0, 100, '2032-02-01T00:00:00Z', '2032-02-01T10:00:00Z', 1, 15, N'T', @j, @u, SYSUTCDATETIME() ${extra ? ', ' + extra.vals : ''})`, { v: voyageId, b: b.id, st: status, j: json, u: coordId });
  await fails(() => bare(v1, 'PENDING_APPROVAL', '{"passed":false,"outcome":"VIOLATION"}'), 'CK_bp_reviewed');                                   // failed check, no override
  await fails(() => bare(v1, 'PENDING_APPROVAL', '{"passed":false,"outcome":"MISSING_DATA"}', { cols: "override_reason, override_by_user_id, override_at, override_rules", vals: "N'x', 1, SYSUTCDATETIME(), N'[\"X\"]'" }), 'CK_bp_reviewed'); // override cannot cover missing data
  await fails(() => bare(v1, 'DRAFT', '{"passed":false,"outcome":"VIOLATION"}', { cols: 'override_reason', vals: "N'x'" }), 'CK_bp_override_set');                // reason without who/when/rules
  await fails(() => bare(v1, 'DRAFT', '{"passed":false,"outcome":"VIOLATION"}', { cols: 'override_by_user_id', vals: '1' }), 'CK_bp_override_set');                  // who without a reason
  await bare(v1, 'PENDING_APPROVAL', '{"passed":false,"outcome":"VIOLATION"}', { cols: "override_reason, override_by_user_id, override_at, override_rules", vals: "N'x', 1, SYSUTCDATETIME(), N'[\"X\"]'" }); // a valid override is accepted
  const v2 = await voyage();
  await bare(v2, 'DRAFT', '{"passed":true,"outcome":"PASS"}');
  await fails(() => bare(v2, 'DRAFT', '{"passed":true,"outcome":"PASS"}'), 'UX_bp_draft_per_voyage');
  const v3 = await voyage();
  await fails(() => insertPlan(v3, b.id, 'APPROVED', { submitted: coordId, approved: coordId }), 'CK_bp_no_self_approval');
  const ok = await insertPlan(v3, b.id, 'APPROVED', { start: 400, end: 500, submitted: coordId, approved: managerId });
  assert.ok(ok[0].id, 'a different approver is accepted');
});

test('what UC-028/029 must not do: drafting and submitting never approve; a draft cannot be approved; no status can be set directly', { skip }, async () => {
  const { plan } = await draft();
  const approve = await call('POST', `/berth-plans/${plan.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(1) });
  assert.deepEqual([approve.status, approve.body.error.details.rule, approve.body.error.details.plan_status], [409, 'NOT_PENDING', 'DRAFT'], 'approval (UC-030) only accepts a submitted plan');
  assert.equal((await call('PATCH', `/berth-plans/${plan.id}`, { body: { plan_status: 'APPROVED' }, headers: ifMatch(1) })).status, 404, 'no way to set a status directly');
  assert.equal((await planRow(plan.id)).plan_status, 'DRAFT');
});
