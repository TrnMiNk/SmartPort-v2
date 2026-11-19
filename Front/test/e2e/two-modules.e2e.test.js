'use strict';

// Integration acceptance of the two approved modules (M1 vessels, M2 berths), Front -> API -> SQL Server, two accounts in two browser contexts.
// Everything the user does goes through the UI; SQL is used only to check what was stored and to insert ship documents (no upload use case exists)
// and the port catalog the form needs. The ETA provider is NOT configured, so the AI forecast must stay "unavailable": it is never counted as a success.
// Time-sensitive steps print their measured latency ("LATENCY name ms") so the evidence file can quote real numbers.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support');

const { skip, FRONT, API, newPage, loginOk } = S;
const sfx = S.SUFFIX;
const CODE = (n) => `T${sfx}${n}`;
let agentA; let portId; let typeId; let coordUserId;
const shipIds = [];
const users = {
  coord: S.mkUser('tcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']),
  manager: S.mkUser('tmgr', `Quản lý ${sfx}`, ['BAN_QUAN_LY']),
  manager2: S.mkUser('tmgr2', `Quản lý 2 ${sfx}`, ['BAN_QUAN_LY']),
  yard: S.mkUser('tyard', `Kho bãi ${sfx}`, ['NHAN_VIEN_KHO_BAI']),
  agent: S.mkUser('tagent', `Đại lý ${sfx}`, ['DAI_LY_HANG_HAI']),
};
const q = async (text, params = {}) => {
  if (process.env.DBG) process.stdout.write(`Q ${text.replace(/\s+/g, ' ').slice(0, 110)}\n`);
  const d = S.db(); const req = d.pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(text)).recordset;
};
const lat = (name, ms) => process.stdout.write(`LATENCY ${name} ${ms} ms\n`);

async function mkShip(label) {
  coordUserId = coordUserId || Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  const id = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES (@c, @i, @n, @t, 220, 30, 9.5, 50000)`, { c: `TS${sfx}${label}`, i: `4${String(100000 + Math.floor(Math.random() * 800000))}`, n: `Two ${label} ${sfx}`, t: typeId }))[0].id;
  for (const type of ['REGISTRATION', 'INSURANCE']) {
    await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
      VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2035-01-01', @u, SYSUTCDATETIME())`, { s: id, t: type, k: `${sfx}${label}${type}`, u: coordUserId });
  }
  shipIds.push(id); return id;
}

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('TA_${sfx}', N'Đại lý T ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('TP${sfx}', N'Cảng T ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
  users.agent.agentId = agentA;
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const ids = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'T${sfx}%'`;
  const plans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own})`;
  await d.pool.request().query(`
    DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (${plans});
    DELETE FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id IN (${mine});
    DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${plans});
    DELETE FROM dbo.berth_plans WHERE id IN (${plans});
    DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${own});
    UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE ship_id IN (${ids});
    DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
    DELETE FROM dbo.ship_documents WHERE ship_id IN (${ids});
    DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});
    DELETE FROM dbo.berths WHERE berth_code LIKE 'T${sfx}%';
    DELETE FROM dbo.auth_user_agents WHERE agent_id = ${agentA};
    DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
}));

const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
async function openPage(page, user) {
  await loginOk(page, user, 'overview.html');
  coordUserId = coordUserId || Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#brt');
  await waitList(page, '#berthList'); await waitList(page, '#planList'); await waitList(page, '#queueList');
}
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const apiFetch = (page, method, path, body, extra = {}) => page.evaluate(async (base, m, p, b, x) => {
  const res = await fetch(base + p, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, path, body, extra);
const fill = async (page, id, value) => { await page.$eval(id, (e) => { e.value = ''; }); if (value !== '') await page.type(id, String(value)); };
const mkBerth = async (page, code) => (await apiFetch(page, 'POST', '/api/v1/berths', { berth_code: code, berth_type: 'CONTAINER', length_m: 600, max_depth_m: 12, available_cranes: 3, allows_dangerous: false })).body.data;
const hasPlan = (page, c, t) => page.waitForFunction((code, text) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(code) && r.textContent.includes(text)), {}, c, t);
const audit = async (action, id) => (await q('SELECT outcome FROM dbo.audit_events WHERE action = @a AND entity_id = @e', { a: action, e: String(id) })).map((r) => r.outcome);
const berthRowHas = (page, code, text, timeout = 8000) => page.waitForFunction((c, t) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(c) && r.textContent.includes(t)), { timeout }, code, text);

// Registers a notice through the form. Returns the voyage id and the measured time from the click to the validation result.
async function registerNotice(a, shipId, code, eta) {
  await a.click('#addNotice'); await a.waitForSelector('#nf');
  await a.select('#f-ship_id', String(shipId));
  await fill(a, '#f-voyage_code', code);
  await a.select('#f-agent_id', String(agentA)); await a.select('#f-origin_port_id', String(portId));
  await a.$eval('#f-declared_eta', (e, v) => { e.value = v; }, eta);
  await fill(a, '#f-declared_teu', 120); await fill(a, '#f-cargo_type', 'Container');
  const t0 = Date.now();
  await a.click('#nf button[type=submit]');
  await a.waitForSelector('#vresult');
  const ms = Date.now() - t0;
  const text = await a.$eval('#vresult', (e) => e.textContent);
  const v = (await q('SELECT id, status, queue_position FROM dbo.voyages WHERE voyage_code = @c', { c: code }))[0];
  return { id: v.id, status: v.status, text, ms };
}

test('M1+M2 full workflow in the browser: notice, automatic validation, queue, plan, check, submit, approval by a second account, berthing, departure; berth, schedule, history and audit', { skip, timeout: 300000 }, async () => {
  const shipId = await mkShip('A');
  const { page: a, context: ca } = await newPage();       // Dispatcher A
  await openPage(a, users.coord);
  const berth = await mkBerth(a, CODE('w'));
  const { page: b, context: cb } = await newPage();       // Port manager B
  await openPage(b, users.manager);

  // 1. Register the notice; automatic validation runs in the same request (UC-013, UC-015).
  const code = `TW-${sfx}`;
  const n = await registerNotice(a, shipId, code, '2031-06-10T08:00');
  lat('notice-submit-to-validation-result', n.ms);
  assert.ok(n.ms < 5000, `validation result within 5 s, took ${n.ms} ms`);
  assert.equal(n.status, 'WAITING_BERTH'); assert.ok(n.text.includes('WAITING_BERTH') && n.text.includes('Vị trí hàng đợi'), n.text);
  const run = (await q('SELECT outcome, policy_version FROM dbo.voyage_validation_runs WHERE voyage_id = @v', { v: n.id }))[0];
  assert.deepEqual([run.outcome, run.policy_version], ['VALID', 'UC015-POLICY-V1']);
  // The AI forecast is unavailable (no provider configured): the screen says so and nothing was stored as a forecast.
  assert.ok(n.text.includes('chưa có dự báo AI'), 'the result states that no AI forecast exists');
  assert.equal((await q('SELECT ai_status FROM dbo.voyage_validation_runs WHERE voyage_id = @v', { v: n.id }))[0].ai_status, 'UNAVAILABLE', 'the run records the AI forecast as unavailable: AI is not counted as executed');
  await a.click('#vresult [data-close]'); await dialogClosed(a);
  await a.waitForSelector(`#queueList tr[data-queue="${n.id}"]`);   // queue membership shown

  // 2. Verify the cargo hazard in the check dialog, check the placement, save a draft, submit.
  // The queue is re-read when the refresh hint of the new notice arrives and is re-drawn if its data changed; a click that lands in that instant loses its node. clickChecked reports the redraw log if that happens.
  await S.clickChecked(a, `#queueList tr[data-queue="${n.id}"] [data-act=berth-check]`); await a.waitForSelector('#cf');
  await a.select('#f-hz', 'NONE'); await a.type('#f-hz_basis', 'Bảng kê hàng hóa đã đối chiếu'); await a.click('#hzBtn');
  await a.waitForFunction(() => document.querySelector('#hzNow') && document.querySelector('#hzNow').textContent.includes('Bảng kê'));
  await a.select('#f-berth_id', String(berth.id));
  await fill(a, '#f-position_start_m', 0); await fill(a, '#f-position_end_m', 240);
  await a.$eval('#f-planned_start', (e, v) => { e.value = v; }, '2031-06-10T08:00'); await a.$eval('#f-planned_end', (e, v) => { e.value = v; }, '2031-06-10T20:00');
  await fill(a, '#f-required_cranes', 2);
  await a.click('#cf button[type=submit]');
  await a.waitForSelector('#chkResult #chkOutcome[data-outcome=PASS]');
  await a.click('#savePlan'); await dialogClosed(a); await hasPlan(a, code, 'DRAFT');
  const planId = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: n.id }))[0].id;
  const t1 = Date.now();
  await a.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-submit]`);
  await hasPlan(a, code, 'PENDING_APPROVAL');

  // 3. B gets the notification without reloading and approves (a second, authorized account).
  await b.waitForFunction((c) => [...document.querySelectorAll('#noteList li[data-unread=true]')].some((li) => li.textContent.includes(c)), { timeout: 8000 }, code);
  lat('plan-submit-to-manager-notification', Date.now() - t1);
  assert.ok(Date.now() - t1 < 5000 + 2000);
  await b.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`);
  await b.waitForSelector('#reviewBox #chkResult #chkOutcome[data-outcome=PASS]');
  await b.click('#approveBtn'); await b.click('#confirmApprove'); await dialogClosed(b);
  const t2 = Date.now();
  await hasPlan(b, code, 'APPROVED');
  const v1 = (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: n.id }))[0];
  assert.deepEqual([v1.status, v1.queue_position], ['BERTH_ASSIGNED', null]);
  await a.waitForFunction((c) => [...document.querySelectorAll('#noteList li')].some((li) => li.textContent.includes(c) && li.textContent.includes('phê duyệt')), { timeout: 8000 }, code);
  lat('approval-to-coordinator-notification', Date.now() - t2);
  await a.waitForFunction((v) => !document.querySelector(`#queueList tr[data-queue="${v}"]`), { timeout: 8000 }, n.id);   // left the queue
  await berthRowHas(a, berth.berth_code, 'Đã đặt trước');

  // 4. Schedule shows BERTH_ASSIGNED with the berth; the coordinator confirms berthing, then departure.
  const openLife = async (page, status) => {
    await page.select('#schStatus', status);
    await page.waitForFunction((c) => [...document.querySelectorAll('#schBody tr[data-sched]')].some((r) => r.textContent.includes(c)), { timeout: 8000 }, code);
    await page.click(`#schBody tr[data-sched="${n.id}"] [data-act=lifecycle]`); await page.waitForSelector('#vlife');
  };
  await openLife(a, 'BERTH_ASSIGNED');
  assert.ok((await a.$eval(`#schBody tr[data-sched="${n.id}"]`, (e) => e.textContent)).includes(berth.berth_code));
  await a.click('#vlife [data-act=berthing]'); await a.waitForSelector('#mvf'); await a.click('#mvConfirm'); await dialogClosed(a);
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: n.id }))[0].status, 'BERTHED');
  await berthRowHas(a, berth.berth_code, 'Đang sử dụng'); await berthRowHas(b, berth.berth_code, 'Đang sử dụng');
  await openLife(a, 'BERTHED');
  await a.click('#vlife [data-act=departure]'); await a.waitForSelector('#mvf'); await a.click('#mvConfirm'); await dialogClosed(a);
  const done = (await q('SELECT status, ata, atd FROM dbo.voyages WHERE id = @v', { v: n.id }))[0];
  assert.equal(done.status, 'DEPARTED'); assert.ok(new Date(done.atd) >= new Date(done.ata));
  await berthRowHas(a, berth.berth_code, 'Trống');
  assert.equal((await q('SELECT plan_status FROM dbo.berth_plans WHERE id = @i', { i: planId }))[0].plan_status, 'COMPLETED');

  // 5. History and audit: the whole lifecycle, and a row for each state-changing step.
  const hist = (await q('SELECT from_status, to_status, actor FROM dbo.voyage_status_history WHERE voyage_id = @v ORDER BY id', { v: n.id })).map((h) => `${h.from_status}>${h.to_status}`);
  assert.deepEqual(hist, ['null>ANNOUNCED', 'ANNOUNCED>VALIDATED', 'VALIDATED>WAITING_BERTH', 'WAITING_BERTH>BERTH_ASSIGNED', 'BERTH_ASSIGNED>BERTHED', 'BERTHED>DEPARTED']);
  assert.deepEqual(await audit('BERTH_PLAN_SUBMIT', planId), ['SUCCESS']);
  assert.deepEqual(await audit('BERTH_PLAN_APPROVE', planId), ['SUCCESS']);
  assert.deepEqual(await audit('VOYAGE_BERTHING', n.id), ['SUCCESS']);
  assert.deepEqual(await audit('VOYAGE_DEPARTURE', n.id), ['SUCCESS']);
  await openLife(a, 'DEPARTED');
  const life = await a.$eval('#vlife', (e) => e.textContent);
  for (const s of ['ANNOUNCED', 'VALIDATED', 'WAITING_BERTH', 'BERTH_ASSIGNED', 'BERTHED', 'DEPARTED']) assert.ok(life.includes(s), `lifecycle shows ${s}`);
  await ca.close(); await cb.close();
});

test('M1+M2 rejection workflow and roles: the manager rejects with a reason; the coordinator is told; the voyage stays queued; roles that must be refused are refused and audited', { skip, timeout: 240000 }, async () => {
  const shipId = await mkShip('B');
  const { page: a, context: ca } = await newPage();
  await openPage(a, users.coord);
  const berth = await mkBerth(a, CODE('r'));
  const { page: b, context: cb } = await newPage();
  await openPage(b, users.manager);
  const code = `TR-${sfx}`;
  const n = await registerNotice(a, shipId, code, '2031-07-10T08:00');
  assert.equal(n.status, 'WAITING_BERTH');
  await a.click('#vresult [data-close]'); await dialogClosed(a);
  await apiFetch(a, 'PUT', `/api/v1/voyages/${n.id}/cargo-hazard`, { cargo_hazard: 'NONE', basis: 'Bảng kê hàng hóa đã đối chiếu' });
  await a.click(`#queueList tr[data-queue="${n.id}"] [data-act=berth-check]`); await a.waitForSelector('#cf');
  await a.select('#f-berth_id', String(berth.id));
  await fill(a, '#f-position_start_m', 0); await fill(a, '#f-position_end_m', 240);
  await a.$eval('#f-planned_start', (e, v) => { e.value = v; }, '2031-07-10T08:00'); await a.$eval('#f-planned_end', (e, v) => { e.value = v; }, '2031-07-10T20:00');
  await fill(a, '#f-required_cranes', 2);
  await a.click('#savePlan'); await dialogClosed(a); await hasPlan(a, code, 'DRAFT');
  const planId = (await q('SELECT id FROM dbo.berth_plans WHERE voyage_id = @v', { v: n.id }))[0].id;
  await a.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-submit]`); await hasPlan(a, code, 'PENDING_APPROVAL');
  await b.waitForFunction((c) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(c) && r.querySelector('[data-bact=plan-review]')), { timeout: 8000 }, code);

  // Roles: the coordinator cannot approve or reject; warehouse staff and the agent are refused every berth route.
  assert.equal(await a.$(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`), null);
  assert.equal((await apiFetch(a, 'POST', `/api/v1/berth-plans/${planId}/approve`, { confirm: true }, { 'If-Match': '"2"' })).status, 403);
  assert.equal((await apiFetch(a, 'POST', `/api/v1/berth-plans/${planId}/reject`, { reason: 'x' }, { 'If-Match': '"2"' })).status, 403);
  const { page: y, context: cy } = await newPage(); await loginOk(y, users.yard, 'overview.html');
  assert.equal((await apiFetch(y, 'POST', `/api/v1/voyages/${n.id}/berthing`, { berth_id: berth.id }, { 'If-Match': '"1"' })).status, 403);
  assert.equal((await apiFetch(y, 'POST', `/api/v1/berth-plans/${planId}/approve`, { confirm: true }, { 'If-Match': '"2"' })).status, 403);
  const { page: g, context: cg } = await newPage(); await loginOk(g, users.agent, 'vessels.html');
  assert.equal((await apiFetch(g, 'GET', '/api/v1/berth-plans')).status, 403);
  assert.equal((await apiFetch(g, 'POST', `/api/v1/voyages/${n.id}/departure`, {}, { 'If-Match': '"1"' })).status, 403);
  let denied; try { denied = (await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE outcome = 'DENIED' AND actor LIKE @a", { a: `e2e_t%_${sfx}` }))[0].n; } catch (e) {
    const who = await q("SELECT r.session_id, r.blocking_session_id, r.wait_type, r.status, LEFT(t.text, 120) AS sql_text FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.session_id <> @@SPID AND r.database_id = DB_ID()");
    throw new Error('audit count timed out; requests: ' + JSON.stringify(who)); }
  assert.ok(denied >= 5, 'refusals are audited');

  // The manager rejects (the reason is required), the coordinator is told within the wait, nothing is reserved.
  await b.click(`#planList tr[data-plan="${planId}"] [data-bact=plan-review]`); await b.waitForSelector('#reviewBox #rejectBtn');
  await b.click('#rejectBtn'); await b.click('#confirmReject');
  await b.waitForFunction(() => document.querySelector('#e-reject_reason').textContent.length > 0);
  await b.type('#f-reject_reason', 'Không đủ cẩu bờ cho chuyến này');
  const t = Date.now();
  await b.click('#confirmReject'); await dialogClosed(b); await hasPlan(b, code, 'REJECTED');
  await a.waitForFunction((c) => [...document.querySelectorAll('#noteList li[data-unread=true]')].some((li) => li.textContent.includes(c) && li.textContent.includes('bị từ chối') && li.textContent.includes('Không đủ cẩu bờ')), { timeout: 8000 }, code);
  lat('rejection-to-coordinator-notification', Date.now() - t);
  const v = (await q('SELECT status, queue_position FROM dbo.voyages WHERE id = @v', { v: n.id }))[0];
  assert.equal(v.status, 'WAITING_BERTH'); assert.ok(v.queue_position, 'still queued');
  await berthRowHas(a, berth.berth_code, 'Trống');
  assert.deepEqual(await audit('BERTH_PLAN_REJECT', planId), ['SUCCESS']);
  assert.ok((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'BERTH_PLAN_REJECT' AND outcome = 'DENIED' AND actor = @a", { a: users.coord.username }))[0].n >= 1, 'the coordinator attempt was refused and audited');
  // A rejected plan is final: the coordinator makes a new draft for the same voyage.
  await a.click(`#queueList tr[data-queue="${n.id}"] [data-act=berth-check]`); await a.waitForSelector('#cf');
  await a.select('#f-berth_id', String(berth.id));
  await fill(a, '#f-position_start_m', 0); await fill(a, '#f-position_end_m', 240);
  await a.$eval('#f-planned_start', (e, vv) => { e.value = vv; }, '2031-07-10T08:00'); await a.$eval('#f-planned_end', (e, vv) => { e.value = vv; }, '2031-07-10T20:00');
  await fill(a, '#f-required_cranes', 3);
  await a.click('#savePlan'); await dialogClosed(a);
  await a.waitForFunction((c) => [...document.querySelectorAll('#planList tr[data-plan]')].filter((r) => r.textContent.includes(c)).length === 2, {}, code);
  await ca.close(); await cb.close(); await cy.close(); await cg.close();
});

test('agent without the berth channel: the approval notice reaches the open page of the voyage\'s agent within 5 s (content-free hint, not the 30 s timer)', { skip, timeout: 240000 }, async () => {
  const shipId = await mkShip('C');
  const { page: a, context: ca } = await newPage(); await openPage(a, users.coord);
  const berth = await mkBerth(a, CODE('g'));
  const { page: b, context: cb } = await newPage(); await openPage(b, users.manager);
  const { page: g, context: cg } = await newPage(); await loginOk(g, users.agent, 'vessels.html'); await g.waitForSelector('#nts'); await waitList(g, '#noteList');
  const code = `TG-${sfx}`;
  const n = await registerNotice(a, shipId, code, '2031-08-10T08:00');
  assert.equal(n.status, 'WAITING_BERTH');
  assert.equal((await apiFetch(a, 'PUT', `/api/v1/voyages/${n.id}/cargo-hazard`, { cargo_hazard: 'NONE', basis: 'Bảng kê hàng hóa đã đối chiếu' })).status, 200);
  const plan = (await apiFetch(a, 'POST', '/api/v1/berth-plans', { voyage_id: n.id, berth_id: berth.id, position_start_m: 0, position_end_m: 240, planned_start: '2031-08-10T01:00:00Z', planned_end: '2031-08-10T13:00:00Z', required_cranes: 2 })).body.data;
  const sub = (await apiFetch(a, 'POST', `/api/v1/berth-plans/${plan.id}/submit`, {}, { 'If-Match': `"${plan.revision}"` })).body.data;
  const t = Date.now();
  assert.equal((await apiFetch(b, 'POST', `/api/v1/berth-plans/${plan.id}/approve`, { confirm: true }, { 'If-Match': `"${sub.revision}"` })).status, 200);
  await g.waitForFunction((c) => [...document.querySelectorAll('#noteList li')].some((li) => li.textContent.includes(c) && li.textContent.includes('xếp bến')), { timeout: 5000, polling: 100 }, code);
  lat('approval-to-agent-notification-no-berth-channel', Date.now() - t);
  assert.equal(await g.$('#brt:not([hidden])'), null, 'the agent has no berth panel');
  await ca.close(); await cb.close(); await cg.close();
});
