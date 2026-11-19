'use strict';

// HTTP integration tests for UC-021 (voyage schedule as list and Gantt) on real SQL Server. Runs only with SP_TEST_DB set.
// Berths and approved berth plans are created by Module 2 (UC-024, UC-030), which does not exist yet, so the fixtures
// insert them directly. That tests the schedule query against the documented schema, not Module 2 itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: schedule integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };

let db; let server; let base; let agentA; let agentB; let portId; let shipId; let berthX; let berthY; let coordId;
const cookies = {}; const usernames = []; let imo;
const v = {};
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, val] of Object.entries(params)) req.input(k, val); return (await req.query(text)).recordset; };
const D = (day, hm) => new Date(Date.UTC(2027, 7, 10 + day, Number(hm.slice(0, 2)), Number(hm.slice(3, 5)))).toISOString(); // day 0 = 2027-08-10

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false, etaAdapter: { predict: async () => ({ status: 'UNAVAILABLE' }) } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'SA_${SUFFIX}', N'Đại lý SA ${SUFFIX}'`);
  agentB = await mk('agents', 'agent_code, agent_name', `'SB_${SUFFIX}', N'Đại lý SB ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'SP${SUFFIX}', N'Cảng SP ${SUFFIX}'`);
  const berthCols = 'berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes';
  berthX = await mk('berths', berthCols, `'SX${SUFFIX}', N'Bến X ${SUFFIX}', 'CONTAINER', 300, 12, 2`);
  berthY = await mk('berths', berthCols, `'SY${SUFFIX}', N'Bến Y ${SUFFIX}', 'CONTAINER', 300, 12, 2`);
  const defs = { coord: ['DIEU_PHOI_VIEN'], manager: ['BAN_QUAN_LY'], yard: ['NHAN_VIEN_KHO_BAI'], agentA: ['DAI_LY_HANG_HAI', agentA], tech: ['KY_THUAT_VIEN'] };
  for (const [key, [role, agentId]] of Object.entries(defs)) {
    const username = `t_s_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  coordId = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: usernames[0] }))[0].user_id;
  imo = '5' + String(100000 + Math.floor(Math.random() * 800000)).padStart(6, '0');
  const typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  shipId = await mk('ships', 'ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t', `'SC${SUFFIX}', '${imo}', N'Sched ${SUFFIX}', ${typeId}, 180, 30, 10, 20000`);

  const voyage = async (key, { agent = agentA, status = 'ANNOUNCED', eta, ata = null, atd = null }) => {
    const valid = ['BERTHED', 'DEPARTED'].includes(status);
    v[key] = (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, ata, atd,
        validation_result, validated_at, validation_policy_version)
      OUTPUT inserted.id VALUES (@s, @c, @st, @a, @p, @eta, 1, N'x', @ata, @atd, ${valid ? "'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1'" : 'NULL, NULL, NULL'})`,
    { s: shipId, c: `S-${key}-${SUFFIX}`, st: status, a: agent, p: portId, eta: new Date(eta), ata: ata && new Date(ata), atd: atd && new Date(atd) }))[0].id;
  };
  const plan = (key, berth, start, end, status = 'APPROVED') => q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end,
      required_cranes, buffer_m, policy_version, constraint_check_json, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at)
    VALUES (@v, @b, @st, 'MANUAL', 0, 100, @s, @e, 1, 0, N'TEST', N'{"passed":true}', @u, SYSUTCDATETIME(), ${status === 'APPROVED' ? '(SELECT TOP 1 user_id FROM dbo.auth_users WHERE user_id <> @u ORDER BY user_id), SYSUTCDATETIME()' : 'NULL, NULL'})`,
  { v: v[key], b: berth, st: status, s: new Date(start), e: new Date(end), u: coordId });
  // A plan is attached to ANNOUNCED fixtures on purpose: WAITING_BERTH rows would join the global queue.
  await voyage('planned', { eta: D(0, '08:00') });
  await plan('planned', berthX, D(1, '08:00'), D(1, '20:00'));
  await voyage('berthed', { status: 'BERTHED', eta: D(0, '01:00'), ata: D(0, '02:00') });
  await plan('berthed', berthX, D(0, '01:00'), D(0, '12:00'));
  await voyage('departed', { agent: agentB, status: 'DEPARTED', eta: D(-1, '09:00'), ata: D(-1, '10:00'), atd: D(-1, '18:00') });
  await plan('departed', berthY, D(-1, '09:00'), D(-1, '19:00'));
  await voyage('noplan', { eta: D(0, '15:00') });
  await voyage('pending', { eta: D(5, '09:00') });
  await plan('pending', berthY, D(5, '09:00'), D(5, '12:00'), 'PENDING_APPROVAL');
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id = ${shipId}`;
  if (shipId) await q(`DELETE FROM dbo.berth_plans WHERE voyage_id IN (${mine}); DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyages WHERE ship_id = ${shipId}; DELETE FROM dbo.ships WHERE id = ${shipId};
           `);
  if (berthX) await q(`DELETE FROM dbo.berths WHERE id IN (${berthX}, ${berthY || berthX})`);
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
             DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id IN (${agentA}, ${agentB}); DELETE FROM dbo.ports WHERE id = ${portId};`);
  await new Promise((r) => server.close(r));
  await db.pool.close();
});

async function get(path, who = 'coord') {
  const res = await fetch(base + '/api/v1' + path, { headers: { Cookie: cookies[who] } });
  return { status: res.status, body: await res.json() };
}
const own = (extra = '') => `/voyages/schedule?${extra}`;
const sorted = (list) => [...list].sort((a, b) => a - b);
const ids = (res) => sorted(res.body.data.items.map((i) => i.id));
const byKey = (res, key) => res.body.data.items.find((i) => i.id === v[key]);
const iso = (x) => new Date(x).toISOString();

test('UC-021 list: shows status, agent, berth (from the approved plan), ETA, ATA and ATD', { skip }, async () => {
  const res = await get(own(`agent_id=${agentA}&size=100`));
  assert.equal(res.status, 200);
  const b = byKey(res, 'berthed');
  assert.equal(b.status, 'BERTHED');
  assert.equal(b.agent_name, `Đại lý SA ${SUFFIX}`);
  assert.equal(b.berth_code, `SX${SUFFIX}`);
  assert.equal(iso(b.ata), D(0, '02:00'));
  assert.equal(iso(b.declared_eta), D(0, '01:00'));
  assert.equal(b.atd, null);
  assert.deepEqual(ids(res), sorted([v.berthed, v.noplan, v.pending, v.planned]));
});

test('UC-021 AC-1: filtering by berth, agent or status returns the matching rows only; a pending plan gives no berth (BR-3)', { skip }, async () => {
  assert.deepEqual(ids(await get(own(`berth_id=${berthX}&size=100`))), sorted([v.berthed, v.planned]));
  assert.deepEqual(ids(await get(own(`berth_id=${berthY}&size=100`))), [v.departed], 'the pending plan on Y is not a berth assignment');
  assert.equal(byKey(await get(own(`agent_id=${agentA}&size=100`)), 'pending').berth_code, null);
  assert.deepEqual(ids(await get(own(`agent_id=${agentB}&size=100`))), [v.departed]);
  assert.deepEqual(ids(await get(own(`status=BERTHED&agent_id=${agentA}&size=100`))), [v.berthed]);
  const none = await get(own(`status=DEPARTED&agent_id=${agentA}`));
  assert.deepEqual([none.status, none.body.data.items.length, none.body.data.total], [200, 0, 0], 'no match: empty list, not an error');
});

test('UC-021 AC-2: Gantt bars equal the stored times (actual times win over the plan)', { skip }, async () => {
  const res = await get(own(`view=gantt&from=${D(-2, '00:00')}&to=${D(3, '00:00')}&agent_id=${agentA}`));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.truncated, false);
  const planned = byKey(res, 'planned');
  assert.deepEqual([planned.bar_source, iso(planned.start_at), iso(planned.end_at)], ['PLAN', D(1, '08:00'), D(1, '20:00')]);
  const berthed = byKey(res, 'berthed');
  assert.deepEqual([berthed.bar_source, iso(berthed.start_at), iso(berthed.end_at)], ['ACTUAL', D(0, '02:00'), D(0, '12:00')], 'ATA starts the bar; the plan end is used until ATD exists');
  const noplan = byKey(res, 'noplan');
  assert.deepEqual([noplan.bar_source, noplan.start_at, noplan.end_at, iso(noplan.declared_eta)], [null, null, null, D(0, '15:00')], 'no interval: placed by ETA only');
  const dep = byKey(await get(own(`view=gantt&from=${D(-2, '00:00')}&to=${D(3, '00:00')}&agent_id=${agentB}`)), 'departed');
  assert.deepEqual([dep.bar_source, iso(dep.start_at), iso(dep.end_at)], ['ACTUAL', D(-1, '10:00'), D(-1, '18:00')], 'ATD ends the bar');
});

test('UC-021 window: a voyage is in the window when its interval overlaps it; touching edges are outside', { skip }, async () => {
  const win = async (from, to) => ids(await get(own(`view=gantt&from=${from}&to=${to}&agent_id=${agentA}`)));
  assert.deepEqual(await win(D(1, '00:00'), D(2, '00:00')), [v.planned], 'day 1 only');
  assert.deepEqual(await win(D(1, '20:00'), D(2, '00:00')), [], 'window starts exactly at the end of the plan: outside');
  assert.deepEqual(await win(D(0, '00:00'), D(1, '08:00')), sorted([v.berthed, v.noplan]), 'window ends exactly at the plan start: outside');
  assert.deepEqual(await win(D(0, '12:00'), D(0, '12:01')), [], 'berthed bar ends at 12:00');
  assert.deepEqual(await win(D(0, '11:59'), D(0, '12:00')), [v.berthed]);
  assert.deepEqual(await win(D(5, '00:00'), D(6, '00:00')), [v.pending], 'no interval: ETA decides');
});

test('UC-021 validation: bad filters, bad windows and a missing Gantt window are refused', { skip }, async () => {
  const bad = async (qs, field) => {
    const r = await get(own(qs));
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
    assert.ok(r.body.error.details.some((d) => d.field === field), `${qs} -> ${field}`);
  };
  await bad('view=cards', 'view');
  await bad('status=NOPE', 'status');
  await bad('agent_id=abc', 'agent_id');
  await bad('berth_id=0', 'berth_id');
  await bad('view=gantt', 'from');
  await bad(`from=${D(0, '00:00')}`, 'to');
  await bad(`view=gantt&from=${D(1, '00:00')}&to=${D(0, '00:00')}`, 'to');
  await bad(`view=gantt&from=${D(0, '00:00')}&to=${D(0, '00:00')}`, 'to');
  await bad(`view=gantt&from=${D(-30, '00:00')}&to=${D(3, '00:00')}`, 'to');
  await bad('view=gantt&from=2027-08-10&to=2027-08-11', 'from');
  await bad('size=0', 'size');
});

test('UC-021 authorization: coordinator, management and warehouse staff can view; agents and technicians cannot', { skip }, async () => {
  for (const who of ['coord', 'manager', 'yard']) assert.equal((await get(own('size=1'), who)).status, 200, who);
  for (const who of ['agentA', 'tech']) assert.equal((await get(own('size=1'), who)).status, 403, who);
  assert.equal((await fetch(base + '/api/v1/voyages/schedule')).status, 401);
  assert.equal((await get('/catalog/berths', 'agentA')).status, 403);
  const berths = await get('/catalog/berths');
  assert.ok(berths.body.data.items.some((b) => b.id === berthX));
});

test('UC-021 paging: list pages are stable and the total is the filtered count', { skip }, async () => {
  const p0 = await get(own(`agent_id=${agentA}&size=2&page=0`));
  const p1 = await get(own(`agent_id=${agentA}&size=2&page=1`));
  assert.equal(p0.body.data.total, 4);
  assert.equal(new Set([...p0.body.data.items, ...p1.body.data.items].map((i) => i.id)).size, 4);
});
