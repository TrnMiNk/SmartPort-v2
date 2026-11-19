'use strict';

// Forward and rollback verification of migration 0007 (recommendation provenance) on a scratch database (SP_MIGRATION_TEST_DB, disposable).
// Plans made from a LOCAL optimizer proposal were stored with source AI / AI_ADJUSTED by migration 0006; 0007 relabels exactly those and leaves every
// other row alone. The rollback refuses while the old schema could not express the data. The test removes only its own rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { listMigrations, runMigrations } = require('../../src/db/migrate');

const DB = process.env.SP_MIGRATION_TEST_DB;
const skip = DB ? false : 'SP_MIGRATION_TEST_DB not set: migration 0007 verification not executed';
const DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE = '0007_recommendation_provenance.sql';
const down = () => fs.readFileSync(path.join(DIR, 'rollback', '0007_recommendation_provenance.down.sql'), 'utf8');

let ctx; let fx;
const q = async (text, params = {}) => { const req = ctx.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const rejects = (fn, re) => assert.rejects(fn, (e) => { assert.match(String(e.message), re, e.message); return true; });
const applyAll = () => runMigrations(ctx.pool, ctx.sql, listMigrations(DIR));
const applied0007 = async () => (await q("SELECT COUNT(*) AS n FROM dbo.schema_migrations WHERE version = '0007'"))[0].n === 1;
const sourceLength = async () => (await q("SELECT max_length AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.berth_plans') AND name = 'source'"))[0].n;

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: DB }).db);
  ctx = { sql, pool: await connect() };
  await applyAll();
  if (await applied0007()) { await ctx.pool.request().batch(down()); await q("DELETE FROM dbo.schema_migrations WHERE version = '0007'"); }   // refuses loudly on leftovers
}, { timeout: 120000 });

test.after(async () => {
  if (!ctx) return;
  await q(`DELETE FROM dbo.berth_plans WHERE policy_version = N'MIG7';
           DELETE FROM dbo.berth_plan_proposals WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'M7-%');
           DELETE FROM dbo.berth_plan_inferences WHERE request_json = N'{"mig7":true}';
           DELETE FROM dbo.audit_events WHERE actor = N'migration:0007' AND reason LIKE N'%Relabelled 2 plans%' AND occurred_at > DATEADD(HOUR, -2, SYSUTCDATETIME());
           DELETE FROM dbo.voyages WHERE voyage_code LIKE 'M7-%'; DELETE FROM dbo.ships WHERE ship_code = 'M7SHIP'; DELETE FROM dbo.berths WHERE berth_code = 'M7B';
           DELETE FROM dbo.ports WHERE port_code = 'M7P'; DELETE FROM dbo.agents WHERE agent_code = 'M7A'; DELETE FROM dbo.ship_types WHERE type_code = 'M7T';`);
  await ctx.pool.close();
});

const voyage = async (code) => (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type)
  OUTPUT inserted.id VALUES (@s, @c, 'ANNOUNCED', @a, @p, '2033-01-01', 1, N'x')`, { s: fx.ship, c: code, a: fx.agent, p: fx.port }))[0].id;
const inference = async (engine) => (await q(`INSERT INTO dbo.berth_plan_inferences (model_version, ai_status, request_json, engine_kind) OUTPUT inserted.id VALUES (N'm7', 'AVAILABLE', N'{"mig7":true}', @e)`, { e: engine }))[0].id;
const proposal = async (inf, v) => (await q(`INSERT INTO dbo.berth_plan_proposals (inference_id, voyage_id, berth_id, rank_no, position_start_m, planned_start, planned_end, expected_wait_h, score, constraint_check_json)
  OUTPUT inserted.id VALUES (@i, @v, @b, 1, 0, '2033-01-01T00:00:00Z', '2033-01-01T10:00:00Z', 1, 0.5, N'{}')`, { i: inf, v, b: fx.berth }))[0].id;
const plan = async (v, source, proposalId) => (await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, proposal_id, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json)
  OUTPUT inserted.id VALUES (@v, @b, 'DRAFT', @s, @p, 0, 100, '2033-01-01T00:00:00Z', '2033-01-01T10:00:00Z', 1, 15, N'MIG7', N'{}')`, { v, b: fx.berth, s: source, p: proposalId ?? null }))[0].id;
const sourceOf = async (id) => (await q('SELECT source FROM dbo.berth_plans WHERE id = @i', { i: id }))[0].source;

test('state before 0007: plans from a local proposal carry AI or AI_ADJUSTED; the provenance values do not exist yet', { skip }, async () => {
  const t = (await q("INSERT INTO dbo.ship_types (type_code, type_name, cargo_class) OUTPUT inserted.id VALUES ('M7T', N'm7', 'CONTAINER')"))[0].id;
  fx = {
    port: (await q("INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('M7P', N'm7')"))[0].id,
    agent: (await q("INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('M7A', N'm7')"))[0].id,
    berth: (await q("INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes) OUTPUT inserted.id VALUES ('M7B', N'm7', 'CONTAINER', 300, 12, 2)"))[0].id,
  };
  fx.ship = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id VALUES ('M7SHIP', '6${String(100000 + Math.floor(Math.random() * 800000))}', N'm7', @t, 200, 30, 9, 50000)`, { t }))[0].id;
  assert.equal(await sourceLength(), 20);
  const vs = []; for (let i = 1; i <= 5; i += 1) vs.push(await voyage(`M7-${i}`));
  const local = await inference('LOCAL_OPTIMIZER'); const external = await inference('EXTERNAL_PROVIDER');
  fx.local = await inference('LOCAL_OPTIMIZER');
  fx.pLocal1 = await proposal(local, vs[0]); fx.pLocal2 = await proposal(local, vs[1]); fx.pExt = await proposal(external, vs[2]);
  fx.planLocalAi = await plan(vs[0], 'AI', fx.pLocal1); fx.planLocalAdj = await plan(vs[1], 'AI_ADJUSTED', fx.pLocal2);
  fx.planExtAi = await plan(vs[2], 'AI', fx.pExt); fx.planManual = await plan(vs[3], 'MANUAL', null);
  await rejects(() => plan(vs[4], 'LOCAL_OPTIMIZER', fx.pLocal1), /CK_bp_source/);
  await rejects(() => inference('EXTERNAL_AI'), /CK_bpi_engine/);
  fx.vs = vs;
});

test('forward: only plans that came from a LOCAL_OPTIMIZER request are relabelled; external, manual and every other column stay; one audit row records the count', { skip }, async () => {
  const before = await q('SELECT * FROM dbo.berth_plans WHERE id IN (@a, @b, @c, @d) ORDER BY id', { a: fx.planLocalAi, b: fx.planLocalAdj, c: fx.planExtAi, d: fx.planManual });
  assert.deepEqual((await applyAll()).applied, [FILE]);
  assert.deepEqual([await sourceOf(fx.planLocalAi), await sourceOf(fx.planLocalAdj), await sourceOf(fx.planExtAi), await sourceOf(fx.planManual)], ['LOCAL_OPTIMIZER', 'LOCAL_OPTIMIZER_ADJUSTED', 'AI', 'MANUAL']);
  const after = await q('SELECT * FROM dbo.berth_plans WHERE id IN (@a, @b, @c, @d) ORDER BY id', { a: fx.planLocalAi, b: fx.planLocalAdj, c: fx.planExtAi, d: fx.planManual });
  for (const [i, row] of after.entries()) for (const key of Object.keys(before[i])) if (key !== 'source') assert.deepEqual(row[key], before[i][key], `column ${key} unchanged`);
  assert.equal(await sourceLength(), 30);
  const audit = await q("SELECT TOP 1 reason FROM dbo.audit_events WHERE actor = N'migration:0007' ORDER BY id DESC");
  assert.match(audit[0].reason, /Relabelled \d+ plans from AI to LOCAL_OPTIMIZER/);
  assert.equal((await applyAll()).applied.length, 0, 'applying again does nothing');
});

test('new constraints: the five sources, a proposal for every non-manual source, EXTERNAL_AI requests, historical EXTERNAL_PROVIDER rows stay valid', { skip }, async () => {
  const v = await voyage('M7-6');
  await rejects(() => plan(v, 'LOCAL_OPTIMIZER', null), /CK_bp_source_proposal/);
  await rejects(() => plan(v, 'MANUAL', fx.pLocal1), /CK_bp_source_proposal/);
  await rejects(() => plan(v, 'MAGIC', fx.pLocal1), /CK_bp_source/);
  fx.planNew = await plan(v, 'LOCAL_OPTIMIZER_ADJUSTED', fx.pLocal1);
  assert.equal(await sourceOf(fx.planNew), 'LOCAL_OPTIMIZER_ADJUSTED');
  fx.infExternal = await inference('EXTERNAL_AI');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plan_inferences WHERE id = @i AND engine_kind = \'EXTERNAL_PROVIDER\'', { i: (await q('SELECT TOP 1 id FROM dbo.berth_plan_inferences WHERE request_json = N\'{"mig7":true}\' AND engine_kind = \'EXTERNAL_PROVIDER\'', {}))[0].id }))[0].n, 1);
});

test('rollback refuses while a LOCAL_OPTIMIZER plan or an EXTERNAL_AI request exists, changing nothing; it succeeds once they are gone; re-apply works with the same checksum', { skip }, async () => {
  await rejects(() => ctx.pool.request().batch(down()), /Rollback 0007 blocked: plans with source LOCAL_OPTIMIZER/);
  assert.equal(await sourceLength(), 30, 'nothing changed');
  await q('DELETE FROM dbo.berth_plans WHERE id IN (@a, @b, @c)', { a: fx.planLocalAi, b: fx.planLocalAdj, c: fx.planNew });
  await rejects(() => ctx.pool.request().batch(down()), /Rollback 0007 blocked: recommendation requests with engine_kind EXTERNAL_AI/);
  await q('DELETE FROM dbo.berth_plan_inferences WHERE id = @i', { i: fx.infExternal });
  await ctx.pool.request().batch(down());
  await q("DELETE FROM dbo.schema_migrations WHERE version = '0007'");
  assert.equal(await sourceLength(), 20);
  assert.equal(await sourceOf(fx.planExtAi), 'AI', 'the external-AI plan and the manual plan survive the rollback');
  await rejects(() => plan(fx.vs[4], 'LOCAL_OPTIMIZER', fx.pLocal1), /CK_bp_source/);
  assert.deepEqual((await applyAll()).applied, [FILE]);
  assert.equal((await q("SELECT checksum FROM dbo.schema_migrations WHERE version = '0007'"))[0].checksum.trim(), listMigrations(DIR).find((m) => m.version === '0007').checksum);
});
