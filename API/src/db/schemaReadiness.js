'use strict';

// Fail-closed schema check used at API start (UC-015 A1). The required schema is whatever migration files this code ships:
// adding migration 0009 raises the requirement automatically. The check only reads; it never changes the schema.
// Problems are reported without any connection detail.

const { listMigrations } = require('./migrate');

// Pure: compares the rows of dbo.schema_migrations with the migration files. Returns a list of problems (empty = compatible).
function evaluateSchema(appliedRows, migrations) {
  const problems = [];
  const applied = new Map();
  for (const row of appliedRows) {
    const version = String(row.version ?? '').trim();
    const checksum = String(row.checksum ?? '').trim();
    if (!/^\d{4}$/.test(version) || !/^[0-9a-f]{64}$/.test(checksum)) {
      problems.push(`invalid migration history row (version "${version}")`);
      continue;
    }
    applied.set(version, checksum);
  }
  const known = new Set(migrations.map((m) => m.version));
  for (const m of migrations) {
    if (!applied.has(m.version)) problems.push(`migration ${m.name} is not applied`);
    else if (applied.get(m.version) !== m.checksum) problems.push(`migration ${m.name} was applied with a different checksum (the file was edited or the database is from another build)`);
  }
  for (const version of applied.keys()) {
    if (!known.has(version)) problems.push(`the database has migration ${version}, which this code does not know (the database is newer than the code)`);
  }
  return problems;
}

async function assertSchemaReady(pool, migrations = listMigrations()) {
  let rows;
  try {
    const exists = await pool.request().query("SELECT COUNT(*) AS n FROM sys.objects WHERE object_id = OBJECT_ID(N'dbo.schema_migrations', N'U')");
    if (exists.recordset[0].n === 0) throw new Error('schema_migrations table missing');
    rows = (await pool.request().query('SELECT version, checksum FROM dbo.schema_migrations')).recordset;
  } catch (err) {
    throw new Error(`database schema is not usable: ${err.message}. Run npm run migrate against this database (the API never changes the schema itself).`);
  }
  const problems = evaluateSchema(rows, migrations);
  if (problems.length) {
    throw new Error(`database schema is incompatible with this version of the API: ${problems.join('; ')}. Run npm run migrate against this database (the API never changes the schema itself).`);
  }
}

module.exports = { evaluateSchema, assertSchemaReady };
