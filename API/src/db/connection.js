'use strict';

// SQL Server connection pool. Uses the msnodesqlv8 driver with Windows (trusted) authentication, as the legacy
// backend does, so no SQL password is stored. Other drivers may be selected with SP_DB_DRIVER.

const { assertNotProtectedDatabase } = require('../config');

// msnodesqlv8 runs every blocking ODBC call on a libuv worker thread, and Node's default pool has only 4. If four
// statements are waiting for locks, the statement that would release them has no thread to run on, and the whole API
// stops (observed with six simultaneous notices, SQL Server could not see it because the wait is on the Node side).
// The pool must be larger than the connection pool (max 10 below). This must be set before the first asynchronous
// work in the process; scripts/run-integration.js and the e2e harness set it for their child processes as well.
const MIN_THREADS = 16;
if (!(Number(process.env.UV_THREADPOOL_SIZE) >= MIN_THREADS)) process.env.UV_THREADPOOL_SIZE = String(MIN_THREADS);

function createPool(dbConfig) {
  assertNotProtectedDatabase(dbConfig.database);
  const sql = dbConfig.driver === 'msnodesqlv8'
    ? require('mssql/msnodesqlv8')
    : require('mssql');
  const config = {
    server: dbConfig.server,
    database: dbConfig.database,
    options: { trustedConnection: dbConfig.trustedConnection },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
  if (dbConfig.driver === 'msnodesqlv8') {
    config.driver = 'msnodesqlv8';
    // msnodesqlv8 needs an explicit ODBC driver name; it is configurable, never a secret.
    config.connectionString = [
      `Driver={${dbConfig.odbcDriver}}`,
      `Server=${dbConfig.server}`,
      `Database=${dbConfig.database}`,
      'Trusted_Connection=yes',
      `Encrypt=${dbConfig.encrypt ? 'yes' : 'no'}`,
    ].join(';');
  }
  const pool = new sql.ConnectionPool(config);
  return { sql, pool, connect: () => pool.connect() };
}

module.exports = { createPool };
