'use strict';

// HTTP integration tests for Module 2, first slice, on real SQL Server: berth catalog (UC-024), berth state and refresh
// hints (UC-025) and the placement check (UC-026). Runs only with SP_TEST_DB set (disposable database).
// Plans, maintenance and voyages in the queue are created by later use cases (UC-028..UC-030, UC-034), so the fixtures
// insert them directly into the documented tables. That tests these use cases against the schema, not those later ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');
const events = require('../../src/realtime/m2Events');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: Module 2 integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
const CODE = (n) => `T${SUFFIX}${n}`;

let db; let server; let base; let agentA; let portId; let typeId; let coordId; let shipId; let bufferBefore;
const cookies = {}; const usernames = []; const voyages = {};
const q = async (text, params = {}) => { const req = db.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const H = (h, day = 0) => new Date(Date.UTC(2031, 0, 10 + day, h)).toISOString(); // far future, so nothing else is planned there

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'MA_${SUFFIX}', N'Đại lý MA ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'MP${SUFFIX}', N'Cảng MP ${SUFFIX}'`);
  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const defs = { coord: ['DIEU_PHOI_VIEN'], manager: ['BAN_QUAN_LY'], yard: ['NHAN_VIEN_KHO_BAI'], admin: ['QUAN_TRI_HE_THONG'], agentA: ['DAI_LY_HANG_HAI', agentA], tech: ['KY_THUAT_VIEN'] };
  for (const [key, [role, agentId]] of Object.entries(defs)) {
    const username = `t_m_${key}_${SUFFIX}`; usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  coordId = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: usernames[0] }))[0].user_id;
  shipId = await mk('ships', 'ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t', `'MC${SUFFIX}', '4${String(100000 + Math.floor(Math.random() * 800000))}', N'Berth ${SUFFIX}', ${typeId}, 250, 32, 10, 60000`);
  bufferBefore = (await q("SELECT param_value FROM dbo.system_parameters WHERE param_key = 'BERTH_SAFETY_BUFFER_M'"))[0].param_value;
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  await q(`IF EXISTS (SELECT 1 FROM dbo.system_parameters WHERE param_key = 'BERTH_SAFETY_BUFFER_M') UPDATE dbo.system_parameters SET param_value = @v WHERE param_key = 'BERTH_SAFETY_BUFFER_M'
           ELSE INSERT INTO dbo.system_parameters (param_key, param_value, default_value, value_type, description) VALUES ('BERTH_SAFETY_BUFFER_M', @v, N'15', 'DECIMAL', N'Khoảng đệm an toàn giữa hai tàu (m), BR-02')`, { v: bufferBefore });
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id = ${shipId}`;
  const ownBerths = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'T${SUFFIX}%'`;
  await q(`DELETE FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${ownBerths});
           DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${ownBerths});
           DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
           DELETE FROM dbo.voyages WHERE ship_id = ${shipId}; DELETE FROM dbo.ships WHERE id = ${shipId};
           DELETE FROM dbo.berths WHERE berth_code LIKE 'T${SUFFIX}%';`);
  for (const u of usernames) {
    await q(`DECLARE @id BIGINT = (SELECT user_id FROM dbo.auth_users WHERE username = N'${u}');
             DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
             DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
  }
  await q(`DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
  events.closeAll();
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
const newBerth = (n, over = {}) => ({ berth_code: CODE(n), berth_type: 'CONTAINER', length_m: 300, max_depth_m: 12, available_cranes: 3, allows_dangerous: false, ...over });
const createBerth = async (n, over) => { const r = await call('POST', '/berths', { body: newBerth(n, over) }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; };
const auditRows = (action, entityId) => q('SELECT outcome, reason, old_json, new_json FROM dbo.audit_events WHERE action = @a AND entity_id = @e ORDER BY id', { a: action, e: String(entityId) });
async function queuedVoyage(key, over = {}) {
  const id = (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, priority_class, queue_position, queued_at,
      validation_result, validated_at, validation_policy_version, ata, cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, @st, @a, @p, '2031-01-10', 1, N'x', @pr, ${over.status === 'WAITING_BERTH' || over.status === undefined ? '9999, SYSUTCDATETIME()' : 'NULL, NULL'}, 'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1', @ata,
      ${over.hazard === null ? 'NULL, NULL, NULL, NULL' : "@hz, N'test fixture', @u, SYSUTCDATETIME()"})`,
  { s: shipId, c: `M-${key}-${SUFFIX}`, st: over.status || 'WAITING_BERTH', a: agentA, p: portId, pr: over.priority || 'STANDARD', ata: over.ata || null, hz: over.hazard || 'NONE', u: coordId }))[0].id;
  voyages[key] = id;
  return id;
}
const plan = (voyageId, berthId, from, to, { status = 'APPROVED', start = 0, end = 250 } = {}) => q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end,
    required_cranes, buffer_m, policy_version, constraint_check_json, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at)
  VALUES (@v, @b, @st, 'MANUAL', @ps, @pe, @f, @t, 1, 15, N'TEST', N'{"passed":true}', @u, SYSUTCDATETIME(), ${status === 'APPROVED' ? '(SELECT TOP 1 user_id FROM dbo.auth_users WHERE user_id <> @u ORDER BY user_id), SYSUTCDATETIME()' : 'NULL, NULL'})`,
{ v: voyageId, b: berthId, st: status, ps: start, pe: end, f: new Date(from), t: new Date(to), u: coordId });

// ---------------------------------------------------------------- UC-024
test('UC-024 create: saved with its data, audited, listed, and chosen in planning without a code change (AC-1)', { skip }, async () => {
  const r = await call('POST', '/berths', { body: newBerth('a', { berth_name: 'Bến thử', longitude: 106.7, latitude: 10.77, allows_dangerous: true }) });
  assert.equal(r.status, 201);
  const b = r.body.data;
  assert.deepEqual([b.berth_code, b.berth_name, b.berth_type, b.length_m, b.max_depth_m, b.available_cranes, b.allows_dangerous, b.operational_status, b.revision], [CODE('a'), 'Bến thử', 'CONTAINER', 300, 12, 3, true, 'IN_SERVICE', 1]);
  assert.equal(r.etag, '"1"');
  assert.equal((await call('GET', `/berths/${b.id}`)).body.data.berth_code, CODE('a'));
  const list = await call('GET', '/berths?size=100');
  assert.ok(list.body.data.items.some((x) => x.id === b.id));
  assert.ok((await call('GET', '/catalog/berths')).body.data.items.some((x) => x.id === b.id), 'the planning catalog reads the same table');
  const audit = await auditRows('BERTH_CREATE', b.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'SUCCESS');
  assert.equal(JSON.parse(audit[0].new_json).berth_code, CODE('a'));
  const noName = await createBerth('b');
  assert.equal(noName.berth_name, CODE('b'), 'the name defaults to the code');
  const noCoord = await createBerth('c');
  assert.deepEqual([noCoord.longitude, noCoord.latitude], [null, null], '3a: coordinates may be empty');
});

test('UC-024 AC-2: a duplicate code is refused on the code field, also when two are created at once', { skip }, async () => {
  await createBerth('d');
  const dup = await call('POST', '/berths', { body: newBerth('d') });
  assert.deepEqual([dup.status, dup.body.error.code, dup.body.error.details.field], [409, 'CONFLICT', 'berth_code']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berths WHERE berth_code = @c', { c: CODE('d') }))[0].n, 1);
  const lower = await call('POST', '/berths', { body: newBerth('d', { berth_code: CODE('d').toLowerCase() }) });
  assert.equal(lower.status, 409, 'codes differing only in case are the same code');
  const results = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/berths', { body: newBerth('e') })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berths WHERE berth_code = @c', { c: CODE('e') }))[0].n, 1);
});

test('UC-024 5a validation: values at or below zero and bad input are refused with the field', { skip }, async () => {
  const bad = async (over, field) => {
    const r = await call('POST', '/berths', { body: newBerth('v', over) });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.ok(r.body.error.details.some((d) => d.field === field), `${JSON.stringify(over)} -> ${field}`);
  };
  await bad({ length_m: 0 }, 'length_m');
  await bad({ max_depth_m: -2 }, 'max_depth_m');
  await bad({ available_cranes: -1 }, 'available_cranes');
  await bad({ berth_type: 'RORO' }, 'berth_type');
  await bad({ berth_code: '' }, 'berth_code');
  await bad({ latitude: 91, longitude: 10 }, 'latitude');
  await bad({ longitude: 10 }, 'latitude');
  await bad({ extra: 1 }, 'extra');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berths WHERE berth_code = @c', { c: CODE('v') }))[0].n, 0, 'nothing is saved');
});

test('UC-024 update: only changed fields, revision check, audit with old and new values', { skip }, async () => {
  const b = await createBerth('u');
  const ok = await call('PATCH', `/berths/${b.id}`, { body: { berth_name: 'Tên mới', available_cranes: 4, reason: 'Thêm cẩu' }, headers: { 'If-Match': '"1"' } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.berth_name, ok.body.data.available_cranes, ok.body.data.revision, ok.etag], ['Tên mới', 4, 2, '"2"']);
  const [row] = await auditRows('BERTH_UPDATE', b.id);
  assert.equal(JSON.parse(row.old_json).available_cranes, 3);
  assert.equal(JSON.parse(row.new_json).available_cranes, 4);
  assert.equal(row.reason, 'Thêm cẩu');
  const stale = await call('PATCH', `/berths/${b.id}`, { body: { available_cranes: 5 }, headers: { 'If-Match': '"1"' } });
  assert.deepEqual([stale.status, stale.body.error.details.current_revision], [409, 2]);
  assert.equal((await call('PATCH', `/berths/${b.id}`, { body: { available_cranes: 5 } })).status, 400, 'If-Match is required');
  assert.equal((await call('PATCH', `/berths/${b.id}`, { body: {}, headers: { 'If-Match': '"2"' } })).status, 400, 'empty change');
  const other = await createBerth('u2');
  const clash = await call('PATCH', `/berths/${b.id}`, { body: { berth_code: other.berth_code }, headers: { 'If-Match': '"2"' } });
  assert.deepEqual([clash.status, clash.body.error.details.field], [409, 'berth_code']);
  assert.equal((await call('PATCH', '/berths/999999999', { body: { available_cranes: 1 }, headers: { 'If-Match': '"1"' } })).status, 404);
  assert.equal((await call('PATCH', `/berths/${b.id}`, { body: { operational_status: 'OUT_OF_SERVICE' }, headers: { 'If-Match': '"2"' } })).body.data.operational_status, 'OUT_OF_SERVICE');
});

test('UC-024 6a / AC-3: changing length or depth of a berth with open plans lists the plans and needs confirmation', { skip }, async () => {
  const b = await createBerth('p');
  const v = await queuedVoyage('p1');
  await plan(v, b.id, H(8), H(20));
  const refused = await call('PATCH', `/berths/${b.id}`, { body: { length_m: 280 }, headers: { 'If-Match': '"1"' } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details.rule, refused.body.error.details.requires_confirmation], [409, 'BUSINESS_RULE_VIOLATION', 'BERTH_HAS_PLANS', true]);
  assert.deepEqual(refused.body.error.details.plans.map((p) => p.voyage_code), [`M-p1-${SUFFIX}`]);
  assert.equal((await q('SELECT length_m FROM dbo.berths WHERE id = @i', { i: b.id }))[0].length_m, 300, 'unchanged');
  assert.equal((await auditRows('BERTH_UPDATE', b.id))[0].outcome, 'FAILED', 'the refusal is audited');
  const noSize = await call('PATCH', `/berths/${b.id}`, { body: { available_cranes: 5 }, headers: { 'If-Match': '"1"' } });
  assert.equal(noSize.status, 200, 'a change that is not a size needs no confirmation');
  const confirmed = await call('PATCH', `/berths/${b.id}`, { body: { max_depth_m: 11, confirm_affected_plans: true }, headers: { 'If-Match': '"2"' } });
  assert.deepEqual([confirmed.status, confirmed.body.data.max_depth_m], [200, 11]);
  const rows = await auditRows('BERTH_UPDATE', b.id);
  assert.match(rows[rows.length - 1].reason, /xác nhận ảnh hưởng 1 kế hoạch/);
  const free = await createBerth('p2');
  assert.equal((await call('PATCH', `/berths/${free.id}`, { body: { length_m: 280 }, headers: { 'If-Match': '"1"' } })).status, 200, 'no plans: no confirmation');
});

test('UC-024 authorization: only the coordinator changes the catalog; management, warehouse and admin read; agent and technician are refused', { skip }, async () => {
  for (const who of ['manager', 'yard', 'admin']) {
    assert.equal((await call('GET', '/berths', { who })).status, 200, who);
    assert.equal((await call('POST', '/berths', { who, body: newBerth('x') })).status, 403, who);
  }
  for (const who of ['agentA', 'tech']) {
    assert.equal((await call('GET', '/berths', { who })).status, 403, who);
    assert.equal((await call('GET', '/berths/status', { who })).status, 403, who);
    assert.equal((await call('POST', '/berth-plan-checks', { who, body: {} })).status, 403, who);
  }
  assert.equal((await call('GET', '/berths', { who: null })).status, 401);
  const b = await createBerth('z');
  assert.equal((await call('PATCH', `/berths/${b.id}`, { who: 'manager', body: { available_cranes: 1 }, headers: { 'If-Match': '"1"' } })).status, 403);
  assert.ok((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_CREATE' AND outcome = 'DENIED' AND actor LIKE @a", { a: `t_m_%_${SUFFIX}` }))[0].n >= 3, 'denials are audited');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berths WHERE berth_code = @c', { c: CODE('x') }))[0].n, 0);
});

// ---------------------------------------------------------------- UC-025
test('UC-025 AC-2: each berth shows the state derived from plans, maintenance and operational status', { skip }, async () => {
  const mkB = (n, over) => createBerth(n, over);
  const free = await mkB('s1'); const reserved = await mkB('s2'); const inUse = await mkB('s3'); const maint = await mkB('s4'); const oos = await mkB('s5');
  const late = await mkB('s6'); const overstay = await mkB('s7'); const pendingOnly = await mkB('s8'); const maintFuture = await mkB('s9');
  const now = Date.now(); const h = (n) => new Date(now + n * 3600000).toISOString();
  await plan(await queuedVoyage('s2'), reserved.id, h(2), h(10));
  await plan(await queuedVoyage('s3', { status: 'BERTHED', ata: new Date(now - 3600000) }), inUse.id, h(-2), h(6));
  await plan(await queuedVoyage('s6'), late.id, h(-1), h(5));                  // the plan holds the berth now, the vessel has not berthed
  await plan(await queuedVoyage('s7', { status: 'BERTHED', ata: new Date(now - 7200000) }), overstay.id, h(-6), h(-1)); // plan ended, vessel still at the berth
  await plan(await queuedVoyage('s8'), pendingOnly.id, h(1), h(8), { status: 'PENDING_APPROVAL' });
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Bảo trì cẩu', N'test')`, { b: maint.id, f: new Date(now - 3600000), t: new Date(now + 3600000) });
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Sắp bảo trì', N'test')`, { b: maintFuture.id, f: new Date(now + 3600000), t: new Date(now + 7200000) });
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'CANCELLED', N'Đã hủy', N'test')`, { b: free.id, f: new Date(now - 3600000), t: new Date(now + 3600000) });
  await call('PATCH', `/berths/${oos.id}`, { body: { operational_status: 'OUT_OF_SERVICE' }, headers: { 'If-Match': '"1"' } });
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Bảo trì', N'test')`, { b: oos.id, f: new Date(now - 3600000), t: new Date(now + 3600000) });

  const snap = await call('GET', '/berths/status');
  assert.equal(snap.status, 200);
  assert.ok(snap.body.data.as_of);
  const st = (b) => snap.body.data.items.find((x) => x.id === b.id).state;
  assert.deepEqual([st(free), st(reserved), st(inUse), st(maint), st(oos), st(late), st(overstay), st(pendingOnly), st(maintFuture)],
    ['AVAILABLE', 'RESERVED', 'IN_USE', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RESERVED', 'IN_USE', 'AVAILABLE', 'AVAILABLE']);
  const item = snap.body.data.items.find((x) => x.id === inUse.id);
  assert.equal(item.current_plan.voyage_code, `M-s3-${SUFFIX}`);
  assert.equal(snap.body.data.items.find((x) => x.id === reserved.id).next_plan.voyage_code, `M-s2-${SUFFIX}`);
  assert.equal(snap.body.data.items.find((x) => x.id === maint.id).maintenance.reason, 'Bảo trì cẩu');

  // Step 6: detail of a berth.
  const d = await call('GET', `/berths/${maint.id}/detail`);
  assert.equal(d.status, 200);
  assert.deepEqual([d.body.data.state, d.body.data.upcoming_maintenance.length], ['MAINTENANCE', 1]);
  const dp = (await call('GET', `/berths/${pendingOnly.id}/detail`)).body.data;
  assert.deepEqual(dp.upcoming_plans.map((p) => p.plan_status), ['PENDING_APPROVAL'], 'pending plans are listed but do not reserve');
  assert.equal((await call('GET', '/berths/999999999/detail')).status, 404);

  // The state is never set by a request (BR-2).
  const forced = await call('PATCH', `/berths/${free.id}`, { body: { state: 'IN_USE' }, headers: { 'If-Match': '"1"' } });
  assert.equal(forced.status, 400);
});

test('UC-025 AC-1: a catalog change reaches an open client as a refresh hint within 5 s; the channel is closed to other roles', { skip }, async () => {
  const ac = new AbortController();
  const res = await fetch(base + '/api/v1/realtime/m2/events', { headers: { Cookie: cookies.manager }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  const got = (async () => { let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) return buf; buf += dec.decode(value); if (/event: refresh/.test(buf)) return buf; } })();
  const started = Date.now();
  const b = await createBerth('r');
  const text = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no refresh hint within 5 s')), 5000))]);
  assert.ok(Date.now() - started < 5000);
  assert.match(text, /BERTHS_CHANGED/);
  assert.match(text, new RegExp(`"berth_id":${b.id}`));
  ac.abort();
  assert.equal((await fetch(base + '/api/v1/realtime/m2/events', { headers: { Cookie: cookies.agentA } })).status, 403);
  assert.equal((await fetch(base + '/api/v1/realtime/m2/events')).status, 401);
});

// ---------------------------------------------------------------- UC-026
const placement = (voyageId, berthId, over = {}) => ({ voyage_id: voyageId, berth_id: berthId, position_start_m: 0, position_end_m: 260, planned_start: H(8), planned_end: H(20), required_cranes: 2, ...over });
const outcomes = (r) => Object.fromEntries(r.body.data.rules.map((x) => [x.id, x.outcome]));

test('UC-026 AC-1: every rule is reported with pass or violation and a reason; nothing is stored by the check', { skip }, async () => {
  const b = await createBerth('k1', { length_m: 300, max_depth_m: 12, available_cranes: 3 });
  const v = await queuedVoyage('k1');
  const plansBefore = (await q('SELECT COUNT(*) AS n FROM dbo.berth_plans'))[0].n;
  const auditBefore = (await q('SELECT COUNT(*) AS n FROM dbo.audit_events'))[0].n;
  const ok = await call('POST', '/berth-plan-checks', { who: 'coord', body: placement(v, b.id) });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.data.outcome, ok.body.data.passed, ok.body.data.buffer_m, ok.body.data.rules.length], ['PASS', true, 15, 9]);
  // Demo 2: a stretch shorter than the vessel.
  const small = await call('POST', '/berth-plan-checks', { who: 'manager', body: placement(v, b.id, { position_end_m: 200 }) });
  assert.equal(small.body.data.outcome, 'VIOLATION');
  assert.match(small.body.data.rules.find((r) => r.id === 'LOA_FIT').reason, /LOA 250 m lớn hơn đoạn bến được bố trí 200 m/);
  const needs = await call('POST', '/berth-plan-checks', { body: placement(v, b.id, { required_cranes: 5, position_end_m: 301 }) });
  assert.deepEqual([outcomes(needs).CRANES, outcomes(needs).LOA_FIT], ['VIOLATION', 'VIOLATION'], 'several violations are all reported');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans'))[0].n, plansBefore);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.audit_events'))[0].n, auditBefore, 'a read-only check writes no audit row');
});

test('UC-026 BR-01, BR-02 and AC-3: overlap, buffer from the parameter (exactly the buffer passes), maintenance, type, depth', { skip }, async () => {
  const b = await createBerth('k2', { length_m: 600 });
  const mine = await queuedVoyage('k2'); const other = await queuedVoyage('k2o');
  await plan(other, b.id, H(8), H(20), { start: 275, end: 500 });             // gap 15 m after a stretch that ends at 260
  const exact = await call('POST', '/berth-plan-checks', { body: placement(mine, b.id) });
  assert.equal(exact.body.data.outcome, 'PASS', 'a gap equal to the buffer passes');
  const tight = await call('POST', '/berth-plan-checks', { body: placement(mine, b.id, { position_end_m: 261, }) });
  assert.deepEqual([outcomes(tight).SAFETY_BUFFER, outcomes(tight).OVERLAP], ['VIOLATION', 'PASS']);
  const overlap = await call('POST', '/berth-plan-checks', { body: placement(mine, b.id, { position_start_m: 100, position_end_m: 360 }) });
  assert.equal(outcomes(overlap).OVERLAP, 'VIOLATION');
  assert.match(overlap.body.data.rules.find((r) => r.id === 'OVERLAP').reason, new RegExp(`M-k2o-${SUFFIX}`));
  const otherTime = await call('POST', '/berth-plan-checks', { body: placement(mine, b.id, { position_start_m: 100, position_end_m: 360, planned_start: H(20), planned_end: H(23) }) });
  assert.equal(otherTime.body.data.outcome, 'PASS', 'same stretch, but the other plan has left');
  const own = await plan(mine, b.id, H(8), H(20), { start: 0, end: 260 });      // the voyage's own plan is not a neighbor
  assert.equal((await call('POST', '/berth-plan-checks', { body: placement(mine, b.id) })).body.data.outcome, 'PASS');
  // AC-3: the buffer is read from the parameter on every check.
  await q("UPDATE dbo.system_parameters SET param_value = N'30' WHERE param_key = 'BERTH_SAFETY_BUFFER_M'");
  const strict = await call('POST', '/berth-plan-checks', { body: placement(mine, b.id) });
  assert.deepEqual([strict.body.data.buffer_m, outcomes(strict).SAFETY_BUFFER], [30, 'VIOLATION']);
  await q("DELETE FROM dbo.system_parameters WHERE param_key = 'BERTH_SAFETY_BUFFER_M'");
  const gone = await call('POST', '/berth-plan-checks', { body: placement(mine, b.id) });
  assert.deepEqual([gone.status, gone.body.error.code], [503, 'PARAMETER_UNAVAILABLE'], 'fail closed, no silent constant');
  await q(`INSERT INTO dbo.system_parameters (param_key, param_value, default_value, value_type, description) VALUES ('BERTH_SAFETY_BUFFER_M', @v, N'15', 'DECIMAL', N'Khoảng đệm an toàn giữa hai tàu (m), BR-02')`, { v: bufferBefore });
  // Maintenance, cancelled maintenance, berth type, depth.
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Nạo vét', N'test')`, { b: b.id, f: new Date(H(19)), t: new Date(H(22)) });
  assert.equal(outcomes(await call('POST', '/berth-plan-checks', { body: placement(mine, b.id) })).MAINTENANCE, 'VIOLATION');
  await q("UPDATE dbo.berth_maintenance SET status = 'CANCELLED' WHERE berth_id = @b", { b: b.id });
  assert.equal(outcomes(await call('POST', '/berth-plan-checks', { body: placement(mine, b.id) })).MAINTENANCE, 'PASS', 'a cancelled interval blocks nothing');
  const bulk = await createBerth('k3', { berth_type: 'BULK', max_depth_m: 9 });
  const wrong = outcomes(await call('POST', '/berth-plan-checks', { body: placement(mine, bulk.id) }));
  assert.deepEqual([wrong.BERTH_TYPE, wrong.DRAFT_FIT], ['VIOLATION', 'VIOLATION']);
  void own;
});

test('UC-026 BR-03: the hazard fact comes from the coordinator-verified voyage data; a request value or the priority class is not evidence', { skip }, async () => {
  const plain = await createBerth('k4'); const allowed = await createBerth('k5', { allows_dangerous: true });
  const unknown = await queuedVoyage('k4', { priority: 'REEFER_OR_HAZARD', hazard: null }); // reefer is not hazardous, and nothing is verified
  const danger = await queuedVoyage('k5', { hazard: 'DANGEROUS' });
  const none = await queuedVoyage('k5b', { hazard: 'NONE' });
  const dg = (v, b, extra) => call('POST', '/berth-plan-checks', { body: placement(v, b.id, extra) });
  const u = await dg(unknown, plain);
  assert.deepEqual([u.body.data.outcome, outcomes(u).DANGEROUS_GOODS], ['MISSING_DATA', 'MISSING_DATA'], 'unverified cargo at an ordinary berth: insufficient data, not a pass');
  assert.match(u.body.data.rules.find((r) => r.id === 'DANGEROUS_GOODS').reason, /chưa có xác minh hàng nguy hiểm/);
  assert.equal(outcomes(await dg(unknown, allowed)).DANGEROUS_GOODS, 'PASS', 'a berth with the label takes any cargo, so no fact is needed');
  assert.equal(outcomes(await dg(danger, plain)).DANGEROUS_GOODS, 'VIOLATION');
  assert.equal(outcomes(await dg(danger, allowed)).DANGEROUS_GOODS, 'PASS');
  assert.equal(outcomes(await dg(none, plain)).DANGEROUS_GOODS, 'PASS');
  // The request cannot supply the fact: the field is refused, so "false" cannot declare a dangerous load safe.
  const forged = await dg(danger, plain, { dangerous_goods: false });
  assert.deepEqual([forged.status, forged.body.error.details.some((d) => d.field === 'dangerous_goods')], [400, true]);
  // Verification: only a coordinator, with a basis, audited; it changes the result.
  const noBasis = await call('PUT', `/voyages/${unknown}/cargo-hazard`, { body: { cargo_hazard: 'NONE' } });
  assert.equal(noBasis.status, 400);
  assert.equal((await call('PUT', `/voyages/${unknown}/cargo-hazard`, { who: 'manager', body: { cargo_hazard: 'NONE', basis: 'x' } })).status, 403);
  assert.equal((await call('PUT', `/voyages/${unknown}/cargo-hazard`, { who: 'agentA', body: { cargo_hazard: 'NONE', basis: 'x' } })).status, 403, 'an agent cannot certify its own cargo');
  const ok = await call('PUT', `/voyages/${unknown}/cargo-hazard`, { body: { cargo_hazard: 'NONE', basis: 'Danh mục hàng hóa số 42' } });
  assert.deepEqual([ok.status, ok.body.data.cargo_hazard, ok.body.data.cargo_hazard_basis], [200, 'NONE', 'Danh mục hàng hóa số 42']);
  assert.equal(outcomes(await dg(unknown, plain)).DANGEROUS_GOODS, 'PASS');
  const [row] = await auditRows('CARGO_HAZARD_VERIFY', unknown);
  assert.deepEqual([row.outcome, row.reason, JSON.parse(row.new_json).cargo_hazard], ['SUCCESS', 'Danh mục hàng hóa số 42', 'NONE']);
});

test('UC-026 inactive berths: an out-of-service berth is a violation that cannot be overridden; a deactivated berth is refused', { skip }, async () => {
  const b = await createBerth('k8'); const v = await queuedVoyage('k8');
  assert.equal((await call('PATCH', `/berths/${b.id}`, { body: { operational_status: 'OUT_OF_SERVICE' }, headers: { 'If-Match': '"1"' } })).status, 200);
  const r = await call('POST', '/berth-plan-checks', { body: placement(v, b.id) });
  assert.deepEqual([r.body.data.outcome, outcomes(r).BERTH_IN_SERVICE, r.body.data.overridable], ['VIOLATION', 'VIOLATION', false]);
  await q('UPDATE dbo.berths SET is_active = 0 WHERE id = @i', { i: b.id });
  const gone = await call('POST', '/berth-plan-checks', { body: placement(v, b.id) });
  assert.deepEqual([gone.status, gone.body.error.details[0].field], [400, 'berth_id']);
});

test('UC-026 6a: missing data gives MISSING_DATA, not a pass; wrong voyage or berth is refused', { skip }, async () => {
  const b = await createBerth('k6'); const v = await queuedVoyage('k6');
  const body = placement(v, b.id); delete body.required_cranes;
  const r = await call('POST', '/berth-plan-checks', { body });
  assert.deepEqual([r.body.data.outcome, r.body.data.passed, outcomes(r).CRANES], ['MISSING_DATA', false, 'MISSING_DATA']);
  const notQueued = await queuedVoyage('k6b', { status: 'ANNOUNCED' });
  const nq = await call('POST', '/berth-plan-checks', { body: placement(notQueued, b.id) });
  assert.deepEqual([nq.status, nq.body.error.details.rule], [409, 'VOYAGE_NOT_IN_QUEUE']);
  assert.equal((await call('POST', '/berth-plan-checks', { body: placement(v, 999999999) })).status, 400);
  assert.equal((await call('POST', '/berth-plan-checks', { body: placement(999999999, b.id) })).status, 400);
  assert.equal((await call('POST', '/berth-plan-checks', { body: placement(v, b.id, { planned_end: H(8) }) })).status, 400);
  assert.equal((await call('POST', '/berth-plan-checks', { who: 'yard', body: placement(v, b.id) })).status, 200, 'any role with M2 view may check');
});

test('UC-026 determinism: the same placement gives the same result every time', { skip }, async () => {
  const b = await createBerth('k7', { length_m: 600 }); const mine = await queuedVoyage('k7'); const o = await queuedVoyage('k7o');
  await plan(o, b.id, H(8), H(20), { start: 270, end: 400 });
  const bodies = Array.from({ length: 4 }, () => placement(mine, b.id));
  const results = await Promise.all(bodies.map((x) => call('POST', '/berth-plan-checks', { body: x })));
  const first = JSON.stringify(results[0].body.data);
  for (const r of results) assert.equal(JSON.stringify(r.body.data), first);
});
