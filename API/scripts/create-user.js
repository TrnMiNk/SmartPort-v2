'use strict';

// Creates one user. The password is read from stdin, never from a command-line argument (it would be kept in
// shell history). Example (PowerShell):
//   "my-long-password" | node scripts/create-user.js --username coord01 --name "Điều phối viên 1" --roles DIEU_PHOI_VIEN
// Requires SP_DB_NAME. Refuses protected databases via src/config.js.

const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/connection');
const { createUser } = require('../src/services/userProvisioning');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.username || !args.name || !args.roles) {
    throw new Error('usage: --username <u> --name <display name> --roles <CODE[,CODE]>');
  }
  const password = await readStdin();
  const config = loadConfig();
  const { sql, pool, connect } = createPool(config.db);
  const connected = await connect();
  try {
    const { userId } = await createUser({ pool: connected, sql }, {
      username: args.username,
      displayName: args.name,
      password,
      roleCodes: args.roles.split(',').map((r) => r.trim()).filter(Boolean),
    });
    process.stdout.write(`created user id=${userId} username=${args.username}\n`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  process.stderr.write(`create-user failed: ${err.message}\n`);
  process.exitCode = 1;
});
