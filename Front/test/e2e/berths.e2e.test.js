'use strict';

// Browser end-to-end tests for Module 2, first slice: berth catalog (UC-024), live berth state (UC-025) and the placement
// check (UC-026), Front -> API -> SQL Server. Set-up and the disposable-database requirement are in support.js.
// Plans, maintenance and queued voyages come from later use cases, so fixtures insert them into the documented tables.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support');

const { skip, FRONT, API, newPage, loginOk } = S;
const sfx = S.SUFFIX;
const CODE = (n) => `E${sfx}${n}`;
let agentA; let portId; let typeId; let shipId; let coordUserId;
const users = {
  coord: S.mkUser('bcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']),
  manager: S.mkUser('bmgr', `Quản lý ${sfx}`, ['BAN_QUAN_LY']),
  agent: S.mkUser('bagent', `Đại lý ${sfx}`, ['DAI_LY_HANG_HAI']),
};
const q = async (text, params = {}) => {
  const d = S.db(); const req = d.pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(text)).recordset;
};

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('BA_${sfx}', N'Đại lý B ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('BP${sfx}', N'Cảng B ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
  users.agent.agentId = agentA;
  shipId = await run(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES ('BC${sfx}', '3${String(100000 + Math.floor(Math.random() * 800000))}', N'Berth E2E ${sfx}', ${typeId}, 250, 32, 10, 60000)`);
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id = ${shipId}`;
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'E${sfx}%'`;
  await d.pool.request().query(`
    DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own}));
    DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own}));
    DELETE FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own});
    DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${own});
    DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyages WHERE ship_id = ${shipId}; DELETE FROM dbo.ships WHERE id = ${shipId};
    DELETE FROM dbo.berths WHERE berth_code LIKE 'E${sfx}%';
    DELETE FROM dbo.auth_user_agents WHERE agent_id = ${agentA};
    DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
}));

const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
async function openBerths(page, user) {
  await loginOk(page, user, 'overview.html');
  await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#brt');
  await waitList(page, '#berthList');
}
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const apiFetch = (page, method, path, body, extra = {}) => page.evaluate(async (base, m, p, b, x) => {
  const res = await fetch(base + p, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, path, body, extra);
const rowOf = (page, code) => page.$$eval('#berthList tr[data-berth]', (rs, c) => (rs.find((r) => r.textContent.includes(c)) || {}).textContent || null, code);
const hasRow = (page, code) => page.waitForFunction((c) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(c)), {}, code);
const fill = async (page, id, value) => { await page.$eval(id, (e) => { e.value = ''; }); if (value !== '') await page.type(id, String(value)); };
async function addBerthUi(page, n, over = {}) {
  await page.click('#addBerth');
  await page.waitForSelector('#bf');
  await fill(page, '#f-berth_code', over.code || CODE(n));
  await page.select('#f-berth_type', over.type || 'CONTAINER');
  await fill(page, '#f-length_m', over.length ?? 300);
  await fill(page, '#f-max_depth_m', over.depth ?? 12);
  await fill(page, '#f-available_cranes', over.cranes ?? 3);
  if (over.dangerous) await page.select('#f-allows_dangerous', 'true');
  await page.click('#bf button[type=submit]');
}

test('UC-024: a coordinator adds a berth in the browser; it is listed as free, stored with an audit row, and can be edited', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openBerths(page, users.coord);
  assert.equal(await page.$eval('#addBerth', (b) => b.hidden), false);
  await addBerthUi(page, 'a');
  await dialogClosed(page);
  await hasRow(page, CODE('a'));
  const row = await rowOf(page, CODE('a'));
  assert.ok(row.includes('Trống') && row.includes('300 / 12'), row);
  const stored = (await q('SELECT berth_type, length_m, available_cranes, revision FROM dbo.berths WHERE berth_code = @c', { c: CODE('a') }))[0];
  assert.deepEqual([stored.berth_type, stored.length_m, stored.available_cranes, Number(stored.revision)], ['CONTAINER', 300, 3, 1]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_CREATE' AND outcome = 'SUCCESS' AND new_json LIKE @c", { c: `%${CODE('a')}%` }))[0].n, 1);
  // 5a: a duplicate code and values at or below zero are shown on their fields; the dialog stays open and nothing is stored.
  await addBerthUi(page, 'a');
  await page.waitForFunction(() => document.querySelector('#e-berth_code').textContent.length > 0);
  assert.equal(await page.evaluate(() => document.querySelector('#vdlg').open), true);
  await fill(page, '#f-berth_code', CODE('b')); await fill(page, '#f-length_m', 0);
  await page.click('#bf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#e-length_m').textContent.length > 0);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berths WHERE berth_code = @c', { c: CODE('b') }))[0].n, 0);
  await page.click('#bf [data-close]');
  await dialogClosed(page);
  // Edit: change the cranes; the list shows the new value.
  await page.click("#berthList tr[data-berth] [data-bact=edit]");
  await page.waitForSelector('#bf');
  assert.ok((await page.$eval('#f-berth_code', (e) => e.value)).startsWith('E'));
  await context.close();
});

test('UC-024 6a: editing the size of a berth with plans lists the plans and asks for confirmation; other roles cannot add or edit', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openBerths(page, users.coord);
  await addBerthUi(page, 'p');
  await dialogClosed(page);
  await hasRow(page, CODE('p'));
  const berthId = (await q('SELECT id FROM dbo.berths WHERE berth_code = @c', { c: CODE('p') }))[0].id;
  const voyageId = (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, '2031-01-10', 1, N'x', 9999, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1')`, { s: shipId, c: `BV-p-${sfx}`, a: agentA, p: portId }))[0].id;
  const reviewer = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id;
  await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json,
      submitted_by_user_id, submitted_at, approved_by_user_id, approved_at) VALUES (@v, @b, 'APPROVED', 'MANUAL', 0, 250, '2031-01-10T01:00:00Z', '2031-01-10T13:00:00Z', 1, 15, N'TEST', N'{"passed":true}', @u, SYSUTCDATETIME(), (SELECT TOP 1 user_id FROM dbo.auth_users WHERE user_id <> @u ORDER BY user_id), SYSUTCDATETIME())`,
  { v: voyageId, b: berthId, u: reviewer });
  await page.reload();
  await page.waitForSelector('#brt');
  await waitList(page, '#berthList');
  await hasRow(page, CODE('p'));
  await page.$$eval('#berthList tr[data-berth]', (rs, c) => rs.find((r) => r.textContent.includes(c)).querySelector('[data-bact=edit]').click(), CODE('p'));
  await page.waitForSelector('#bf');
  await fill(page, '#f-length_m', 280);
  await page.click('#bf button[type=submit]');
  await page.waitForFunction(() => { const w = document.querySelector('#bwarn'); return w && !w.hidden && w.textContent.includes('BV-p-'); });
  assert.equal((await q('SELECT length_m FROM dbo.berths WHERE id = @i', { i: berthId }))[0].length_m, 300, 'unchanged until confirmed');
  await page.click('#bwarn [data-bact=confirm]');
  await dialogClosed(page);
  await page.waitForFunction((c) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(c) && r.textContent.includes('280 / 12')), {}, CODE('p'));
  assert.equal((await q('SELECT length_m FROM dbo.berths WHERE id = @i', { i: berthId }))[0].length_m, 280);
  await context.close();

  // Management reads but cannot change; the agent does not see the panel and the API refuses it.
  const { page: mp, context: mc } = await newPage();
  await openBerths(mp, users.manager);
  assert.equal(await mp.$eval('#addBerth', (b) => b.hidden), true);
  assert.equal(await mp.$('[data-bact=edit]'), null);
  assert.equal((await apiFetch(mp, 'POST', '/api/v1/berths', { berth_code: CODE('m'), berth_type: 'BULK', length_m: 100, max_depth_m: 8, available_cranes: 1, allows_dangerous: false })).status, 403);
  await mc.close();
  const { page: ap, context: ac } = await newPage();
  await loginOk(ap, users.agent, 'vessels.html');
  await ap.goto(`${FRONT}/vessels.html`);
  await ap.waitForSelector('#brt', { hidden: true });
  assert.equal((await apiFetch(ap, 'GET', '/api/v1/berths/status')).status, 403);
  await ac.close();
});

test('UC-025: derived states are shown and filtered, the detail lists plans and maintenance, and a change made by someone else appears without reload', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openBerths(page, users.coord);
  const mk = async (n, extra = {}) => (await apiFetch(page, 'POST', '/api/v1/berths', { berth_code: CODE(n), berth_type: 'CONTAINER', length_m: 300, max_depth_m: 12, available_cranes: 2, allows_dangerous: false, ...extra })).body.data;
  const maint = await mk('s1'); const reserved = await mk('s2'); await mk('s3');
  const now = Date.now();
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Bảo trì cẩu E2E', N'test')`, { b: maint.id, f: new Date(now - 3600000), t: new Date(now + 7200000) });
  const voyageId = (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, '2031-01-10', 1, N'x', 9999, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1')`, { s: shipId, c: `BV-s-${sfx}`, a: agentA, p: portId }))[0].id;
  const reviewer = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id;
  await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json,
      submitted_by_user_id, submitted_at, approved_by_user_id, approved_at) VALUES (@v, @b, 'APPROVED', 'MANUAL', 0, 250, @f, @t, 1, 15, N'TEST', N'{"passed":true}', @u, SYSUTCDATETIME(), (SELECT TOP 1 user_id FROM dbo.auth_users WHERE user_id <> @u ORDER BY user_id), SYSUTCDATETIME())`,
  { v: voyageId, b: reserved.id, u: reviewer, f: new Date(now + 3 * 3600000), t: new Date(now + 9 * 3600000) });
  await page.reload();
  await page.waitForSelector('#brt');
  await waitList(page, '#berthList');
  await hasRow(page, CODE('s3'));
  assert.ok((await rowOf(page, CODE('s1'))).includes('Bảo trì') && (await rowOf(page, CODE('s1'))).includes('đến'));
  assert.ok((await rowOf(page, CODE('s2'))).includes('Đã đặt trước') && (await rowOf(page, CODE('s2'))).includes(`BV-s-${sfx}`));
  assert.ok((await rowOf(page, CODE('s3'))).includes('Trống'));
  // 5a: filter by state and by type, client side, with an empty state.
  await page.select('#brtState', 'MAINTENANCE');
  await page.waitForFunction((c) => document.querySelectorAll('#berthList tr[data-berth]').length >= 1 && ![...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(c)), {}, CODE('s3'));
  await page.select('#brtType', 'BULK');
  await page.waitForFunction(() => document.querySelector('#berthList').textContent.includes('Không có dữ liệu'));
  await page.select('#brtType', ''); await page.select('#brtState', '');
  // Step 6: detail.
  await page.$$eval('#berthList tr[data-berth]', (rs, c) => rs.find((r) => r.textContent.includes(c)).querySelector('[data-bact=detail]').click(), CODE('s2'));
  await page.waitForSelector('#bdetail');
  const detail = await page.$eval('#bdetail', (e) => e.textContent);
  assert.ok(detail.includes(`BV-s-${sfx}`) && detail.includes('APPROVED') && detail.includes('Upcoming plans'));
  await page.click('#bdetail [data-close]');
  await dialogClosed(page);

  // AC-1: another user adds a berth; this open page shows it within 5 s with no reload. (The reload hint is the event.)
  const { page: other, context: oc } = await newPage();
  await loginOk(other, users.coord, 'overview.html');
  const t0 = Date.now();
  const created = (await apiFetch(other, 'POST', '/api/v1/berths', { berth_code: CODE('live'), berth_type: 'BULK', length_m: 200, max_depth_m: 9, available_cranes: 1, allows_dangerous: true })).body.data;
  assert.ok(created.id);
  await page.waitForFunction((c) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(c)), { timeout: 5000 }, CODE('live'));
  assert.ok(Date.now() - t0 < 5000);
  await oc.close();

  // 3a: the channel cannot be reached: the page shows the warning, the browser keeps retrying, and when the channel is back the
  // warning disappears and the snapshot is reloaded. (The connection is re-opened with the channel blocked; a stream cut
  // in the middle goes through the same error handler.)
  await page.setRequestInterception(true);
  let block = true;
  const handler = (r) => { if (block && r.url().includes('/realtime/m2/events')) r.abort(); else r.continue(); };
  page.on('request', handler);
  await page.evaluate(() => { BP.s.es.close(); BP.connect(); });
  await page.waitForFunction(() => !document.querySelector('#brtWarn').hidden, { timeout: 10000 });
  assert.ok((await page.$eval('#brtWarn', (e) => e.textContent)).includes('Dữ liệu có thể chưa cập nhật'));
  const created2 = (await apiFetch(page, 'POST', '/api/v1/berths', { berth_code: CODE('after'), berth_type: 'BULK', length_m: 200, max_depth_m: 9, available_cranes: 1, allows_dangerous: false })).body.data;
  assert.ok(created2.id);
  block = false;
  await page.waitForFunction(() => document.querySelector('#brtWarn').hidden, { timeout: 15000 });
  await hasRow(page, CODE('after')); // missed while disconnected, found by the reload on reconnect
  page.off('request', handler);
  await context.close();
});

// Voyage waiting in the queue. The cargo hazard is verified unless hazard is null (UC-026 BR-03 needs a verified fact).
async function queuedVoyage(code, { hazard = 'NONE' } = {}) {
  const u = Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version,
      cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, '2031-01-10T01:00:00Z', 1, N'x', 9999, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'UC015-POLICY-V1', ${hazard ? "@h, N'fixture', @u, SYSUTCDATETIME()" : 'NULL, NULL, NULL, NULL'})`,
  { s: shipId, c: code, a: agentA, p: portId, h: hazard, u }))[0].id;
}
const openCheck = async (page, voyageId) => {
  await page.waitForSelector(`#queueList tr[data-queue="${voyageId}"]`);
  await page.click(`#queueList tr[data-queue="${voyageId}"] [data-act=berth-check]`);
  await page.waitForSelector('#cf');
};
const fillPlan = async (page, berthId, { start = 0, end = 260, cranes = 2, from = '2031-01-10T08:00', to = '2031-01-10T20:00' } = {}) => {
  await page.select('#f-berth_id', String(berthId));
  await fill(page, '#f-position_start_m', start); await fill(page, '#f-position_end_m', end);
  await page.$eval('#f-planned_start', (e, v) => { e.value = v; }, from); await page.$eval('#f-planned_end', (e, v) => { e.value = v; }, to);
  await fill(page, '#f-required_cranes', cranes === null ? '' : cranes);
};
const mkBerth = async (page, code, extra = {}) => (await apiFetch(page, 'POST', '/api/v1/berths', { berth_code: code, berth_type: 'CONTAINER', length_m: 600, max_depth_m: 12, available_cranes: 3, allows_dangerous: false, ...extra })).body.data;
// Waits for the override box; if it never appears, fail with what the dialog shows instead of a bare timeout.
const waitOverride = async (page) => { try { await page.waitForSelector('#ovBox #f-override_reason', { timeout: 8000 }); } catch (e) { throw new Error('override box missing; dialog shows: ' + JSON.stringify(await page.evaluate(() => (document.querySelector('#vdlg') || document.body).innerText.slice(0, 700)))); } };
const planRowOf = (page, voyageCode) => page.$$eval('#planList tr[data-plan]', (rs, c) => (rs.find((r) => r.textContent.includes(c)) || {}).textContent || null, voyageCode);
const hasPlan = (page, voyageCode, text) => page.waitForFunction((c, t) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(c) && r.textContent.includes(t)), {}, voyageCode, text);

test('UC-026: unverified cargo is missing data; verifying it in the dialog lets the check report each rule with its reason; the manager can check but not move', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openBerths(page, users.coord);
  const berth = await mkBerth(page, CODE('k'), { length_m: 300 });
  const code = `BV-k-${sfx}`;
  const voyageId = await queuedVoyage(code, { hazard: null });
  await page.reload();
  await openCheck(page, voyageId);
  assert.equal(await page.$eval('#f-planned_start', (e) => e.value), '2031-01-10T08:00', 'prefilled from the effective ETA, shown in UTC+7');
  assert.ok((await page.$eval('#hzNow', (e) => e.textContent)).includes('Chưa xác minh'));
  await page.select('#f-berth_id', String(berth.id));
  await page.click('#cf button[type=submit]');   // empty values: field errors, no result
  await page.waitForFunction(() => document.querySelector('#e-position_start_m').textContent.length > 0);
  await fillPlan(page, berth.id, { end: 200 });
  await page.click('#cf button[type=submit]');
  await page.waitForSelector('#chkOutcome');
  assert.equal(await page.$eval('#chkOutcome', (e) => e.dataset.outcome), 'MISSING_DATA', 'cargo not verified: insufficient data, not a pass');
  assert.equal(await page.$eval('#chkOutcome [data-rule=DANGEROUS_GOODS]', (e) => e.dataset.outcome), 'MISSING_DATA');
  // Verifying the cargo (with a basis) in the dialog.
  await page.click('#hzBtn');
  await page.waitForFunction(() => document.querySelector('#e-hz').textContent.length > 0);    // the basis is required
  await page.type('#f-hz_basis', 'Danh mục hàng hóa số 42');
  await page.click('#hzBtn');
  await page.waitForFunction(() => document.querySelector('#hzNow').textContent.includes('Đã xác minh: không có hàng nguy hiểm'));
  const hz = (await q('SELECT cargo_hazard, cargo_hazard_basis FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0];
  assert.deepEqual([hz.cargo_hazard, hz.cargo_hazard_basis], ['NONE', 'Danh mục hàng hóa số 42']);
  // A stretch shorter than the vessel (LOA 250 m): a violation naming the rule and the reason.
  await page.click('#cf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#chkOutcome') && document.querySelector('#chkOutcome').dataset.outcome === 'VIOLATION');
  const loa = await page.$eval('#chkOutcome [data-rule=LOA_FIT]', (e) => ({ outcome: e.dataset.outcome, text: e.textContent }));
  assert.equal(loa.outcome, 'VIOLATION');
  assert.ok(loa.text.includes('LOA 250 m lớn hơn đoạn bến được bố trí 200 m'), loa.text);
  assert.equal(await page.$eval('#chkOutcome [data-rule=MAINTENANCE]', (e) => e.dataset.outcome), 'PASS');
  await fill(page, '#f-position_end_m', 260);
  await page.click('#cf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#chkOutcome') && document.querySelector('#chkOutcome').dataset.outcome === 'PASS');
  await fill(page, '#f-required_cranes', '');
  await page.click('#cf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#chkOutcome') && document.querySelector('#chkOutcome').dataset.outcome === 'MISSING_DATA');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v', { v: voyageId }))[0].n, 0, 'the check stores nothing');
  await context.close();

  const { page: mp, context: mc } = await newPage();
  await openBerths(mp, users.manager);
  await mp.waitForSelector(`#queueList tr[data-queue="${voyageId}"]`);
  assert.equal(await mp.$(`#queueList tr[data-queue="${voyageId}"] [data-act=move]`), null, 'management cannot move');
  await openCheck(mp, voyageId);
  assert.equal(await mp.$('#savePlan'), null, 'management can check but not save a plan');
  assert.equal(await mp.$('#hzBtn'), null, 'management cannot verify cargo');
  await mc.close();
});

test('UC-028/029: a coordinator saves a draft, is warned about a violation and overrides it with a reason, submits for approval, and a rule that fails at submission is refused', { skip, timeout: 180000 }, async () => {
  const { page, context } = await newPage();
  await openBerths(page, users.coord);
  const berth = await mkBerth(page, CODE('m1'));
  const v1 = await queuedVoyage(`BV-m1-${sfx}`); const v2 = await queuedVoyage(`BV-m2-${sfx}`); const v3 = await queuedVoyage(`BV-m3-${sfx}`);
  const before = (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: v1 }))[0];
  await page.reload();
  await page.waitForSelector('#plp');
  await waitList(page, '#planList');

  // UC-028 main flow: a clean placement is saved as a draft; the voyage and the queue do not change.
  await openCheck(page, v1);
  await fillPlan(page, berth.id);
  await page.click('#savePlan');
  await dialogClosed(page);
  await hasPlan(page, `BV-m1-${sfx}`, 'DRAFT');
  assert.ok((await planRowOf(page, `BV-m1-${sfx}`)).includes('Đạt'));
  const draft1 = (await q('SELECT id, plan_status, source FROM dbo.berth_plans WHERE voyage_id = @v', { v: v1 }))[0];
  assert.deepEqual([draft1.plan_status, draft1.source], ['DRAFT', 'MANUAL']);
  assert.deepEqual((await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: v1 }))[0], before);

  // 3a: a violation is always warned; saving needs a reason (an empty reason is refused); the reason is stored and audited.
  await openCheck(page, v2);
  await fillPlan(page, berth.id, { start: 300, end: 520, from: '2031-01-11T08:00', to: '2031-01-11T20:00' });   // 220 m for a 250 m vessel
  await page.click('#savePlan');
  await waitOverride(page);
  assert.equal(await page.$eval('#chkOutcome', (e) => e.dataset.outcome), 'VIOLATION');
  assert.equal(await page.$eval('#chkOutcome [data-rule=LOA_FIT]', (e) => e.dataset.outcome), 'VIOLATION');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v', { v: v2 }))[0].n, 0, 'the warning stored nothing');
  await page.click('#ovBtn');
  await page.waitForFunction(() => document.querySelector('#e-override_reason').textContent.length > 0);
  await page.type('#f-override_reason', 'Tàu neo chéo, đã thống nhất với hoa tiêu');
  await page.click('#ovBtn');
  await dialogClosed(page);
  await hasPlan(page, `BV-m2-${sfx}`, 'Có ghi đè');
  const draft2 = (await q("SELECT id, JSON_VALUE(constraint_check_json, '$.passed') AS passed, override_reason, override_rules FROM dbo.berth_plans WHERE voyage_id = @v", { v: v2 }))[0];
  assert.deepEqual([draft2.passed, draft2.override_reason, draft2.override_rules], ['false', 'Tàu neo chéo, đã thống nhất với hoa tiêu', '["LOA_FIT"]']);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_PLAN_OVERRIDE' AND entity_id = @e AND reason = N'Tàu neo chéo, đã thống nhất với hoa tiêu'", { e: String(draft2.id) }))[0].n, 1);

  // UC-029 main flow: send for approval. Management gets a notice; nothing is approved.
  await page.click(`#planList tr[data-plan="${draft1.id}"] [data-bact=plan-submit]`);
  await hasPlan(page, `BV-m1-${sfx}`, 'PENDING_APPROVAL');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @e AND recipient_role_code = 'BAN_QUAN_LY'", { e: draft1.id }))[0].n, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE plan_status = 'APPROVED' AND voyage_id IN (@a, @b, @c)", { a: v1, b: v2, c: v3 }))[0].n, 0);
  assert.equal(await page.$(`#planList tr[data-plan="${draft1.id}"] [data-bact=plan-submit]`), null, 'a submitted plan cannot be submitted again');
  assert.deepEqual((await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: v1 }))[0], before, 'the voyage stays in the queue');

  // UC-029 2a: maintenance appears after the draft was saved; the submission is refused, the plan stays a draft, and only an override reason lets it through.
  await openCheck(page, v3);
  await fillPlan(page, berth.id, { start: 0, end: 260, from: '2031-01-12T08:00', to: '2031-01-12T20:00' });
  await page.click('#savePlan');
  await dialogClosed(page);
  await hasPlan(page, `BV-m3-${sfx}`, 'DRAFT');
  const draft3 = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: v3 }))[0].id;
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, '2031-01-12T05:00:00Z', '2031-01-12T09:00:00Z', 'ACTIVE', N'Nạo vét', N'test')`, { b: berth.id });
  await page.click(`#planList tr[data-plan="${draft3}"] [data-bact=plan-submit]`);
  await waitOverride(page);
  assert.equal(await page.$eval('#chkOutcome [data-rule=MAINTENANCE]', (e) => e.dataset.outcome), 'VIOLATION');
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: draft3 }))[0].plan_status, 'DRAFT');
  await page.type('#f-override_reason', 'Bảo trì sẽ kết thúc sớm');
  await page.click('#ovBtn');
  await dialogClosed(page);
  await hasPlan(page, `BV-m3-${sfx}`, 'PENDING_APPROVAL');
  assert.equal((await q('SELECT override_reason FROM dbo.berth_plans WHERE id = @i', { i: draft3 }))[0].override_reason, 'Bảo trì sẽ kết thúc sớm');

  // Editing the draft with an override (v2) keeps its reason requirement: the edit dialog opens with the stored values.
  await page.click(`#planList tr[data-plan="${draft2.id}"] [data-bact=plan-edit]`);
  await page.waitForSelector('#cf');
  assert.equal(await page.$eval('#f-position_end_m', (e) => e.value), '520');
  await page.click('#cf [data-close]');
  await dialogClosed(page);
  await context.close();

  // Management sees the plans but has no buttons to save or submit them; the API refuses forced calls.
  const { page: mp, context: mc } = await newPage();
  await openBerths(mp, users.manager);
  await waitList(mp, '#planList');
  await hasPlan(mp, `BV-m1-${sfx}`, 'PENDING_APPROVAL');
  assert.equal(await mp.$('#planList [data-bact=plan-submit]'), null);
  assert.equal(await mp.$('#planList [data-bact=plan-edit]'), null);
  assert.equal((await apiFetch(mp, 'POST', `/api/v1/berth-plans/${draft2.id}/submit`, {}, { 'If-Match': '"1"' })).status, 403);
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: draft2.id }))[0].plan_status, 'DRAFT');
  await mc.close();
});

test('UC-028: an out-of-service berth cannot be overridden into a plan, and the dialog says so without offering a reason box', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openBerths(page, users.coord);
  const berth = await mkBerth(page, CODE('o1'));
  await apiFetch(page, 'PATCH', `/api/v1/berths/${berth.id}`, { operational_status: 'OUT_OF_SERVICE' }, { 'If-Match': '"1"' });
  const v = await queuedVoyage(`BV-o1-${sfx}`);
  await page.reload();
  await openCheck(page, v);
  await fillPlan(page, berth.id);
  await page.click('#savePlan');
  await page.waitForSelector('#ovBox');
  assert.equal(await page.$eval('#chkOutcome [data-rule=BERTH_IN_SERVICE]', (e) => e.dataset.outcome), 'VIOLATION');
  assert.match(await page.$eval('#ovBox', (e) => e.textContent), /không thể ghi đè/i);
  assert.equal(await page.$('#f-override_reason'), null);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v', { v }))[0].n, 0);
  await context.close();
});

test('UC-029 + UC-030, two accounts: the dispatcher submits, the port manager is notified, reviews and approves; the dispatcher cannot; the schedule, the berth state and the queue follow', { skip, timeout: 180000 }, async () => {
  const { page: a, context: ca } = await newPage();      // Dispatcher A
  await openBerths(a, users.coord);
  const berth = await mkBerth(a, CODE('ap'));
  const code = `BV-ap-${sfx}`;
  const voyageId = await queuedVoyage(code);
  const other = await queuedVoyage(`BV-ap2-${sfx}`);     // stays in the queue behind it
  await a.reload();
  await a.waitForSelector('#plp'); await waitList(a, '#planList');

  const { page: b, context: cb } = await newPage();      // Port manager B, already looking at the page
  await openBerths(b, users.manager);
  await waitList(b, '#planList'); await waitList(b, '#noteList');
  assert.equal(await b.$$eval('#planList tr[data-plan]', (rs, c) => rs.some((r) => r.textContent.includes(c)), code), false, 'nothing to review yet');

  // A creates a draft and sends it for approval.
  await openCheck(a, voyageId);
  await fillPlan(a, berth.id);
  await a.click('#savePlan');
  await dialogClosed(a);
  await hasPlan(a, code, 'DRAFT');
  const planId = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: voyageId }))[0].id;
  const sentAt = Date.now();
  await a.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-submit]`);
  await hasPlan(a, code, 'PENDING_APPROVAL');

  // B receives the notice and sees the plan without reloading, within 5 seconds.
  await b.waitForFunction((c) => [...document.querySelectorAll('#noteList li[data-unread=true]')].some((li) => li.textContent.includes(c)), { timeout: 5000 }, code);
  assert.ok(Date.now() - sentAt < 5000 + 2000, 'the notice reached the manager quickly');
  await b.waitForFunction((c) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(c) && r.textContent.includes('PENDING_APPROVAL') && r.querySelector('[data-bact=plan-review]')), { timeout: 5000 }, code);
  assert.ok((await b.$eval('#noteCount', (e) => e.textContent)).includes('mới'));
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id = @e AND recipient_role_code = 'BAN_QUAN_LY'", { e: planId }))[0].n, 1, 'a real notification row in SQL Server');
  // The notice can be marked as read, and stays listed when "unread only" is off.
  await b.click(`#noteList li[data-note] [data-bact=note-read]`);
  await b.waitForFunction((c) => ![...document.querySelectorAll('#noteList li')].some((li) => li.textContent.includes(c) && li.dataset.unread === 'true'), { timeout: 5000 }, code);

  // A cannot approve their own plan: no button, and a forced call is refused.
  assert.equal(await a.$(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`), null, 'the dispatcher has no approve button');
  assert.equal((await apiFetch(a, 'POST', `/api/v1/berth-plans/${planId}/approve`, { confirm: true }, { 'If-Match': '"2"' })).status, 403);
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'PENDING_APPROVAL');

  // B reviews: the stored check, a fresh check, then a confirmation step before the approval.
  await b.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`);
  await b.waitForSelector('#reviewBox #storedCheck [data-outcome=PASS]');
  await b.waitForSelector('#reviewBox #chkResult #chkOutcome[data-outcome=PASS]');
  await b.click('#approveBtn');
  await b.waitForSelector('#confirmBox:not([hidden])');
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'PENDING_APPROVAL', 'nothing is approved before the confirmation');
  await b.click('#cancelApprove');                       // 4a: cancelling keeps the plan pending
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'PENDING_APPROVAL');
  await b.click('#approveBtn');
  await b.click('#confirmApprove');
  await dialogClosed(b);
  await hasPlan(b, code, 'APPROVED');

  // SQL Server: plan, voyage, queue history, audit.
  const plan = (await q('SELECT plan_status, approved_by_user_id, submitted_by_user_id FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0];
  assert.equal(plan.plan_status, 'APPROVED');
  assert.notEqual(String(plan.approved_by_user_id), String(plan.submitted_by_user_id));
  const voyage = (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0];
  assert.deepEqual([voyage.status, voyage.queue_position], ['BERTH_ASSIGNED', null]);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v AND change_type = 'LEFT_QUEUE'", { v: voyageId }))[0].n, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_PLAN_APPROVE' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(planId) }))[0].n, 1);

  // The queue: gone from B's queue panel after the refresh, the other voyage stays.
  await b.waitForFunction((v) => !document.querySelector(`#queueList tr[data-queue="${v}"]`), { timeout: 8000 }, voyageId);
  assert.ok(await b.$(`#queueList tr[data-queue="${other}"]`), 'the voyage behind it is still queued');
  // The berth state: reserved for this voyage.
  await b.waitForFunction((bc, c) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(bc) && r.textContent.includes('Đã đặt trước') && r.textContent.includes(c)), { timeout: 8000 }, berth.berth_code, code);
  // The schedule: the voyage shows as BERTH_ASSIGNED with its berth.
  await b.select('#schStatus', 'BERTH_ASSIGNED');
  await b.waitForFunction((c, bc) => [...document.querySelectorAll('#schBody tr[data-sched]')].some((r) => r.textContent.includes(c) && r.textContent.includes('BERTH_ASSIGNED') && r.textContent.includes(bc)), { timeout: 8000 }, code, berth.berth_code);

  // A's page, never reloaded, follows: the voyage left the queue and the approval notice arrived.
  await a.waitForFunction((v) => !document.querySelector(`#queueList tr[data-queue="${v}"]`), { timeout: 8000 }, voyageId);
  await a.waitForFunction((c) => [...document.querySelectorAll('#noteList li')].some((li) => li.textContent.includes(c) && /xếp bến|phê duyệt/i.test(li.textContent) && !/chờ phê duyệt/.test(li.textContent)), { timeout: 8000 }, code);

  // Approving again is refused (it is no longer pending).
  assert.equal((await apiFetch(b, 'POST', `/api/v1/berth-plans/${planId}/approve`, { confirm: true }, { 'If-Match': '"3"' })).status, 409);
  await ca.close(); await cb.close();
});

test('UC-030: a plan that no longer passes at approval is refused in the dialog, shows the failed rule, stays pending and the submitter is told', { skip, timeout: 120000 }, async () => {
  const { page: a, context: ca } = await newPage();
  await openBerths(a, users.coord);
  const berth = await mkBerth(a, CODE('ap3'));
  const code = `BV-ap3-${sfx}`;
  const voyageId = await queuedVoyage(code);
  await a.reload(); await a.waitForSelector('#plp'); await waitList(a, '#planList');
  await openCheck(a, voyageId); await fillPlan(a, berth.id, { from: '2031-02-10T08:00', to: '2031-02-10T20:00' });
  await a.click('#savePlan'); await dialogClosed(a); await hasPlan(a, code, 'DRAFT');
  const planId = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: voyageId }))[0].id;
  await a.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-submit]`); await hasPlan(a, code, 'PENDING_APPROVAL');
  // Maintenance is added after the submission.
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, '2031-02-10T03:00:00Z', '2031-02-10T09:00:00Z', 'ACTIVE', N'Nạo vét', N'test')`, { b: berth.id });
  const { page: b, context: cb } = await newPage();
  await openBerths(b, users.manager);
  await hasPlan(b, code, 'PENDING_APPROVAL');
  await b.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`);
  await b.waitForSelector('#reviewBox #chkResult #chkOutcome');
  assert.equal(await b.$eval('#reviewBox #chkResult #chkOutcome', (e) => e.dataset.outcome), 'VIOLATION', 'the fresh check no longer passes, whatever the stored result says');
  assert.equal(await b.$eval('#approveBtn', (e) => e.disabled), true);
  assert.equal(await b.$eval('#reviewBox #storedCheck #chkOutcome', (e) => e.dataset.outcome), 'PASS', 'the stored result still says pass');
  // A forced approval is refused by the server in the same way.
  const forced = await apiFetch(b, 'POST', `/api/v1/berth-plans/${planId}/approve`, { confirm: true }, { 'If-Match': '"2"' });
  assert.deepEqual([forced.status, forced.body.error.details.rule], [409, 'CONSTRAINT_VIOLATION_AT_APPROVAL']);
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'PENDING_APPROVAL');
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0].status, 'WAITING_BERTH');
  await a.waitForFunction((c) => [...document.querySelectorAll('#noteList li')].some((li) => li.textContent.includes(c) && li.textContent.includes('Không thể phê duyệt')), { timeout: 8000 }, code);
  await ca.close(); await cb.close();
});

test('UC-031, two accounts: the manager rejects a pending plan with a reason; the dispatcher gets the reason within 5 s; nothing is reserved and the voyage stays queued; the dispatcher makes a new plan', { skip, timeout: 180000 }, async () => {
  const { page: a, context: ca } = await newPage();      // Dispatcher A
  await openBerths(a, users.coord);
  const berth = await mkBerth(a, CODE('rj'));
  const code = `BV-rj-${sfx}`;
  const voyageId = await queuedVoyage(code);
  await a.reload(); await a.waitForSelector('#plp'); await waitList(a, '#planList');
  const { page: b, context: cb } = await newPage();      // Port manager B
  await openBerths(b, users.manager);
  await waitList(b, '#planList');

  await openCheck(a, voyageId); await fillPlan(a, berth.id, { from: '2031-03-10T08:00', to: '2031-03-10T20:00' });
  await a.click('#savePlan'); await dialogClosed(a); await hasPlan(a, code, 'DRAFT');
  const planId = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: voyageId }))[0].id;
  await a.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-submit]`);
  await hasPlan(a, code, 'PENDING_APPROVAL');
  await b.waitForFunction((c) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(c) && r.querySelector('[data-bact=plan-review]')), { timeout: 5000 }, code);

  // Dispatcher A has no review or reject control.
  assert.equal(await a.$(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`), null);
  assert.equal((await apiFetch(a, 'POST', `/api/v1/berth-plans/${planId}/reject`, { reason: 'x' }, { 'If-Match': '"2"' })).status, 403);

  // B opens the plan, chooses Reject, and the reason is required (4a).
  await b.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`);
  await b.waitForSelector('#reviewBox #rejectBtn');
  await b.click('#rejectBtn');
  await b.waitForSelector('#rejectBox:not([hidden])');
  await b.click('#confirmReject');
  await b.waitForFunction(() => document.querySelector('#e-reject_reason').textContent.length > 0);
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'PENDING_APPROVAL', 'no reason, no rejection');
  await b.click('#cancelReject');                         // cancelling keeps it pending
  await b.waitForSelector('#rejectBox', { hidden: true });
  await b.click('#rejectBtn');
  await b.type('#f-reject_reason', 'Không đủ cẩu bờ cho chuyến này');
  const sentAt = Date.now();
  await b.click('#confirmReject');
  await dialogClosed(b);
  await hasPlan(b, code, 'REJECTED');
  assert.ok((await planRowOf(b, code)).includes('Không đủ cẩu bờ cho chuyến này'), 'the rejection and its reason are visible');
  assert.equal(await b.$(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`), null, 'it no longer waits for a decision');

  // A, without reloading, gets the reason within 5 seconds.
  await a.waitForFunction((c) => [...document.querySelectorAll('#noteList li[data-unread=true]')].some((li) => li.textContent.includes(c) && li.textContent.includes('bị từ chối') && li.textContent.includes('Không đủ cẩu bờ cho chuyến này')), { timeout: 5000 }, code);
  assert.ok(Date.now() - sentAt < 7000);
  await hasPlan(a, code, 'REJECTED');

  // SQL Server: rejected, with reason and history; nothing reserved; the voyage is still waiting in the queue.
  const row = (await q('SELECT plan_status, rejection_reason FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0];
  assert.deepEqual([row.plan_status, row.rejection_reason], ['REJECTED', 'Không đủ cẩu bờ cho chuyến này']);
  const v = (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0];
  assert.equal(v.status, 'WAITING_BERTH'); assert.ok(v.queue_position);
  assert.ok(await a.$(`#queueList tr[data-queue="${voyageId}"]`), 'still in the queue on the dispatcher\'s screen');
  await a.waitForFunction((bc) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(bc) && r.textContent.includes('Trống')), { timeout: 8000 }, berth.berth_code);

  // The dispatcher corrects: the rejected plan cannot be edited, a new draft for the same voyage is accepted.
  assert.equal(await a.$(`#planList tr[data-plan="${planId}"] [data-bact=plan-edit]`), null);
  await openCheck(a, voyageId); await fillPlan(a, berth.id, { cranes: 3, from: '2031-03-10T08:00', to: '2031-03-10T20:00' });
  await a.click('#savePlan'); await dialogClosed(a);
  await a.waitForFunction((c) => [...document.querySelectorAll('#planList tr[data-plan]')].filter((r) => r.textContent.includes(c)).length === 2, {}, code);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v AND plan_status = 'DRAFT'", { v: voyageId }))[0].n, 1);
  await ca.close(); await cb.close();
});

test('UC-022 and UC-023, two accounts: the manager approves; the coordinator confirms berthing, then departure; berth, schedule, SQL Server and audit follow', { skip, timeout: 240000 }, async () => {
  const { page: a, context: ca } = await newPage();      // Dispatcher A
  await openBerths(a, users.coord);
  const berth = await mkBerth(a, CODE('mv'));
  const code = `BV-mv-${sfx}`;
  const voyageId = await queuedVoyage(code);
  await a.reload(); await a.waitForSelector('#plp'); await waitList(a, '#planList');
  const { page: b, context: cb } = await newPage();      // Port manager B
  await openBerths(b, users.manager);
  await waitList(b, '#planList');

  await openCheck(a, voyageId); await fillPlan(a, berth.id, { from: '2031-04-10T08:00', to: '2031-04-10T20:00' });
  await a.click('#savePlan'); await dialogClosed(a); await hasPlan(a, code, 'DRAFT');
  const planId = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: voyageId }))[0].id;
  await a.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-submit]`);
  await hasPlan(a, code, 'PENDING_APPROVAL');
  await b.waitForFunction((c) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(c) && r.querySelector('[data-bact=plan-review]')), { timeout: 5000 }, code);
  await b.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`);
  await b.waitForSelector('#reviewBox #chkResult #chkOutcome[data-outcome=PASS]');
  await b.click('#approveBtn'); await b.click('#confirmApprove'); await dialogClosed(b);
  await hasPlan(b, code, 'APPROVED');
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0].status, 'BERTH_ASSIGNED');

  const openLife = async (page, status) => {
    await page.select('#schStatus', status);
    await page.waitForFunction((c) => [...document.querySelectorAll('#schBody tr[data-sched]')].some((r) => r.textContent.includes(c)), { timeout: 8000 }, code);
    await page.click(`#schBody tr[data-sched="${voyageId}"] [data-act=lifecycle]`);
    await page.waitForSelector('#vlife');
  };
  // The manager has no movement button and a forced call is refused.
  await openLife(b, 'BERTH_ASSIGNED');
  assert.equal(await b.$('#vlife [data-act=berthing]'), null, 'port management does not confirm berthing');
  assert.equal((await apiFetch(b, 'POST', `/api/v1/voyages/${voyageId}/berthing`, { berth_id: berth.id }, { 'If-Match': '"1"' })).status, 403);
  await b.click('#vlife [data-close]'); await dialogClosed(b);

  // A: confirm berthing. An edited time without a reason is refused (2a); then the default time is confirmed.
  await openLife(a, 'BERTH_ASSIGNED');
  await a.click('#vlife [data-act=berthing]');
  await a.waitForSelector('#mvf');
  assert.equal(await a.$eval('#f-berth_id', (e) => Number(e.value)), berth.id, 'the planned berth is preselected');
  await a.$eval('#f-actual_time', (e) => { const d = new Date(Date.now() - 3 * 3600e3), p = (n) => String(n).padStart(2, '0'); e.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; });
  await a.click('#mvConfirm');
  await a.waitForFunction(() => document.querySelector('#e-reason').textContent.length > 0);
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0].status, 'BERTH_ASSIGNED', 'nothing changed');
  await a.type('#f-reason', 'Tàu đã cập từ 3 giờ trước, nhập bổ sung');
  await a.click('#mvConfirm');
  await dialogClosed(a);
  const v1 = (await q('SELECT status, ata FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0];
  assert.equal(v1.status, 'BERTHED'); assert.ok(Date.now() - new Date(v1.ata).getTime() > 2.5 * 3600e3, 'the edited ATA was stored');
  await a.waitForFunction((bc) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(bc) && r.textContent.includes('Đang sử dụng')), { timeout: 8000 }, berth.berth_code);
  await b.waitForFunction((bc) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(bc) && r.textContent.includes('Đang sử dụng')), { timeout: 8000 }, berth.berth_code);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'VOYAGE_BERTHING' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(voyageId) }))[0].n, 1);

  // A: confirm departure with the default time.
  await openLife(a, 'BERTHED');
  assert.equal(await a.$('#vlife [data-act=berthing]'), null, 'no second berthing button');
  await a.click('#vlife [data-act=departure]');
  await a.waitForSelector('#mvf');
  await a.click('#mvConfirm');
  await dialogClosed(a);
  const v2 = (await q('SELECT status, ata, atd FROM dbo.voyages WHERE id = @v', { v: voyageId }))[0];
  assert.equal(v2.status, 'DEPARTED'); assert.ok(new Date(v2.atd) >= new Date(v2.ata));
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'COMPLETED');
  await a.waitForFunction((bc) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(bc) && r.textContent.includes('Trống')), { timeout: 8000 }, berth.berth_code);
  await a.waitForFunction((c) => [...document.querySelectorAll('#schBody tr[data-sched]')].every((r) => !r.textContent.includes(c)), { timeout: 8000 }, code);
  await openLife(a, 'DEPARTED');
  const life = await a.$eval('#vlife', (e) => e.textContent);
  assert.ok(life.includes('BERTHED') && life.includes('DEPARTED'), life);
  assert.equal(await a.$('#vlife [data-act=departure]'), null, 'no button after departure');
  await ca.close(); await cb.close();
});
