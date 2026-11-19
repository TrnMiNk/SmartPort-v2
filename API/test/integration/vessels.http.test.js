'use strict';

// HTTP integration tests for UC-010, UC-011 and UC-013 against real SQL Server. Run only with SP_TEST_DB set to a
// disposable, migrated and seeded database. Rows created here are removed in `after` (only the ones this run made).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { createApp } = require('../../src/app');
const { createUser } = require('../../src/services/userProvisioning');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: vessel HTTP integration tests not executed';
const SUFFIX = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'long-enough-password-1';
const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };

let db; let server; let base;
let typeId; let agentA; let agentB; let portId;
const cookies = {};
const usernames = [];
const imos = [];
let imoCounter = 100000 + Math.floor(Math.random() * 700000);
const nextImo = () => { const v = '8' + String(imoCounter++).padStart(6, '0'); imos.push(v); return v; };

const q = async (text, params = {}) => {
  const req = db.pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(text)).recordset;
};

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const config = loadConfig({ SP_DB_NAME: TEST_DB });
  const { sql, connect } = createPool(config.db);
  db = { sql, pool: await connect() };
  server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const mk = async (table, cols, vals) => (await q(`INSERT INTO dbo.${table} (${cols}) OUTPUT inserted.id VALUES (${vals})`))[0].id;
  agentA = await mk('agents', 'agent_code, agent_name', `'TA_${SUFFIX}', N'Đại lý A ${SUFFIX}'`);
  agentB = await mk('agents', 'agent_code, agent_name', `'TB_${SUFFIX}', N'Đại lý B ${SUFFIX}'`);
  portId = await mk('ports', 'port_code, port_name', `'TP${SUFFIX}', N'Cảng thử ${SUFFIX}'`);

  const defs = { coord: ['DIEU_PHOI_VIEN'], agentA: ['DAI_LY_HANG_HAI', agentA], agentB: ['DAI_LY_HANG_HAI', agentB],
    tech: ['KY_THUAT_VIEN'], yard: ['NHAN_VIEN_KHO_BAI'], manager: ['BAN_QUAN_LY'], admin: ['QUAN_TRI_HE_THONG'] };
  for (const [key, [role, agentId]] of Object.entries(defs)) {
    const username = `t_v_${key}_${SUFFIX}`;
    usernames.push(username);
    await createUser(db, { username, displayName: `Test ${key}`, password: PASSWORD, roleCodes: [role], agentId: agentId ?? null });
    const res = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    cookies[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
}, { timeout: 90000 });

test.after(async () => {
  if (!db) return;
  const shipIds = (await q(`SELECT id FROM dbo.ships WHERE imo_number IN (${imos.map((i) => `'${i}'`).join(',') || "''"})`)).map((r) => r.id);
  if (shipIds.length) {
    const ids = shipIds.join(',');
    const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
    await q(`UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${ids});
             DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
             DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});`);
  }
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
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: cookies[who] } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 204 */ }
  return { status: res.status, body: json, etag: res.headers.get('etag') };
}

const shipBody = (over = {}) => ({ imo_number: nextImo(), ship_name: `MV ${SUFFIX}`, ship_type_id: typeId, flag_state: 'VN',
  operator_agent_id: agentA, length_overall_m: 180, beam_m: 30, max_draft_m: 10, deadweight_t: 20000, ...over });
const noticeBody = (shipId, over = {}) => ({ ship_id: shipId, voyage_code: `V${crypto.randomBytes(3).toString('hex')}`, agent_id: agentA,
  origin_port_id: portId, declared_eta: '2026-12-01T08:00:00+07:00', declared_teu: 120, cargo_type: 'Container', ...over });
const newShip = async (over) => (await call('POST', '/ships', { who: 'coord', body: shipBody(over) })).body.data;
const auditCount = async (action, outcome, entityId) => (await q(
  'SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = @a AND outcome = @o' + (entityId ? ' AND entity_id = @e' : ''),
  { a: action, o: outcome, ...(entityId ? { e: String(entityId) } : {}) }))[0].n;

// ---------------------------------------------------------------- UC-010 create
test('UC-010: a coordinator creates a vessel; the response, ETag and audit row are correct', { skip }, async () => {
  const body = shipBody();
  const res = await call('POST', '/ships', { who: 'coord', body });
  assert.equal(res.status, 201);
  const ship = res.body.data;
  assert.equal(ship.imo_number, body.imo_number);
  assert.equal(ship.ship_code, 'IMO' + body.imo_number);
  assert.equal(ship.is_active, true);
  assert.equal(ship.revision, 1);
  assert.equal(ship.ship_type_name.length > 0, true);
  assert.equal(ship.operator_agent_id, agentA);
  assert.equal(res.etag, '"1"');
  assert.equal(await auditCount('SHIP_CREATE', 'SUCCESS', ship.id), 1);
  const stored = (await call('GET', `/ships/${ship.id}`, { who: 'coord' })).body.data;
  assert.equal(stored.length_overall_m, 180);
});

test('UC-010: the same IMO cannot be created twice (409 with the field), and the refusal is audited', { skip }, async () => {
  const body = shipBody();
  assert.equal((await call('POST', '/ships', { who: 'coord', body })).status, 201);
  const before = await auditCount('SHIP_CREATE', 'FAILED');
  const dup = await call('POST', '/ships', { who: 'coord', body: { ...body, ship_name: 'Other name' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CONFLICT');
  assert.equal(dup.body.error.details.field, 'imo_number');
  assert.equal(await auditCount('SHIP_CREATE', 'FAILED'), before + 1);
});

test('UC-010: two simultaneous creates of one IMO produce exactly one vessel', { skip }, async () => {
  const body = shipBody();
  const results = await Promise.all([call('POST', '/ships', { who: 'coord', body }), call('POST', '/ships', { who: 'coord', body })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.ships WHERE imo_number = @i', { i: body.imo_number }))[0].n, 1);
});

test('UC-010: invalid input is refused with field errors and nothing is stored', { skip }, async () => {
  const body = shipBody({ imo_number: '12AB567', length_overall_m: 0, beam_m: -5, ship_name: '' });
  const res = await call('POST', '/ships', { who: 'coord', body });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  assert.deepEqual(res.body.error.details.map((d) => d.field).sort(), ['beam_m', 'imo_number', 'length_overall_m', 'ship_name']);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.ships WHERE imo_number = '12AB567'"))[0].n, 0);
});

test('UC-010: unknown fields (mass assignment) and unknown references are refused', { skip }, async () => {
  const forged = await call('POST', '/ships', { who: 'coord', body: shipBody({ is_active: false, revision: 50 }) });
  assert.equal(forged.status, 400);
  assert.deepEqual(forged.body.error.details.map((d) => d.field).sort(), ['is_active', 'revision']);
  const badType = await call('POST', '/ships', { who: 'coord', body: shipBody({ ship_type_id: 999999 }) });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.details[0].field, 'ship_type_id');
  const badAgent = await call('POST', '/ships', { who: 'coord', body: shipBody({ operator_agent_id: 999999 }) });
  assert.equal(badAgent.body.error.details[0].field, 'operator_agent_id');
});

test('UC-010: malformed JSON and an anonymous caller get the error contract, never SQL or stack text', { skip }, async () => {
  const bad = await fetch(base + '/api/v1/ships', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies.coord }, body: '{oops' });
  assert.equal(bad.status, 400);
  const anon = await call('POST', '/ships', { body: shipBody() });
  assert.equal(anon.status, 401);
  for (const res of [await bad.clone().text(), JSON.stringify(anon.body)]) assert.doesNotMatch(res, /dbo\.|SELECT|INSERT|at .*\.js|stack/i);
});

// ---------------------------------------------------------------- authorization (SRS matrix, server side)
test('authorization: roles outside the matrix cannot reach vessel endpoints; denials are audited', { skip }, async () => {
  const ship = await newShip();
  const before = await auditCount('SHIP_CREATE', 'DENIED');
  const cases = [
    ['tech', 'GET', '/ships', 403], ['tech', 'POST', '/ships', 403], ['tech', 'GET', '/voyages', 403], ['tech', 'GET', '/catalog/ports', 403],
    ['tech', 'GET', `/ships/${ship.id}`, 403],
    ['yard', 'GET', '/ships', 200], ['yard', 'GET', '/voyages', 200], ['yard', 'POST', '/ships', 403],
    ['yard', 'PATCH', `/ships/${ship.id}`, 403], ['yard', 'POST', `/ships/${ship.id}/deactivate`, 403],
    ['yard', 'POST', '/voyages', 403],
    ['manager', 'GET', '/ships', 200], ['manager', 'POST', '/ships', 403], ['manager', 'POST', '/voyages', 403],
    ['admin', 'GET', '/ships', 200], ['admin', 'POST', '/ships', 403], ['admin', 'PATCH', `/ships/${ship.id}`, 403],
    ['agentA', 'GET', '/ships', 200], ['agentA', 'POST', '/ships', 403], ['agentA', 'PATCH', `/ships/${ship.id}`, 403],
    ['agentA', 'POST', `/ships/${ship.id}/deactivate`, 403],
    [undefined, 'GET', '/ships', 401], [undefined, 'GET', '/voyages', 401], [undefined, 'GET', '/catalog/agents', 401],
  ];
  for (const [who, method, path, expected] of cases) {
    const res = await call(method, path, { who, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, expected, `${who ?? 'anonymous'} ${method} ${path}`);
  }
  assert.ok((await auditCount('SHIP_CREATE', 'DENIED')) >= before + 4, 'denied creates are written to the audit log');
});

// ---------------------------------------------------------------- UC-011 search, read, update, deactivate
test('UC-011: search by IMO prefix and name, paging, includeInactive, and LIKE wildcards are not interpreted', { skip }, async () => {
  const names = [1, 2, 3].map((n) => `Search${SUFFIX}-${n}`);
  const ships = [];
  for (const ship_name of names) ships.push(await newShip({ ship_name }));
  const byName = await call('GET', `/ships?search=Search${SUFFIX}`, { who: 'coord' });
  assert.equal(byName.body.data.total, 3);
  const page2 = await call('GET', `/ships?search=Search${SUFFIX}&size=2&page=1`, { who: 'coord' });
  assert.equal(page2.body.data.items.length, 1);
  assert.equal(page2.body.data.total, 3);
  assert.equal(page2.body.data.page, 1);
  const byImo = await call('GET', `/ships?search=${ships[0].imo_number}`, { who: 'coord' });
  assert.deepEqual(byImo.body.data.items.map((s) => s.id), [ships[0].id]);
  for (const wildcard of ['%25', '_', '%5B', '%5C']) {
    assert.equal((await call('GET', `/ships?search=${wildcard}`, { who: 'coord' })).body.data.total, 0, `search ${wildcard}`);
  }
  const none = await call('GET', `/ships?search=zzz-no-such-${SUFFIX}`, { who: 'coord' });
  assert.deepEqual(none.body.data.items, []);
  assert.equal(none.status, 200);
});

test('UC-011: invalid list parameters and malformed ids are refused or not found', { skip }, async () => {
  for (const qs of ['page=-1', 'size=0', 'size=101', 'size=abc', 'includeInactive=maybe']) {
    assert.equal((await call('GET', `/ships?${qs}`, { who: 'coord' })).status, 400, qs);
  }
  for (const id of ['abc', '0', '-3', '99999999999', '1.5', '999999999']) {
    assert.equal((await call('GET', `/ships/${id}`, { who: 'coord' })).status, 404, id);
  }
});

test('UC-011: update needs the current revision; stale, missing and duplicate-IMO cases are refused; history keeps old and new', { skip }, async () => {
  const ship = await newShip();
  const other = await newShip();
  const noHeader = await call('PATCH', `/ships/${ship.id}`, { who: 'coord', body: { ship_name: 'X' } });
  assert.equal(noHeader.status, 400);
  assert.equal(noHeader.body.error.details[0].field, 'If-Match');
  const ok = await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: 'Renamed', reason: 'Sửa tên' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.ship_name, 'Renamed');
  assert.equal(ok.body.data.revision, 2);
  assert.equal(ok.etag, '"2"');
  const stale = await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: 'Late' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.current_revision, 2);
  const dupImo = await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"2"' }, body: { imo_number: other.imo_number } });
  assert.equal(dupImo.status, 409);
  assert.equal(dupImo.body.error.details.field, 'imo_number');
  const invalid = await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"2"' }, body: { beam_m: 0 } });
  assert.equal(invalid.status, 400);
  assert.equal((await call('PATCH', '/ships/999999999', { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: 'x' } })).status, 404);
  const audit = (await q("SELECT old_json, new_json, reason FROM dbo.audit_events WHERE action = 'SHIP_UPDATE' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(ship.id) }))[0];
  assert.equal(JSON.parse(audit.old_json).ship_name, ship.ship_name);
  assert.equal(JSON.parse(audit.new_json).ship_name, 'Renamed');
  assert.equal(audit.reason, 'Sửa tên');
});

test('UC-011: two simultaneous updates with the same revision: one wins, one gets 409', { skip }, async () => {
  const ship = await newShip();
  const results = await Promise.all([
    call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: 'Racer A' } }),
    call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: 'Racer B' } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('UC-011: deactivation needs a reason and is refused while a voyage is unfinished; allowed once it is rejected or departed', { skip }, async () => {
  const ship = await newShip();
  const notice = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id) });
  assert.equal(notice.status, 201);
  const noReason = await call('POST', `/ships/${ship.id}/deactivate`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: {} });
  assert.equal(noReason.status, 400);
  const refused = await call('POST', `/ships/${ship.id}/deactivate`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { reason: 'Hết khai thác' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'BUSINESS_RULE_VIOLATION');
  assert.equal(refused.body.error.details.rule, 'SHIP_HAS_UNFINISHED_VOYAGE');
  assert.equal(refused.body.error.details.voyages[0].id, notice.body.data.id);
  assert.equal((await q('SELECT is_active FROM dbo.ships WHERE id = @i', { i: ship.id }))[0].is_active, true, 'unchanged');
  await q("UPDATE dbo.voyages SET status = 'REJECTED' WHERE id = @i", { i: notice.body.data.id });
  const done = await call('POST', `/ships/${ship.id}/deactivate`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { reason: 'Hết khai thác' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.is_active, false);
  assert.equal(done.body.data.revision, 2);
  const again = await call('POST', `/ships/${ship.id}/deactivate`, { who: 'coord', headers: { 'If-Match': '"2"' }, body: { reason: 'Lần nữa' } });
  assert.equal(again.body.error.details.rule, 'SHIP_ALREADY_INACTIVE');
  // Inactive vessels are hidden from the default list, shown on request, and cannot receive new notices (UC-011 BR-1).
  assert.equal((await call('GET', `/ships?search=${ship.imo_number}`, { who: 'coord' })).body.data.total, 0);
  assert.equal((await call('GET', `/ships?search=${ship.imo_number}&includeInactive=true`, { who: 'coord' })).body.data.total, 1);
  const blocked = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id) });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.rule, 'SHIP_INACTIVE');
});

test('UC-011 AC-1: the history lists every change with actor, reason and old and new values, oldest first', { skip }, async () => {
  const ship = await newShip({ ship_name: `Hist ${SUFFIX}` });
  await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: `Hist ${SUFFIX} B`, flag_state: 'SG', reason: 'Đổi tên và cờ' } });
  await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"2"' }, body: { length_overall_m: 200.5 } });
  await call('POST', `/ships/${ship.id}/deactivate`, { who: 'coord', headers: { 'If-Match': '"3"' }, body: { reason: 'Hết khai thác' } });
  const res = await call('GET', `/ships/${ship.id}/history`, { who: 'coord' });
  assert.equal(res.status, 200);
  const items = res.body.data.items;
  assert.deepEqual(items.map((i) => i.action), ['SHIP_CREATE', 'SHIP_UPDATE', 'SHIP_UPDATE', 'SHIP_DEACTIVATE']);
  assert.ok(items.every((i) => i.actor === `t_v_coord_${SUFFIX}` && i.at));
  assert.deepEqual(items[0].changes, []);
  assert.equal(items[1].reason, 'Đổi tên và cờ');
  assert.deepEqual(items[1].changes.map((c) => c.field).sort(), ['flag_state', 'ship_name']);
  assert.deepEqual(items[1].changes.find((c) => c.field === 'ship_name'), { field: 'ship_name', old: `Hist ${SUFFIX}`, new: `Hist ${SUFFIX} B` });
  assert.deepEqual(items[2].changes, [{ field: 'length_overall_m', old: 180, new: 200.5 }]);
  assert.deepEqual(items[3].changes, [{ field: 'is_active', old: true, new: false }]);
  assert.equal(items[3].reason, 'Hết khai thác');
  // refused attempts are audited but are not part of the history
  assert.equal((await call('PATCH', `/ships/${ship.id}`, { who: 'coord', headers: { 'If-Match': '"1"' }, body: { ship_name: 'late' } })).status, 409);
  assert.equal((await call('GET', `/ships/${ship.id}/history`, { who: 'coord' })).body.data.items.length, 4);
});

test('UC-011: the history follows the vessel visibility rules (agent scope, role matrix, bad ids)', { skip }, async () => {
  const mine = await newShip({ operator_agent_id: agentA });
  const theirs = await newShip({ operator_agent_id: agentB });
  assert.equal((await call('GET', `/ships/${mine.id}/history`, { who: 'agentA' })).status, 200);
  assert.equal((await call('GET', `/ships/${theirs.id}/history`, { who: 'agentA' })).status, 404);
  assert.equal((await call('GET', `/ships/${mine.id}/history`, { who: 'tech' })).status, 403);
  assert.equal((await call('GET', `/ships/${mine.id}/history`)).status, 401);
  assert.equal((await call('GET', '/ships/abc/history', { who: 'coord' })).status, 404);
  assert.equal((await call('GET', '/ships/999999999/history', { who: 'coord' })).status, 404);
});

// ---------------------------------------------------------------- UC-013 arrival notice
test('UC-013: a coordinator creates a notice: saved as ANNOUNCED, then validated automatically; history, audit, ETA instant', { skip }, async () => {
  const ship = await newShip();
  const res = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id, { voyage_code: 'V-2026/01', priority_class: 'MAIN_LINE' }) });
  assert.equal(res.status, 201);
  const v = res.body.data;
  // The vessel has no documents, so the seeded dev policy (registration and insurance required) gives MISSING_DOCUMENTS.
  assert.equal(v.status, 'MISSING_DOCUMENTS');
  assert.equal(v.validation.state, 'COMPLETED');
  assert.equal(v.validation.outcome, 'MISSING_DOCUMENTS');
  assert.equal(v.priority_class, 'MAIN_LINE');
  assert.equal(v.ship_id, ship.id);
  assert.equal(v.declared_eta, '2026-12-01T01:00:00.000Z', '08:00 at +07:00 is 01:00 UTC; no time-zone drift');
  assert.equal(v.declared_teu, 120);
  const detail = (await call('GET', `/voyages/${v.id}`, { who: 'coord' })).body.data;
  assert.deepEqual(detail.history.map((h) => [h.from_status, h.to_status]), [[null, 'ANNOUNCED'], ['ANNOUNCED', 'MISSING_DOCUMENTS']]);
  assert.equal(detail.history[0].actor, `t_v_coord_${SUFFIX}`);
  assert.equal(await auditCount('VOYAGE_CREATE', 'SUCCESS', v.id), 1);
});

test('UC-013: a duplicate notice (same vessel and voyage) is refused with the existing reference, also when simultaneous', { skip }, async () => {
  const ship = await newShip();
  const body = noticeBody(ship.id);
  const first = await call('POST', '/voyages', { who: 'coord', body });
  const dup = await call('POST', '/voyages', { who: 'coord', body: { ...body, declared_teu: 5 } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.details.existing_voyage_id, first.body.data.id);
  assert.equal(await auditCount('VOYAGE_CREATE', 'FAILED') > 0, true);
  const raceBody = noticeBody(ship.id);
  const race = await Promise.all([call('POST', '/voyages', { who: 'coord', body: raceBody }), call('POST', '/voyages', { who: 'coord', body: raceBody })]);
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id = @s AND voyage_code = @c', { s: ship.id, c: raceBody.voyage_code }))[0].n, 1);
  // The same voyage code on a different vessel is a different notice.
  const other = await newShip();
  assert.equal((await call('POST', '/voyages', { who: 'coord', body: { ...body, ship_id: other.id } })).status, 201);
});

test('UC-013: invalid notices are refused and nothing is stored', { skip }, async () => {
  const ship = await newShip();
  const bad = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id, { declared_eta: '2026-02-30T10:00:00Z', declared_teu: -1, cargo_type: '' }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['cargo_type', 'declared_eta', 'declared_teu']);
  const forged = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id, { status: 'BERTHED' }) });
  assert.equal(forged.status, 400);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id = @s', { s: ship.id }))[0].n, 0);
});

test('UC-013: unknown vessel, port and agent are refused with the right field', { skip }, async () => {
  const none = await call('POST', '/voyages', { who: 'coord', body: noticeBody(999999999) });
  assert.equal(none.status, 409);
  assert.equal(none.body.error.details.rule, 'SHIP_NOT_FOUND');
  const ship = await newShip();
  const port = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id, { origin_port_id: 999999 }) });
  assert.equal(port.status, 400);
  assert.equal(port.body.error.details[0].field, 'origin_port_id');
  const agent = await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id, { agent_id: 999999 }) });
  assert.equal(agent.body.error.details[0].field, 'agent_id');
});

test('UC-013: an agent may announce only for its own agent and its own vessels, and cannot set the priority', { skip }, async () => {
  const shipA = await newShip({ operator_agent_id: agentA });
  const shipB = await newShip({ operator_agent_id: agentB });
  const own = await call('POST', '/voyages', { who: 'agentA', body: noticeBody(shipA.id, { agent_id: agentA }) });
  assert.equal(own.status, 201);
  assert.equal(own.body.data.priority_class, 'STANDARD');
  const before = await auditCount('VOYAGE_CREATE', 'DENIED');
  const foreignShip = await call('POST', '/voyages', { who: 'agentA', body: noticeBody(shipB.id, { agent_id: agentA }) });
  assert.equal(foreignShip.status, 403);
  const foreignAgent = await call('POST', '/voyages', { who: 'agentA', body: noticeBody(shipA.id, { agent_id: agentB }) });
  assert.equal(foreignAgent.status, 403);
  assert.equal(await auditCount('VOYAGE_CREATE', 'DENIED'), before + 2);
  const priority = await call('POST', '/voyages', { who: 'agentA', body: noticeBody(shipA.id, { priority_class: 'REEFER_OR_HAZARD' }) });
  assert.equal(priority.status, 400);
  assert.equal(priority.body.error.details[0].field, 'priority_class');
  assert.equal((await call('POST', '/voyages', { who: 'agentA', body: noticeBody(shipA.id, { priority_class: 'STANDARD' }) })).status, 201);
});

test('agent scope on reads: vessels, voyages and agents of other agents are invisible (404, not 403)', { skip }, async () => {
  const shipA = await newShip({ operator_agent_id: agentA, ship_name: `Scope${SUFFIX}A` });
  const shipB = await newShip({ operator_agent_id: agentB, ship_name: `Scope${SUFFIX}B` });
  const vB = (await call('POST', '/voyages', { who: 'coord', body: noticeBody(shipB.id, { agent_id: agentB }) })).body.data;
  const vA = (await call('POST', '/voyages', { who: 'coord', body: noticeBody(shipA.id, { agent_id: agentA }) })).body.data;
  const ships = (await call('GET', `/ships?search=Scope${SUFFIX}`, { who: 'agentA' })).body.data;
  assert.deepEqual(ships.items.map((s) => s.id), [shipA.id]);
  assert.equal((await call('GET', `/ships/${shipB.id}`, { who: 'agentA' })).status, 404);
  assert.equal((await call('GET', `/ships/${shipA.id}`, { who: 'agentA' })).status, 200);
  assert.equal((await call('GET', `/voyages/${vB.id}`, { who: 'agentA' })).status, 404);
  assert.equal((await call('GET', `/voyages/${vA.id}`, { who: 'agentA' })).status, 200);
  const list = (await call('GET', '/voyages?size=100', { who: 'agentA' })).body.data.items;
  assert.ok(list.every((v) => v.agent_id === agentA), 'only voyages of its own agent');
  assert.ok(list.some((v) => v.id === vA.id));
  const agents = (await call('GET', '/catalog/agents', { who: 'agentA' })).body.data.items;
  assert.deepEqual(agents.map((a) => a.id), [agentA]);
  const all = (await call('GET', '/catalog/agents', { who: 'coord' })).body.data.items.map((a) => a.id);
  assert.ok(all.includes(agentA) && all.includes(agentB));
});

test('voyage list filters by status and vessel and validates its parameters', { skip }, async () => {
  const ship = await newShip();
  await call('POST', '/voyages', { who: 'coord', body: noticeBody(ship.id) });
  const byShip = (await call('GET', `/voyages?ship_id=${ship.id}`, { who: 'coord' })).body.data;
  assert.equal(byShip.total, 1);
  assert.equal(byShip.items[0].ship_name.length > 0, true);
  assert.equal((await call('GET', `/voyages?ship_id=${ship.id}&status=BERTHED`, { who: 'coord' })).body.data.total, 0);
  assert.equal((await call('GET', '/voyages?status=NOPE', { who: 'coord' })).status, 400);
  assert.equal((await call('GET', '/voyages?ship_id=x', { who: 'coord' })).status, 400);
});

test('catalogs: forms can load ship types, ports and agents; unauthorized roles cannot', { skip }, async () => {
  const types = (await call('GET', '/catalog/ship-types', { who: 'coord' })).body.data.items;
  assert.ok(types.some((t) => t.code === 'CONTAINER' && t.cargo_class === 'CONTAINER'));
  const ports = (await call('GET', '/catalog/ports', { who: 'agentA' })).body.data.items;
  assert.ok(ports.some((p) => p.id === portId));
  assert.equal((await call('GET', '/catalog/ports', { who: 'tech' })).status, 403);
});
