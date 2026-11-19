'use strict';

// Applies seeds/dev_seed.sql (reference data for development databases). The file is read as UTF-8 and sent through the
// same driver as the migrations, so Vietnamese text is stored correctly. Do NOT run seed files with sqlcmd unless it
// is given `-f 65001`: its default code page corrupts non-ASCII text (this happened once and is covered by a test).
// The seed is idempotent. It refuses protected databases through createPool/loadConfig.

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');
const { createPool } = require('./connection');

const SEED_DIR = path.join(__dirname, '..', '..', 'seeds');
const SEED_FILE = path.join(SEED_DIR, 'dev_seed.sql');

// Optional argument: another seed file in seeds/ (name must look like dev_*.sql; no paths).
function seedFileFor(arg) {
  if (!arg) return SEED_FILE;
  if (!/^dev_[a-z_]+\.sql$/.test(arg)) throw new Error('seed file must be a name like dev_demo_catalog.sql inside seeds/');
  return path.join(SEED_DIR, arg);
}

async function main() {
  const config = loadConfig();
  const file = seedFileFor(process.argv[2]);
  const { pool, connect } = createPool(config.db);
  const connected = await connect();
  try {
    await connected.request().batch(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${path.basename(file)} applied to ${config.db.database}\n`);
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`seed failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { SEED_FILE };
