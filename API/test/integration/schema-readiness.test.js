'use strict';

// A1 on a real, fully migrated disposable database (SP_TEST_DB). Read-only: it never changes the schema.
// "Missing migration" is simulated by asking for a migration list that is longer or different than what is applied.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { listMigrations } = require('../../src/db/migrate');
const { assertSchemaReady } = require('../../src/db/schemaReadiness');

const DB = process.env.SP_TEST_DB;
const skip = DB ? false : 'SP_TEST_DB not set: real-database schema readiness not executed';
let pool;

test.before(async () => { if (!skip) pool = await createPool(loadConfig({ ...process.env, SP_DB_NAME: DB }).db).connect(); });
test.after(async () => { if (pool) await pool.close(); });

test('a database migrated to every shipped migration is compatible (existing compatible behaviour)', { skip }, async () => {
  await assertSchemaReady(pool);
});

test('the same database is refused when the code requires one more migration', { skip }, async () => {
  const next = [...listMigrations(), { version: '9999', name: '9999_future.sql', checksum: 'c'.repeat(64) }];
  await assert.rejects(() => assertSchemaReady(pool, next), /9999_future\.sql is not applied/);
});

test('the same database is refused when a shipped file differs from what was applied', { skip }, async () => {
  const changed = listMigrations().map((m) => (m.version === '0008' ? { ...m, checksum: 'd'.repeat(64) } : m));
  await assert.rejects(() => assertSchemaReady(pool, changed), /0008_.*different checksum/);
});

test('the same database is refused when it is newer than the code (0008 unknown to the code)', { skip }, async () => {
  const older = listMigrations().filter((m) => m.version !== '0008');
  await assert.rejects(() => assertSchemaReady(pool, older), /migration 0008, which this code does not know/);
});
