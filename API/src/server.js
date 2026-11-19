'use strict';

// Process entry point. Refuses to start unless the database is reachable and every migration this code ships is applied with the same checksum.

const { loadConfig } = require('./config');
const { createPool } = require('./db/connection');
const { createApp } = require('./app');
const { createEtaAdapter } = require('./ai/etaAdapter');
const { createEtaWorker } = require('./jobs/etaWorker');
const { assertSchemaReady } = require('./db/schemaReadiness');

async function start() {
  const config = loadConfig();
  const { sql, pool: rawPool, connect } = createPool(config.db);
  const pool = await connect();
  try {
    await assertSchemaReady(pool);   // fail closed: before the app, the worker or the listener exist
  } catch (err) {
    await rawPool.close().catch(() => {});
    throw err;
  }
  const db = { pool, sql };
  const etaAdapter = createEtaAdapter({ url: config.aiEtaUrl, apiKey: config.aiApiKey });
  // The ETA prediction worker: pending predictions are database rows, so a restart resumes them (src/jobs/etaWorker.js).
  const etaWorker = createEtaWorker({ db, etaAdapter });
  const app = createApp({
    db,
    policy: config.policy,
    corsOrigin: config.corsOrigin,
    cookieSecure: config.cookieSecure,
    etaAdapter,
    etaWorker,
  });
  const server = app.listen(config.port, config.host, () => {
    process.stdout.write(`SmartPort API listening on ${config.host}:${config.port}\n`);
    etaWorker.start();
  });
  const shutdown = async () => {
    server.close();
    await etaWorker.stop();
    await pool.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((err) => {
    process.stderr.write(`startup failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { start };
