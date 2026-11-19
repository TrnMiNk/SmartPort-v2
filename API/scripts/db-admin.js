'use strict';

// Safe creation and copying of DISPOSABLE SmartPort V2 databases (local SQL Server, Windows authentication). It only ever creates a NEW database.
//   node scripts/db-admin.js create <new name> --confirm-new
//   node scripts/db-admin.js copy <existing name> <new name> --confirm-copy
// - Names must look like SmartPortV2_<letters, digits, underscore>; protected names are refused (loadConfig rules).
// - It refuses when the new name already exists. It never drops, restores over, renames or alters an existing database.
// - `copy` takes a COPY_ONLY full backup of the source (this changes nothing in the source and does not disturb its backup chain) into the server's
//   default backup folder, then restores it under the new name with new file names. The .bak file stays there; delete it yourself when you no longer need it.
// - No credentials are used or printed (trusted connection).

const sql = require('mssql/msnodesqlv8');
const SERVER = process.env.SP_DB_SERVER || 'localhost';
const ODBC_DRIVER = process.env.SP_ODBC_DRIVER || 'ODBC Driver 18 for SQL Server';
const { assertNotProtectedDatabase } = require('../src/config');

const NAME = /^SmartPortV2_[A-Za-z0-9_]{1,60}$/;

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  const confirm = process.argv.includes(mode === 'copy' ? '--confirm-copy' : '--confirm-new');
  if (!['create', 'copy'].includes(mode) || !confirm) throw new Error('Usage: create <new name> --confirm-new | copy <existing name> <new name> --confirm-copy');
  const source = mode === 'copy' ? a : null; const target = mode === 'copy' ? b : a;
  for (const n of [source, target].filter(Boolean)) if (!NAME.test(n || '')) throw new Error(`Database names must look like SmartPortV2_<letters, digits, underscore>: ${n}`);
  assertNotProtectedDatabase(target);
  const pool = await new sql.ConnectionPool({ connectionString: `Driver={${ODBC_DRIVER}};Server=${SERVER};Database=master;Trusted_Connection=Yes;TrustServerCertificate=Yes;` }).connect();
  try {
    const exists = async (n) => (await pool.request().input('n', sql.NVarChar(128), n).query('SELECT COUNT(*) AS c FROM sys.databases WHERE name = @n')).recordset[0].c === 1;
    if (await exists(target)) throw new Error(`The database ${target} already exists. Choose a new name; nothing was changed.`);
    if (mode === 'create') {
      await pool.request().batch(`CREATE DATABASE [${target}]`);
      process.stdout.write(`Created empty database ${target}. Next: SP_DB_NAME=${target} npm run migrate\n`);
      return;
    }
    if (!(await exists(source))) throw new Error(`The source database ${source} does not exist.`);
    const dirs = (await pool.request().query(`SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(400)) AS backup_dir, CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS NVARCHAR(400)) AS data_dir, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS NVARCHAR(400)) AS log_dir`)).recordset[0];
    if (!dirs.backup_dir || !dirs.data_dir || !dirs.log_dir) throw new Error('The server reports no default backup, data or log folder.');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bak = `${dirs.backup_dir.replace(/[\\/]*$/, '\\')}${target}_from_${source}_${stamp}.bak`;
    await pool.request().batch(`BACKUP DATABASE [${source}] TO DISK = N'${bak.replace(/'/g, "''")}' WITH COPY_ONLY, INIT, CHECKSUM`);
    const files = (await pool.request().batch(`RESTORE FILELISTONLY FROM DISK = N'${bak.replace(/'/g, "''")}'`)).recordset;
    const moves = files.map((f) => `MOVE N'${f.LogicalName.replace(/'/g, "''")}' TO N'${(f.Type === 'L' ? dirs.log_dir : dirs.data_dir).replace(/[\\/]*$/, '\\')}${target}_${f.Type === 'L' ? 'log.ldf' : 'data.mdf'}'`);
    if (files.length !== 2) throw new Error('Unexpected number of database files; stopped before restoring.');
    await pool.request().batch(`RESTORE DATABASE [${target}] FROM DISK = N'${bak.replace(/'/g, "''")}' WITH ${moves.join(', ')}, CHECKSUM`);
    process.stdout.write(`Copied ${source} to the new database ${target} (backup file kept: ${bak}).\nNext: SP_DB_NAME=${target} npm run migrate\n`);
  } finally { await pool.close(); }
}

main().catch((err) => { process.stderr.write(`db-admin failed: ${err.message}\n`); process.exitCode = 1; });
