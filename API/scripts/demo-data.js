'use strict';

// Demo data for a DISPOSABLE, freshly migrated SmartPort V2 database. Everything goes through the real API (in-process), so the data
// carries real history, audit rows and notifications. It never touches an existing database by itself:
//   SP_DB_NAME=<new empty db> SP_DEMO_PASSWORD=<12+ chars you choose> node scripts/demo-data.js --confirm-disposable
// It refuses when the flag or password is missing, when the database name is protected (loadConfig), and when the database already holds
// berths, voyages or demo accounts. The password is read from the environment and is never printed or stored in a file.
// Ship documents (registration, insurance) are inserted with SQL because no document-upload use case is built in this delivery.

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/connection');
const { createApp } = require('../src/app');
const { createUser } = require('../src/services/userProvisioning');

const ACCOUNTS = {
  coord: ['demo_dieuphoi', 'Điều phối viên (demo)', ['DIEU_PHOI_VIEN']],
  coord2: ['demo_dieuphoi2', 'Điều phối viên 2 (demo)', ['DIEU_PHOI_VIEN']],
  manager: ['demo_quanly', 'Quản lý cảng (demo)', ['BAN_QUAN_LY']],
  manager2: ['demo_quanly2', 'Quản lý cảng 2 (demo)', ['BAN_QUAN_LY']],
  yard: ['demo_khobai', 'Nhân viên kho bãi (demo)', ['NHAN_VIEN_KHO_BAI']],
  agent: ['demo_daily', 'Đại lý hàng hải (demo)', ['DAI_LY_HANG_HAI']],
};

async function main() {
  const password = process.env.SP_DEMO_PASSWORD;
  if (!process.argv.includes('--confirm-disposable')) throw new Error('Pass --confirm-disposable: this writes demo data into the database named by SP_DB_NAME.');
  if (!password || password.length < 12) throw new Error('SP_DEMO_PASSWORD (at least 12 characters) is required.');
  const config = loadConfig();
  const { sql, connect } = createPool(config.db);
  const db = { sql, pool: await connect() };
  const q = async (text, params = {}) => { const r = db.pool.request(); for (const [k, v] of Object.entries(params)) r.input(k, v); return (await r.query(text)).recordset; };
  const count = async (t) => (await q(`SELECT COUNT(*) AS n FROM dbo.${t}`))[0].n;
  if ((await count('berths')) + (await count('voyages')) > 0) throw new Error('The database already has berths or voyages. Use a new empty, migrated database.');
  if ((await q("SELECT COUNT(*) AS n FROM dbo.auth_users WHERE username LIKE 'demo[_]%'"))[0].n > 0) throw new Error('Demo accounts already exist.');

  const agents = await q('SELECT id FROM dbo.agents ORDER BY id'); const ports = await q('SELECT id FROM dbo.ports ORDER BY id');
  const types = Object.fromEntries((await q('SELECT id, type_code FROM dbo.ship_types')).map((t) => [t.type_code, t.id]));
  if (!agents.length || !ports.length) throw new Error('Run `npm run seed` and `npm run seed:demo` on the database first (catalog of ports and agents).');
  const policy = { loginMaxFailures: 5, loginLockMinutes: 15, sessionIdleMinutes: 30 };
  const server = createApp({ db, policy, corsOrigin: 'http://localhost:5500', cookieSecure: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const cookie = {};
  for (const [key, [username, displayName, roles]] of Object.entries(ACCOUNTS)) {
    await createUser(db, { username, displayName, password, roleCodes: roles, agentId: key === 'agent' ? agents[0].id : null });
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    cookie[key] = `sp_session=${res.headers.get('set-cookie').match(/sp_session=([^;]+)/)[1]}; sp_auth=1`;
  }
  const call = async (who, method, path, body, rev) => {
    const res = await fetch(base + path, { method, headers: { Cookie: cookie[who], ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rev !== undefined ? { 'If-Match': `"${rev}"` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json && json.error)}`);
    return json.data;
  };
  const H = (h) => new Date(Date.now() + h * 3600e3).toISOString();

  const berthSpecs = [['D01', 'CONTAINER', 450, 15, 5, false], ['D02', 'CONTAINER', 400, 14, 4, false], ['D03', 'CONTAINER', 350, 13, 4, false], ['D04', 'CONTAINER', 300, 12, 3, false],
    ['D05', 'CONTAINER', 300, 12, 3, false], ['D06', 'CONTAINER', 300, 11, 2, false], ['D07', 'BULK', 280, 11, 2, false], ['D08', 'BULK', 260, 10, 2, true]];
  const berths = [];
  for (const [code, type, len, depth, cranes, dg] of berthSpecs) {
    berths.push(await call('coord', 'POST', '/berths', { berth_code: code, berth_name: `Bến demo ${code}`, berth_type: type, length_m: len, max_depth_m: depth, available_cranes: cranes, allows_dangerous: dg }));
  }
  const names = ['Hải Long', 'Sao Mai', 'Bình Minh', 'Đại Dương', 'Thái Bình', 'Ngọc Lan', 'Phương Đông', 'Hồng Hà', 'Cửu Long', 'Trường Sa', 'An Giang', 'Hòa Bình', 'Vạn Xuân', 'Tân Cảng', 'Lạc Hồng',
    'Kim Quy', 'Bạch Đằng', 'Sông Hương', 'Phú Quốc', 'Côn Đảo', 'Nha Trang', 'Cam Ranh', 'Quy Nhơn', 'Vũng Tàu'];
  let imo = 9100000 + Math.floor(Math.random() * 800000);
  const ships = [];
  for (let i = 0; i < names.length; i += 1) {
    const bulk = i % 5 === 4;
    const s = await call('coord', 'POST', '/ships', { imo_number: String(imo += 1), ship_name: `DEMO ${names[i]}`, ship_type_id: bulk ? types.BULK : types.CONTAINER, operator_agent_id: agents[i % agents.length].id,
      length_overall_m: 150 + (i * 9) % 110, beam_m: 24 + (i % 6), max_draft_m: 8 + (i % 5) * 0.5, deadweight_t: 18000 + i * 1500 });
    ships.push(s);
  }
  const noDocs = new Set([ships.length - 1]);
  for (let i = 0; i < ships.length; i += 1) {
    if (noDocs.has(i)) continue;
    for (const type of ['REGISTRATION', 'INSURANCE']) {
      await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
        VALUES (@s, @t, N'demo.pdf', @k, 'application/pdf', 1000, 'APPROVED', DATEADD(YEAR, 2, SYSUTCDATETIME()), (SELECT TOP 1 user_id FROM dbo.auth_users WHERE username = 'demo_dieuphoi'), SYSUTCDATETIME())`,
      { s: ships[i].id, t: type, k: crypto.randomBytes(8).toString('hex') });
    }
  }
  let n = 0;
  const notice = async (ship, etaH, teu = 800, over = {}) => {
    n += 1;
    const v = await call(over.who || 'coord', 'POST', '/voyages', { ship_id: ship.id, voyage_code: `DM${String(n).padStart(3, '0')}`, agent_id: ship.operator_agent_id || agents[0].id, origin_port_id: ports[n % ports.length].id,
      declared_eta: H(etaH), declared_teu: teu, cargo_type: 'Container', ...(over.priority ? { priority_class: over.priority } : {}) });
    if (v.status === 'WAITING_BERTH') await call('coord', 'PUT', `/voyages/${v.id}/cargo-hazard`, { cargo_hazard: 'NONE', basis: 'Bảng kê hàng hóa demo' });
    loa.set(v.id, Number(ship.length_overall_m));
    return v;
  };
  const loa = new Map();
  const draft = (voyageId, berth, startH, endH, pos = 0, len = 0, cranes = 2) => call('coord', 'POST', '/berth-plans', { voyage_id: voyageId, berth_id: berth.id, position_start_m: pos, position_end_m: pos + loa.get(voyageId) + 10, planned_start: H(startH), planned_end: H(endH), required_cranes: cranes });
  const submit = (p) => call('coord', 'POST', `/berth-plans/${p.id}/submit`, {}, 1);
  const approve = (p, rev) => call('manager', 'POST', `/berth-plans/${p.id}/approve`, { confirm: true }, rev);
  const moved = async (v, berth, ataH, atdH) => {
    const rev = (await call('coord', 'GET', `/voyages/${v.id}`)).revision;
    await call('coord', 'POST', `/voyages/${v.id}/berthing`, { berth_id: berth.id, actual_time: H(ataH), reason: 'Nhập bổ sung dữ liệu demo' }, rev);
    if (atdH !== undefined) {
      const rev2 = (await call('coord', 'GET', `/voyages/${v.id}`)).revision;
      await call('coord', 'POST', `/voyages/${v.id}/departure`, { actual_time: H(atdH), reason: 'Nhập bổ sung dữ liệu demo' }, rev2);
    }
  };
  const approved = async (v, berth, s, e, pos, len, cranes) => { const d = await draft(v.id, berth, s, e, pos, len, cranes); const sub = await submit(d); return approve(d, sub.revision); };

  // History: two departed voyages, two berthed now, three assigned, two pending, one rejected, one draft; the rest wait in the queue.
  const used = [];
  const take = (bulk = false) => { const s = ships.find((x, i) => !used.includes(x) && !noDocs.has(i) && (x.ship_type_id === types.BULK) === bulk); used.push(s); return s; };
  for (const [berth, a, b] of [[berths[0], -60, -40], [berths[1], -50, -30]]) { const v = await notice(take(), -2); await approved(v, berth, a, b, 0, 220, 3); await moved(v, berth, a, b); }
  for (const [berth, a, b] of [[berths[0], -6, 12], [berths[2], -3, 18]]) { const v = await notice(take(), 3); await approved(v, berth, a, b, 0, 200, 3); await moved(v, berth, a, undefined); }
  for (const [berth, a, b] of [[berths[1], 6, 30], [berths[3], 10, 34], [berths[6], 4, 28]]) { const v = await notice(take(berth === berths[6]), 5); await approved(v, berth, a, b, 0, 180, 2); }
  for (const [berth, a, b] of [[berths[4], 20, 40], [berths[5], 26, 46]]) { const v = await notice(take(), 24); const d = await draft(v.id, berth, a, b, 0, 180, 2); await submit(d); }
  { const v = await notice(take(), 30); const d = await draft(v.id, berths[2], 40, 60, 0, 180, 2); const sub = await submit(d); await call('manager', 'POST', `/berth-plans/${d.id}/reject`, { reason: 'Không đủ cẩu bờ trong khung giờ này' }, sub.revision); }
  { const v = await notice(take(), 34); await draft(v.id, berths[3], 50, 70, 0, 180, 2); }
  const queueRest = ships.length - used.length - 1;
  for (let i = 0; i < queueRest; i += 1) await notice(take(ships.filter((x, k) => !used.includes(x) && !noDocs.has(k) && x.ship_type_id !== types.BULK).length === 0), 40 + i * 6, 400 + i * 90, { priority: i % 6 === 0 ? 'MAIN_LINE' : undefined });
  await notice(ships[ships.length - 1], 90); // no documents: MISSING_DOCUMENTS, not queued

  const summary = {};
  for (const r of await q('SELECT status, COUNT(*) AS n FROM dbo.voyages GROUP BY status')) summary[r.status] = r.n;
  process.stdout.write(`Demo data written to ${config.db.database}\nvoyages by status: ${JSON.stringify(summary)}\n`
    + `berths: ${await count('berths')}, ships: ${await count('ships')}, plans: ${await count('berth_plans')}, audit rows: ${await count('audit_events')}\n`
    + `accounts: ${Object.values(ACCOUNTS).map((a) => a[0]).join(', ')} (password = the SP_DEMO_PASSWORD you supplied)\n`);
  await new Promise((r) => server.close(r));
  await db.pool.close();
}

main().catch((err) => { process.stderr.write(`demo-data failed: ${err.message}\n`); process.exitCode = 1; });
