'use strict';

// Forward and rollback verification of migration 0006 (berth recommendations, per-vessel outcomes, human decisions) on a scratch database.
// Runs only when SP_MIGRATION_TEST_DB names a disposable database. The test first rolls 0006 back (the rollback refuses when it would lose data,
// so a leftover from a failed run fails loudly instead of deleting anything), then creates rows in the OLD shape, applies 0006 and checks that
// they survive, checks the new constraints, checks that each kind of data blocks the rollback, and finally removes only its own rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { listMigrations, runMigrations } = require('../../src/db/migrate');

const DB = process.env.SP_MIGRATION_TEST_DB;
const skip = DB ? false : 'SP_MIGRATION_TEST_DB not set: migration 0006 verification not executed';
const DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE = '0006_berth_recommendations.sql';
const down = () => fs.readFileSync(path.join(DIR, 'rollback', '0006_berth_recommendations.down.sql'), 'utf8');
const down0007 = () => fs.readFileSync(path.join(DIR, 'rollback', '0007_recommendation_provenance.down.sql'), 'utf8');
const FILE7 = '0007_recommendation_provenance.sql';

let ctx; let fx;
const q = async (text, params = {}) => { const req = ctx.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const columns = async (table) => (await q('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t)', { t: table })).map((r) => r.name);
const exists = async (name) => (await q('SELECT COUNT(*) AS n FROM sys.objects WHERE name = @n', { n: name }))[0].n === 1;
const rejects = (fn, re) => assert.rejects(fn, (e) => { assert.match(String(e.message), re, e.message); return true; });
const applyAll = () => runMigrations(ctx.pool, ctx.sql, listMigrations(DIR));
const rollback = () => ctx.pool.request().batch(down());

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: DB }).db);
  ctx = { sql, pool: await connect() };
  await applyAll();
  // 0007 depends on 0006, so it is rolled back first (both rollbacks refuse when they would lose data).
  if ((await q("SELECT COUNT(*) AS n FROM dbo.schema_migrations WHERE version = '0007'"))[0].n === 1) { await ctx.pool.request().batch(down0007()); await q("DELETE FROM dbo.schema_migrations WHERE version = '0007'"); }
  if (await exists('berth_plan_decisions')) { await rollback(); await q("DELETE FROM dbo.schema_migrations WHERE version = '0006'"); }
}, { timeout: 120000 });

test.after(async () => {
  if (!ctx) return;
  await q(`DELETE FROM dbo.berth_plan_decisions WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'M6-%');
           DELETE FROM dbo.berth_plans WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'M6-%');
           DELETE FROM dbo.berth_plan_inference_vessels WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'M6-%');
           DELETE FROM dbo.berth_plan_proposals WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'M6-%');
           DELETE FROM dbo.berth_plan_inferences WHERE request_json = N'{"mig6":true}';`);
  await q(`DELETE FROM dbo.voyages WHERE voyage_code LIKE 'M6-%'; DELETE FROM dbo.ships WHERE ship_code = 'M6SHIP'; DELETE FROM dbo.berths WHERE berth_code = 'M6B';
           DELETE FROM dbo.ports WHERE port_code = 'M6P'; DELETE FROM dbo.agents WHERE agent_code = 'M6A'; DELETE FROM dbo.ship_types WHERE type_code = 'M6T';`);
  await ctx.pool.close();
});

const voyage = async (code) => (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type)
  OUTPUT inserted.id VALUES (@s, @c, 'ANNOUNCED', @a, @p, '2033-01-01', 1, N'x')`, { s: fx.ship, c: code, a: fx.agent, p: fx.port }))[0].id;
const proposal = (inference, voyageId, rank) => q(`INSERT INTO dbo.berth_plan_proposals (inference_id, voyage_id, berth_id, rank_no, position_start_m, planned_start, planned_end, expected_wait_h, score, constraint_check_json)
  OUTPUT inserted.id VALUES (@i, @v, @b, @r, 0, '2033-01-01T00:00:00Z', '2033-01-01T10:00:00Z', 1, 0.5, N'{}')`, { i: inference, v: voyageId, b: fx.berth, r: rank });

test('state before 0006: the old tables hold one request and proposals in the old shape; a rank is unique per request', { skip }, async () => {
  assert.equal(await exists('berth_plan_decisions'), false);
  assert.equal((await columns('dbo.berth_plan_inferences')).includes('response_json'), false);
  const t = (await q("INSERT INTO dbo.ship_types (type_code, type_name, cargo_class) OUTPUT inserted.id VALUES ('M6T', N'm6', 'CONTAINER')"))[0].id;
  fx = {
    port: (await q("INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('M6P', N'm6')"))[0].id,
    agent: (await q("INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('M6A', N'm6')"))[0].id,
    berth: (await q("INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes) OUTPUT inserted.id VALUES ('M6B', N'm6', 'CONTAINER', 300, 12, 2)"))[0].id,
  };
  fx.ship = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id VALUES ('M6SHIP', '8${String(100000 + Math.floor(Math.random() * 800000))}', N'm6', @t, 200, 30, 9, 50000)`, { t }))[0].id;
  fx.v1 = await voyage('M6-1'); fx.v2 = await voyage('M6-2');
  fx.inference = (await q(`INSERT INTO dbo.berth_plan_inferences (model_version, ai_status, request_json) OUTPUT inserted.id VALUES (N'old-1', 'AVAILABLE', N'{"mig6":true}')`))[0].id;
  fx.p1 = (await proposal(fx.inference, fx.v1, 1))[0].id;
  await rejects(() => proposal(fx.inference, fx.v2, 1), /UQ_bpp_rank/);        // old rule: rank 1 only once per request
  fx.before = await q('SELECT * FROM dbo.berth_plan_inferences WHERE id = @i', { i: fx.inference });
  fx.pBefore = await q('SELECT * FROM dbo.berth_plan_proposals WHERE id = @i', { i: fx.p1 });
});

test('forward: 0006 applies; existing request and proposal are unchanged and take the defaults; rank is now unique per vessel', { skip }, async () => {
  assert.deepEqual((await applyAll()).applied, [FILE, FILE7]);
  const after = (await q('SELECT * FROM dbo.berth_plan_inferences WHERE id = @i', { i: fx.inference }))[0];
  for (const key of Object.keys(fx.before[0])) assert.deepEqual(after[key], fx.before[0][key], `inference column ${key} unchanged`);
  assert.deepEqual([after.engine_kind, after.snapshot_hash, after.response_json, after.duration_ms, after.completed_at], ['EXTERNAL_PROVIDER', null, null, null, null]);
  const p = (await q('SELECT * FROM dbo.berth_plan_proposals WHERE id = @i', { i: fx.p1 }))[0];
  for (const key of Object.keys(fx.pBefore[0])) assert.deepEqual(p[key], fx.pBefore[0][key], `proposal column ${key} unchanged`);
  assert.deepEqual([p.position_end_m, p.explanation_json], [null, null]);
  assert.equal((await proposal(fx.inference, fx.v2, 1)).length, 1, 'another vessel may now have its own rank 1 in the same request');
  await rejects(() => proposal(fx.inference, fx.v2, 1), /UQ_bpp_rank_vessel/);
  assert.equal(await exists('UQ_bpp_rank'), false);
  const again = await applyAll(); assert.deepEqual(again.applied, [], 'applying again does nothing');
});

test('new constraints: engine kind, JSON, hash, durations, outcomes, decisions and their links', { skip }, async () => {
  await rejects(() => q("INSERT INTO dbo.berth_plan_inferences (model_version, ai_status, request_json, engine_kind) VALUES (N'x', 'AVAILABLE', N'{\"mig6\":true}', 'MAGIC')"), /CK_bpi_engine/);
  await rejects(() => q("INSERT INTO dbo.berth_plan_inferences (model_version, ai_status, request_json, response_json) VALUES (N'x', 'AVAILABLE', N'{\"mig6\":true}', N'not json')"), /CK_bpi_response_json/);
  await rejects(() => q("INSERT INTO dbo.berth_plan_inferences (model_version, ai_status, request_json, snapshot_hash) VALUES (N'x', 'AVAILABLE', N'{\"mig6\":true}', REPLICATE('Z', 64))"), /CK_bpi_hash/);
  await rejects(() => q("INSERT INTO dbo.berth_plan_inferences (model_version, ai_status, request_json, duration_ms) VALUES (N'x', 'AVAILABLE', N'{\"mig6\":true}', -1)"), /CK_bpi_duration/);
  await q("UPDATE dbo.berth_plan_inferences SET engine_kind = 'LOCAL_OPTIMIZER', snapshot_hash = REPLICATE('a', 64), response_json = N'{}', duration_ms = 12, completed_at = SYSUTCDATETIME() WHERE id = @i", { i: fx.inference });
  const vessel = (outcome, over = '') => q(`INSERT INTO dbo.berth_plan_inference_vessels (inference_id, voyage_id, effective_eta, eta_source, outcome, candidates_considered, candidates_rejected, reasons_json${over ? ', ' + over.split('=')[0] : ''})
    VALUES (@i, @v, '2033-01-01', 'DECLARED', @o, 3, 1, N'[]'${over ? ', ' + over.split('=')[1] : ''})`, { i: fx.inference, v: fx.v1, o: outcome });
  await rejects(() => vessel('MAYBE'), /CK_bpiv_outcome/);
  await rejects(() => q("INSERT INTO dbo.berth_plan_inference_vessels (inference_id, voyage_id, effective_eta, eta_source, outcome, candidates_considered, candidates_rejected, reasons_json) VALUES (@i, @v, '2033-01-01', 'DECLARED', 'RECOMMENDED', 1, 2, N'[]')", { i: fx.inference, v: fx.v1 }), /CK_bpiv_counts/);
  await rejects(() => q("INSERT INTO dbo.berth_plan_inference_vessels (inference_id, voyage_id, effective_eta, eta_source, outcome, candidates_considered, candidates_rejected, reasons_json) VALUES (@i, @v, '2033-01-01', 'DECLARED', 'RECOMMENDED', 1, 0, N'oops')", { i: fx.inference, v: fx.v1 }), /CK_bpiv_reasons/);
  await vessel('RECOMMENDED');
  await rejects(() => vessel('UNSCHEDULABLE'), /UQ_bpiv_vessel/);
  await rejects(() => q('UPDATE dbo.berth_plan_proposals SET position_end_m = 0 WHERE id = @i', { i: fx.p1 }), /CK_bpp_end/);
  // Decisions: IGNORED has no plan or proposal; ACCEPTED and MODIFIED need both; one decision per plan; one IGNORED per vessel of a request.
  const decision = (d, over = {}) => q(`INSERT INTO dbo.berth_plan_decisions (inference_id, voyage_id, proposal_id, plan_id, decision, reason, decided_by_user_id) VALUES (@i, @v, @p, @pl, @d, @r, 1)`,
    { i: fx.inference, v: fx.v1, p: over.p ?? null, pl: over.pl ?? null, d, r: over.r ?? null });
  await rejects(() => decision('MAYBE'), /CK_bpd_decision/);
  await rejects(() => decision('IGNORED', { p: fx.p1 }), /CK_bpd_links/);
  await rejects(() => decision('ACCEPTED'), /CK_bpd_links/);
  await rejects(() => decision('IGNORED', { r: '   ' }), /CK_bpd_reason/);
  await decision('IGNORED', { r: 'Không phù hợp' });
  await rejects(() => decision('IGNORED'), /UX_bpd_ignore/);
  fx.plan = (await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, proposal_id, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json)
    OUTPUT inserted.id VALUES (@v, @b, 'DRAFT', 'AI', @p, 0, 100, '2033-01-01T00:00:00Z', '2033-01-01T10:00:00Z', 1, 15, N'MIG6', N'{}')`, { v: fx.v1, b: fx.berth, p: fx.p1 }))[0].id;
  await decision('ACCEPTED', { p: fx.p1, pl: fx.plan });
  await rejects(() => decision('MODIFIED', { p: fx.p1, pl: fx.plan }), /UX_bpd_plan/);
});

test('rollback refuses while any recommendation data exists (plan, decision, vessel outcome, proposal, request) and changes nothing; it succeeds once none is left', { skip }, async () => {
  await ctx.pool.request().batch(down0007()); await q("DELETE FROM dbo.schema_migrations WHERE version = '0007'");   // the later migration goes first
  const blocked = async (code) => { await rejects(rollback, new RegExp(code)); assert.equal(await exists('berth_plan_decisions'), true, 'nothing was dropped'); };
  await blocked('Rollback 0006 blocked: berth plans made from proposals exist');
  await q('DELETE FROM dbo.berth_plan_decisions WHERE inference_id = @i AND plan_id IS NOT NULL', { i: fx.inference });
  await q('DELETE FROM dbo.berth_plans WHERE id = @i', { i: fx.plan });
  await blocked('Rollback 0006 blocked: human decisions on recommendations exist');   // the IGNORED decision alone blocks
  await q('DELETE FROM dbo.berth_plan_decisions WHERE inference_id = @i', { i: fx.inference });
  await blocked('Rollback 0006 blocked: per-vessel recommendation outcomes exist');
  await q('DELETE FROM dbo.berth_plan_inference_vessels WHERE inference_id = @i', { i: fx.inference });
  await blocked('Rollback 0006 blocked: stored proposals exist');
  await q('DELETE FROM dbo.berth_plan_proposals WHERE inference_id = @i', { i: fx.inference });
  await blocked('Rollback 0006 blocked: stored recommendation requests exist');
  await q('DELETE FROM dbo.berth_plan_inferences WHERE id = @i', { i: fx.inference });
  await rollback();
  assert.equal(await exists('berth_plan_decisions'), false); assert.equal(await exists('berth_plan_inference_vessels'), false);
  assert.equal((await columns('dbo.berth_plan_inferences')).includes('response_json'), false);
  assert.equal((await columns('dbo.berth_plan_proposals')).includes('position_end_m'), false);
  assert.equal(await exists('UQ_bpp_rank'), true); assert.equal(await exists('UQ_bpp_rank_vessel'), false);
  await q("DELETE FROM dbo.schema_migrations WHERE version = '0006'");
});

test('re-apply after the rollback works and records the same checksum as the file', { skip }, async () => {
  assert.deepEqual((await applyAll()).applied, [FILE, FILE7]);
  const row = (await q("SELECT checksum FROM dbo.schema_migrations WHERE version = '0006'"))[0];
  assert.equal(row.checksum.trim(), listMigrations(DIR).find((m) => m.version === '0006').checksum);
  assert.equal(await exists('berth_plan_decisions'), true);
});
