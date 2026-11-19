'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, assertNotProtectedDatabase, ConfigError } = require('../../src/config');
const { listMigrations } = require('../../src/db/migrate');
const path = require('node:path');

test('loadConfig requires SP_DB_NAME (fail closed, no default database)', () => {
  assert.throws(() => loadConfig({}), ConfigError);
});

test('loadConfig applies defaults and parses explicit values', () => {
  const cfg = loadConfig({ SP_DB_NAME: 'SmartPortV2_Dev', SP_PORT: '4100' });
  assert.equal(cfg.port, 4100);
  assert.equal(cfg.host, '127.0.0.1'); // loopback by default, not all interfaces
  assert.equal(loadConfig({ SP_DB_NAME: 'x', SP_HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.equal(cfg.db.server, 'localhost');
  assert.equal(cfg.db.driver, 'msnodesqlv8');
  assert.equal(cfg.db.trustedConnection, true);
  assert.equal(cfg.db.encrypt, true);
});

test('loadConfig rejects an out-of-range or non-integer port', () => {
  assert.throws(() => loadConfig({ SP_DB_NAME: 'x', SP_PORT: '0' }), ConfigError);
  assert.throws(() => loadConfig({ SP_DB_NAME: 'x', SP_PORT: '3000.5' }), ConfigError);
});

test('protected databases are refused: legacy, system and master names', () => {
  for (const name of ['CangThongMinh', 'CangThongMinh_UC015_Test', 'QL_BenhVien_Ptan', 'SITE-04', 'master', 'MSDB']) {
    assert.throws(() => assertNotProtectedDatabase(name), ConfigError, name);
  }
});

test('a dedicated SmartPort V2 database name is accepted', () => {
  assert.doesNotThrow(() => assertNotProtectedDatabase('SmartPortV2_Test'));
});

test('migration list is ordered, versioned and has stable checksums', () => {
  const migrations = listMigrations(path.join(__dirname, '..', '..', 'migrations'));
  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0].version, '0001');
  assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);
  const names = migrations.map((m) => m.name);
  assert.deepEqual(names, [...names].sort());
  // rollback files live in a subfolder and must not be applied by the runner
  assert.ok(migrations.every((m) => !m.name.includes('down')));
});

test('AI provider settings are optional; a bad URL fails closed; the key is only carried, never defaulted', () => {
  const base = { SP_DB_NAME: 'SmartPortV2_Dev' };
  const none = loadConfig(base);
  assert.deepEqual([none.aiEtaUrl, none.aiBerthUrl, none.aiApiKey], [null, null, null], 'no provider and no key by default: AI stays UNAVAILABLE');
  const set = loadConfig({ ...base, SP_AI_BERTH_URL: 'https://ai.example.test/recommend', SP_AI_API_KEY: 'k' });
  assert.deepEqual([set.aiBerthUrl, set.aiApiKey], ['https://ai.example.test/recommend', 'k']);
  assert.throws(() => loadConfig({ ...base, SP_AI_BERTH_URL: 'ftp://x' }), ConfigError);
});

test('B6: production refuses an insecure cookie or a non-https browser origin; development keeps its defaults', () => {
  const prod = { SP_DB_NAME: 'SmartPortV2_Prod', NODE_ENV: 'production' };
  assert.throws(() => loadConfig({ ...prod, SP_CORS_ORIGIN: 'https://port.example' , SP_COOKIE_SECURE: 'false' }), /SP_COOKIE_SECURE/);
  assert.throws(() => loadConfig({ ...prod }), /SP_CORS_ORIGIN/, 'no origin configured: the localhost default is not accepted in production');
  assert.throws(() => loadConfig({ ...prod, SP_CORS_ORIGIN: 'http://port.example' }), /https/);
  const ok = loadConfig({ ...prod, SP_CORS_ORIGIN: 'https://port.example' });
  assert.equal(ok.cookieSecure, true); assert.equal(ok.corsOrigin, 'https://port.example');
  const dev = loadConfig({ SP_DB_NAME: 'SmartPortV2_Dev' });
  assert.equal(dev.cookieSecure, true, 'Secure by default even in development'); assert.equal(dev.corsOrigin, 'http://localhost:5500');
  assert.doesNotThrow(() => loadConfig({ SP_DB_NAME: 'SmartPortV2_Dev', SP_COOKIE_SECURE: 'false' }));
});
