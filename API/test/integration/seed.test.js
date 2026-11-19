'use strict';

// Regression: Vietnamese text in the reference seed must be stored exactly. A seed once run through sqlcmd without
// `-f 65001` stored "TÃ u container" instead of "Tàu container". Apply seeds with `npm run seed`.
// Runs only with SP_TEST_DB set (disposable, migrated and seeded database).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: seed encoding test not executed';

let db;
test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: TEST_DB }).db);
  db = { sql, pool: await connect() };
});
test.after(async () => { if (db) await db.pool.close(); });

const one = async (text) => (await db.pool.request().query(text)).recordset[0];

test('seeded Vietnamese names are stored as real UTF-8 text', { skip }, async () => {
  assert.equal((await one("SELECT type_name AS v FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).v, 'Tàu container');
  assert.equal((await one("SELECT type_name AS v FROM dbo.ship_types WHERE type_code = 'BULK'")).v, 'Tàu hàng rời');
  assert.equal((await one("SELECT role_name AS v FROM dbo.auth_roles WHERE role_code = 'DIEU_PHOI_VIEN'")).v, 'Điều phối viên');
  assert.equal((await one("SELECT role_name AS v FROM dbo.auth_roles WHERE role_code = 'KY_THUAT_VIEN'")).v, 'Kỹ thuật viên');
  assert.equal((await one("SELECT name_vi AS v FROM dbo.document_types WHERE code = 'REGISTRATION'")).v, 'Giấy chứng nhận đăng ký');
});

test('no seeded text contains the typical mojibake marker characters', { skip }, async () => {
  const rows = (await db.pool.request().query(`
    SELECT role_name AS v FROM dbo.auth_roles UNION ALL SELECT type_name FROM dbo.ship_types
    UNION ALL SELECT name_vi FROM dbo.document_types UNION ALL SELECT description FROM dbo.system_parameters`)).recordset;
  assert.ok(rows.length >= 10);
  for (const { v } of rows) assert.ok(!/Ã|Â|Ä|Æ|Ð|Ñ/.test(v), `suspicious text: ${v}`);
});

test('all seeded roles from the SRS matrix exist, and the seed is repeatable (idempotent)', { skip }, async () => {
  const codes = (await db.pool.request().query('SELECT role_code FROM dbo.auth_roles')).recordset.map((r) => r.role_code);
  for (const code of ['QUAN_TRI_HE_THONG', 'DIEU_PHOI_VIEN', 'DAI_LY_HANG_HAI', 'BAN_QUAN_LY', 'NHAN_VIEN_KHO_BAI', 'KY_THUAT_VIEN']) {
    assert.ok(codes.includes(code), code);
  }
  const fs = require('node:fs');
  const { SEED_FILE } = require('../../src/db/seed');
  const before = (await one('SELECT COUNT(*) AS n FROM dbo.auth_roles')).n;
  await db.pool.request().batch(fs.readFileSync(SEED_FILE, 'utf8'));
  assert.equal((await one('SELECT COUNT(*) AS n FROM dbo.auth_roles')).n, before, 're-running the seed adds no duplicates');
});
