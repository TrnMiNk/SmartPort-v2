'use strict';

// All configuration comes from the environment (rule 04). No secrets or connection strings are hardcoded.
// Database names are required: there is no default database, so a missing variable fails closed.

const LEGACY_DB_PATTERN = /^(CangThongMinh|QL_BenhVien|SITE-)/i;
const SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);

function loadConfig(env = process.env) {
  const database = env.SP_DB_NAME;
  if (!database) {
    throw new ConfigError('SP_DB_NAME is required');
  }
  // Production safety (NFR-SEC-01): in production the session cookie must be Secure and the browser origin must be https. The development defaults
  // (SP_COOKIE_SECURE=false, http://localhost:5500) stay available outside production.
  if (env.NODE_ENV === 'production') {
    if ((env.SP_COOKIE_SECURE ?? 'true') !== 'true') throw new ConfigError('SP_COOKIE_SECURE must be true when NODE_ENV=production');
    if (!/^https:\/\//.test(env.SP_CORS_ORIGIN ?? '')) throw new ConfigError('SP_CORS_ORIGIN must be an https:// origin when NODE_ENV=production');
  }
  return {
    port: parseIntStrict(env.SP_PORT ?? '3000', 'SP_PORT', 1, 65535),
    // Loopback by default so a development API is not exposed to the network. Set SP_HOST explicitly to widen.
    host: env.SP_HOST ?? '127.0.0.1',
    corsOrigin: env.SP_CORS_ORIGIN ?? 'http://localhost:5500',
    // Optional ETA forecast provider (UC-016). Without it the forecast is reported UNAVAILABLE, never simulated (D3).
    aiEtaUrl: parseOptionalUrl(env.SP_AI_ETA_URL, 'SP_AI_ETA_URL'),
    // Optional berth recommendation provider (UC-027) and one optional bearer key for AI providers. The key is read from the environment only,
    // sent only in the Authorization header, and never logged (src/ai/providerHttp.js).
    aiBerthUrl: parseOptionalUrl(env.SP_AI_BERTH_URL, 'SP_AI_BERTH_URL'),
    aiApiKey: env.SP_AI_API_KEY || null,
    cookieSecure: (env.SP_COOKIE_SECURE ?? 'true') === 'true',
    policy: {
      // Defaults from UC-001 (5 consecutive failures) and UC-002 (30 minutes idle). Lock duration is an
      // assumption (see docs/use-cases/UC001.md, A-2) and is configurable.
      loginMaxFailures: parseIntStrict(env.SP_LOGIN_MAX_FAILURES ?? '5', 'SP_LOGIN_MAX_FAILURES', 1, 20),
      loginLockMinutes: parseIntStrict(env.SP_LOGIN_LOCK_MINUTES ?? '15', 'SP_LOGIN_LOCK_MINUTES', 1, 1440),
      sessionIdleMinutes: parseIntStrict(env.SP_SESSION_IDLE_MINUTES ?? '30', 'SP_SESSION_IDLE_MINUTES', 1, 1440),
    },
    db: {
      server: env.SP_DB_SERVER ?? 'localhost',
      database,
      driver: env.SP_DB_DRIVER ?? 'msnodesqlv8',
      odbcDriver: env.SP_ODBC_DRIVER ?? 'ODBC Driver 18 for SQL Server',
      trustedConnection: (env.SP_DB_TRUSTED ?? 'true') === 'true',
      encrypt: (env.SP_DB_ENCRYPT ?? 'true') === 'true',
    },
  };
}

// Refuse to run migrations or the API against legacy or system databases.
function assertNotProtectedDatabase(database) {
  if (SYSTEM_DBS.has(database.toLowerCase()) || LEGACY_DB_PATTERN.test(database)) {
    throw new ConfigError(`Refusing to use protected database "${database}". Use a dedicated SmartPort V2 database.`);
  }
}

function parseOptionalUrl(raw, name) {
  if (raw === undefined || raw === '') return null;
  let url;
  try { url = new URL(raw); } catch (e) { throw new ConfigError(`${name} must be an http(s) URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be an http(s) URL`);
  return url.href;
}

function parseIntStrict(raw, name, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

module.exports = { loadConfig, assertNotProtectedDatabase, ConfigError };
