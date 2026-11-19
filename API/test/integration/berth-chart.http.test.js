'use strict';

// FR-BRT-03 chart data (GET /berths/:id/chart) on real SQL Server: layers, physical occupancy of a BERTHED vessel after its planned end, maintenance,
// exclusions, roles and validation. Fixtures are inserted directly (plans and voyages are created by other use cases). Runs only with SP_TEST_DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: berth chart tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const H = (h, day = 0) => new Date(Date.UTC(2032, 5, 10 + day, h));
let db; let server; let base; let agentA; let portId; let typeId; let coordId; let berth; let other; const cookies = {}; const usernames = []; const shipIds = [];
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'CA_${SUFFIX}', N'Đại lý CA ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'CP${SUFFIX}', N'Cảng CP ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  for (const [key, [role, agentId]] of Object.entries({ coord: ['DIEU_PHOI_VIEN'], manager: ['BAN_QUAN_LY'], yard: ['NHAN_VIEN_KHO_BAI'], agentA: ['DAI_LY_HANG_HAI', agentA] })) {
    const username = `t_c_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  coordId = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: usernames[0] }))[0].user_id;
  berth = (await call('POST', '/berths', { body: { berth_code: `C${SUFFIX}a`, berth_type: 'CONTAINER', length_m: 400, max_depth_m: 12, available_cranes: 3, allows_dangerous: false } })).body.data;
  other = (await call('POST', '/berths', { body: { berth_code: `C${SUFFIX}b`, berth_type: 'CONTAINER', length_m: 300, max_depth_m: 12, available_cranes: 3, allows_dangerous: false } })).body.data;
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const ids = shipIds.length ? shipIds.join(',') : '0';
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'C${SUFFIX}%'`;
  await q(`DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (SELECT id FROM dbo.berth_plans WHERE berth_id IN (${own}));
           DELETE FROM dbo.berth_plans WHERE berth_id IN (${own}); DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${own});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${ids}));
           DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids}); DELETE FROM dbo.berths WHERE berth_code LIKE 'C${SUFFIX}%';`);
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
             DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
  await new Promise((r) => server.close(r));
  await db.pool.close();
});

async function call(method, path, { who = 'coord', body } = {}) {
  const res = await fetch(base + '/api/v1' + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}
let n = 0;
async function voyage(status, { ata = null, atd = null } = {}) {
  n += 1;
  const sid = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES (@c, @i, @n, @t, 200, 30, 9, 50000)`, { c: `CS${SUFFIX}${n}`, i: `8${String(100000 + Math.floor(Math.random() * 800000))}`, n: `Chart ${n}`, t: typeId }))[0].id;
  shipIds.push(sid);
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, validation_result, validated_at, validation_policy_version, ata, atd, queue_position, queued_at)
    OUTPUT inserted.id VALUES (@s, @c, @st, @a, @p, '2032-06-10', 1, N'x', 'VALID', SYSUTCDATETIME(), 'V', @ata, @atd, ${status === 'WAITING_BERTH' ? '@pos, SYSUTCDATETIME()' : 'NULL, NULL'})`,
  { s: sid, c: `CV-${n}-${SUFFIX}`, st: status, a: agentA, p: portId, ata, atd, pos: 70000 + n }))[0].id;
}
const OVERRIDE_COLS = (override) => (override ? "@ov, @u, SYSUTCDATETIME(), N'[\"LENGTH\"]'" : 'NULL, NULL, NULL, NULL');
const plan = (voyageId, berthId, from, to, status, { start = 0, end = 200, passed = true, override = null } = {}) => q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end,
    required_cranes, buffer_m, policy_version, constraint_check_json, override_reason, override_by_user_id, override_at, override_rules, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at)
  OUTPUT inserted.id VALUES (@v, @b, @st, 'MANUAL', @ps, @pe, @f, @t, 1, 15, N'TEST', @chk, ${OVERRIDE_COLS(override)}, ${status === 'DRAFT' ? 'NULL, NULL' : '@u, SYSUTCDATETIME()'},
    ${status === 'APPROVED' || status === 'COMPLETED' ? '(SELECT TOP 1 user_id FROM dbo.auth_users WHERE user_id <> @u ORDER BY user_id), SYSUTCDATETIME()' : 'NULL, NULL'})`,
{ v: voyageId, b: berthId, st: status, ps: start, pe: end, f: from, t: to, u: coordId, chk: JSON.stringify({ passed, outcome: passed ? 'PASS' : 'VIOLATION' }), ov: override });
const chart = (id, from, to, who = 'coord') => call('GET', `/berths/${id}/chart?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, { who });

test('chart layers: approved, pending, draft and completed plans, an actual BERTHED vessel past its planned end (open-ended), maintenance; rejected, other berths and out-of-window items are left out', { skip }, async () => {
  const vApproved = await voyage('BERTH_ASSIGNED'); const vPending = await voyage('WAITING_BERTH'); const vDraft = await voyage('WAITING_BERTH'); const vDone = await voyage('DEPARTED', { ata: H(0, -2), atd: H(3, -2) });
  const vRejected = await voyage('WAITING_BERTH'); const vOtherBerth = await voyage('BERTH_ASSIGNED'); const vFar = await voyage('BERTH_ASSIGNED');
  const pApproved = (await plan(vApproved, berth.id, H(8), H(20), 'APPROVED', { start: 0, end: 150 }))[0].id;
  await plan(vPending, berth.id, H(8), H(20), 'PENDING_APPROVAL', { start: 160, end: 300 });
  await plan(vDraft, berth.id, H(22), H(30), 'DRAFT', { start: 0, end: 120, passed: false });
  await plan(vDone, berth.id, H(0, -2), H(10, -2), 'COMPLETED', { start: 0, end: 100 });
  await q("UPDATE dbo.berth_plans SET override_reason = N'ghi đè thử', override_by_user_id = @u, override_at = SYSUTCDATETIME(), override_rules = N'[\"LENGTH\"]' WHERE voyage_id = @v", { u: coordId, v: vPending });
  await plan(vRejected, berth.id, H(8), H(20), 'APPROVED', { start: 300, end: 390 });
  await q("UPDATE dbo.berth_plans SET plan_status = 'REJECTED', rejection_reason = N'x' WHERE voyage_id = @v", { v: vRejected });
  await plan(vOtherBerth, other.id, H(8), H(20), 'APPROVED');
  await plan(vFar, berth.id, H(8, 60), H(20, 60), 'APPROVED');
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Nạo vét', N'test'), (@b, @f, @t, 'CANCELLED', N'Đã hủy', N'test')`, { b: berth.id, f: H(12, 1), t: H(18, 1) });

  const r = await chart(berth.id, H(0, -3), H(0, 3));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.deepEqual([d.berth.id, d.berth.berth_code, d.berth.length_m], [berth.id, `C${SUFFIX}a`, 400]);
  const byVoyage = Object.fromEntries(d.plans.map((p) => [p.voyage_id, p]));
  assert.deepEqual(Object.keys(byVoyage).map(Number).sort(), [vApproved, vPending, vDraft, vDone].sort(), 'rejected, other-berth and out-of-window plans are not in the chart');
  assert.deepEqual([byVoyage[vApproved].plan_status, byVoyage[vApproved].plan_id, byVoyage[vApproved].position_start_m, byVoyage[vApproved].position_end_m], ['APPROVED', Number(pApproved), 0, 150]);
  assert.equal(byVoyage[vPending].plan_status, 'PENDING_APPROVAL'); assert.equal(byVoyage[vDraft].plan_status, 'DRAFT');
  assert.equal(byVoyage[vDraft].check_passed, false, 'the stored UC-026 result is carried so a violation can be marked'); assert.equal(byVoyage[vApproved].check_passed, true);
  assert.equal(byVoyage[vPending].has_override, true);
  // A completed plan ends at the actual departure, not at the planned end.
  assert.equal(new Date(byVoyage[vDone].occupies_to).toISOString(), H(3, -2).toISOString(), 'a completed plan ends at the actual departure');
  assert.equal(new Date(byVoyage[vApproved].occupies_to).toISOString(), H(20).toISOString());
  assert.deepEqual(d.maintenance.map((m) => m.reason), ['Nạo vét'], 'cancelled maintenance is not shown');
  assert.equal((await chart(berth.id, H(0, 1), H(0, 2))).body.data.maintenance.length, 1);
  assert.equal((await chart(other.id, H(0, -3), H(0, 3))).body.data.plans.length, 1);
});

test('chart: a BERTHED vessel stays on its stretch after the planned end passed (open-ended); an early arrival occupies from its ATA; a departed vessel ends at its ATD', { skip }, async () => {
  const near = (a, b) => Math.abs(new Date(a) - b) <= 10;   // DATETIME columns round to 3.33 ms
  const now = Date.now(); const T = (h) => new Date(now + h * 3600e3);
  const late = await voyage('BERTHED', { ata: T(-30) }); const early = await voyage('BERTHED', { ata: T(-3) }); const gone = await voyage('DEPARTED', { ata: T(-20), atd: T(-6) });
  await plan(late, other.id, T(-30), T(-10), 'APPROVED', { start: 0, end: 150 });       // planned end passed, still berthed: no known end
  await plan(early, other.id, T(-1), T(10), 'APPROVED', { start: 160, end: 290 });      // berthed before the planned start
  await plan(gone, other.id, T(-20), T(-8), 'COMPLETED', { start: 0, end: 100 });
  const d = (await chart(other.id, T(-48), T(48))).body.data; const by = Object.fromEntries(d.plans.map((p) => [p.voyage_id, p]));
  assert.deepEqual([by[late].physically_berthed, by[late].occupies_to], [true, null], 'open-ended: the berth is not free just because the plan ended');
  assert.ok(near(by[late].occupies_from, T(-30)));
  assert.ok(near(by[early].occupies_from, T(-3)), 'an early arrival occupies from the actual arrival');
  assert.ok(near(by[early].occupies_to, T(10)));
  assert.ok(near(by[gone].occupies_to, T(-6)), 'a departed vessel ends at its ATD');
  const later = (await chart(other.id, T(24), T(36))).body.data;
  assert.deepEqual(later.plans.map((p) => p.voyage_id), [late], 'the open-ended occupancy reaches every later window');
});

test('chart: a concurrent update is visible through the plan revision (clients compare it before saving)', { skip }, async () => {
  const v = await voyage('WAITING_BERTH');
  const id = (await plan(v, other.id, H(8, 20), H(18, 20), 'DRAFT', { start: 0, end: 100 }))[0].id;
  const rev = (await chart(other.id, H(0, 19), H(0, 22))).body.data.plans.find((p) => p.plan_id === Number(id)).revision;
  await q('UPDATE dbo.berth_plans SET position_start_m = 50, position_end_m = 150, revision = revision + 1 WHERE id = @i', { i: id });
  const after = (await chart(other.id, H(0, 19), H(0, 22))).body.data.plans.find((p) => p.plan_id === Number(id));
  assert.equal(after.revision, rev + 1); assert.deepEqual([after.position_start_m, after.position_end_m], [50, 150]);
});

test('chart access: roles with berth view (coordinator, manager, yard) read it; the agent is refused; anonymous is 401', { skip }, async () => {
  assert.equal((await chart(berth.id, H(0), H(0, 1), 'manager')).status, 200);
  assert.equal((await chart(berth.id, H(0), H(0, 1), 'agentA')).status, 403);
  assert.equal((await chart(berth.id, H(0), H(0, 1), 'yard')).status, 200, 'the SRS matrix lets yard staff view berths');
  assert.equal((await chart(berth.id, H(0), H(0, 1), null)).status, 401);
});

test('chart validation: missing or invalid window, reversed or longer than 14 days, unknown or malformed berth', { skip }, async () => {
  const bad = async (qs, field) => { const r = await call('GET', `/berths/${berth.id}/chart${qs}`); assert.equal(r.status, 400, qs); assert.ok(r.body.error.details.some((d) => d.field === field), qs); };
  await bad('', 'from'); await bad('?from=2032-06-10T00:00:00Z', 'to'); await bad('?from=nope&to=2032-06-11T00:00:00Z', 'from');
  await bad('?from=2032-06-11T00:00:00Z&to=2032-06-10T00:00:00Z', 'to'); await bad('?from=2032-06-01T00:00:00Z&to=2032-06-20T00:00:00Z', 'to');
  assert.equal((await chart(999999999, H(0), H(0, 1))).status, 404);
  assert.equal((await call('GET', '/berths/abc/chart?from=2032-06-10T00:00:00Z&to=2032-06-11T00:00:00Z')).status, 404);
});
