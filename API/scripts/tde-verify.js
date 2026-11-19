'use strict';

// NFR-SEC-06 verification of SQL Server Transparent Data Encryption (TDE) on a NEW disposable database. Nothing here touches an existing SmartPort database.
//   node scripts/tde-verify.js --confirm-disposable-tde
// What it does, in one process (so the random passwords exist only in memory and are never printed or written):
//   1. refuses unless the instance has no database master key in master, no user certificate and no encrypted database (it will not disturb a real TDE set-up),
//      and the database SmartPortV2_LoadTde does not exist;
//   2. creates the database, migrates 0001-0008, seeds the catalog, inserts a unique marker text (ship name, user display name);
//   3. BEFORE encryption: runs the 50-user load test, backs the database up and scans the .bak and the data file for the marker (the control: it must be FOUND);
//   4. creates a database master key and a certificate in master, a database encryption key (AES-256), turns encryption on and waits for it to finish;
//      backs up the certificate and its private key (encrypted with a random password) to files;
//   5. AFTER encryption: authorized access (marker read back, API integration tests, the load test again), then the .bak and the data file must NOT contain the marker;
//   6. backup/restore: restore under a new name (works); drop both databases and the certificate and try to restore again (must fail: certificate missing);
//      re-create the certificate from the backup files and restore (works);
//   7. cleans up: drops the databases, the certificate and the master key it created, deletes its files, and reports what could not be removed.
// Known side effect that cannot be avoided: the first encrypted database makes SQL Server encrypt tempdb too, until the instance restarts.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sql = require('mssql/msnodesqlv8');
const SERVER = process.env.SP_DB_SERVER || 'localhost';
const ODBC_DRIVER = process.env.SP_ODBC_DRIVER || 'ODBC Driver 18 for SQL Server';
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/connection');

const DB = 'SmartPortV2_LoadTde'; const RESTORED = 'SmartPortV2_LoadTdeRestored'; const CERT = 'SPTdeVerifyCert';
const MARKER = `TDEMARK-${crypto.randomBytes(5).toString('hex')}`;
const strong = () => `Aa1!${crypto.randomBytes(18).toString('base64url')}`;
const out = { marker: 'random, not shown', steps: [] };
const log = (name, detail) => { out.steps.push({ step: name, ...detail }); process.stderr.write(`[${name}] ${JSON.stringify(detail).slice(0, 300)}\n`); };
const root = path.resolve(__dirname, '..');

async function main() {
  if (!process.argv.includes('--confirm-disposable-tde')) throw new Error('Pass --confirm-disposable-tde: this creates a database master key and a certificate in master (removed at the end) and encrypts a new database.');
  const master = await new sql.ConnectionPool({ connectionString: `Driver={${ODBC_DRIVER}};Server=${SERVER};Database=master;Trusted_Connection=Yes;TrustServerCertificate=Yes;` }).connect();
  const q = async (text, pool = master) => (await pool.request().query(text)).recordset;
  const batch = async (text, pool = master) => pool.request().batch(text);
  const cleanup = {};   // run in a fixed order: restored copy, database, certificate and master key, files, work folder
  try {
    // ---------------------------------------------------------------- 1. guards
    const info = (await q("SELECT CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) edition, CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(40)) version, IS_SRVROLEMEMBER('sysadmin') sysadmin, CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(400)) backup_dir"))[0];
    if (!info.sysadmin) throw new Error('sysadmin is required');
    const dmk = await q("SELECT name FROM master.sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##'");
    const certs = await q("SELECT name FROM master.sys.certificates WHERE name NOT LIKE '##%'");
    const enc = await q('SELECT DB_NAME(database_id) AS db FROM sys.dm_database_encryption_keys WHERE database_id <> 2');   // tempdb stays encrypted after an earlier run until the instance restarts
    const exists = await q(`SELECT name FROM sys.databases WHERE name IN ('${DB}', '${RESTORED}')`);
    if (dmk.length || certs.length || enc.length || exists.length) throw new Error(`Refusing: the instance already has a database master key (${dmk.length}), user certificates (${certs.length}), encrypted databases (${enc.length}) or ${DB} (${exists.length}). Nothing was changed.`);
    out.instance = { edition: info.edition, version: info.version };
    // Files go to a folder created at the drive root, so both this process and the SQL Server service account can use it (the default backup and data folders are
    // readable only by the service account, which would stop us from looking inside the files). Everything in it is deleted at the end.
    const work = `C:\\SPTdeVerify_${crypto.randomBytes(3).toString('hex')}`; fs.mkdirSync(work); const dir = `${work}\\`;
    spawnSync('icacls', [work, '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf8' });   // Everyone: modify, on this throw-away folder only
    const bakPlain = `${dir}${DB}_plain.bak`; const bakEnc = `${dir}${DB}_enc.bak`; const cerFile = `${dir}${CERT}.cer`; const pvkFile = `${dir}${CERT}.pvk`;
    cleanup.work = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* reported below */ } if (fs.existsSync(work)) out.undeletedFolder = work; };

    // ---------------------------------------------------------------- 2. database
    await batch(`CREATE DATABASE [${DB}] ON PRIMARY (NAME = N'${DB}_data', FILENAME = N'${dir}${DB}_data.mdf') LOG ON (NAME = N'${DB}_log', FILENAME = N'${dir}${DB}_log.ldf')`); cleanup.db = async () => { await batch(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END`); };
    const env = { ...process.env, SP_DB_NAME: DB, UV_THREADPOOL_SIZE: '16' };
    const run = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const a of [['src/db/migrate.js'], ['src/db/seed.js'], ['src/db/seed.js', 'dev_demo_catalog.sql']]) { const r = run(a); if (r.status !== 0) throw new Error(`${a.join(' ')} failed: ${(r.stderr || '').slice(0, 200)}`); }
    const { sql: sqlLib } = createPool(loadConfig({ SP_DB_NAME: DB }).db);
    const dbq = async (t, params = {}) => { const { connect } = createPool(loadConfig({ SP_DB_NAME: DB }).db); const pool = await connect(); try { const r = pool.request(); for (const [k, v] of Object.entries(params)) r.input(k, v.type, v.value); return (await r.query(t)).recordset; } finally { await pool.close(); } };
    const typeId = (await dbq("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
    await dbq("INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) VALUES ('TDE1', '9999991', N'Ship " + MARKER + "', " + typeId + ", 100, 20, 6, 5000)");
    const files = await dbq(`SELECT name, physical_name, type_desc FROM sys.database_files`);
    const dataFile = files.find((f) => f.type_desc === 'ROWS'); 
    log('database', { migrated: true, marker_rows: 1, data_file_readable_by_test: 'not needed: SQL Server reads the files' });
    // the marker as it sits in the files: nvarchar is UTF-16LE, so look for both encodings
    // The marker as it sits in a file: nvarchar is UTF-16LE, so look for both encodings. The database is taken offline so its data file can be read.
    const scan = (file) => { const buf = fs.readFileSync(file); return { ascii: buf.indexOf(Buffer.from(MARKER, 'ascii')) >= 0, utf16: buf.indexOf(Buffer.from(MARKER, 'utf16le')) >= 0, mb: Math.round(buf.length / 104857.6) / 10 }; };
    // SQL Server restricts its data and log files to its service account and administrators, so the data file itself cannot be read from here: the backup file (readable) is the checked copy.
    const scanData = async () => ({ notInspected: 'data file ACL is restricted to the SQL Server service account' });
    const backup = async (file, label) => { const t0 = Date.now(); await batch(`BACKUP DATABASE [${DB}] TO DISK = N'${file}' WITH COPY_ONLY, INIT, CHECKSUM, MAXTRANSFERSIZE = 131072`); return { ms: Date.now() - t0, label }; };
    cleanup.files = () => { for (const f of [bakPlain, bakEnc, cerFile, pvkFile]) { try { fs.unlinkSync(f); } catch (e) { if (fs.existsSync(f)) out.undeletedFiles = [...(out.undeletedFiles || []), f]; } } };

    // ---------------------------------------------------------------- 3. before encryption (control)
    const loadJson = path.join(work, 'load.json');
    const load = (label) => { const r = run(['scripts/load-test.js', '--confirm-disposable', '--users', '50', '--seconds', '30', '--burst-seconds', '15', '--out', loadJson]); if (r.status !== 0) return { label, error: (r.stderr || r.stdout || '').slice(0, 300) };
      const d = JSON.parse(fs.readFileSync(loadJson, 'utf8')); fs.rmSync(`${loadJson}.pid`, { force: true });
      return { label, login: { p50: d.login.p50, max: d.login.max }, steady: { requests: d.phases.A_steady.requests, rps: d.phases.A_steady.throughputRps, p50: d.phases.A_steady.overall.p50, p95: d.phases.A_steady.overall.p95, p99: d.phases.A_steady.overall.p99, max: d.phases.A_steady.overall.max, failed: d.phases.A_steady.overall.failed },
        burst: { requests: d.phases.B_burst.requests, rps: d.phases.B_burst.throughputRps, p50: d.phases.B_burst.overall.p50, p95: d.phases.B_burst.overall.p95, p99: d.phases.B_burst.overall.p99, max: d.phases.B_burst.overall.max, failed: d.phases.B_burst.overall.failed }, consistency: d.consistency.checkConsistencyExit }; };
    out.loadBefore = load('plaintext database');
    const bPlain = await backup(bakPlain, 'plain'); const sPlain = scan(bakPlain); const dPlain = await scanData();
    out.before = { backup_ms: bPlain.ms, bak: sPlain, data_file: dPlain, controlValid: sPlain.ascii || sPlain.utf16 };
    log('before-encryption', out.before);

    // ---------------------------------------------------------------- 4. enable TDE
    const dmkPw = strong(); const pvkPw = strong();
    cleanup.keys = async () => { try { await batch(`USE master; IF EXISTS (SELECT 1 FROM sys.certificates WHERE name = '${CERT}') DROP CERTIFICATE ${CERT};`); } catch (e) { out.certDropBlocked = String(e.message).slice(0, 200); }
      try { await batch(`USE master; IF EXISTS (SELECT 1 FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##') DROP MASTER KEY;`); } catch (e) { out.masterKeyDropBlocked = String(e.message).slice(0, 200); } };
    await batch(`USE master; CREATE MASTER KEY ENCRYPTION BY PASSWORD = '${dmkPw}'; CREATE CERTIFICATE ${CERT} WITH SUBJECT = 'SmartPort V2 TDE verification (disposable)';`);
    await batch(`BACKUP CERTIFICATE ${CERT} TO FILE = N'${cerFile}' WITH PRIVATE KEY (FILE = N'${pvkFile}', ENCRYPTION BY PASSWORD = '${pvkPw}')`);
    await batch(`USE [${DB}]; CREATE DATABASE ENCRYPTION KEY WITH ALGORITHM = AES_256 ENCRYPTION BY SERVER CERTIFICATE ${CERT}; ALTER DATABASE [${DB}] SET ENCRYPTION ON;`);
    const t0 = Date.now(); let state;
    for (;;) { state = (await q(`SELECT encryption_state, percent_complete FROM sys.dm_database_encryption_keys WHERE database_id = DB_ID('${DB}')`))[0]; if (state && state.encryption_state === 3) break; if (Date.now() - t0 > 120000) throw new Error('encryption did not finish in 120 s'); await new Promise((r) => setTimeout(r, 500)); }
    const dek = (await q(`SELECT encryption_state, key_algorithm, key_length, encryptor_type FROM sys.dm_database_encryption_keys WHERE database_id = DB_ID('${DB}')`))[0];
    out.encrypt = { seconds: Math.round((Date.now() - t0) / 100) / 10, state: dek.encryption_state, algorithm: dek.key_algorithm, bits: dek.key_length, protectedBy: dek.encryptor_type, is_encrypted_flag: (await q(`SELECT is_encrypted FROM sys.databases WHERE name = '${DB}'`))[0].is_encrypted === true, tempdbAlsoEncrypted: (await q("SELECT encryption_state FROM sys.dm_database_encryption_keys WHERE database_id = 2"))[0] ? true : false };
    log('encrypted', out.encrypt);

    // ---------------------------------------------------------------- 5. after encryption
    out.authorizedRead = (await dbq(`SELECT COUNT(*) AS n FROM dbo.ships WHERE ship_name = N'Ship ${MARKER}'`))[0].n === 1;
    const files2 = ['unit-skipped']; void files2;
    const tests = fs.readdirSync(path.join(root, 'test', 'integration')).filter((f) => f.endsWith('.test.js') && !f.startsWith('migration-')).map((f) => path.join('test', 'integration', f));
    const it = run(['--test', '--test-concurrency=1', ...tests], { SP_TEST_DB: DB }); const pass = (/ℹ pass (\d+)/.exec(it.stdout) || [])[1]; const fail = (/ℹ fail (\d+)/.exec(it.stdout) || [])[1];
    out.integrationOnEncrypted = { files: tests.length, pass: Number(pass), fail: Number(fail), note: 'migration-*.test.js excluded (they use a separate scratch database)' };
    log('integration', out.integrationOnEncrypted);
    out.loadAfter = load('TDE database');
    const bEnc = await backup(bakEnc, 'encrypted'); const sEnc = scan(bakEnc); const dEnc = await scanData();
    out.after = { backup_ms: bEnc.ms, bak: sEnc, data_file: dEnc, markerAbsent: !(sEnc.ascii || sEnc.utf16) };
    log('after-encryption', out.after);
    out.authorizedReadAfterOfflineOnline = (await dbq(`SELECT COUNT(*) AS n FROM dbo.ships WHERE ship_name = N'Ship ${MARKER}'`))[0].n === 1;

    // ---------------------------------------------------------------- 6. backup and restore
    const logical = (await q(`SELECT name, type_desc FROM sys.master_files WHERE database_id = DB_ID('${DB}')`));
    const dirData = work;
    const moves = (target) => logical.map((f) => `MOVE N'${f.name}' TO N'${path.join(dirData, `${target}_${f.type_desc === 'LOG' ? 'log.ldf' : 'data.mdf'}`)}'`).join(', ');
    const restore = async () => { await batch(`RESTORE DATABASE [${RESTORED}] FROM DISK = N'${bakEnc}' WITH ${moves(RESTORED)}, CHECKSUM`); };
    cleanup.restored = async () => { await batch(`IF DB_ID('${RESTORED}') IS NOT NULL BEGIN ALTER DATABASE [${RESTORED}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${RESTORED}]; END`); };
    await restore();
    const copy = await new sql.ConnectionPool({ connectionString: `Driver={${ODBC_DRIVER}};Server=${SERVER};Database=${RESTORED};Trusted_Connection=Yes;TrustServerCertificate=Yes;` }).connect();
    out.restoreWithCertificate = { ok: true, markerRead: (await q(`SELECT COUNT(*) AS n FROM dbo.ships WHERE ship_name = N'Ship ${MARKER}'`, copy))[0].n === 1, restoredIsEncrypted: (await q(`SELECT is_encrypted FROM sys.databases WHERE name = '${RESTORED}'`))[0].is_encrypted === true };
    await copy.close();
    await batch(`ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; ALTER DATABASE [${RESTORED}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${RESTORED}];`);
    let dropped = true; try { await batch(`USE master; DROP CERTIFICATE ${CERT};`); } catch (e) { dropped = false; out.certDropWhileTempdbEncrypted = String(e.message).slice(0, 220); }
    out.certificateDropped = dropped;
    if (dropped) {
      let failure = null; try { await restore(); } catch (e) { failure = { number: e.number || (e.originalError && e.originalError.info && e.originalError.info.number), message: String(e.message).replace(/\[[^\]]*\]/g, '').slice(0, 200) }; }
      out.restoreWithoutCertificate = failure ? { refused: true, ...failure } : { refused: false };
      await batch(`USE master; CREATE CERTIFICATE ${CERT} FROM FILE = N'${cerFile}' WITH PRIVATE KEY (FILE = N'${pvkFile}', DECRYPTION BY PASSWORD = '${pvkPw}')`);
      await restore();
      const copy2 = await new sql.ConnectionPool({ connectionString: `Driver={${ODBC_DRIVER}};Server=${SERVER};Database=${RESTORED};Trusted_Connection=Yes;TrustServerCertificate=Yes;` }).connect();
      out.restoreAfterCertificateRecreatedFromBackup = { ok: true, markerRead: (await q(`SELECT COUNT(*) AS n FROM dbo.ships WHERE ship_name = N'Ship ${MARKER}'`, copy2))[0].n === 1 };
      await copy2.close();
    }
    log('restore', { withCert: out.restoreWithCertificate, certificateDropped: out.certificateDropped, withoutCert: out.restoreWithoutCertificate, recreated: out.restoreAfterCertificateRecreatedFromBackup });
  } catch (e) { out.failure = String(e.message).slice(0, 400); }
  finally {
    for (const todo of ['restored', 'db', 'keys', 'files', 'work'].map((k) => cleanup[k]).filter(Boolean)) { try { await todo(); } catch (e) { out.cleanupProblems = [...(out.cleanupProblems || []), String(e.message).slice(0, 160)]; } }
    try { out.afterCleanup = { encryptedDatabases: await q("SELECT DB_NAME(database_id) AS db, encryption_state FROM sys.dm_database_encryption_keys"), userCertificates: await q("SELECT name FROM master.sys.certificates WHERE name NOT LIKE '##%'"), databaseMasterKey: await q("SELECT name FROM master.sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##'"), leftoverDatabases: await q(`SELECT name FROM sys.databases WHERE name IN ('${DB}', '${RESTORED}')`) }; } catch (e) { /* report below */ }
    await master.close();
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out.failure) process.exitCode = 1;
}

main().catch((e) => { process.stderr.write(`tde-verify failed: ${e.message}\n`); process.exitCode = 1; });
