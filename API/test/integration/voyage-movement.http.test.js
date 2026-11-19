'use strict';

// HTTP integration tests for UC-022 (confirm berthing) and UC-023 (confirm departure), driven from plans made and approved through the real API (no hand-made plan rows)
// on real SQL Server. Plans are created through the real API (draft, submit); only the voyages waiting in the queue are inserted. Runs only with SP_TEST_DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: approval integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const CODE = (n) => `M${SUFFIX}${n}`;

let db; let server; let base; let agentA; let portId; let typeId; let shipId; let coordId; let managerId;
const cookies = {}; const usernames = [];
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const H = (h, day = 0) => new Date(Date.UTC(2033, 0, 10 + day, h)).toISOString();

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'MA_${SUFFIX}', N'Đại lý AA ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'MP${SUFFIX}', N'Cảng AP ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const defs = { coord: [['DIEU_PHOI_VIEN']], dual: [['DIEU_PHOI_VIEN', 'BAN_QUAN_LY']], manager: [['BAN_QUAN_LY']], manager2: [['BAN_QUAN_LY']],
    yard: [['NHAN_VIEN_KHO_BAI']], agentUser: [['DAI_LY_HANG_HAI'], agentA], tech: [['KY_THUAT_VIEN']] };
  for (const [key, [roles, agentId]] of Object.entries(defs)) {
    const username = `t_m_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: roles, agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  const idOf = async (key) => Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: `t_m_${key}_${SUFFIX}` }))[0].user_id);
  coordId = await idOf('coord'); managerId = await idOf('manager');
  shipId = await mk('ships', 'ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t', `'MC${SUFFIX}', '1${String(100000 + Math.floor(Math.random() * 800000))}', N'Approve ${SUFFIX}', ${typeId}, 250, 32, 10, 60000`);
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id = ${shipId}`;
  const ownBerths = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'M${SUFFIX}%'`;
  const ownPlans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${ownBerths})`;
  await q(`DELETE FROM dbo.notifications WHERE (entity_type = 'BERTH_PLAN' AND entity_id IN (${ownPlans})) OR recipient_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 't_m_%_${SUFFIX}');
           DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${ownPlans});
           DELETE FROM dbo.berth_plans WHERE id IN (${ownPlans});
           DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${ownBerths});
           DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine});
           UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id = ${shipId};
           DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.ship_documents WHERE ship_id = ${shipId};
           DELETE FROM dbo.voyages WHERE ship_id = ${shipId}; DELETE FROM dbo.ships WHERE id = ${shipId};
           DELETE FROM dbo.berths WHERE berth_code LIKE 'M${SUFFIX}%';`);
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
const ifMatch = (rev) => ({ 'If-Match': `"${rev}"` });
let n = 0;
const newBerth = async (over = {}) => { n += 1; const r = await call('POST', '/berths', { body: { berth_code: CODE(n), berth_type: 'CONTAINER', length_m: 600, max_depth_m: 12, available_cranes: 3, allows_dangerous: false, ...over } }); assert.equal(r.status, 201); return r.body.data; };
// Voyages waiting in the queue get consecutive positions after the current end of the queue, so the queue stays 1..n and gaps are visible.
async function voyage(over = {}) {
  n += 1;
  const next = Number((await q("SELECT ISNULL(MAX(queue_position), 0) + 1 AS p FROM dbo.voyages WHERE status = 'WAITING_BERTH'"))[0].p);
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at,
      validation_result, validated_at, validation_policy_version, cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, '2033-01-10', 1, N'x', @pos, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1', 'NONE', N'fixture', @u, SYSUTCDATETIME())`,
  { s: shipId, c: `MV-${n}-${SUFFIX}`, a: agentA, p: portId, pos: over.pos || next, u: coordId }))[0].id;
}
const placement = (voyageId, berthId, over = {}) => ({ voyage_id: voyageId, berth_id: berthId, position_start_m: 0, position_end_m: 260, planned_start: H(8), planned_end: H(20), required_cranes: 2, ...over });
// The real flow: draft, then submit. Returns the pending plan.
async function pending({ berth, voyageId, over } = {}) {
  const b = berth || await newBerth(); const v = voyageId || await voyage();
  const d = await call('POST', '/berth-plans', { body: placement(v, b.id, over) });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await call('POST', `/berth-plans/${d.body.data.id}/submit`, { headers: ifMatch(1) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { plan: s.body.data, berth: b, voyageId: v };
}
// A voyage made BERTH_ASSIGNED by the real approval (UC-030) by another account.
async function assigned(opts = {}) {
  const p = await pending(opts);
  const a = await call('POST', `/berth-plans/${p.plan.id}/approve`, { who: 'manager', body: { confirm: true }, headers: ifMatch(p.plan.revision) });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return { ...p, planId: p.plan.id };
}
const voyageRow = async (id) => { const r = (await q('SELECT status, queue_position, revision, ata, atd FROM dbo.voyages WHERE id = @i', { i: id }))[0]; return { ...r, revision: Number(r.revision) }; };
const planRow = async (id) => (await q('SELECT plan_status, revision FROM dbo.berth_plans WHERE id = @i', { i: id }))[0];
const onBerth = (ctx, over = {}) => ({ berth_id: ctx.berth.id, ...over });
const berthing = async (ctx, body, who = 'coord', rev) => call('POST', `/voyages/${ctx.voyageId}/berthing`, { who, body: body === undefined ? onBerth(ctx) : body, headers: ifMatch(rev ?? (await voyageRow(ctx.voyageId)).revision) });
const departure = async (ctx, body = {}, who = 'coord', rev) => call('POST', `/voyages/${ctx.voyageId}/departure`, { who, body, headers: ifMatch(rev ?? (await voyageRow(ctx.voyageId)).revision) });
const stateOf = async (b) => (await call('GET', '/berths/status')).body.data.items.find((x) => x.id === b.id);
const audits = (action, id) => q('SELECT outcome, reason, old_json, new_json FROM dbo.audit_events WHERE action = @a AND entity_id = @e ORDER BY id', { a: action, e: String(id) });
const hist = async (id) => (await q('SELECT from_status, to_status FROM dbo.voyage_status_history WHERE voyage_id = @i ORDER BY id', { i: id })).map((h) => `${h.from_status}>${h.to_status}`);
const count = async (text, params) => (await q(text, params))[0].n;

test('UC-022 main flow: a plan approved by another account, then berthing: BERTHED with ATA and actor, berth in use, schedule shows the actual time, history and audit written', { skip }, async () => {
  const ctx = await assigned();
  assert.equal((await voyageRow(ctx.voyageId)).status, 'BERTH_ASSIGNED');
  assert.equal((await stateOf(ctx.berth)).state, 'RESERVED', 'before berthing the berth is reserved, not in use');
  const before = Date.now();
  const r = await berthing(ctx);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.status, r.body.data.ata_edited], ['BERTHED', false]);
  const row = await voyageRow(ctx.voyageId);
  assert.equal(r.body.data.revision, row.revision);
  assert.ok(Math.abs(new Date(row.ata).getTime() - before) < 10000, 'ATA defaults to now');
  assert.deepEqual([row.status, row.queue_position, row.atd], ['BERTHED', null, null]);
  assert.equal((await planRow(ctx.planId)).plan_status, 'APPROVED', 'the approved plan is kept');
  const st = await stateOf(ctx.berth);
  assert.deepEqual([st.state, st.current_plan.voyage_status], ['IN_USE', 'BERTHED'], 'planned for 2033 but the vessel is physically there: in use');
  const sch = (await call('GET', '/voyages/schedule?status=BERTHED&size=100')).body.data.items.find((i) => i.id === ctx.voyageId);
  assert.deepEqual([sch.bar_source, sch.berth_id], ['ACTUAL', ctx.berth.id]);
  assert.deepEqual(await hist(ctx.voyageId), ['WAITING_BERTH>BERTH_ASSIGNED', 'BERTH_ASSIGNED>BERTHED']);
  assert.equal((await q('SELECT TOP 1 actor FROM dbo.voyage_status_history WHERE voyage_id = @i ORDER BY id DESC', { i: ctx.voyageId }))[0].actor, `t_m_coord_${SUFFIX}`);
  const [a] = await audits('VOYAGE_BERTHING', ctx.voyageId);
  assert.deepEqual([a.outcome, JSON.parse(a.new_json).status, JSON.parse(a.old_json).status], ['SUCCESS', 'BERTHED', 'BERTH_ASSIGNED']);
  assert.equal((await call('GET', '/voyages/queue')).body.data.items.some((e) => e.voyage_id === ctx.voyageId), false);
});

test('UC-022 request checks, 2a, 4a and state: validation, edited time needs a reason, wrong berth, wrong state, stale and duplicate requests, permissions', { skip }, async () => {
  const ctx = await assigned();
  const other = await newBerth();
  const bad = async (body) => { const r = await berthing(ctx, body); assert.equal(r.status, 400, JSON.stringify(body)); return r.body.error.details.map((d) => d.field); };
  assert.ok((await bad({})).includes('berth_id'));
  assert.ok((await bad({ berth_id: 'x' })).includes('berth_id'));
  assert.ok((await bad(onBerth(ctx, { extra: 1 }))).includes('extra'));
  assert.ok((await bad(onBerth(ctx, { actual_time: 'yesterday' }))).includes('actual_time'));
  assert.ok((await bad(onBerth(ctx, { actual_time: new Date(Date.now() + 3600e3).toISOString() }))).includes('actual_time'), 'future time refused');
  assert.ok((await bad(onBerth(ctx, { actual_time: new Date(Date.now() - 3600e3).toISOString() }))).includes('reason'), '2a: edited time needs a reason');
  assert.ok((await bad(onBerth(ctx, { reason: '   ' }))).includes('reason'));
  assert.equal((await call('POST', `/voyages/${ctx.voyageId}/berthing`, { body: onBerth(ctx) })).status, 400, 'If-Match is required');
  assert.equal((await call('POST', `/voyages/${ctx.voyageId}/berthing`, { who: null, body: onBerth(ctx), headers: ifMatch(1) })).status, 401);
  assert.equal((await call('POST', '/voyages/999999999/berthing', { body: onBerth(ctx), headers: ifMatch(1) })).status, 404);
  for (const who of ['manager', 'yard', 'agentUser', 'tech']) assert.equal((await berthing(ctx, undefined, who)).status, 403, who);
  assert.ok(await count("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'VOYAGE_BERTHING' AND outcome = 'DENIED' AND actor LIKE @a", { a: `t_m_%_${SUFFIX}` }) >= 4);
  const wrong = await berthing(ctx, { berth_id: other.id });
  assert.deepEqual([wrong.status, wrong.body.error.code, wrong.body.error.details.rule], [409, 'BUSINESS_RULE_VIOLATION', 'WRONG_BERTH']);
  const stale = await berthing(ctx, undefined, 'coord', 1);
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.current_revision, (await voyageRow(ctx.voyageId)).revision);
  assert.equal((await voyageRow(ctx.voyageId)).status, 'BERTH_ASSIGNED', 'every refusal left the voyage unchanged');
  const waiting = { voyageId: await voyage(), berth: other };
  const w = await berthing(waiting);
  assert.deepEqual([w.status, w.body.error.details.rule, w.body.error.details.voyage_status], [409, 'NOT_BERTH_ASSIGNED', 'WAITING_BERTH'], 'a waiting voyage has no approved plan');
  const earlier = new Date(Date.now() - 3600e3).toISOString();
  const ok = await berthing(ctx, onBerth(ctx, { actual_time: earlier, reason: 'Tàu đã cập từ trước, nhập bổ sung' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.ata_edited, true);
  assert.equal(new Date((await voyageRow(ctx.voyageId)).ata).toISOString(), earlier);
  assert.match((await audits('VOYAGE_BERTHING', ctx.voyageId)).at(-1).reason, /nhập bổ sung/);
  const dup = await berthing(ctx);
  assert.deepEqual([dup.status, dup.body.error.details.rule], [409, 'NOT_BERTH_ASSIGNED'], 'a second confirmation is refused');
  assert.equal(await count("SELECT COUNT(*) AS n FROM dbo.voyage_status_history WHERE voyage_id = @i AND to_status = 'BERTHED'", { i: ctx.voyageId }), 1);
});

test('UC-022: an occupied stretch refuses a second vessel; three simultaneous confirmations give exactly one', { skip }, async () => {
  const b = await newBerth();
  const first = await assigned({ berth: b });
  const second = await assigned({ berth: b, over: { planned_start: H(8, 3), planned_end: H(20, 3) } });
  assert.equal((await berthing(first)).status, 200);
  const occ = await berthing(second);
  assert.deepEqual([occ.status, occ.body.error.details.rule], [409, 'BERTH_OCCUPIED'], 'the berth is physically occupied');
  const lone = await assigned();
  const rev = (await voyageRow(lone.voyageId)).revision;
  const rs = await Promise.all([berthing(lone, undefined, 'coord', rev), berthing(lone, undefined, 'dual', rev), berthing(lone, undefined, 'coord', rev)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dbo.voyage_status_history WHERE voyage_id = @i AND to_status = 'BERTHED'", { i: lone.voyageId }), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'VOYAGE_BERTHING' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(lone.voyageId) }), 1);
});

test('UC-023 main flow: departure sets DEPARTED with ATD and actor, completes the plan, frees the berth, keeps all history', { skip }, async () => {
  const ctx = await assigned();
  assert.equal((await berthing(ctx)).status, 200);
  assert.equal((await stateOf(ctx.berth)).state, 'IN_USE');
  const r = await departure(ctx);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.status, r.body.data.atd_edited], ['DEPARTED', false]);
  const row = await voyageRow(ctx.voyageId);
  assert.equal(row.status, 'DEPARTED'); assert.ok(row.atd && row.ata && new Date(row.atd) >= new Date(row.ata));
  assert.equal((await planRow(ctx.planId)).plan_status, 'COMPLETED', 'the plan is completed, not deleted');
  assert.equal((await stateOf(ctx.berth)).state, 'AVAILABLE', 'the berth is free');
  assert.deepEqual(await hist(ctx.voyageId), ['WAITING_BERTH>BERTH_ASSIGNED', 'BERTH_ASSIGNED>BERTHED', 'BERTHED>DEPARTED']);
  const ph = (await call('GET', `/berth-plans/${ctx.planId}`)).body.data.history.map((h) => `${h.from_status}>${h.to_status}`);
  assert.deepEqual(ph, ['null>DRAFT', 'DRAFT>PENDING_APPROVAL', 'PENDING_APPROVAL>APPROVED', 'APPROVED>COMPLETED']);
  const [a] = await audits('VOYAGE_DEPARTURE', ctx.voyageId);
  assert.deepEqual([a.outcome, JSON.parse(a.new_json).plan_status], ['SUCCESS', 'COMPLETED']);
  const sch = (await call('GET', '/voyages/schedule?status=DEPARTED&size=100')).body.data.items.find((i) => i.id === ctx.voyageId);
  assert.deepEqual([sch.bar_source, sch.berth_id], ['ACTUAL', ctx.berth.id], 'the schedule still shows the berth and the actual times');
  // The same stretch and period can be planned and approved for another vessel now (a completed plan holds the berth only until ATD).
  const again = await assigned({ berth: ctx.berth, over: { planned_start: H(10), planned_end: H(18) } });
  assert.equal((await voyageRow(again.voyageId)).status, 'BERTH_ASSIGNED');
  assert.equal(await count("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE berth_id = @b AND plan_status = 'COMPLETED'", { b: ctx.berth.id }), 1, 'history is kept');
});

test('UC-023 checks: only a berthed voyage departs; ATD not before ATA or in the future; edited time needs a reason; stale, duplicate, concurrent; permissions', { skip }, async () => {
  const wait = await assigned();
  const early = await departure(wait);
  assert.deepEqual([early.status, early.body.error.details.rule, early.body.error.details.voyage_status], [409, 'NOT_BERTHED', 'BERTH_ASSIGNED']);
  const ctx = await assigned();
  const ataAt = new Date(Date.now() - 2 * 3600e3).toISOString();
  assert.equal((await berthing(ctx, onBerth(ctx, { actual_time: ataAt, reason: 'nhập bổ sung' }))).status, 200);
  const badBody = async (body) => { const r = await departure(ctx, body); assert.equal(r.status, 400, JSON.stringify(body)); return r.body.error.details.map((d) => d.field); };
  assert.ok((await badBody({ actual_time: new Date(Date.now() + 3600e3).toISOString() })).includes('actual_time'));
  assert.ok((await badBody({ extra: 1 })).includes('extra'));
  assert.ok((await badBody({ actual_time: new Date(Date.now() - 3600e3).toISOString() })).includes('reason'), '3a: edited time needs a reason');
  assert.equal((await call('POST', `/voyages/${ctx.voyageId}/departure`, { body: {} })).status, 400, 'If-Match is required');
  assert.equal((await call('POST', `/voyages/${ctx.voyageId}/departure`, { who: null, body: {}, headers: ifMatch(1) })).status, 401);
  assert.equal((await call('POST', '/voyages/999999999/departure', { body: {}, headers: ifMatch(1) })).status, 404);
  for (const who of ['manager', 'yard', 'agentUser', 'tech']) assert.equal((await departure(ctx, {}, who)).status, 403, who);
  const before = await departure(ctx, { actual_time: new Date(Date.parse(ataAt) - 3600e3).toISOString(), reason: 'thử' });
  assert.deepEqual([before.status, before.body.error.details.rule], [409, 'ATD_BEFORE_ATA'], 'ATD before ATA refused');
  assert.equal((await departure(ctx, {}, 'coord', 1)).status, 409, 'stale revision');
  assert.deepEqual([(await voyageRow(ctx.voyageId)).status, (await planRow(ctx.planId)).plan_status], ['BERTHED', 'APPROVED'], 'refusals changed nothing');
  const rev = (await voyageRow(ctx.voyageId)).revision;
  const rs = await Promise.all([departure(ctx, {}, 'coord', rev), departure(ctx, {}, 'dual', rev), departure(ctx, {}, 'coord', rev)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dbo.voyage_status_history WHERE voyage_id = @i AND to_status = 'DEPARTED'", { i: ctx.voyageId }), 1);
  const dup = await departure(ctx);
  assert.deepEqual([dup.status, dup.body.error.details.rule], [409, 'NOT_BERTHED'], 'a second departure is refused');
  const edit = await assigned();
  assert.equal((await berthing(edit, onBerth(edit, { actual_time: ataAt, reason: 'nhập bổ sung' }))).status, 200);
  const ok = await departure(edit, { actual_time: new Date(Date.now() - 3600e3).toISOString(), reason: 'Nhập bổ sung giờ rời' });
  assert.deepEqual([ok.status, ok.body.data.atd_edited], [200, true], JSON.stringify(ok.body));
});

test('UC-023 berth availability: after departure the berth shows the next approved plan or maintenance, never "in use"', { skip }, async () => {
  const b = await newBerth();
  const first = await assigned({ berth: b });
  const next = await assigned({ berth: b, over: { planned_start: H(8, 5), planned_end: H(20, 5) } });
  assert.equal((await berthing(first)).status, 200);
  assert.equal((await departure(first)).status, 200);
  const st = await stateOf(b);
  assert.deepEqual([st.state, st.current_plan, Number(st.next_plan.plan_id)], ['RESERVED', null, next.planId], 'another approved assignment keeps the berth reserved');
  await q("INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, reason, status, created_by) VALUES (@b, DATEADD(HOUR, -1, SYSUTCDATETIME()), DATEADD(HOUR, 5, SYSUTCDATETIME()), N'bảo trì thử', 'ACTIVE', N'test')", { b: b.id });
  assert.equal((await stateOf(b)).state, 'MAINTENANCE', 'a maintenance window wins over a reservation');
});

test('end to end through the real API only: notice, automatic validation and queue, plan, submit, approve by another account, berthing, departure; then berth, schedule, history, audit', { skip }, async () => {
  const b = await newBerth();
  const code = `E${SUFFIX}${Date.now() % 100000}`;
  for (const type of ['REGISTRATION', 'INSURANCE']) {
    await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
             VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2030-01-01', @u, SYSUTCDATETIME())`, { s: shipId, t: type, k: crypto.randomBytes(8).toString('hex'), u: coordId });
  }
  const created = await call('POST', '/voyages', { body: { ship_id: shipId, voyage_code: code, agent_id: agentA, origin_port_id: portId, declared_eta: new Date(Date.now() + 2 * 86400e3).toISOString(), declared_teu: 100, cargo_type: 'Container' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.status, 'WAITING_BERTH');
  assert.equal((await call('PUT', `/voyages/${id}/cargo-hazard`, { body: { cargo_hazard: 'NONE', basis: 'Bảng kê hàng hóa đã đối chiếu' } })).status, 200);
  const ctx = await assigned({ berth: b, voyageId: id });
  assert.equal((await voyageRow(id)).status, 'BERTH_ASSIGNED');
  assert.equal((await departure(ctx)).status, 409, 'cannot depart before berthing');
  assert.equal((await berthing(ctx)).status, 200);
  assert.equal((await departure(ctx)).status, 200);
  assert.deepEqual(await hist(id), ['null>ANNOUNCED', 'ANNOUNCED>VALIDATED', 'VALIDATED>WAITING_BERTH', 'WAITING_BERTH>BERTH_ASSIGNED', 'BERTH_ASSIGNED>BERTHED', 'BERTHED>DEPARTED']);
  assert.equal((await stateOf(b)).state, 'AVAILABLE');
  const v = (await call('GET', `/voyages/${id}`)).body.data;
  assert.equal(v.status, 'DEPARTED');
  const sch = (await call('GET', '/voyages/schedule?status=DEPARTED&size=100')).body.data.items.find((i) => i.id === id);
  assert.deepEqual([sch.bar_source, sch.berth_id], ['ACTUAL', b.id]);
  for (const action of ['BERTH_PLAN_APPROVE', 'VOYAGE_BERTHING', 'VOYAGE_DEPARTURE']) assert.equal((await audits(action, action === 'BERTH_PLAN_APPROVE' ? ctx.planId : id)).filter((a) => a.outcome === 'SUCCESS').length, 1, action);
});
