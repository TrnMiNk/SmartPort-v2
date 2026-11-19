'use strict';

// Forward and rollback verification of migration 0008 (durable ETA prediction jobs) on a scratch database (SP_MIGRATION_TEST_DB, disposable).
// The test brings the database to the state before 0008 (the rollback refuses loudly when it would lose data), checks that old rows survive, checks the new
// constraints, checks that every kind of information blocks the rollback, and removes only its own rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { listMigrations, runMigrations } = require('../../src/db/migrate');

const DB = process.env.SP_MIGRATION_TEST_DB;
const skip = DB ? false : 'SP_MIGRATION_TEST_DB not set: migration 0008 verification not executed';
const DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE = '0008_eta_prediction_jobs.sql';
const down = () => fs.readFileSync(path.join(DIR, 'rollback', '0008_eta_prediction_jobs.down.sql'), 'utf8');

let ctx; let fx;
const q = async (text, params = {}) => { const req = ctx.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };
const rejects = (fn, re) => assert.rejects(fn, (e) => { assert.match(String(e.message), re, e.message); return true; });
const applyAll = () => runMigrations(ctx.pool, ctx.sql, listMigrations(DIR));
const applied = async () => (await q("SELECT COUNT(*) AS n FROM dbo.schema_migrations WHERE version = '0008'"))[0].n === 1;
const hasColumn = async (c) => (await q("SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('dbo.voyage_eta_predictions') AND name = @c", { c }))[0].n === 1;

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: DB }).db);
  ctx = { sql, pool: await connect() };
  await applyAll();
  if (await applied()) { await ctx.pool.request().batch(down()); await q("DELETE FROM dbo.schema_migrations WHERE version = '0008'"); }
}, { timeout: 120000 });

test.after(async () => {
  if (!ctx) return;
  await q(`UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE voyage_code LIKE 'M8-%';
           DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE voyage_code LIKE 'M8-%');
           DELETE FROM dbo.voyages WHERE voyage_code LIKE 'M8-%'; DELETE FROM dbo.ships WHERE ship_code = 'M8SHIP';
           DELETE FROM dbo.ports WHERE port_code = 'M8P'; DELETE FROM dbo.agents WHERE agent_code = 'M8A'; DELETE FROM dbo.ship_types WHERE type_code = 'M8T';`);
  await ctx.pool.close();
});

const voyage = async (code) => (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type)
  OUTPUT inserted.id VALUES (@s, @c, 'ANNOUNCED', @a, @p, '2033-01-01', 1, N'x')`, { s: fx.ship, c: code, a: fx.agent, p: fx.port }))[0].id;
const prediction = (voyageId, cols, vals, params = {}) => q(`INSERT INTO dbo.voyage_eta_predictions (voyage_id, declared_eta, input_hash, input_json, ${cols}) OUTPUT inserted.id
  VALUES (@v, '2033-01-01', REPLICATE('a', 64), N'{}', ${vals})`, { v: voyageId, ...params });

test('state before 0008: old predictions exist (AVAILABLE and UNAVAILABLE), PENDING does not', { skip }, async () => {
  assert.equal(await hasColumn('claim_token'), false);
  const t = (await q("INSERT INTO dbo.ship_types (type_code, type_name, cargo_class) OUTPUT inserted.id VALUES ('M8T', N'm8', 'CONTAINER')"))[0].id;
  fx = {
    port: (await q("INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('M8P', N'm8')"))[0].id,
    agent: (await q("INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('M8A', N'm8')"))[0].id,
  };
  fx.ship = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id VALUES ('M8SHIP', '2${String(100000 + Math.floor(Math.random() * 800000))}', N'm8', @t, 200, 30, 9, 50000)`, { t }))[0].id;
  fx.v1 = await voyage('M8-1'); fx.v2 = await voyage('M8-2'); fx.v3 = await voyage('M8-3');
  fx.oldOk = (await prediction(fx.v1, 'ai_status, predicted_eta, eta_deviation_h, eta_confidence, model_version', "'AVAILABLE', '2033-01-01T02:00:00', 2, 0.5, N'old-1'"))[0].id;
  fx.oldFail = (await prediction(fx.v2, 'ai_status, failure_reason', "'UNAVAILABLE', N'NOT_CONFIGURED'"))[0].id;
  await rejects(() => prediction(fx.v3, 'ai_status', "'PENDING'"), /CK_vep_status|CK_vep_result/);   // a result-less PENDING row breaks both old constraints; SQL Server may name either
  fx.before = await q('SELECT * FROM dbo.voyage_eta_predictions WHERE id IN (@a, @b) ORDER BY id', { a: fx.oldOk, b: fx.oldFail });
});

test('forward: 0008 applies; old rows are unchanged and take the defaults; PENDING is accepted only without a result; one pending row per voyage; effect and attempts are checked', { skip }, async () => {
  assert.deepEqual((await applyAll()).applied, [FILE]);
  const after = await q('SELECT * FROM dbo.voyage_eta_predictions WHERE id IN (@a, @b) ORDER BY id', { a: fx.oldOk, b: fx.oldFail });
  for (const [i, row] of after.entries()) {
    for (const key of Object.keys(fx.before[i])) assert.deepEqual(row[key], fx.before[i][key], `old column ${key} unchanged`);
    assert.deepEqual([row.completed_at, row.attempts, row.claim_token, row.claimed_until, row.queue_effect], [null, 0, null, null, null]);
  }
  fx.pending = (await prediction(fx.v3, 'ai_status', "'PENDING'"))[0].id;
  await rejects(() => prediction(fx.v3, 'ai_status', "'PENDING'"), /UX_vep_one_pending/);
  const v4 = await voyage('M8-4');
  await rejects(() => prediction(v4, 'ai_status, predicted_eta', "'PENDING', '2033-01-01T02:00:00'"), /CK_vep_result/);
  await rejects(() => prediction(v4, 'ai_status, failure_reason', "'PENDING', N'x'"), /CK_vep_result/);
  await rejects(() => prediction(v4, 'ai_status, completed_at', "'PENDING', SYSUTCDATETIME()"), /CK_vep_result/);
  await rejects(() => prediction(v4, 'ai_status, failure_reason, queue_effect', "'UNAVAILABLE', N'x', 'MOVED'"), /CK_vep_effect/);
  await rejects(() => prediction(v4, 'ai_status, failure_reason, attempts', "'UNAVAILABLE', N'x', -1"), /CK_vep_attempts/);
  await rejects(() => prediction(v4, 'ai_status', "'WAITING'"), /CK_vep_status/);
  await rejects(() => prediction(v4, 'ai_status, predicted_eta', "'AVAILABLE', '2033-01-01'"), /CK_vep_result/);
  // the run record may say PENDING
  await q("UPDATE dbo.voyage_eta_predictions SET claim_token = NEWID(), claimed_until = DATEADD(MINUTE, 1, SYSUTCDATETIME()), attempts = 1 WHERE id = @i", { i: fx.pending });
  assert.equal((await q("SELECT COUNT(*) AS n FROM sys.check_constraints WHERE name = 'CK_vvr_ai' AND definition LIKE '%PENDING%'"))[0].n, 1);
  assert.equal((await applyAll()).applied.length, 0, 'applying again does nothing');
});

test('rollback refuses while a PENDING row or any new information exists, changing nothing; it succeeds when only old-shape rows are left; re-apply gives the same checksum', { skip }, async () => {
  await rejects(() => ctx.pool.request().batch(down()), /Rollback 0008 blocked: PENDING ETA predictions exist/);
  assert.equal(await hasColumn('claim_token'), true, 'nothing was dropped');
  await q("UPDATE dbo.voyage_eta_predictions SET ai_status = 'UNAVAILABLE', failure_reason = N'TIMEOUT', claim_token = NULL, claimed_until = NULL WHERE id = @i", { i: fx.pending });   // finished, but it holds attempts
  await rejects(() => ctx.pool.request().batch(down()), /Rollback 0008 blocked: predictions hold completion, attempt or queue-effect information/);
  await q('UPDATE dbo.voyage_eta_predictions SET attempts = 0 WHERE id = @i', { i: fx.pending });
  await q("UPDATE dbo.voyage_eta_predictions SET queue_effect = 'UNCHANGED' WHERE id = @i", { i: fx.pending });
  await rejects(() => ctx.pool.request().batch(down()), /Rollback 0008 blocked: predictions hold completion/);
  await q('UPDATE dbo.voyage_eta_predictions SET queue_effect = NULL WHERE id = @i', { i: fx.pending });
  await ctx.pool.request().batch(down());
  await q("DELETE FROM dbo.schema_migrations WHERE version = '0008'");
  assert.equal(await hasColumn('claim_token'), false); assert.equal(await hasColumn('queue_effect'), false);
  const left = await q('SELECT id, ai_status FROM dbo.voyage_eta_predictions WHERE id IN (@a, @b, @c) ORDER BY id', { a: fx.oldOk, b: fx.oldFail, c: fx.pending });
  assert.deepEqual(left.map((r) => r.ai_status), ['AVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE'], 'every row survives the rollback');
  await rejects(() => prediction(fx.v1, 'ai_status', "'PENDING'"), /CK_vep_status/);
  assert.deepEqual((await applyAll()).applied, [FILE]);
  assert.equal((await q("SELECT checksum FROM dbo.schema_migrations WHERE version = '0008'"))[0].checksum.trim(), listMigrations(DIR).find((m) => m.version === '0008').checksum);
});
