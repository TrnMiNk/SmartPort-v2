'use strict';

// B2 (NFR-PER-07): at least 50 users at the same time; usual operations (look-ups, saving a form) answer within 3 seconds.
// 50 independent, signed-in HTTP sessions (real login, real cookies) run a mix of read and safe state-changing operations of Modules 1 and 2 against a
// separately started API process on SQL Server. It is a HTTP-level load test on one machine: it is NOT a full-browser test and says nothing about
// several API processes, a network, or a production host. Everything is created in, and removed from, a dedicated empty database.
//   SP_DB_NAME=SmartPortV2_Load<name> node scripts/load-test.js --confirm-disposable [--users 50] [--seconds 60] [--burst-seconds 30] [--out file.json]
// Refuses: no flag, a protected name, a name not starting with SmartPortV2_Load, a database that already has berths or voyages. Passwords are random,
// kept in memory and never printed. Phase A has think time (0.5 to 1.5 s, a person using the screens); phase B has none (stress).

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/connection');
const { createUser } = require('../src/services/userProvisioning');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const USERS = Number(arg('--users', 50)); const SECONDS = Number(arg('--seconds', 60)); const BURST = Number(arg('--burst-seconds', 30));
const PORT = Number(arg('--port', 3201)); const OUT = arg('--out', null);
const TAG = crypto.randomBytes(3).toString('hex');
const SHIPS_PER_AGENT_USER = 6;
const agent = new http.Agent({ keepAlive: true, maxSockets: 120 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const samples = [];                    // { phase, op, status, ms, ok }
const authz = [];                      // { name, expected, actual }
let phase = 'setup';

function request(method, urlPath, { cookie, body, headers = {}, record = true, op = `${method} ${urlPath.split('?')[0]}`, expect = [200] } = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint(); const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, agent, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6; let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* no body */ }
        if (record) samples.push({ phase, op, status: res.statusCode, ms, ok: expect.includes(res.statusCode) });
        resolve({ status: res.statusCode, body: json, headers: res.headers, ms });
      });
    });
    req.on('error', (e) => { const ms = Number(process.hrtime.bigint() - t0) / 1e6; if (record) samples.push({ phase, op, status: 0, ms, ok: false, error: e.code || e.message }); resolve({ status: 0, body: null, headers: {}, ms, error: e.code || e.message }); });
    req.setTimeout(30000, () => req.destroy(Object.assign(new Error('client timeout 30 s'), { code: 'CLIENT_TIMEOUT' })));
    if (data) req.write(data); req.end();
  });
}

function percentile(sorted, p) { if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]; }
function stats(list) {
  const ms = list.map((s) => s.ms).sort((a, b) => a - b);
  return { n: list.length, ok: list.filter((s) => s.ok).length, failed: list.filter((s) => !s.ok).length, over3s: ms.filter((x) => x > 3000).length,
    p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), max: ms.length ? ms[ms.length - 1] : null, mean: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null };
}
const round = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

async function dbCounters(pool) {
  const w = (await pool.request().query(`SELECT wait_type, waiting_tasks_count AS n, wait_time_ms AS ms FROM sys.dm_os_wait_stats WHERE wait_type LIKE 'LCK[_]M%' AND waiting_tasks_count > 0`)).recordset;
  const c = (await pool.request().query(`SELECT counter_name, cntr_value FROM sys.dm_os_performance_counters WHERE counter_name IN ('Number of Deadlocks/sec', 'Lock Timeouts/sec', 'Lock Waits/sec') AND instance_name = '_Total'`)).recordset;
  return { lockWaits: w.reduce((a, r) => a + Number(r.n), 0), lockWaitMs: w.reduce((a, r) => a + Number(r.ms), 0), counters: Object.fromEntries(c.map((r) => [r.counter_name.trim(), Number(r.cntr_value)])) };
}

async function main() {
  if (!process.argv.includes('--confirm-disposable')) throw new Error('Pass --confirm-disposable: this creates users, ships and voyages in the database named by SP_DB_NAME.');
  const config = loadConfig();
  if (!/^SmartPortV2_Load/.test(config.db.database)) throw new Error('The database name must start with SmartPortV2_Load (a dedicated empty database).');
  const { sql, connect } = createPool(config.db);
  const db = { sql, pool: await connect() };
  const q = async (text, params = {}) => { const r = db.pool.request(); for (const [k, v] of Object.entries(params)) r.input(k, v); return (await r.query(text)).recordset; };
  if ((await q('SELECT (SELECT COUNT(*) FROM dbo.berths) + (SELECT COUNT(*) FROM dbo.voyages) AS n'))[0].n > 0) throw new Error('The database already has berths or voyages. Use a new empty, migrated and seeded database.');

  // ---------------------------------------------------------------- data set
  const typeId = (await q("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'"))[0].id;
  const portId = (await q(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('LD${TAG}', N'Cảng tải ${TAG}')`))[0].id;
  const agentIds = []; for (let i = 0; i < 5; i += 1) agentIds.push((await q(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('LA${TAG}${i}', N'Đại lý tải ${i} ${TAG}')`))[0].id);
  const mix = [['DAI_LY_HANG_HAI', Math.round(USERS * 0.4)], ['DIEU_PHOI_VIEN', Math.round(USERS * 0.3)], ['BAN_QUAN_LY', Math.round(USERS * 0.1)]];
  mix.push(['NHAN_VIEN_KHO_BAI', USERS - mix.reduce((a, m) => a + m[1], 0)]);
  const users = []; const passwords = new Map();
  for (const [role, n] of mix) for (let i = 0; i < n; i += 1) {
    const u = { name: `ld_${role.slice(0, 3).toLowerCase()}${i}_${TAG}`, role, agentId: role === 'DAI_LY_HANG_HAI' ? agentIds[i % agentIds.length] : null, notices: 0, ships: [], queue: null };
    const pw = crypto.randomBytes(12).toString('base64url'); passwords.set(u.name, pw);
    await createUser(db, { username: u.name, displayName: `Load ${u.name}`, password: pw, roleCodes: [role], agentId: u.agentId });
    users.push(u);
  }
  const anyCoordId = Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.find((u) => u.role === 'DIEU_PHOI_VIEN').name }))[0].user_id);
  const shipIds = [];
  for (const u of users.filter((x) => x.role === 'DAI_LY_HANG_HAI')) for (let s = 0; s < SHIPS_PER_AGENT_USER; s += 1) {
    const id = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, operator_agent_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id
      VALUES (@c, @i, @n, @t, @a, 180, 28, 9, 40000)`, { c: `LS${TAG}${shipIds.length}`, i: `9${String(100000 + shipIds.length * 7 + rand(0, 6))}`, n: `Load ${shipIds.length} ${TAG}`, t: typeId, a: u.agentId }))[0].id;
    for (const type of ['REGISTRATION', 'INSURANCE']) await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
      VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2035-01-01', @u, SYSUTCDATETIME())`, { s: id, t: type, k: `${TAG}${id}${type}`, u: anyCoordId });
    u.ships.push(id); shipIds.push(id);
  }

  // ---------------------------------------------------------------- API process
  const apiLog = [];
  const api = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16', SP_DB_NAME: config.db.database, SP_PORT: String(PORT), SP_HOST: '127.0.0.1', SP_COOKIE_SECURE: 'false', SP_CORS_ORIGIN: 'http://localhost:5500' } });
  api.stdout.on('data', (d) => apiLog.push(String(d))); api.stderr.on('data', (d) => apiLog.push(String(d)));
  if (OUT) fs.writeFileSync(`${OUT}.pid`, String(api.pid));
  for (let i = 0; ; i += 1) { const r = await request('GET', '/api/v1/health', { record: false }); if (r.status === 200) break; if (i > 80) throw new Error('API did not start: ' + apiLog.join('')); await sleep(250); }
  process.stdout.write(`API pid ${api.pid} on ${PORT}; ${users.length} users (${mix.map((m) => `${m[0]} ${m[1]}`).join(', ')})\n`);

  const sseStops = []; let sseFrames = 0; let sseOpen = 0;
  const result = { config: { users: USERS, seconds: SECONDS, burstSeconds: BURST, node: process.version, cpus: require('node:os').cpus().length, db: config.db.database }, phases: {} };
  let failure = null;
  try {
    const before = await dbCounters(db.pool);
    // ---- login (50 at once)
    phase = 'login';
    await Promise.all(users.map(async (u) => {
      const r = await request('POST', '/api/v1/auth/login', { op: 'login', expect: [200], body: { username: u.name, password: passwords.get(u.name) } });
      if (r.status !== 200) return;
      u.cookie = `sp_session=${(r.headers['set-cookie'].join(';').match(/sp_session=([^;]+)/) || [])[1]}; sp_auth=1`;
    }));
    const signedIn = users.filter((u) => u.cookie);
    if (signedIn.length !== users.length) throw new Error(`only ${signedIn.length} of ${users.length} users signed in`);
    // ---- authorization checks (expected refusals) and the first data
    phase = 'setup';
    const check = async (name, expected, r) => authz.push({ name, expected, actual: r.status, pass: r.status === expected });
    const coord = users.find((u) => u.role === 'DIEU_PHOI_VIEN'); const agentU = users.find((u) => u.role === 'DAI_LY_HANG_HAI'); const yardU = users.find((u) => u.role === 'NHAN_VIEN_KHO_BAI'); const mgr = users.find((u) => u.role === 'BAN_QUAN_LY');
    const berths = [];
    for (let i = 0; i < 3; i += 1) { const r = await request('POST', '/api/v1/berths', { cookie: coord.cookie, record: false, body: { berth_code: `LB${TAG}${i}`, berth_type: 'CONTAINER', length_m: 400, max_depth_m: 12, available_cranes: 4, allows_dangerous: false } }); berths.push(r.body.data); }
    await check('no cookie -> 401', 401, await request('GET', '/api/v1/voyages', { record: false }));
    await check('bad session -> 401', 401, await request('GET', '/api/v1/voyages', { cookie: 'sp_session=not-a-session; sp_auth=1', record: false }));
    await check('agent reads berth plans -> 403', 403, await request('GET', '/api/v1/berth-plans', { cookie: agentU.cookie, record: false }));
    await check('agent opens berth channel -> 403', 403, await request('GET', '/api/v1/berths/status', { cookie: agentU.cookie, record: false }));
    await check('coordinator approves a plan -> 403', 403, await request('POST', '/api/v1/berth-plans/1/approve', { cookie: coord.cookie, record: false, body: { confirm: true }, headers: { 'If-Match': '"1"' } }));
    await check('yard staff submits a notice -> 403', 403, await request('POST', '/api/v1/voyages', { cookie: yardU.cookie, record: false, body: { ship_id: agentU.ships[0], voyage_code: `LX${TAG}`, agent_id: agentIds[0], origin_port_id: portId, declared_eta: '2035-01-01T00:00:00Z', declared_teu: 1, cargo_type: 'x' } }));
    await check('manager moves the queue -> 403', 403, await request('PATCH', '/api/v1/voyages/1/queue-position', { cookie: mgr.cookie, record: false, body: { to_position: 1, reason: 'x' }, headers: { 'If-Match': '"1"' } }));
    const other = users.find((u) => u.role === 'DAI_LY_HANG_HAI' && u.agentId !== agentU.agentId);
    await check('agent submits for another agent\'s ship -> not created', 403, await request('POST', '/api/v1/voyages', { cookie: other.cookie, record: false, body: { ship_id: agentU.ships[0], voyage_code: `LY${TAG}`, agent_id: agentU.agentId, origin_port_id: portId, declared_eta: '2035-01-01T00:00:00Z', declared_teu: 1, cargo_type: 'x' } }));
    // ---- refresh channels as the browser keeps them: berth channel for berth viewers, notification channel for everyone
    const openSse = (u, p) => { const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers: { Cookie: u.cookie } }, (res) => { if (res.statusCode === 200) sseOpen += 1; res.on('data', (c) => { if (String(c).includes('event: refresh')) sseFrames += 1; }); res.on('error', () => {}); }); req.on('error', () => {}); req.end(); sseStops.push(() => req.destroy()); };
    for (const u of users) { openSse(u, '/api/v1/realtime/notifications'); if (u.role !== 'DAI_LY_HANG_HAI') openSse(u, '/api/v1/realtime/m2/events'); }
    await sleep(800);

    // ---- operations
    const eta = () => new Date(Date.UTC(2031, 0, 1) + rand(0, 3000) * 3600e3).toISOString();
    const queueOf = async (u) => { const r = await request('GET', '/api/v1/voyages/queue', { cookie: u.cookie, op: 'GET queue' }); if (r.status === 200) u.queue = r.body.data; return r; };
    const ops = {
      DAI_LY_HANG_HAI: [
        [4, (u) => request('GET', '/api/v1/voyages?size=20', { cookie: u.cookie, op: 'GET voyages (list)' })],
        [2, (u) => request('GET', '/api/v1/ships?size=20', { cookie: u.cookie, op: 'GET ships (list)' })],
        [2, (u) => request('GET', '/api/v1/notifications', { cookie: u.cookie, op: 'GET notifications' })],
        [2, (u) => request('GET', '/api/v1/auth/me', { cookie: u.cookie, op: 'GET auth/me' })],
        [3, (u) => { if (u.notices >= u.ships.length) return request('GET', '/api/v1/voyages?size=10', { cookie: u.cookie, op: 'GET voyages (list)' });
          const ship = u.ships[u.notices]; u.notices += 1;
          return request('POST', '/api/v1/voyages', { cookie: u.cookie, op: 'POST voyage notice (save + validate + queue)', expect: [201], body: { ship_id: ship, voyage_code: `LV${TAG}${crypto.randomBytes(4).toString('hex')}`, agent_id: u.agentId, origin_port_id: portId, declared_eta: eta(), declared_teu: rand(20, 400), cargo_type: 'Container' } }); }],
      ],
      DIEU_PHOI_VIEN: [
        [3, (u) => queueOf(u)],
        [2, (u) => request('GET', '/api/v1/voyages/schedule?view=list&size=20', { cookie: u.cookie, op: 'GET schedule (list)' })],
        [2, (u) => request('GET', '/api/v1/berths/status', { cookie: u.cookie, op: 'GET berth status' })],
        [2, (u) => request('GET', '/api/v1/berth-plans?size=20', { cookie: u.cookie, op: 'GET berth plans' })],
        [2, (u) => { const from = new Date(); const to = new Date(from.getTime() + 3 * 86400e3); return request('GET', `/api/v1/berths/${pick(berths).id}/chart?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, { cookie: u.cookie, op: 'GET berth chart' }); }],
        [2, async (u) => { const it = u.queue && u.queue.items.length ? pick(u.queue.items) : null; if (!it) return queueOf(u);
          return request('POST', '/api/v1/berth-plan-checks', { cookie: u.cookie, op: 'POST placement check (UC-026)', body: { voyage_id: it.voyage_id, berth_id: pick(berths).id, position_start_m: 0, position_end_m: 150, planned_start: '2031-03-01T00:00:00Z', planned_end: '2031-03-01T12:00:00Z', required_cranes: 1 } }); }],
        [2, async (u) => { const it = u.queue && u.queue.items.length ? pick(u.queue.items) : null; if (!it) return queueOf(u);
          return request('PUT', `/api/v1/voyages/${it.voyage_id}/cargo-hazard`, { cookie: u.cookie, op: 'PUT cargo hazard (save)', body: { cargo_hazard: 'NONE', basis: 'load test' } }); }],
        [1, async (u) => { const items = u.queue && u.queue.items; if (!items || items.length < 2) return queueOf(u); const it = pick(items); let to = rand(1, items.length); if (to === it.position) to = to === 1 ? 2 : 1;
          const r = await request('PATCH', `/api/v1/voyages/${it.voyage_id}/queue-position`, { cookie: u.cookie, op: 'PATCH queue move (409 = someone moved first)', expect: [200, 409], body: { to_position: to, reason: 'load test' }, headers: { 'If-Match': `"${u.queue.revision}"` } });
          if (r.status === 409) await queueOf(u); else if (r.status === 200 && r.body && r.body.data) u.queue = r.body.data; return r; }],
        [2, (u) => request('GET', '/api/v1/notifications', { cookie: u.cookie, op: 'GET notifications' })],
      ],
      BAN_QUAN_LY: [
        [3, (u) => request('GET', '/api/v1/berth-plans?size=20', { cookie: u.cookie, op: 'GET berth plans' })],
        [2, (u) => request('GET', '/api/v1/berths/status', { cookie: u.cookie, op: 'GET berth status' })],
        [2, (u) => request('GET', '/api/v1/voyages/queue', { cookie: u.cookie, op: 'GET queue' })],
        [2, (u) => request('GET', '/api/v1/voyages/schedule?view=list&size=20', { cookie: u.cookie, op: 'GET schedule (list)' })],
        [2, (u) => request('GET', '/api/v1/notifications', { cookie: u.cookie, op: 'GET notifications' })],
      ],
      NHAN_VIEN_KHO_BAI: [
        [3, (u) => request('GET', '/api/v1/berths/status', { cookie: u.cookie, op: 'GET berth status' })],
        [3, (u) => request('GET', '/api/v1/voyages/schedule?view=list&size=20', { cookie: u.cookie, op: 'GET schedule (list)' })],
        [2, (u) => request('GET', '/api/v1/berth-plans?size=20', { cookie: u.cookie, op: 'GET berth plans' })],
        [1, (u) => request('GET', '/api/v1/notifications', { cookie: u.cookie, op: 'GET notifications' })],
      ],
    };
    const weighted = (role) => ops[role].flatMap(([w, fn]) => Array(w).fill(fn));
    const runPhase = async (name, seconds, think) => {
      phase = name; const t0 = Date.now(); const end = t0 + seconds * 1000; const before = samples.length;
      await Promise.all(users.map(async (u) => { const list = weighted(u.role); while (Date.now() < end) { await pick(list)(u); if (think) await sleep(rand(think[0], think[1])); } }));
      const elapsed = (Date.now() - t0) / 1000; const mine = samples.slice(before).filter((s) => s.phase === name);
      result.phases[name] = { seconds: round(elapsed), requests: mine.length, throughputRps: round(mine.length / elapsed), overall: stats(mine) };
    };
    await Promise.all(users.filter((u) => u.role !== 'DAI_LY_HANG_HAI').map(queueOf));
    await runPhase('A_steady', SECONDS, [500, 1500]);
    if (BURST > 0) await runPhase('B_burst', BURST, null);
    const after = await dbCounters(db.pool);
    result.sql = { lockWaitsDuringRun: after.lockWaits - before.lockWaits, lockWaitMsDuringRun: after.lockWaitMs - before.lockWaitMs,
      deadlocks: (after.counters['Number of Deadlocks/sec'] || 0) - (before.counters['Number of Deadlocks/sec'] || 0), lockTimeouts: (after.counters['Lock Timeouts/sec'] || 0) - (before.counters['Lock Timeouts/sec'] || 0) };
    result.sse = { connectionsOpened: sseOpen, expected: users.length + users.filter((u) => u.role !== 'DAI_LY_HANG_HAI').length, refreshFramesSeen: sseFrames };
  } catch (e) { failure = e; }

  // ---------------------------------------------------------------- results and consistency
  for (const stop of sseStops) stop();
  const byOp = {}; for (const s of samples.filter((x) => x.phase.startsWith('A') || x.phase.startsWith('B') || x.phase === 'login')) (byOp[`${s.phase.slice(0, 1)} ${s.op}`] ||= []).push(s);
  result.byOperation = Object.fromEntries(Object.entries(byOp).sort().map(([k, v]) => [k, Object.fromEntries(Object.entries(stats(v)).map(([a, b]) => [a, typeof b === 'number' && !Number.isInteger(b) ? round(b) : b]))]));
  for (const p of Object.values(result.phases)) p.overall = Object.fromEntries(Object.entries(p.overall).map(([a, b]) => [a, typeof b === 'number' && !Number.isInteger(b) ? round(b) : b]));
  result.login = stats(samples.filter((s) => s.phase === 'login'));
  result.errors = Object.entries(samples.filter((s) => !s.ok).reduce((m, s) => { const k = `${s.op} -> ${s.status}${s.error ? ' ' + s.error : ''}`; m[k] = (m[k] || 0) + 1; return m; }, {}));
  result.authzChecks = authz;
  result.apiLogLines = apiLog.join('').split('\n').filter(Boolean).slice(-10);
  try {
    const created = (await q(`SELECT COUNT(*) AS n FROM dbo.voyages WHERE ship_id IN (${shipIds.join(',') || 0})`))[0].n;
    const noted = samples.filter((s) => s.op.startsWith('POST voyage notice') && s.status === 201).length;
    const noHistory = (await q(`SELECT COUNT(*) AS n FROM dbo.voyages v WHERE ship_id IN (${shipIds.join(',') || 0}) AND NOT EXISTS (SELECT 1 FROM dbo.voyage_status_history h WHERE h.voyage_id = v.id)`))[0].n;
    const dupCodes = (await q(`SELECT COUNT(*) AS n FROM (SELECT voyage_code FROM dbo.voyages GROUP BY voyage_code HAVING COUNT(*) > 1) d`))[0].n;
    const runs = (await q(`SELECT COUNT(*) AS n FROM dbo.voyage_validation_runs WHERE voyage_id IN (SELECT id FROM dbo.voyages WHERE ship_id IN (${shipIds.join(',') || 0}))`))[0].n;
    const chk = spawnSync(process.execPath, ['scripts/check-consistency.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, SP_DB_NAME: config.db.database }, encoding: 'utf8' });
    result.consistency = { noticesAccepted201: noted, voyageRowsCreated: created, rowsWithoutHistory: noHistory, duplicateVoyageCodes: dupCodes, validationRuns: runs, checkConsistencyExit: chk.status, checkConsistencyTail: (chk.stdout || '').trim().split('\n').slice(-2) };
  } catch (e) { result.consistency = { error: e.message }; }
  api.kill();
  await sleep(500);
  // ---------------------------------------------------------------- cleanup of this run's own rows (the database is disposable; this keeps it re-runnable)
  try {
    const ids = shipIds.join(',') || '0'; const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
    await q(`UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${ids});
      DELETE FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id IN (${mine}); DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine}); DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
      DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine}); DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine}); DELETE FROM dbo.voyages WHERE ship_id IN (${ids});
      DELETE FROM dbo.ship_documents WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids}); DELETE FROM dbo.berths WHERE berth_code LIKE 'LB${TAG}%';
      DELETE FROM dbo.notifications WHERE recipient_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 'ld[_]%[_]${TAG}');
      DELETE FROM dbo.auth_sessions WHERE user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 'ld[_]%[_]${TAG}');
      DELETE FROM dbo.auth_user_roles WHERE user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 'ld[_]%[_]${TAG}');
      DELETE FROM dbo.auth_user_agents WHERE user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 'ld[_]%[_]${TAG}');
      DELETE FROM dbo.auth_users WHERE username LIKE 'ld[_]%[_]${TAG}'; DELETE FROM dbo.agents WHERE agent_code LIKE 'LA${TAG}%'; DELETE FROM dbo.ports WHERE port_code = 'LD${TAG}';`);
    result.cleanup = 'removed this run\'s users, ships, voyages, berths, agents and port; audit rows remain';
  } catch (e) { result.cleanup = `incomplete: ${e.message}`; }
  await db.pool.close(); agent.destroy();
  if (failure) result.failure = failure.message;
  const text = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, text + '\n');
  process.stdout.write(text + '\n');
  if (failure) process.exitCode = 1;
}

main().catch((e) => { process.stderr.write(`load-test failed: ${e.message}\n`); process.exitCode = 1; });
