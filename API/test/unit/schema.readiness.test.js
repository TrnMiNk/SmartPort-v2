'use strict';

// A1 regression: the API must refuse to start against a schema that does not match the migrations this code ships.
// Uses a fake pool (rows of dbo.schema_migrations) so nothing touches a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSchema, assertSchemaReady } = require('../../src/db/schemaReadiness');
const { listMigrations } = require('../../src/db/migrate');

const files = listMigrations();
const rowsOf = (list) => list.map((m) => ({ version: m.version, checksum: m.checksum }));
const fakePool = ({ tableExists = true, rows = [], failSelect = null } = {}) => ({
  request: () => ({
    query: async (text) => {
      if (text.includes('sys.objects')) return { recordset: [{ n: tableExists ? 1 : 0 }] };
      if (failSelect) throw new Error(failSelect);
      return { recordset: rows };
    },
  }),
});

test('the shipped migrations are 0001..0008 in order, so the check really requires 0008', () => {
  assert.deepEqual(files.map((m) => m.version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']);
});

test('fully migrated database is compatible', async () => {
  assert.deepEqual(evaluateSchema(rowsOf(files), files), []);
  await assertSchemaReady(fakePool({ rows: rowsOf(files) }));
});

test('database missing 0008 (the old demo databases) is refused and names the migration', async () => {
  const rows = rowsOf(files.filter((m) => m.version !== '0008'));
  assert.deepEqual(evaluateSchema(rows, files).length, 1);
  await assert.rejects(() => assertSchemaReady(fakePool({ rows })), /0008_eta_prediction_jobs\.sql is not applied/);
});

test('database missing a middle migration (a gap) is refused', async () => {
  const rows = rowsOf(files.filter((m) => m.version !== '0006'));
  await assert.rejects(() => assertSchemaReady(fakePool({ rows })), /0006_berth_recommendations\.sql is not applied/);
});

test('a new migration file raises the requirement without any code change', async () => {
  const next = [...files, { version: '0009', name: '0009_future.sql', checksum: 'a'.repeat(64) }];
  await assert.rejects(() => assertSchemaReady(fakePool({ rows: rowsOf(files) }), next), /0009_future\.sql is not applied/);
});

test('checksum mismatch on an applied migration is refused', async () => {
  const rows = rowsOf(files); rows[2] = { ...rows[2], checksum: 'f'.repeat(64) };
  await assert.rejects(() => assertSchemaReady(fakePool({ rows })), /0003_.*different checksum/);
});

test('a database newer than the code (unknown applied version) is refused', async () => {
  const rows = [...rowsOf(files), { version: '0099', checksum: 'b'.repeat(64) }];
  await assert.rejects(() => assertSchemaReady(fakePool({ rows })), /migration 0099, which this code does not know/);
});

test('missing schema_migrations table is refused with the migrate hint', async () => {
  await assert.rejects(() => assertSchemaReady(fakePool({ tableExists: false })), /schema_migrations table missing.*npm run migrate/s);
});

test('empty history is refused (every migration reported missing)', async () => {
  assert.equal(evaluateSchema([], files).length, files.length);
  await assert.rejects(() => assertSchemaReady(fakePool({ rows: [] })), /0001_baseline\.sql is not applied/);
});

test('invalid migration metadata (bad version or checksum, unreadable table) is refused', async () => {
  const bad = [...rowsOf(files).slice(1), { version: 'x1', checksum: 'zz' }];
  assert.ok(evaluateSchema(bad, files).some((p) => p.startsWith('invalid migration history row')));
  await assert.rejects(() => assertSchemaReady(fakePool({ rows: bad })), /invalid migration history row/);
  await assert.rejects(() => assertSchemaReady(fakePool({ failSelect: "Invalid column name 'checksum'" })), /schema is not usable.*Invalid column name/s);
});

test('the error never carries connection details', async () => {
  await assert.rejects(() => assertSchemaReady(fakePool({ rows: [] })), (e) => !/password|pwd|server=|Trusted_Connection|user id/i.test(e.message));
});
