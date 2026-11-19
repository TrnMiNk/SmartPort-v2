'use strict';

// HTTP integration tests for UC-030 (approve a berth plan), the notification API (UC-029 AC-2) and the voyage state BERTH_ASSIGNED (decision C-1)
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
const CODE = (n) => `A${SUFFIX}${n}`;

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
  agentA = await mk('agents', 'agent_code, agent_name', `'AA_${SUFFIX}', N'Đại lý AA ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'AP${SUFFIX}', N'Cảng AP ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const defs = { coord: [['DIEU_PHOI_VIEN']], dual: [['DIEU_PHOI_VIEN', 'BAN_QUAN_LY']], manager: [['BAN_QUAN_LY']], manager2: [['BAN_QUAN_LY']],
    yard: [['NHAN_VIEN_KHO_BAI']], agentUser: [['DAI_LY_HANG_HAI'], agentA], tech: [['KY_THUAT_VIEN']] };
  for (const [key, [roles, agentId]] of Object.entries(defs)) {
    const username = `t_a_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: roles, agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  const idOf = async (key) => Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: `t_a_${key}_${SUFFIX}` }))[0].user_id);
  coordId = await idOf('coord'); managerId = await idOf('manager');
  shipId = await mk('ships', 'ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t', `'AC${SUFFIX}', '1${String(100000 + Math.floor(Math.random() * 800000))}', N'Approve ${SUFFIX}', ${typeId}, 250, 32, 10, 60000`);
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id = ${shipId}`;
  const ownBerths = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'A${SUFFIX}%'`;
  const ownPlans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${ownBerths})`;
  await q(`DELETE FROM dbo.notifications WHERE (entity_type = 'BERTH_PLAN' AND entity_id IN (${ownPlans})) OR recipient_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 't_a_%_${SUFFIX}');
           DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${ownPlans});
           DELETE FROM dbo.berth_plans WHERE id IN (${ownPlans});
           DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${ownBerths});
           DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyages WHERE ship_id = ${shipId}; DELETE FROM dbo.ships WHERE id = ${shipId};
           DELETE FROM dbo.berths WHERE berth_code LIKE 'A${SUFFIX}%';`);
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
  { s: shipId, c: `AV-${n}-${SUFFIX}`, a: agentA, p: portId, pos: over.pos || next, u: coordId }))[0].id;
}
const placement = (voyageId, berthId, over = {}) => ({ voyage_id: voyageId, berth_id: berthId, position_start_m: 0, position_end_m: 260, planned_start: H(8), planned_end: H(20), required_cranes: 2, ...over });
// The real flow: draft, then submit. Returns the pending plan.
async function pending({ berth, voyageId, over, overrideReason, who = 'coord' } = {}) {
  const b = berth || await newBerth(); const v = voyageId || await voyage();
  const d = await call('POST', '/berth-plans', { who, body: { ...placement(v, b.id, over), ...(overrideReason ? { override_reason: overrideReason } : {}) } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await call('POST', `/berth-plans/${d.body.data.id}/submit`, { who, headers: ifMatch(1) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { plan: s.body.data, berth: b, voyageId: v };
}
const approve = (id, rev, who = 'manager') => call('POST', `/berth-plans/${id}/approve`, { who, body: { confirm: true }, headers: ifMatch(rev) });
const voyageRow = async (id) => (await q('SELECT status, queue_position, queued_at, revision, ata FROM dbo.voyages WHERE id = @i', { i: id }))[0];
const planRow = async (id) => (await q("SELECT plan_status, revision, approved_by_user_id, submitted_by_user_id, JSON_VALUE(constraint_check_json, '$.passed') AS passed FROM dbo.berth_plans WHERE id = @i", { i: id }))[0];
const audits = (action, id) => q('SELECT outcome, reason, old_json, new_json FROM dbo.audit_events WHERE action = @a AND entity_id = @e ORDER BY id', { a: action, e: String(id) });
const queueIds = async () => (await call('GET', '/voyages/queue')).body.data;

// ---------------------------------------------------------------- notifications (UC-029 AC-2)
test('notifications: a submitted plan reaches the port management role and only those who may see it; read marks work; nobody else can read or mark them', { skip }, async () => {
  const { plan } = await pending();
  const mine = (r) => r.body.data.items.filter((x) => x.entity_type === 'BERTH_PLAN' && x.entity_id === plan.id);
  for (const who of ['manager', 'manager2', 'dual']) {
    const r = await call('GET', '/notifications?unread=true&size=100', { who });
    assert.equal(r.status, 200, who);
    assert.equal(mine(r).length, 1, `${who} sees the notice of the plan`);
    assert.equal(mine(r)[0].read_at, null);
    assert.ok(r.body.data.unread >= 1);
  }
  assert.match(mine(await call('GET', '/notifications?size=100', { who: 'manager' }))[0].body, new RegExp(CODE(1)));
  for (const who of ['coord', 'yard', 'agentUser', 'tech']) assert.equal(mine(await call('GET', '/notifications?size=100', { who })).length, 0, `${who} does not see it`);
  assert.equal((await call('GET', '/notifications', { who: null })).status, 401);
  const id = mine(await call('GET', '/notifications?size=100', { who: 'manager' }))[0].id;
  assert.equal((await call('POST', `/notifications/${id}/read`, { who: 'coord' })).status, 404, 'a notice not addressed to the user is not disclosed');
  assert.equal((await call('POST', `/notifications/${id}/read`, { who: 'agentUser' })).status, 404);
  const read = await call('POST', `/notifications/${id}/read`, { who: 'manager' });
  assert.deepEqual([read.status, read.body.data.read_at !== null], [200, true]);
  assert.equal(mine(await call('GET', '/notifications?unread=true&size=100', { who: 'manager' })).length, 0, 'no longer unread');
  assert.equal(mine(await call('GET', '/notifications?size=100', { who: 'manager' })).length, 1, 'still listed');
  assert.equal((await call('POST', `/notifications/${id}/read`, { who: 'manager' })).status, 200, 'reading twice is harmless');
  assert.equal((await audits('NOTIFICATION_READ', id)).length, 1, 'one audit row, not two');
  assert.equal((await call('POST', '/notifications/abc/read', { who: 'manager' })).status, 404);
  assert.equal((await call('GET', '/notifications?unread=maybe', { who: 'manager' })).status, 400);
  assert.equal((await call('GET', '/notifications?size=0', { who: 'manager' })).status, 400);
});

// ---------------------------------------------------------------- UC-030 main flow
test('UC-030 main flow: the manager approves; the plan is APPROVED, the voyage BERTH_ASSIGNED and out of the queue, which closes the gap; history, audit and notices follow', { skip }, async () => {
  const b = await newBerth();
  const v1 = await voyage(); const v2 = await voyage(); const v3 = await voyage();
  const pos = async (id) => (await voyageRow(id)).queue_position;
  const [p1, p2, p3] = [await pending({ berth: b, voyageId: v1, over: { position_start_m: 0, position_end_m: 260 } }), await pending({ berth: b, voyageId: v2, over: { position_start_m: 300, position_end_m: 560 } }), await pending({ berth: b, voyageId: v3, over: { position_start_m: 0, position_end_m: 260, planned_start: H(8, 1), planned_end: H(20, 1) } })];
  const before = [await pos(v1), await pos(v2), await pos(v3)];
  assert.deepEqual(before.map((x, i) => x - before[0] - i), [0, 0, 0], 'consecutive positions before');
  const qBefore = await queueIds();
  const r = await approve(p2.plan.id, p2.plan.revision);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const plan = r.body.data;
  assert.deepEqual([plan.plan_status, plan.approved_by_user_id, plan.revision, plan.check.passed, plan.check.outcome], ['APPROVED', managerId, 3, true, 'PASS']);
  assert.ok(plan.approved_at);
  assert.deepEqual(plan.voyage, { id: v2, status: 'BERTH_ASSIGNED', queue_position: null, left_queue_position: before[1] });
  const v = await voyageRow(v2);
  assert.deepEqual([v.status, v.queue_position], ['BERTH_ASSIGNED', null]);
  assert.ok(v.queued_at, 'the time the voyage entered the queue is kept');
  assert.equal(await pos(v1), before[0], 'ahead of it: unchanged');
  assert.equal(await pos(v3), before[2] - 1, 'behind it: moved up by one');
  const q2 = await queueIds();
  assert.equal(q2.items.some((e) => e.voyage_id === v2), false, 'no longer in the active queue');
  assert.equal(q2.items.length, qBefore.items.length - 1);
  assert.deepEqual(q2.items.map((e) => e.position), q2.items.map((_, i) => i + 1), 'positions 1..n without gaps');
  assert.ok(q2.revision > qBefore.revision, 'the queue revision changed, so stale screens reload');
  const [change] = await q("SELECT from_position, to_position, change_type, reason, actor FROM dbo.voyage_queue_changes WHERE voyage_id = @v", { v: v2 });
  assert.deepEqual([change.from_position, change.to_position, change.change_type], [before[1], null, 'LEFT_QUEUE']);
  assert.match(change.reason, /đã được phê duyệt/);
  const vh = await q('SELECT from_status, to_status, actor FROM dbo.voyage_status_history WHERE voyage_id = @v ORDER BY id', { v: v2 });
  assert.deepEqual(vh.map((h) => `${h.from_status}>${h.to_status}`), ['WAITING_BERTH>BERTH_ASSIGNED']);
  assert.equal(vh[0].actor, `t_a_manager_${SUFFIX}`);
  const ph = (await call('GET', `/berth-plans/${p2.plan.id}`)).body.data.history.map((h) => `${h.from_status}>${h.to_status}`);
  assert.deepEqual(ph, ['null>DRAFT', 'DRAFT>PENDING_APPROVAL', 'PENDING_APPROVAL>APPROVED']);
  const [a] = await audits('BERTH_PLAN_APPROVE', p2.plan.id);
  const decision = JSON.parse(a.new_json);
  assert.deepEqual([a.outcome, decision.decision.outcome, decision.decision.policy_version, decision.voyage.to, decision.voyage.left_queue_position], ['SUCCESS', 'PASS', 'UC026-RULES-V2', 'BERTH_ASSIGNED', before[1]]);
  // The others are untouched: a plan awaiting its decision stays so, and the approval did not approve anything else.
  assert.deepEqual([(await planRow(p1.plan.id)).plan_status, (await planRow(p3.plan.id)).plan_status], ['PENDING_APPROVAL', 'PENDING_APPROVAL']);
  // Notices: the submitter and the agent's user are told; other roles are not.
  const notes = async (who) => (await call('GET', '/notifications?size=100', { who })).body.data.items.filter((x) => x.entity_id === p2.plan.id && /xếp bến|phê duyệt/i.test(x.title) && !/chờ phê duyệt/i.test(x.title));
  assert.equal((await notes('coord')).length, 1);
  assert.equal((await notes('agentUser')).length, 1);
  assert.equal((await notes('yard')).length, 0);
  // Approving again, or approving what is no longer pending.
  const again = await approve(p2.plan.id, 3);
  assert.deepEqual([again.status, again.body.error.details.rule, again.body.error.details.plan_status], [409, 'NOT_PENDING', 'APPROVED']);
});

test('UC-030 integration: the approved plan shows in the schedule (UC-021) and the berth state (UC-025); UC-022 can later record the actual berthing', { skip }, async () => {
  const b = await newBerth(); const v = await voyage();
  const now = Date.now(); const h = (x) => new Date(now + x * 3600000).toISOString();
  const p = await pending({ berth: b, voyageId: v, over: { planned_start: h(-1), planned_end: h(5) } });
  const st = async () => (await call('GET', '/berths/status')).body.data.items.find((x) => x.id === b.id);
  assert.equal((await st()).state, 'AVAILABLE', 'a pending plan reserves nothing');
  assert.equal((await approve(p.plan.id, p.plan.revision)).status, 200);
  const s1 = await st();
  assert.deepEqual([s1.state, s1.current_plan.voyage_status], ['RESERVED', 'BERTH_ASSIGNED']);
  assert.match(s1.current_plan.voyage_code, new RegExp(`^AV-\\d+-${SUFFIX}$`));
  const sched = await call('GET', `/voyages/schedule?agent_id=${agentA}&berth_id=${b.id}&size=100`);
  const row = sched.body.data.items.find((x) => x.id === v);
  assert.deepEqual([row.status, row.berth_code, row.bar_source], ['BERTH_ASSIGNED', b.berth_code, 'PLAN']);
  assert.equal((await call('GET', `/voyages/schedule?status=BERTH_ASSIGNED&agent_id=${agentA}&size=100`)).body.data.items.some((x) => x.id === v), true, 'the new state can be filtered');
  const gantt = await call('GET', `/voyages/schedule?view=gantt&from=${h(-3)}&to=${h(8)}&berth_id=${b.id}`);
  assert.deepEqual([gantt.body.data.items.length, gantt.body.data.items[0].status], [1, 'BERTH_ASSIGNED']);
  assert.equal((await queueIds()).items.some((e) => e.voyage_id === v), false);
  // UC-022 later: BERTHED needs an ATA; the database accepts the transition from BERTH_ASSIGNED and refuses it without one.
  await assert.rejects(() => q("UPDATE dbo.voyages SET status = 'BERTHED' WHERE id = @i", { i: v }), /CK_voyages_ata/);
  await q("UPDATE dbo.voyages SET status = 'BERTHED', ata = SYSUTCDATETIME() WHERE id = @i", { i: v });
  assert.equal((await st()).state, 'IN_USE', 'the berth is in use once the voyage is berthed');
});

// ---------------------------------------------------------------- F-1b: the check is repeated now
test('F-1b: approval re-checks everything on current data; a stored pass is never trusted; a blocked plan stays pending, is audited and its submitter is told', { skip }, async () => {
  const cases = [
    ['maintenance added after the submission', async (b) => q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Nạo vét', N'test')`, { b: b.id, f: new Date(H(5)), t: new Date(H(10)) }), 'MAINTENANCE'],
    ['an approved plan of another voyage now overlaps (BR-01)', async (b, c) => { const other = await voyage(); await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at)
      VALUES (@v, @b, 'APPROVED', 'MANUAL', 100, 350, @f, @t, 1, 15, N'TEST', N'{"passed":true,"outcome":"PASS"}', @s, SYSUTCDATETIME(), @a, SYSUTCDATETIME())`, { v: other, b: b.id, f: new Date(H(8)), t: new Date(H(20)), s: coordId, a: managerId + 0 }); }, 'OVERLAP'],
    ['the berth was put out of service', async (b) => call('PATCH', `/berths/${b.id}`, { body: { operational_status: 'OUT_OF_SERVICE' }, headers: ifMatch(1) }), 'BERTH_IN_SERVICE'],
    ['the cargo is now known to be dangerous (BR-03)', async (b, c) => q("UPDATE dbo.voyages SET cargo_hazard = 'DANGEROUS' WHERE id = @v", { v: c.voyageId }), 'DANGEROUS_GOODS'],
    ['the cargo verification was withdrawn', async (b, c) => q('UPDATE dbo.voyages SET cargo_hazard = NULL, cargo_hazard_basis = NULL, cargo_hazard_verified_by_user_id = NULL, cargo_hazard_verified_at = NULL WHERE id = @v', { v: c.voyageId }), 'DANGEROUS_GOODS'],
    ['the ship record lost its draft data', async (b, c) => q('UPDATE dbo.ships SET max_draft_m = 99 WHERE id = (SELECT ship_id FROM dbo.voyages WHERE id = @v)', { v: c.voyageId }), 'DRAFT_FIT'],
  ];
  const draftBefore = (await q('SELECT max_draft_m FROM dbo.ships WHERE id = @s', { s: shipId }))[0].max_draft_m;
  try {
    for (const [name, change, rule] of cases) {
      const ctx = await pending();
      assert.equal(ctx.plan.check.passed, true, `${name}: stored result passed`);
      await change(ctx.berth, ctx);
      const r = await approve(ctx.plan.id, ctx.plan.revision);
      assert.deepEqual([r.status, r.body.error.code, r.body.error.details.rule], [409, 'BUSINESS_RULE_VIOLATION', 'CONSTRAINT_VIOLATION_AT_APPROVAL'], name);
      assert.ok(r.body.error.details.check.rules.some((x) => x.id === rule && x.outcome !== 'PASS'), `${name}: ${rule} reported`);
      assert.deepEqual([(await planRow(ctx.plan.id)).plan_status, (await voyageRow(ctx.voyageId)).status], ['PENDING_APPROVAL', 'WAITING_BERTH'], `${name}: nothing changed`);
      assert.equal((await audits('BERTH_PLAN_APPROVE', ctx.plan.id))[0].outcome, 'FAILED', `${name}: refusal audited`);
      const told = (await call('GET', '/notifications?size=100', { who: 'coord' })).body.data.items.filter((x) => x.entity_id === ctx.plan.id && /Không thể phê duyệt/.test(x.title));
      assert.equal(told.length, 1, `${name}: the submitter is told why`);
      await q('UPDATE dbo.ships SET max_draft_m = @d WHERE id = @s', { d: draftBefore, s: shipId });
    }
  } finally { await q('UPDATE dbo.ships SET max_draft_m = @d WHERE id = @s', { d: draftBefore, s: shipId }); }
});

test('F-1b: plans that only wait for a decision do not block each other; the first approval holds the berth and the other plan is then refused', { skip }, async () => {
  const b = await newBerth();
  const first = await pending({ berth: b, voyageId: await voyage() });                                       // 0-260 m
  const over = await pending({ berth: b, voyageId: await voyage(), over: { position_start_m: 100, position_end_m: 360 }, overrideReason: 'Tàu neo chéo, đã thống nhất' });   // overlaps the first, submitted with an override
  assert.deepEqual([over.plan.check.passed, over.plan.override_rules], [false, ['OVERLAP']]);
  assert.equal((await call('GET', `/berth-plans/${over.plan.id}`)).body.data.check.passed, false, 'passed keeps its meaning while the plan waits');
  // Judged now, against approved plans only, the overridden plan passes, so it can be approved; the stored result becomes the one made now.
  const ok = await approve(over.plan.id, over.plan.revision);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.check.passed, ok.body.data.override_reason], [true, 'Tàu neo chéo, đã thống nhất']);
  assert.equal(JSON.parse((await audits('BERTH_PLAN_APPROVE', over.plan.id))[0].old_json).check.passed, false, 'the earlier failed result stays in the audit trail');
  // Now it holds the berth, and the first plan overlaps an approved one.
  const refused = await approve(first.plan.id, first.plan.revision);
  assert.deepEqual([refused.status, refused.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL']);
  assert.equal(refused.body.error.details.check.rules.find((x) => x.id === 'OVERLAP').outcome, 'VIOLATION');
  assert.deepEqual([(await planRow(first.plan.id)).plan_status, (await voyageRow(first.voyageId)).status], ['PENDING_APPROVAL', 'WAITING_BERTH']);
});

test('F-1b: BR-01 and BR-03 violations are never approved, whatever the override says', { skip }, async () => {
  // BR-01: an overridden plan overlapping an already approved one.
  const b = await newBerth();
  const a = await pending({ berth: b, voyageId: await voyage() });
  assert.equal((await approve(a.plan.id, a.plan.revision)).status, 200);
  const o = await pending({ berth: b, voyageId: await voyage(), over: { position_start_m: 100, position_end_m: 360 }, overrideReason: 'cần gấp' });
  const r1 = await approve(o.plan.id, o.plan.revision);
  assert.deepEqual([r1.status, r1.body.error.details.rule, r1.body.error.details.had_override], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL', true]);
  assert.equal(r1.body.error.details.check.rules.find((x) => x.id === 'OVERLAP').outcome, 'VIOLATION');
  // BR-03: dangerous cargo at a berth without the label, submitted with an override.
  const plain = await newBerth(); const dv = await voyage();
  await call('PUT', `/voyages/${dv}/cargo-hazard`, { body: { cargo_hazard: 'DANGEROUS', basis: 'Danh mục hàng nguy hiểm số 3' } });
  const d = await pending({ berth: plain, voyageId: dv, overrideReason: 'đã có biện pháp an toàn' });
  assert.deepEqual(d.plan.override_rules, ['DANGEROUS_GOODS']);
  const r2 = await approve(d.plan.id, d.plan.revision);
  assert.deepEqual([r2.status, r2.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL']);
  assert.equal((await planRow(d.plan.id)).plan_status, 'PENDING_APPROVAL');
  // Once the cause is gone (the cargo is verified as not dangerous), the same plan can be approved and the decision records that it had an override.
  assert.equal((await call('PUT', `/voyages/${dv}/cargo-hazard`, { body: { cargo_hazard: 'NONE', basis: 'Xác minh lại: danh mục số 3A' } })).status, 200);
  const ok = await approve(d.plan.id, d.plan.revision);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(JSON.parse((await audits('BERTH_PLAN_APPROVE', d.plan.id)).pop().new_json).decision.had_override, true);
  assert.equal((await planRow(d.plan.id)).passed, 'true', 'the stored result is the one made at approval');
});

// ---------------------------------------------------------------- F-4, RBAC, versions
test('F-4: a user cannot approve a plan they submitted, however many times they try at once; the database refuses it too', { skip }, async () => {
  const ctx = await pending({ who: 'dual' });      // submitted by a user who also holds the port management role
  assert.equal(ctx.plan.submitted_by_user_id, Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: `t_a_dual_${SUFFIX}` }))[0].user_id));
  const attempts = await Promise.all([1, 2, 3].map(() => approve(ctx.plan.id, ctx.plan.revision, 'dual')));
  for (const r of attempts) assert.deepEqual([r.status, r.body.error.details.rule], [409, 'SELF_APPROVAL']);
  assert.deepEqual([(await planRow(ctx.plan.id)).plan_status, (await voyageRow(ctx.voyageId)).status], ['PENDING_APPROVAL', 'WAITING_BERTH']);
  assert.equal((await audits('BERTH_PLAN_APPROVE', ctx.plan.id)).filter((a) => a.outcome === 'FAILED' && a.reason === 'SELF_APPROVAL').length, 3, 'every attempt is audited');
  await assert.rejects(() => q("UPDATE dbo.berth_plans SET plan_status = 'APPROVED', approved_by_user_id = submitted_by_user_id, approved_at = SYSUTCDATETIME() WHERE id = @i", { i: ctx.plan.id }), /CK_bp_no_self_approval/);
  assert.equal((await approve(ctx.plan.id, ctx.plan.revision, 'manager')).status, 200, 'another manager can approve it');
});

test('RBAC and request checks: only port management approves; confirmation and revision are required; stale and unknown plans are refused', { skip }, async () => {
  const ctx = await pending();
  for (const who of ['coord', 'yard', 'agentUser', 'tech']) assert.equal((await approve(ctx.plan.id, ctx.plan.revision, who)).status, 403, who);
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/approve`, { who: null, body: { confirm: true }, headers: ifMatch(2) })).status, 401);
  assert.ok((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_PLAN_APPROVE' AND outcome = 'DENIED' AND actor LIKE @a", { a: `t_a_%_${SUFFIX}` }))[0].n >= 4, 'denials are audited');
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/approve`, { who: 'manager', body: {}, headers: ifMatch(2) })).status, 400, 'confirm is required');
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/approve`, { who: 'manager', body: { confirm: false }, headers: ifMatch(2) })).status, 400);
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/approve`, { who: 'manager', body: { confirm: true } })).status, 400, 'If-Match is required');
  const stale = await approve(ctx.plan.id, 1);
  assert.deepEqual([stale.status, stale.body.error.details.current_revision], [409, 2]);
  assert.equal((await approve(999999999, 1)).status, 404);
  assert.deepEqual([(await planRow(ctx.plan.id)).plan_status, (await voyageRow(ctx.voyageId)).status], ['PENDING_APPROVAL', 'WAITING_BERTH'], 'nothing changed by refusals');
  const draft = (await call('POST', '/berth-plans', { body: placement(await voyage(), (await newBerth()).id) })).body.data;
  const nd = await approve(draft.id, draft.revision);
  assert.deepEqual([nd.status, nd.body.error.details.rule, nd.body.error.details.plan_status], [409, 'NOT_PENDING', 'DRAFT']);
  const moved = await voyage(); const mc = await pending({ voyageId: moved });
  await q("UPDATE dbo.voyages SET status = 'VALIDATED', queue_position = NULL WHERE id = @i", { i: moved });
  const nq = await approve(mc.plan.id, mc.plan.revision);
  assert.deepEqual([nq.status, nq.body.error.details.rule], [409, 'VOYAGE_NOT_IN_QUEUE']);
});

test('concurrency: two managers approving the same plan, and two overlapping plans approved at once, give exactly one approval', { skip }, async () => {
  const same = await pending();
  const rs = await Promise.all([approve(same.plan.id, same.plan.revision, 'manager'), approve(same.plan.id, same.plan.revision, 'manager2'), approve(same.plan.id, same.plan.revision, 'dual')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE id = @i AND plan_status = 'APPROVED'", { i: same.plan.id }))[0].n, 1);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: same.voyageId }))[0].n, 1, 'the voyage left the queue once');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_status_history WHERE voyage_id = @v AND to_status = 'BERTH_ASSIGNED'", { v: same.voyageId }))[0].n, 1);
  assert.equal((await call('GET', '/notifications?size=100', { who: 'coord' })).body.data.items.filter((x) => x.entity_id === same.plan.id && /đã được phê duyệt/.test(x.title)).length, 1, 'one notice to the submitter');

  // Overlapping plans on one berth. Plan B overlaps A; B was submitted with an override. Only one can be approved, whichever is decided first.
  const b = await newBerth();
  const pa = await pending({ berth: b });
  const pb = await pending({ berth: b, over: { position_start_m: 100, position_end_m: 360 }, overrideReason: 'cần gấp' });
  const both = await Promise.all([approve(pa.plan.id, pa.plan.revision, 'manager'), approve(pb.plan.id, pb.plan.revision, 'manager2')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(both.find((r) => r.status === 409).body.error.details.rule, 'CONSTRAINT_VIOLATION_AT_APPROVAL');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE berth_id = @b AND plan_status = 'APPROVED'", { b: b.id }))[0].n, 1, 'no overlapping approved assignments');
  // Several plans in the queue approved at once: the queue stays 1..n.
  const set = []; for (let i = 0; i < 4; i += 1) set.push(await pending({ over: { position_start_m: 0, position_end_m: 260 } }));
  const all = await Promise.all(set.map((c, i) => approve(c.plan.id, c.plan.revision, i % 2 ? 'manager' : 'manager2')));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200]);
  const qq = await queueIds();
  assert.deepEqual(qq.items.map((e) => e.position), qq.items.map((_, i) => i + 1), 'positions stay 1..n after simultaneous approvals');
});

test('UC-030 does not do more than it should: other approved plans untouched, drafts and submissions still do not change voyages', { skip }, async () => {
  const b = await newBerth();
  const a = await pending({ berth: b }); assert.equal((await approve(a.plan.id, a.plan.revision)).status, 200);
  const keep = await planRow(a.plan.id);
  const c = await pending({ berth: b, over: { planned_start: H(8, 2), planned_end: H(20, 2) } });
  assert.deepEqual(await planRow(a.plan.id), keep, 'an approved plan is not touched by later plans');
  assert.deepEqual([(await voyageRow(c.voyageId)).status], ['WAITING_BERTH'], 'submission leaves the voyage in the queue');
});

// ---------------------------------------------------------------- UC-031 rejection
const reject = (id, rev, reason = 'không đủ cẩu bờ', who = 'manager') => call('POST', `/berth-plans/${id}/reject`, { who, body: reason === undefined ? {} : { reason }, headers: ifMatch(rev) });

test('UC-031 main flow: the manager rejects with a reason; the plan is REJECTED, nothing is reserved, the voyage and queue are untouched, the submitter is told the reason', { skip }, async () => {
  const ctx = await pending();
  const vBefore = await voyageRow(ctx.voyageId);
  const qBefore = await queueIds();
  const r = await reject(ctx.plan.id, ctx.plan.revision, '  không đủ cẩu bờ  ');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.plan_status, r.body.data.rejection_reason, r.body.data.revision, r.body.data.approved_by_user_id], ['REJECTED', 'không đủ cẩu bờ', 3, null]);
  assert.deepEqual(await voyageRow(ctx.voyageId), vBefore, 'the voyage is not changed (not BERTH_ASSIGNED, same queue position)');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: ctx.voyageId }))[0].n, 0);
  assert.deepEqual((await queueIds()).items.map((e) => e.voyage_id), qBefore.items.map((e) => e.voyage_id), 'the queue keeps its order');
  const st = (await call('GET', '/berths/status')).body.data.items.find((b) => b.id === ctx.berth.id);
  assert.deepEqual([st.state, st.next_plan], ['AVAILABLE', null], 'the berth is not reserved');
  const h = (await call('GET', `/berth-plans/${ctx.plan.id}`)).body.data.history;
  assert.deepEqual(h.map((x) => `${x.from_status}>${x.to_status}`), ['null>DRAFT', 'DRAFT>PENDING_APPROVAL', 'PENDING_APPROVAL>REJECTED']);
  assert.deepEqual([h[2].reason, h[2].actor], ['không đủ cẩu bờ', `t_a_manager_${SUFFIX}`]);
  const [a] = await audits('BERTH_PLAN_REJECT', ctx.plan.id);
  assert.deepEqual([a.outcome, a.reason, JSON.parse(a.new_json).previous_status, JSON.parse(a.new_json).new_status, JSON.parse(a.old_json).plan_status], ['SUCCESS', 'không đủ cẩu bờ', 'PENDING_APPROVAL', 'REJECTED', 'PENDING_APPROVAL']);
  const told = async (who) => (await call('GET', '/notifications?size=100', { who })).body.data.items.filter((x) => x.entity_id === ctx.plan.id && /bị từ chối/.test(x.title));
  assert.equal((await told('coord')).length, 1);
  assert.match((await told('coord'))[0].body, /không đủ cẩu bờ/);
  for (const who of ['manager', 'yard', 'agentUser', 'tech']) assert.equal((await told(who)).length, 0, `${who} does not get the rejection notice`);
  assert.equal((await call('GET', '/berth-plans?status=PENDING_APPROVAL&voyage_id=' + ctx.voyageId)).body.data.total, 0, 'no longer in the approval list');
});

test('UC-031 4a and request checks: a reason is required; only port management rejects; revision and state are checked', { skip }, async () => {
  const ctx = await pending();
  for (const body of [null, '', '   ', 'x'.repeat(501)]) {
    const r = await reject(ctx.plan.id, ctx.plan.revision, body);
    assert.deepEqual([r.status, r.body.error.details.some((d) => d.field === 'reason')], [400, true], JSON.stringify(body));
  }
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/reject`, { who: 'manager', body: { reason: 'x', extra: 1 }, headers: ifMatch(2) })).status, 400);
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/reject`, { who: 'manager', body: { reason: 'x' } })).status, 400, 'If-Match is required');
  for (const who of ['coord', 'yard', 'agentUser', 'tech']) assert.equal((await reject(ctx.plan.id, ctx.plan.revision, 'x', who)).status, 403, who);
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/reject`, { who: null, body: { reason: 'x' }, headers: ifMatch(2) })).status, 401);
  assert.ok((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_PLAN_REJECT' AND outcome = 'DENIED' AND actor LIKE @a", { a: `t_a_%_${SUFFIX}` }))[0].n >= 4);
  const stale = await reject(ctx.plan.id, 1);
  assert.deepEqual([stale.status, stale.body.error.details.current_revision], [409, 2]);
  assert.equal((await reject(999999999, 1)).status, 404);
  assert.equal((await planRow(ctx.plan.id)).plan_status, 'PENDING_APPROVAL', 'every refusal left the plan as it was');
  const draft = (await call('POST', '/berth-plans', { body: placement(await voyage(), (await newBerth()).id) })).body.data;
  const rd = await reject(draft.id, draft.revision);
  assert.deepEqual([rd.status, rd.body.error && rd.body.error.details && rd.body.error.details.plan_status], [409, 'DRAFT'], JSON.stringify(rd.body));
  const ap = await pending(); assert.equal((await approve(ap.plan.id, ap.plan.revision)).status, 200);
  const late = await reject(ap.plan.id, 3);
  assert.deepEqual([late.status, late.body.error.details.rule, late.body.error.details.plan_status], [409, 'NOT_PENDING', 'APPROVED']);
  assert.deepEqual([(await planRow(ap.plan.id)).plan_status, (await voyageRow(ap.voyageId)).status], ['APPROVED', 'BERTH_ASSIGNED'], 'an approved plan stays approved');
  await assert.rejects(() => q("UPDATE dbo.berth_plans SET plan_status = 'REJECTED', rejection_reason = N'  ' WHERE id = @i", { i: ctx.plan.id }), /CK_bp_reject_reason/);
});

test('UC-031 after the rejection: the plan is final, cannot be approved, edited or resubmitted; the coordinator makes a new plan, the old one stays as history', { skip }, async () => {
  const ctx = await pending();
  const rej = await reject(ctx.plan.id, ctx.plan.revision);
  assert.equal(rej.status, 200);
  const rev = rej.body.data.revision;
  assert.equal((await reject(ctx.plan.id, rev)).body.error.details.plan_status, 'REJECTED', 'rejecting twice is refused');
  const again = await approve(ctx.plan.id, rev);
  assert.deepEqual([again.status, again.body.error.details.rule], [409, 'NOT_PENDING'], 'a rejected plan is never approved');
  assert.equal((await call('PUT', `/berth-plans/${ctx.plan.id}`, { body: placement(ctx.voyageId, ctx.berth.id), headers: ifMatch(rev) })).body.error.details.rule, 'NOT_DRAFT');
  assert.equal((await call('POST', `/berth-plans/${ctx.plan.id}/submit`, { headers: ifMatch(rev) })).body.error.details.rule, 'NOT_DRAFT');
  // The voyage is still in the queue, so a new plan can be made and goes through the normal flow.
  const d = await call('POST', '/berth-plans', { body: placement(ctx.voyageId, ctx.berth.id, { required_cranes: 3 }) });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await call('POST', `/berth-plans/${d.body.data.id}/submit`, { headers: ifMatch(1) });
  assert.equal(s.status, 200);
  assert.equal((await approve(d.body.data.id, s.body.data.revision)).status, 200);
  assert.deepEqual([(await voyageRow(ctx.voyageId)).status, (await planRow(ctx.plan.id)).plan_status, (await planRow(d.body.data.id)).plan_status], ['BERTH_ASSIGNED', 'REJECTED', 'APPROVED']);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE berth_id = @b AND plan_status = 'APPROVED'", { b: ctx.berth.id }))[0].n, 1, 'only the new plan holds the berth');
});

test('UC-031 concurrency: three simultaneous rejections give one; a rejection against an approval gives exactly one decision and a consistent voyage', { skip }, async () => {
  const one = await pending();
  const rs = await Promise.all([reject(one.plan.id, one.plan.revision, 'a', 'manager'), reject(one.plan.id, one.plan.revision, 'b', 'manager2'), reject(one.plan.id, one.plan.revision, 'c', 'dual')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plan_status_history WHERE plan_id = @i AND to_status = 'REJECTED'", { i: one.plan.id }))[0].n, 1);
  assert.equal((await call('GET', '/notifications?size=100', { who: 'coord' })).body.data.items.filter((x) => x.entity_id === one.plan.id && /bị từ chối/.test(x.title)).length, 1, 'one notice');
  for (let i = 0; i < 3; i += 1) {
    const c = await pending();
    const both = await Promise.all([approve(c.plan.id, c.plan.revision, 'manager'), reject(c.plan.id, c.plan.revision, 'từ chối đồng thời', 'manager2')]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], `round ${i}`);
    const approved = both[0].status === 200;
    assert.deepEqual([(await planRow(c.plan.id)).plan_status, (await voyageRow(c.voyageId)).status], approved ? ['APPROVED', 'BERTH_ASSIGNED'] : ['REJECTED', 'WAITING_BERTH'], `round ${i}: plan and voyage agree`);
    assert.equal(both[approved ? 1 : 0].body.error.details.rule, 'NOT_PENDING');
  }
  const qq = await queueIds();
  assert.deepEqual(qq.items.map((e) => e.position), qq.items.map((_, i) => i + 1), 'the queue stays 1..n');
});

// ---------------------------------------------------------------- notification hints for users without the berth channel
test('notification hints: an agent with no berth permission gets a content-free hint when a plan is submitted; no session gets none', { skip }, async () => {
  assert.equal((await call('GET', '/realtime/notifications', { who: null })).status, 401);
  const controller = new AbortController();
  const res = await fetch(base + '/api/v1/realtime/notifications', { headers: { Cookie: cookies.agentUser }, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let seen = '';
  const hints = async (ms) => { const end = Date.now() + ms; while (Date.now() < end && !/refresh/.test(seen)) { const r = await Promise.race([reader.read(), new Promise((x) => setTimeout(() => x(null), 200))]); if (r && r.value) seen += decoder.decode(r.value); } return /event: refresh/.test(seen); };
  assert.equal((await call('GET', '/berths', { who: 'agentUser' })).status, 403, 'the agent has no berth permission (so no berth channel)');
  const started = Date.now();
  const ctx = await pending();
  assert.equal(await hints(5000), true, 'a hint arrives within 5 seconds of the submission');
  assert.ok(Date.now() - started < 5000);
  assert.match(seen, /"type":"NOTIFICATION"/);
  assert.doesNotMatch(seen, /plan_id|voyage|berth/, 'the hint carries no ids or content');
  controller.abort();
  void ctx;
});
