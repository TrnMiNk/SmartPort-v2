'use strict';

// Browser end-to-end test for UC-027 local berth recommendations (policy UC027-OPT-V2), Front -> API -> SQL Server, two accounts.
// Needs a database with migration 0006 (see support.js). Queued voyages and ships are fixtures; the rest goes through the UI.
// The engine is a deterministic optimizer, not a machine-learning model: the screen must say so, and no AI result is claimed.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support');

const { skip, FRONT, API, newPage, loginOk } = S;
const sfx = S.SUFFIX;
const CODE = (n) => `Q${sfx}${n}`;
let agentA; let portId; let typeId; let coordUserId; let seq = 9000;
const shipIds = [];
const users = { coord: S.mkUser('rcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']), manager: S.mkUser('rmgr', `Quản lý ${sfx}`, ['BAN_QUAN_LY']) };
const q = async (text, params = {}) => { const d = S.db(); const req = d.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('QA_${sfx}', N'Đại lý Q ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('QP${sfx}', N'Cảng Q ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const ids = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'Q${sfx}%'`;
  const plans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own})`;
  await d.pool.request().query(`
    DELETE FROM dbo.berth_plan_decisions WHERE voyage_id IN (${mine});
    DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (${plans});
    DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${plans});
    DELETE FROM dbo.berth_plans WHERE id IN (${plans});
    DELETE FROM dbo.berth_plan_inference_vessels WHERE voyage_id IN (${mine});
    DELETE FROM dbo.berth_plan_proposals WHERE voyage_id IN (${mine});
    DELETE FROM dbo.berth_plan_inferences WHERE requested_by_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 'e2e_rcoord_${sfx}');
    DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});
    DELETE FROM dbo.berths WHERE berth_code LIKE 'Q${sfx}%';
    DELETE FROM dbo.auth_user_agents WHERE agent_id = ${agentA};
    DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
}));

async function queued(code, { loa = 200, teu = 800, etaH = 6 } = {}) {
  coordUserId = coordUserId || Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  const shipId = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES (@c, @i, @n, @t, @loa, 30, 9, 50000)`, { c: `QS${sfx}${seq}`, i: `7${String(100000 + Math.floor(Math.random() * 800000))}`, n: `Rec ${code}`, t: typeId, loa }))[0].id;
  shipIds.push(shipId); seq += 1;
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version,
      cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, @eta, @teu, N'x', @pos, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V', 'NONE', N'fixture', @u, SYSUTCDATETIME())`,
  { s: shipId, c: code, a: agentA, p: portId, eta: new Date(Date.now() + etaH * 3600e3), teu, pos: seq, u: coordUserId }))[0].id;
}
const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
async function openPage(page, user) {
  await loginOk(page, user, 'overview.html');
  await page.goto(`${FRONT}/vessels.html`); await page.waitForSelector('#brt');
  await waitList(page, '#berthList'); await waitList(page, '#planList'); await waitList(page, '#queueList');
}
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const apiFetch = (page, method, path, body, extra = {}) => page.evaluate(async (base, m, p, b, x) => {
  const res = await fetch(base + p, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, path, body, extra);
const mkBerth = async (page, code, extra = {}) => (await apiFetch(page, 'POST', '/api/v1/berths', { berth_code: code, berth_type: 'CONTAINER', length_m: 450, max_depth_m: 14, available_cranes: 4, allows_dangerous: false, ...extra })).body.data;
const planOf = async (voyageId) => (await q('SELECT id, plan_status, source, proposal_id, required_cranes, revision FROM dbo.berth_plans WHERE voyage_id = @v ORDER BY id DESC', { v: voyageId }))[0];
const decisionsOf = (voyageId) => q('SELECT decision, plan_id, proposal_id FROM dbo.berth_plan_decisions WHERE voyage_id = @v ORDER BY id', { v: voyageId });

test('UC-027 in the browser: the coordinator asks for recommendations; the screen says it is a local optimizer and not machine learning; uses, modifies and ignores proposals; the manager approves; manual planning still works', { skip, timeout: 240000 }, async () => {
  const { page: a, context: ca } = await newPage(); await openPage(a, users.coord);
  const b1 = await mkBerth(a, CODE('1')); await mkBerth(a, CODE('2'), { length_m: 400 });
  const v1 = await queued(`RV1-${sfx}`); const v2 = await queued(`RV2-${sfx}`, { etaH: 8 }); const v3 = await queued(`RV3-${sfx}`, { etaH: 10 });
  const tooLong = await queued(`RV4-${sfx}`, { loa: 900, etaH: 12 }); const v5 = await queued(`RV5-${sfx}`, { etaH: 14 });
  await a.reload(); await a.waitForSelector('#brt'); await waitList(a, '#queueList');
  await a.waitForSelector('#recBtn:not([hidden])');
  // The manager has no recommendation button.
  const { page: b, context: cb } = await newPage(); await openPage(b, users.manager);
  assert.equal(await b.$('#recBtn:not([hidden])'), null, 'port management does not ask for recommendations');
  assert.equal((await apiFetch(b, 'POST', '/api/v1/berth-recommendations', {})).status, 403);

  // Ask. The dialog states what the engine is, and every shown proposal says UC-026 passed.
  const t0 = Date.now();
  await a.click('#recBtn');
  await a.waitForSelector('#recBox .rec-v');
  const ms = Date.now() - t0;
  process.stdout.write(`LATENCY recommendation-click-to-result ${ms} ms\n`);
  const note = await a.$eval('#recNote', (e) => e.textContent);
  assert.ok(note.includes('không phải mô hình học máy') && note.includes('Dự báo AI: chưa có') && note.includes('UC027-OPT-V2'), note);
  assert.ok(!/xác suất|độ tin cậy \d/.test(await a.$eval('#recBox', (e) => e.textContent.replace(/không phải xác suất hay độ tin cậy/g, ''))), 'no confidence figure is shown');
  const mine = (id) => `#recBox [data-rec-voyage="${id}"]`;
  assert.ok((await a.$$eval(`${mine(v1)} tr[data-prop]`, (r) => r.length)) >= 1);
  assert.ok((await a.$eval(mine(v1), (e) => e.textContent)).includes('UC-026 đạt'));
  const unsched = await a.$eval(mine(tooLong), (e) => e.textContent);
  assert.ok(unsched.includes('Không xếp được tự động') && unsched.includes('LOA'), unsched);
  assert.equal(await a.$(`${mine(tooLong)} [data-bact=rec-use]`), null, 'nothing to use for an unschedulable vessel');
  const infId = Number((await q('SELECT TOP 1 id FROM dbo.berth_plan_inferences ORDER BY id DESC'))[0].id);
  assert.equal((await q('SELECT engine_kind FROM dbo.berth_plan_inferences WHERE id = @i', { i: infId }))[0].engine_kind, 'LOCAL_OPTIMIZER');

  // v1: use the proposal as it is -> the normal draft dialog opens prefilled; saving records AI / ACCEPTED.
  await a.click(`${mine(v1)} [data-bact=rec-use]`);
  await a.waitForSelector('#cf');
  assert.ok((await a.$eval('#f-berth_id', (e) => Number(e.value))) > 0 && (await a.$eval('#f-position_end_m', (e) => e.value)) !== '', 'the draft form is prefilled from the proposal');
  await a.click('#savePlan'); await dialogClosed(a);
  const p1 = await planOf(v1);
  assert.deepEqual([p1.plan_status, p1.source], ['DRAFT', 'LOCAL_OPTIMIZER']); assert.ok(p1.proposal_id);
  assert.deepEqual((await decisionsOf(v1)).map((d) => d.decision), ['ACCEPTED']);
  await a.waitForSelector(`#planList tr[data-plan="${p1.id}"] [data-source=LOCAL_OPTIMIZER]`);
  assert.equal(await a.$eval(`#planList tr[data-plan="${p1.id}"] [data-source]`, (e) => e.textContent), 'Thuật toán tối ưu cục bộ', 'the plan list shows the local algorithm, never "AI"');
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: v1 }))[0].status, 'WAITING_BERTH', 'a draft does not move the voyage');

  // v2: use the proposal but change the number of cranes -> AI_ADJUSTED / MODIFIED.
  await a.click('#recBtn'); await a.waitForSelector('#recBox .rec-v');
  await a.click(`${mine(v2)} [data-bact=rec-use]`); await a.waitForSelector('#cf');
  const cranes = Number(await a.$eval('#f-required_cranes', (e) => e.value));
  await a.$eval('#f-required_cranes', (e, v) => { e.value = v; }, String(cranes > 1 ? cranes - 1 : cranes + 1));
  await a.click('#savePlan'); await dialogClosed(a);
  const p2 = await planOf(v2);
  assert.deepEqual([p2.plan_status, p2.source], ['DRAFT', 'LOCAL_OPTIMIZER_ADJUSTED']);
  assert.deepEqual((await decisionsOf(v2)).map((d) => d.decision), ['MODIFIED']);

  // v3: ignore the recommendation -> recorded, shown, no plan; then plan by hand (UC-028 unchanged).
  await a.click('#recBtn'); await a.waitForSelector('#recBox .rec-v');
  await a.click(`${mine(v3)} [data-bact=rec-ignore]`);
  await a.waitForFunction((sel) => document.querySelector(sel) && document.querySelector(sel).textContent.includes('Đã bỏ qua đề xuất'), {}, mine(v3));
  assert.deepEqual((await decisionsOf(v3)).map((d) => d.decision), ['IGNORED']);
  assert.equal(await a.$(`${mine(v3)} [data-bact=rec-use]`), null, 'after ignoring there is nothing to use');
  assert.equal(await planOf(v3), undefined, 'ignoring makes no plan');
  await a.click('#recBox [data-close]'); await dialogClosed(a);
  await a.click(`#queueList tr[data-queue="${v3}"] [data-act=berth-check]`); await a.waitForSelector('#cf');
  await a.select('#f-berth_id', String(b1.id));
  await a.$eval('#f-position_start_m', (e) => { e.value = '0'; }); await a.$eval('#f-position_end_m', (e) => { e.value = '230'; }); await a.$eval('#f-required_cranes', (e) => { e.value = '2'; });
  await a.$eval('#f-planned_start', (e) => { e.value = '2031-09-10T08:00'; }); await a.$eval('#f-planned_end', (e) => { e.value = '2031-09-10T20:00'; });
  await a.click('#savePlan'); await dialogClosed(a);
  const p3 = await planOf(v3); assert.deepEqual([p3.plan_status, p3.source], ['DRAFT', 'MANUAL']);
  assert.equal((await decisionsOf(v3)).filter((d) => d.plan_id).length, 0, 'a manual plan has no recommendation decision');

  // The AI-sourced draft goes through the normal submit and a separate approval; the recommendation never approves anything.
  // Every save reloads the plan list in the background. The last save (v3) is shown only when its row appears, so wait for that
  // before touching the list; otherwise the reload replaces the row (and its button) between finding it and clicking it.
  await a.waitForSelector(`#planList tr[data-plan="${p3.id}"]`);
  await S.clickChecked(a, `#planList tr[data-plan="${p1.id}"] [data-bact=plan-submit]`);
  await b.waitForFunction((id) => document.querySelector(`#planList tr[data-plan="${id}"] [data-bact=plan-review]`), { timeout: 8000 }, p1.id);
  await b.click(`#planList tr[data-plan="${p1.id}"] [data-bact=plan-review]`);
  await b.waitForSelector('#reviewBox #chkResult #chkOutcome[data-outcome=PASS]');
  await b.click('#approveBtn'); await b.click('#confirmApprove'); await dialogClosed(b);
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: v1 }))[0].status, 'BERTH_ASSIGNED');
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: v5 }))[0].status, 'WAITING_BERTH', 'vessels nobody planned stay in the queue');
  assert.ok(ms < 10000, `UC-027 AC-1: ${ms} ms`);
  await ca.close(); await cb.close();
});
