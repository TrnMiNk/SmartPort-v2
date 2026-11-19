'use strict';

// Runs the integration tests one file at a time with a large enough libuv thread pool (see src/db/connection.js).
// A plain `node --test` would start with the default pool of 4 threads, which the driver can exhaust.
// Usage: SP_DB_NAME=<db> SP_TEST_DB=<db> npm run test:integration
//
// Pre-flight: the queue tests (UC-020, UC-030, UC-031) assume the berth queue holds nothing but their own voyages. Voyages left in the queue by
// a failed earlier run make them fail with confusing messages ("positions 1..n"). So the run stops first and names the leftovers.
// SP_ALLOW_DIRTY_QUEUE=1 skips the check (read-only: nothing is deleted here).

const { spawnSync } = require('node:child_process');

async function leftovers() {
  const name = process.env.SP_TEST_DB;
  if (!name || process.env.SP_ALLOW_DIRTY_QUEUE === '1') return [];
  const { loadConfig } = require('../src/config');
  const { createPool } = require('../src/db/connection');
  const { sql, connect } = createPool(loadConfig({ ...process.env, SP_DB_NAME: name }).db);
  const pool = await connect();
  try {
    const r = await pool.request().query(`SELECT TOP 10 id, voyage_code, queue_position FROM dbo.voyages WHERE status = 'WAITING_BERTH' ORDER BY queue_position`);
    return r.recordset;
  } catch (e) {
    return [];   // a database that is not migrated yet fails in the tests themselves with a clearer message
  } finally { await pool.close(); void sql; }
}

(async () => {
  const stray = await leftovers();
  if (stray.length) {
    process.stderr.write(`Integration tests not started: ${process.env.SP_TEST_DB} already has voyages waiting in the berth queue (first ${stray.length}: ${stray.map((v) => `${v.voyage_code}@${v.queue_position}`).join(', ')}).\n`
      + 'They are probably fixtures of a failed earlier run, or real or demo data. Remove them only if they are test data, or set SP_ALLOW_DIRTY_QUEUE=1 to run anyway.\n');
    process.exit(2);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/integration/**/*.test.js'], {
    stdio: 'inherit',
    env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16' },
  });
  process.exit(result.status === null ? 1 : result.status);
})();
