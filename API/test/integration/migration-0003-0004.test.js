'use strict';

// Forward and rollback verification of migrations 0003 (override and cargo hazard), 0004 (no self-approval) and 0005 (BERTH_ASSIGNED and the
// queue exit history) on a scratch database. Runs only when SP_MIGRATION_TEST_DB names a disposable database (it is created empty and kept; nothing
// is dropped). The test first brings the database back to the state after 0002 by running the rollback files, which refuse to run when they would
// lose data, so a leftover from an earlier failed run makes the test fail loudly instead of deleting anything. Rows it creates are removed at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { listMigrations, runMigrations } = require('../../src/db/migrate');

const DB = process.env.SP_MIGRATION_TEST_DB;
const skip = DB ? false : 'SP_MIGRATION_TEST_DB not set: migration 0003/0004/0005 verification not executed';
const DIR = path.join(__dirname, '..', '..', 'migrations');
const down = (name) => fs.readFileSync(path.join(DIR, 'rollback', name), 'utf8');
const ROLLBACK_0003 = '0003_berth_plan_override_cargo_hazard.down.sql';
const ROLLBACK_0004 = '0004_berth_plan_no_self_approval.down.sql';
const ROLLBACK_0005 = '0005_voyage_berth_assigned.down.sql';
const ALL = ['0003_berth_plan_override_cargo_hazard.sql', '0004_berth_plan_no_self_approval.sql', '0005_voyage_berth_assigned.sql'];

let ctx;
const q = async (text, params = {}) => { const req = ctx.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const columns = async (table) => (await q('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t)', { t: table })).map((r) => r.name);
const constraint = async (name) => (await q('SELECT COUNT(*) AS n FROM sys.check_constraints WHERE name = @n', { n: name }))[0].n === 1;
const index = async (name) => (await q('SELECT COUNT(*) AS n FROM sys.indexes WHERE name = @n', { n: name }))[0].n === 1;
const rejects = (fn, re) => assert.rejects(fn, (e) => { assert.match(String(e.message), re, e.message); return true; });
const forget = (versions) => q(`DELETE FROM dbo.schema_migrations WHERE version IN (${versions.map((v) => `'${v}'`).join(',')})`);
const applyAll = () => runMigrations(ctx.pool, ctx.sql, listMigrations(DIR));
const nullable = async (table, column) => (await q('SELECT is_nullable FROM sys.columns WHERE object_id = OBJECT_ID(@t) AND name = @c', { t: table, c: column }))[0].is_nullable;

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: DB }).db);
  ctx = { sql, pool: await connect() };
  await applyAll();
  // Back to the state after 0002. The rollback files stop with an error if data would be lost.
  await ctx.pool.request().batch(down(ROLLBACK_0005));
  await ctx.pool.request().batch(down(ROLLBACK_0004));
  await ctx.pool.request().batch(down(ROLLBACK_0003));
  await forget(['0003', '0004', '0005']);
}, { timeout: 120000 });

test.after(async () => {
  if (!ctx) return;
  await q(`DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'MIG-%');
           DELETE FROM dbo.berth_plans WHERE policy_version = N'MIG-TEST'; DELETE FROM dbo.voyages WHERE voyage_code LIKE 'MIG-%'; DELETE FROM dbo.ships WHERE ship_code = 'MIGSHIP';
           DELETE FROM dbo.berths WHERE berth_code = 'MIGB'; DELETE FROM dbo.ports WHERE port_code = 'MIGP'; DELETE FROM dbo.agents WHERE agent_code = 'MIGA';
           DELETE FROM dbo.ship_types WHERE type_code = 'MIGT';`);
  await ctx.pool.close();
});

let fixture;
async function plan(voyageId, status, json, extra = {}) {
  return (await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version,
      constraint_check_json, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at) OUTPUT inserted.id
    VALUES (@v, @b, @st, 'MANUAL', 0, 100, '2033-01-01T00:00:00Z', '2033-01-01T10:00:00Z', 1, 15, N'MIG-TEST', @j, 1, SYSUTCDATETIME(), @ap, ${extra.approved ? 'SYSUTCDATETIME()' : 'NULL'})`,
  { v: voyageId, b: fixture.berth, st: status, j: json, ap: extra.approved ?? null }))[0].id;
}
const voyage = async (code) => (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type)
  OUTPUT inserted.id VALUES (@s, @c, 'ANNOUNCED', @a, @p, '2033-01-01', 1, N'x')`, { s: fixture.ship, c: code, a: fixture.agent, p: fixture.port }))[0].id;
const waiting = async (code, position) => (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at,
  validation_result, validated_at, validation_policy_version) OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, '2033-01-01', 1, N'x', @pos, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V')`,
{ s: fixture.ship, c: code, a: fixture.agent, p: fixture.port, pos: position }))[0].id;

test('state after 0002: existing plans, queued voyages and queue history are accepted by the original rules', { skip }, async () => {
  assert.equal(await constraint('CK_bp_reviewed'), true);
  assert.equal((await columns('dbo.berth_plans')).includes('override_by_user_id'), false);
  assert.equal((await columns('dbo.voyage_queue_changes')).includes('change_type'), false);
  const t = (await q("INSERT INTO dbo.ship_types (type_code, type_name, cargo_class) OUTPUT inserted.id VALUES ('MIGT', N'mig', 'CONTAINER')"))[0].id;
  fixture = {
    port: (await q("INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('MIGP', N'mig')"))[0].id,
    agent: (await q("INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('MIGA', N'mig')"))[0].id,
    berth: (await q("INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes) OUTPUT inserted.id VALUES ('MIGB', N'mig', 'CONTAINER', 300, 12, 2)"))[0].id,
  };
  fixture.ship = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id VALUES ('MIGSHIP', '9${String(100000 + Math.floor(Math.random() * 800000))}', N'mig', @t, 200, 30, 10, 1000)`, { t }))[0].id;
  fixture.pending = await plan(await voyage('MIG-1'), 'PENDING_APPROVAL', '{"passed":true,"outcome":"PASS"}');
  fixture.approved = await plan(await voyage('MIG-2'), 'APPROVED', '{"passed":true,"outcome":"PASS"}', { approved: 2 });
  fixture.queued = await waiting('MIG-Q1', 1);
  fixture.queued2 = await waiting('MIG-Q2', 2);
  await q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, reason, actor) VALUES (@v, 2, 1, N'đổi thứ tự', N'mig')", { v: fixture.queued });
  const vx = await voyage('MIG-X');
  await rejects(() => plan(vx, 'PENDING_APPROVAL', '{"passed":false,"outcome":"VIOLATION"}'), /CK_bp_reviewed/);
  await rejects(() => q("UPDATE dbo.voyages SET status = 'BERTH_ASSIGNED', queue_position = NULL WHERE id = @i", { i: fixture.queued }), /CK_voyages_status/);   // the state does not exist yet
  fixture.before = await q('SELECT * FROM dbo.berth_plans WHERE id IN (@a, @b) ORDER BY id', { a: fixture.pending, b: fixture.approved });
  fixture.voyagesBefore = await q('SELECT * FROM dbo.voyages WHERE voyage_code LIKE \'MIG-%\' ORDER BY id');
  fixture.changesBefore = await q('SELECT * FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: fixture.queued });
});

test('forward: 0003, 0004 and 0005 apply and keep every existing plan, voyage and queue history row unchanged', { skip }, async () => {
  const result = await applyAll();
  assert.deepEqual(result.applied, ALL);
  const after = await q('SELECT * FROM dbo.berth_plans WHERE id IN (@a, @b) ORDER BY id', { a: fixture.pending, b: fixture.approved });
  for (const [i, row] of after.entries()) {
    for (const key of Object.keys(fixture.before[i])) assert.deepEqual(row[key], fixture.before[i][key], `existing plan column ${key} is unchanged`);
    assert.deepEqual([row.override_reason, row.override_by_user_id, row.override_at, row.override_rules], [null, null, null, null]);
  }
  assert.deepEqual(await q('SELECT * FROM dbo.voyages WHERE voyage_code LIKE \'MIG-%\' ORDER BY id').then((rows) => rows.map((r) => ({ ...r, cargo_hazard: undefined, cargo_hazard_basis: undefined, cargo_hazard_verified_by_user_id: undefined, cargo_hazard_verified_at: undefined }))),
    fixture.voyagesBefore.map((r) => ({ ...r, cargo_hazard: undefined, cargo_hazard_basis: undefined, cargo_hazard_verified_by_user_id: undefined, cargo_hazard_verified_at: undefined })), 'voyages are unchanged');
  const changes = await q('SELECT * FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: fixture.queued });
  for (const key of Object.keys(fixture.changesBefore[0])) assert.deepEqual(changes[0][key], fixture.changesBefore[0][key], `queue history column ${key} is unchanged`);
  assert.equal(changes[0].change_type, 'MOVE', 'existing queue history becomes MOVE');
  for (const c of ['CK_bp_reviewed', 'CK_bp_override_set', 'CK_bp_no_self_approval', 'CK_voyages_cargo_hazard']) assert.equal(await constraint(c), true, c);
  assert.equal(await index('UX_bp_draft_per_voyage'), true);
  assert.equal(await nullable('dbo.voyage_queue_changes', 'to_position'), true);
  assert.deepEqual((await applyAll()).applied, [], 'applying again does nothing');
});

test('forward: the new rules hold in the database', { skip }, async () => {
  const v = await voyage('MIG-3');
  const withOverride = (status, json) => q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version,
      constraint_check_json, submitted_by_user_id, submitted_at, override_reason, override_by_user_id, override_at, override_rules) OUTPUT inserted.id
    VALUES (@v, @b, @st, 'MANUAL', 0, 100, '2033-02-01T00:00:00Z', '2033-02-01T10:00:00Z', 1, 15, N'MIG-TEST', @j, 1, SYSUTCDATETIME(), N'lý do', 1, SYSUTCDATETIME(), N'["X"]')`, { v, b: fixture.berth, st: status, j: json });
  await rejects(() => plan(v, 'PENDING_APPROVAL', '{"passed":false,"outcome":"VIOLATION"}'), /CK_bp_reviewed/);
  await rejects(() => withOverride('PENDING_APPROVAL', '{"passed":false,"outcome":"MISSING_DATA"}'), /CK_bp_reviewed/);
  await rejects(() => q("INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, cargo_hazard) VALUES (@s, 'MIG-H', 'ANNOUNCED', @a, @p, '2033-01-01', 1, N'x', 'NONE')", { s: fixture.ship, a: fixture.agent, p: fixture.port }), /CK_voyages_cargo_hazard/);
  await rejects(() => q('UPDATE dbo.berth_plans SET approved_by_user_id = submitted_by_user_id, approved_at = SYSUTCDATETIME(), plan_status = \'APPROVED\' WHERE id = @i', { i: fixture.pending }), /CK_bp_no_self_approval/);
  fixture.overridden = (await withOverride('PENDING_APPROVAL', '{"passed":false,"outcome":"VIOLATION"}'))[0].id;
  assert.ok(fixture.overridden, 'a valid override is accepted');
});

test('0005 rules: BERTH_ASSIGNED has no queue position and a validation result; BERTHED still needs the ATA; the queue exit is recorded without a new position', { skip }, async () => {
  const assign = (id, extra = '') => q(`UPDATE dbo.voyages SET status = 'BERTH_ASSIGNED' ${extra} WHERE id = @i`, { i: id });
  await rejects(() => assign(fixture.queued), /CK_voyages_queue_state/);                         // still carries its queue position
  await rejects(() => q("UPDATE dbo.voyages SET status = 'BERTH_ASSIGNED', queue_position = NULL, validation_result = NULL WHERE id = @i", { i: fixture.queued }), /CK_voyages_valid_result/);
  await assign(fixture.queued, ', queue_position = NULL');                                       // accepted; history rows survive
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @i', { i: fixture.queued }))[0].status, 'BERTH_ASSIGNED');
  await rejects(() => q("UPDATE dbo.voyages SET status = 'BERTHED' WHERE id = @i", { i: fixture.queued }), /CK_voyages_ata/);
  await q("UPDATE dbo.voyages SET status = 'BERTHED', ata = SYSUTCDATETIME() WHERE id = @i", { i: fixture.queued });   // UC-022 later: BERTH_ASSIGNED to BERTHED with an ATA
  await q("UPDATE dbo.voyages SET status = 'BERTH_ASSIGNED', ata = NULL WHERE id = @i", { i: fixture.queued });          // back, so the rollback checks below can use it
  await rejects(() => q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, change_type, reason, actor) VALUES (@v, 1, NULL, 'MOVE', N'x', N'mig')", { v: fixture.queued }), /CK_vqc_positions/);
  await rejects(() => q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, change_type, reason, actor) VALUES (@v, 1, 2, 'LEFT_QUEUE', N'x', N'mig')", { v: fixture.queued }), /CK_vqc_positions/);
  await rejects(() => q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, change_type, reason, actor) VALUES (@v, NULL, NULL, 'LEFT_QUEUE', N'x', N'mig')", { v: fixture.queued }), /CK_vqc_positions/);
  await rejects(() => q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, change_type, reason, actor) VALUES (@v, 1, NULL, 'OTHER', N'x', N'mig')", { v: fixture.queued }), /CK_vqc_positions/);
  await q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, change_type, reason, actor) VALUES (@v, 1, NULL, 'LEFT_QUEUE', N'kế hoạch được duyệt', N'mig')", { v: fixture.queued });
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v", { v: fixture.queued }))[0].n, 2, 'history keeps the move and the exit');
});

test('rollback 0005 is refused while BERTH_ASSIGNED voyages or queue exits exist, changes nothing, then succeeds and keeps the older data', { skip }, async () => {
  await rejects(() => ctx.pool.request().batch(down(ROLLBACK_0005)), /Rollback 0005 blocked: voyages in state BERTH_ASSIGNED/);
  assert.equal(await nullable('dbo.voyage_queue_changes', 'to_position'), true, 'nothing was rolled back');
  await q("UPDATE dbo.voyages SET status = 'WAITING_BERTH', queue_position = 1 WHERE id = @i", { i: fixture.queued });
  await rejects(() => ctx.pool.request().batch(down(ROLLBACK_0005)), /Rollback 0005 blocked: queue history rows of type LEFT_QUEUE/);
  assert.equal((await columns('dbo.voyage_queue_changes')).includes('change_type'), true);
  await q("DELETE FROM dbo.voyage_queue_changes WHERE voyage_id = @v AND change_type = 'LEFT_QUEUE'", { v: fixture.queued });
  await ctx.pool.request().batch(down(ROLLBACK_0005));
  assert.equal((await columns('dbo.voyage_queue_changes')).includes('change_type'), false);
  assert.equal(await nullable('dbo.voyage_queue_changes', 'to_position'), false);
  await rejects(() => q("UPDATE dbo.voyages SET status = 'BERTH_ASSIGNED', queue_position = NULL WHERE id = @i", { i: fixture.queued }), /CK_voyages_status/);   // the original rule is back
  await rejects(() => q("INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, reason, actor) VALUES (@v, 1, NULL, N'x', N'mig')", { v: fixture.queued }), /to_position|NULL/i);
  const changes = await q('SELECT * FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: fixture.queued });
  assert.deepEqual(changes.map((c) => [c.from_position, c.to_position, c.reason]), [[2, 1, 'đổi thứ tự']], 'the original queue history survived');
  await forget(['0005']);
});

test('rollback 0003 is refused while it would lose data, and changes nothing', { skip }, async () => {
  await ctx.pool.request().batch(down(ROLLBACK_0004));      // removes only a constraint
  assert.equal(await constraint('CK_bp_no_self_approval'), false);
  await rejects(() => ctx.pool.request().batch(down(ROLLBACK_0003)), /Rollback 0003 blocked: berth plans with an override/);
  assert.equal(await constraint('CK_bp_override_set'), true, 'nothing was rolled back');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE id = @i', { i: fixture.overridden }))[0].n, 1);
  await q('DELETE FROM dbo.berth_plans WHERE id = @i', { i: fixture.overridden });
  await q("UPDATE dbo.voyages SET cargo_hazard = 'NONE', cargo_hazard_basis = N'cơ sở', cargo_hazard_verified_by_user_id = 1, cargo_hazard_verified_at = SYSUTCDATETIME() WHERE voyage_code = 'MIG-1'");
  await rejects(() => ctx.pool.request().batch(down(ROLLBACK_0003)), /Rollback 0003 blocked: voyages with a verified cargo hazard/);
  assert.equal((await columns('dbo.voyages')).includes('cargo_hazard'), true, 'the hazard data is still there');
  await q("UPDATE dbo.voyages SET cargo_hazard = NULL, cargo_hazard_basis = NULL, cargo_hazard_verified_by_user_id = NULL, cargo_hazard_verified_at = NULL WHERE voyage_code = 'MIG-1'");
});

test('rollback: with no such data it restores the original rules and keeps every plan and voyage; then all three migrations apply again', { skip }, async () => {
  await ctx.pool.request().batch(down(ROLLBACK_0003));
  assert.deepEqual([await constraint('CK_bp_override_set'), await constraint('CK_voyages_cargo_hazard'), await index('UX_bp_draft_per_voyage'), await constraint('CK_bp_reviewed')], [false, false, false, true]);
  assert.equal((await columns('dbo.berth_plans')).includes('override_rules'), false);
  assert.equal((await columns('dbo.voyages')).includes('cargo_hazard'), false);
  const after = await q('SELECT * FROM dbo.berth_plans WHERE id IN (@a, @b) ORDER BY id', { a: fixture.pending, b: fixture.approved });
  for (const [i, row] of after.entries()) for (const key of Object.keys(row)) assert.deepEqual(row[key], fixture.before[i][key], `plan column ${key} survived the rollback`);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyages WHERE voyage_code LIKE 'MIG-%' AND status = 'WAITING_BERTH'"))[0].n, 2, 'the queued voyages are intact');
  const v4 = await voyage('MIG-4');
  await rejects(() => plan(v4, 'PENDING_APPROVAL', '{"passed":false,"outcome":"VIOLATION"}'), /CK_bp_reviewed/);   // original rule is back
  await forget(['0003', '0004']);
  assert.deepEqual((await applyAll()).applied, ALL);
  assert.equal(await constraint('CK_bp_no_self_approval'), true);
  assert.equal(await nullable('dbo.voyage_queue_changes', 'to_position'), true);
});
