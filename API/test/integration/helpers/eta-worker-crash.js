'use strict';

// Helper process for the restart test (eta-async.http.test.js). It starts an ETA worker whose provider never answers, claims one pending job and prints
// "CLAIMED <id>" so the test can kill the process (SIGKILL) while the job is still pending. The provider here is a stand-in that hangs; nothing is predicted.
//   env: SP_DB_NAME (the test database)

const { loadConfig } = require('../../../src/config');
const { createPool } = require('../../../src/db/connection');
const { createEtaWorker } = require('../../../src/jobs/etaWorker');

(async () => {
  const { sql, connect } = createPool(loadConfig().db);
  const db = { sql, pool: await connect() };
  const hanging = { configured: true, predict: () => new Promise(() => {}) };
  const worker = createEtaWorker({ db, etaAdapter: hanging, leaseMs: 1500, log: () => {} });
  const jobs = await worker.claim(1);
  process.stdout.write(`CLAIMED ${jobs.length ? jobs[0].id : 'none'}\n`);
  if (jobs.length) worker.process(jobs[0]);   // never finishes
  setInterval(() => {}, 1000);                // stay alive until the test kills this process
})().catch((e) => { process.stderr.write(String(e && e.message) + '\n'); process.exit(1); });
