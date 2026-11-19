'use strict';

// Applies versioned SQL migrations in filename order and records each one in dbo.schema_migrations.
// Fail-closed rules: a checksum mismatch on an applied migration aborts the run (never edit an applied file;
// add a new one, rule 05). Each migration file manages its own transaction.
// Note: the migration body and its schema_migrations record are not in one transaction. If the process dies
// between them, the next run will re-apply and fail, which is detected rather than silently accepted.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../config');
const { createPool } = require('./connection');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name))
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      return {
        version: name.slice(0, 4),
        name,
        text,
        checksum: crypto.createHash('sha256').update(text).digest('hex'),
      };
    });
}

async function ensureHistoryTable(pool) {
  await pool.request().batch(`
    IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
    CREATE TABLE dbo.schema_migrations (
      version     CHAR(4)       NOT NULL CONSTRAINT PK_schema_migrations PRIMARY KEY,
      name        NVARCHAR(200) NOT NULL,
      checksum    CHAR(64)      NOT NULL,
      applied_at  DATETIME2(3)  NOT NULL CONSTRAINT DF_schema_migrations_applied DEFAULT (SYSUTCDATETIME())
    );`);
}

async function runMigrations(pool, sql, migrations) {
  await ensureHistoryTable(pool);
  const applied = (await pool.request().query('SELECT version, checksum FROM dbo.schema_migrations')).recordset;
  const appliedByVersion = new Map(applied.map((row) => [row.version.trim(), row.checksum.trim()]));
  const result = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const known = appliedByVersion.get(migration.version);
    if (known !== undefined) {
      if (known !== migration.checksum) {
        throw new Error(`Checksum mismatch for applied migration ${migration.name}; add a new migration instead of editing it`);
      }
      result.skipped.push(migration.name);
      continue;
    }
    await pool.request().batch(migration.text);
    await pool.request()
      .input('version', sql.Char(4), migration.version)
      .input('name', sql.NVarChar(200), migration.name)
      .input('checksum', sql.Char(64), migration.checksum)
      .query('INSERT INTO dbo.schema_migrations (version, name, checksum) VALUES (@version, @name, @checksum)');
    result.applied.push(migration.name);
  }
  return result;
}

async function main() {
  const config = loadConfig();
  const { sql, pool, connect } = createPool(config.db);
  const connected = await connect();
  try {
    const result = await runMigrations(connected, sql, listMigrations());
    process.stdout.write(`applied: ${result.applied.join(', ') || '(none)'}\nskipped: ${result.skipped.join(', ') || '(none)'}\n`);
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`migration failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { listMigrations, runMigrations };
