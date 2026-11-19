'use strict';

// A3 / FR-BRT-03: the berth plan chart (time x position) in real browsers on real SQL Server data. Layers, geometry, UTC+7 labels, drag and drop that opens the
// normal check/save dialog (UC-026 on the server, revision checks, override with a reason), UC-027 proposals shown as unconfirmed, the tray, roles, refresh
// safety during a drag, loading/error states and the tablet/phone layout. Screenshots are saved to docs/testing/screenshots for inspection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support');

const { skip, FRONT, API, newPage, loginOk } = S;
const sfx = S.SUFFIX;
const SHOTS = path.resolve(__dirname, '..', '..', '..', 'docs', 'testing', 'screenshots');
let agentA; let portId; let typeId; let coordUserId; let seq = 20000;
const shipIds = [];
const users = {
  coord: S.mkUser('kcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']), coord2: S.mkUser('kcoord2', `Điều phối 2 ${sfx}`, ['DIEU_PHOI_VIEN']),
  manager: S.mkUser('kmgr', `Quản lý ${sfx}`, ['BAN_QUAN_LY']), agent: S.mkUser('kagent', `Đại lý ${sfx}`, ['DAI_LY_HANG_HAI']),
};
const q = async (text, params = {}) => { const d = S.db(); const req = d.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('KA_${sfx}', N'Đại lý K ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('KP${sfx}', N'Cảng K ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
  users.agent.agentId = agentA;
  fs.mkdirSync(SHOTS, { recursive: true });
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const ids = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'K${sfx}%'`;
  const plans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own})`;
  await d.pool.request().query(`
    DELETE FROM dbo.berth_plan_decisions WHERE voyage_id IN (${mine});
    DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (${plans});
    DELETE FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id IN (${mine});
    DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${plans});
    DELETE FROM dbo.berth_plans WHERE id IN (${plans});
    DELETE FROM dbo.berth_plan_inference_vessels WHERE voyage_id IN (${mine});
    DELETE FROM dbo.berth_plan_proposals WHERE voyage_id IN (${mine});
    DELETE FROM dbo.berth_plan_inferences WHERE requested_by_user_id IN (SELECT user_id FROM dbo.auth_users WHERE username LIKE 'e2e_kcoord_${sfx}');
    DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${own});
    DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});
    DELETE FROM dbo.berths WHERE berth_code LIKE 'K${sfx}%';
    DELETE FROM dbo.auth_user_agents WHERE agent_id = ${agentA};
    DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
}));

async function queued(code, { loa = 200, etaH = 6 } = {}) {
  coordUserId = coordUserId || Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  const shipId = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES (@c, @i, @n, @t, @loa, 30, 9, 50000)`, { c: `KS${sfx}${seq}`, i: `5${String(100000 + Math.floor(Math.random() * 800000))}`, n: `Chart ${code}`, t: typeId, loa }))[0].id;
  shipIds.push(shipId); seq += 1;
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version,
      cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, @eta, 100, N'x', @pos, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V', 'NONE', N'fixture', @u, SYSUTCDATETIME())`,
  { s: shipId, c: code, a: agentA, p: portId, eta: new Date(Date.now() + etaH * 3600e3), pos: seq, u: coordUserId }))[0].id;
}
const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
async function openPage(page, user) {
  await loginOk(page, user, user.roles.includes('DAI_LY_HANG_HAI') ? 'vessels.html' : 'overview.html');
  await page.goto(`${FRONT}/vessels.html`);
  if (user.roles.includes('DAI_LY_HANG_HAI')) return;
  await page.waitForSelector('#brt'); await waitList(page, '#berthList'); await waitList(page, '#planList'); await waitList(page, '#queueList');
  await page.waitForSelector('#bch');
}
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const apiFetch = (page, method, p, body, extra = {}) => page.evaluate(async (base, m, u, b, x) => {
  const res = await fetch(base + u, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, p, body, extra);
const mkBerth = async (page, code, extra = {}) => (await apiFetch(page, 'POST', '/api/v1/berths', { berth_code: code, berth_type: 'CONTAINER', length_m: 400, max_depth_m: 14, available_cranes: 4, allows_dangerous: false, ...extra })).body.data;
const H = 3600e3;
const at = (h) => new Date(Math.round((Date.now() + h * H) / 900000) * 900000).toISOString();   // quarter-hour grid, like the chart
const mkPlan = async (page, voyageId, berthId, s, e, ps, pe) => (await apiFetch(page, 'POST', '/api/v1/berth-plans', { voyage_id: voyageId, berth_id: berthId, position_start_m: ps, position_end_m: pe, planned_start: at(s), planned_end: at(e), required_cranes: 2 })).body.data;
const planRow = async (id) => (await q('SELECT plan_status, source, berth_id, position_start_m, position_end_m, planned_start, planned_end, revision, override_reason FROM dbo.berth_plans WHERE id = @i', { i: id }))[0];
const selectBerth = async (page, id) => { await page.waitForFunction((b) => [...document.querySelectorAll('#bcBerth option')].some((o) => o.value === String(b)), { timeout: 10000 }, id); await page.select('#bcBerth', String(id)); await page.waitForFunction((b) => document.querySelector('#bcPlot') && document.querySelector('#bcPlot').dataset.berth === String(b), {}, id); };
const blk = (sel) => `#bcPlot ${sel}`;
// A real mouse drag: press on the middle of the element, move in steps, release.
async function drag(page, selector, dx, dy, { toSelector } = {}) {
  const el = await page.$(selector); await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
  const b = await el.boundingBox(); const sx = b.x + b.width / 2; const sy = b.y + b.height / 2;
  let tx = sx + dx; let ty = sy + dy;
  if (toSelector) { const tb = await (await page.$(toSelector)).boundingBox(); tx = tb.x + dx; ty = tb.y + dy; }
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 6 }); await page.mouse.move(tx, ty, { steps: 6 });
  return { up: () => page.mouse.up(), tx, ty };
}
const rectOf = (page, selector) => page.$eval(selector, (e) => { const p = document.querySelector('#bcPlot').getBoundingClientRect(); const r = e.getBoundingClientRect(); return { left: r.left - p.left, top: r.top - p.top, width: r.width, height: r.height }; });

test('A3 chart in the browser: real layers (approved, pending, draft, actual, maintenance, proposal), exact geometry and UTC+7 labels, drag and drop through the UC-026 dialog, override, concurrent edit, tray, roles, refresh safety, states and responsive layout', { skip, timeout: 540000 }, async () => {
  const { page: a, context: ca } = await newPage(); await openPage(a, users.coord);
  const { page: b, context: cb } = await newPage(); await openPage(b, users.manager);
  const { page: c, context: cc } = await newPage(); await openPage(c, users.coord2);
  const { page: g, context: cg } = await newPage(); await openPage(g, users.agent);
  assert.equal(await g.$eval('#bch', (e) => e.hidden).catch(() => true), true, 'the agent has no berth permission: the chart is hidden');
  assert.equal((await apiFetch(g, 'GET', `/api/v1/berths/1/chart?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z`)).status, 403);

  // ---- fixtures through the real API: one berth and plans in every state
  const berth = await mkBerth(a, `K${sfx}1`); assert.ok(berth.id);
  const small = { loa: 100 }; const vA = await queued(`KA-${sfx}`, small); const vP = await queued(`KP-${sfx}`, small); const vD = await queued(`KD-${sfx}`, small); const vB = await queued(`KB-${sfx}`, small); const vT = await queued(`KT-${sfx}`, { loa: 100 });
  const pA = await mkPlan(a, vA, berth.id, 4, 16, 0, 120); const pP = await mkPlan(a, vP, berth.id, 4, 16, 140, 260); const pD = await mkPlan(a, vD, berth.id, 20, 32, 0, 120); const pB = await mkPlan(a, vB, berth.id, 2, 9, 280, 400);
  for (const p of [pA, pP, pD, pB]) assert.ok(p && p.id, 'plan created: ' + JSON.stringify(p));
  const submit = async (p) => (await apiFetch(a, 'POST', `/api/v1/berth-plans/${p.id}/submit`, {}, { 'If-Match': `"${p.revision}"` })).body.data;
  const sA = await submit(pA); const sB = await submit(pB); await submit(pP);
  for (const s of [sA, sB]) assert.equal((await apiFetch(b, 'POST', `/api/v1/berth-plans/${s.id}/approve`, { confirm: true }, { 'If-Match': `"${s.revision}"` })).status, 200);
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', N'Nạo vét luồng', N'test')`, { b: berth.id, f: new Date(Date.now() + 40 * H), t: new Date(Date.now() + 46 * H) });
  // actual berthing through the UI of the schedule (UC-022): the vessel then occupies its stretch physically
  await a.evaluate(() => BP.loadPlans());
  await a.select('#schStatus', 'BERTH_ASSIGNED');
  await a.waitForFunction((id) => document.querySelector(`#schBody tr[data-sched="${id}"] [data-act=lifecycle]`), { timeout: 10000 }, vB);
  await S.clickChecked(a, `#schBody tr[data-sched="${vB}"] [data-act=lifecycle]`); await a.waitForSelector('#vlife'); await a.click('#vlife [data-act=berthing]'); await a.waitForSelector('#mvf'); await a.click('#mvConfirm'); await dialogClosed(a);
  assert.equal((await q('SELECT status FROM dbo.voyages WHERE id = @v', { v: vB }))[0].status, 'BERTHED');

  await a.evaluate(() => VR.loadQueue({ silent: true }));
  await a.evaluate(() => BP.load({ silent: true })); await a.evaluate(() => BP.loadPlans()); await selectBerth(a, berth.id);
  await a.waitForSelector(blk(`.bc-actual`));

  // ---- layers and what distinguishes them
  assert.ok(await a.$(blk(`.bc-approved[data-plan="${pA.id}"]`)), 'approved plan'); assert.ok(await a.$(blk(`.bc-pending[data-plan="${pP.id}"]`)), 'pending plan');
  assert.ok(await a.$(blk(`.bc-draft[data-plan="${pD.id}"][data-drag=plan]`)), 'draft plan, draggable');
  assert.ok(await a.$(blk(`.bc-actual[data-plan="${pB.id}"]`)), 'a BERTHED vessel is drawn as actual occupancy, not as an approved reservation');
  assert.equal(await a.$(blk(`.bc-approved[data-plan="${pB.id}"]`)), null);
  assert.ok(await a.$(blk('.bc-maint')), 'maintenance');
  // geometry follows the stored data: left = x(start), width = x(end) - x(start), top = y(start m), height = y(length)
  const geo = await a.evaluate((id) => { const sc = BC.scale; const p = BC.s.data.plans.find((x) => x.plan_id === id); const el = document.querySelector(`#bcPlot [data-plan="${id}"]`); const pr = document.querySelector('#bcPlot').getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { l: r.left - pr.left, w: r.width, t: r.top - pr.top, h: r.height, el: sc.x(new Date(p.planned_start).getTime()), ew: sc.x(new Date(p.planned_end).getTime()) - sc.x(new Date(p.planned_start).getTime()), et: sc.y(p.position_start_m), eh: sc.y(p.position_end_m) - sc.y(p.position_start_m) }; }, pA.id);
  for (const [k, v] of [['l', 'el'], ['w', 'ew'], ['t', 'et'], ['h', 'eh']]) assert.ok(Math.abs(geo[k] - geo[v]) <= 2.5, `${k}: ${geo[k]} vs ${geo[v]}`);
  const rowA = await planRow(pA.id); const utc7 = (iso) => new Date(new Date(iso).getTime() + 7 * H).toISOString().slice(0, 16).replace('T', ' ');
  assert.ok((await a.$eval(blk(`[data-plan="${pA.id}"]`), (e) => e.title)).includes(utc7(rowA.planned_start)), 'the tooltip shows the stored start in UTC+7');
  const firstTick = await a.$eval('.bc-x span', (e) => e.textContent); assert.match(firstTick, /^\d\d-\d\d 00:00$/, 'the axis is labelled in UTC+7 days'); assert.match(await a.$eval('#bcRange', (e) => e.textContent), /UTC\+7/);
  // legend and status text are present; nothing relies on colour only
  const legend = await a.$eval('.bc-legend', (e) => e.textContent); for (const t of ['Đã duyệt', 'Chờ duyệt', 'Nháp', 'Đang cập bến', 'chưa xác nhận', 'Bảo trì', 'Vi phạm UC-026', 'Có ghi đè']) assert.ok(legend.includes(t), t);
  await a.evaluate(() => document.querySelector('#bch').scrollIntoView()); await a.screenshot({ path: path.join(SHOTS, 'a3-desktop-layers.png'), fullPage: false });

  // ---- UC-027 proposals appear as dashed, unconfirmed blocks; they reserve nothing
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berths WHERE is_active = 1'))[0].n, 1, 'precondition: this berth is the only active one, so proposals land on it');
  await a.click('#recBtn'); await a.waitForSelector('#recBox .rec-v'); await a.click('#recBox [data-close]'); await dialogClosed(a);
  const recState = await a.evaluate((v) => ({ berthSel: BC.s.berthId, rec: BP.s.rec.vessels.map((x) => [x.voyage_id, x.outcome, (x.proposals || []).map((p) => p.berth_id), x.decision && x.decision.length]), mine: BC.proposals().map((x) => [x.voyage_id, x.planned_start, x.planned_end, x.position_start_m, x.position_end_m]), win: [BC.s.data.from, BC.s.data.to], show: BC.s.showProposals }), vT);
  await a.waitForSelector(blk(`.bc-proposal[data-voyage="${vT}"]`), { timeout: 4000 }).catch((e) => { throw new Error('no proposal block: ' + JSON.stringify(recState)); });
  assert.ok((await a.$eval(blk(`.bc-proposal[data-voyage="${vT}"]`), (e) => e.title)).includes('chưa xác nhận, không giữ chỗ'));
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.berth_plans WHERE voyage_id = @v', { v: vT }))[0].n, 0, 'a proposal is not a plan and holds nothing');
  assert.equal(await a.$eval('#bcProp', (e) => e.checked), true); await a.click('#bcProp'); assert.equal(await a.$(blk('.bc-proposal')), null, 'the toggle hides proposals'); await a.click('#bcProp');
  await a.waitForSelector(blk(`.bc-proposal[data-voyage="${vT}"]`));

  // ---- drag a DRAFT to a free place: the dialog opens with the dropped values and the server's UC-026 result; nothing is stored until Save
  const before = await planRow(pD.id);
  const d1 = await drag(a, blk(`[data-plan="${pD.id}"]`), 40, 60); await d1.up();
  await a.waitForSelector('#cf', { visible: true }); await a.waitForSelector('#chkResult #chkOutcome');
  const form = await a.evaluate(() => ({ ps: Number(document.querySelector('#f-position_start_m').value), pe: Number(document.querySelector('#f-position_end_m').value), st: document.querySelector('#f-planned_start').value, en: document.querySelector('#f-planned_end').value, out: document.querySelector('#chkOutcome').dataset.outcome }));
  assert.ok(form.ps > 0 && form.pe - form.ps === 120, `the stretch moved and kept its size: ${JSON.stringify(form)}`);
  assert.equal(form.out, 'PASS', 'the dropped place is free'); assert.ok(form.st > '2000', 'time field filled');
  assert.ok(await a.$(blk('.bc-ghost-PASS')) , 'the check result is drawn on the chart');
  const unchanged = await planRow(pD.id); assert.deepEqual([unchanged.position_start_m, unchanged.revision], [before.position_start_m, before.revision], 'the drop itself stores nothing');
  await a.click('#savePlan'); await dialogClosed(a);
  const saved = await planRow(pD.id); assert.equal(Number(saved.position_start_m), form.ps); assert.equal(Number(saved.revision), Number(before.revision) + 1);
  await a.waitForFunction((id, ps) => { const p = BC.s.data.plans.find((x) => x.plan_id === id); return p && p.position_start_m === ps; }, { timeout: 8000 }, pD.id, form.ps);
  const moved = await a.evaluate((id) => { const p = BC.s.data.plans.find((x) => x.plan_id === id); const r = document.querySelector(`#bcPlot [data-plan="${id}"]`); return { top: parseFloat(r.style.top), expect: BC.scale.y(p.position_start_m) }; }, pD.id);
  assert.ok(Math.abs(moved.top - moved.expect) < 1.5, 'the block was redrawn at the saved stretch');

  // ---- drag the draft onto the APPROVED vessel's place: the server reports the violation, the chart marks it, saving needs an override reason
  const target = await rectOf(a, blk(`[data-plan="${pA.id}"]`)); const me = await rectOf(a, blk(`[data-plan="${pD.id}"]`));
  const d2 = await drag(a, blk(`[data-plan="${pD.id}"]`), target.left - me.left, target.top - me.top + 10); await d2.up();
  await a.waitForSelector('#cf', { visible: true }); await a.waitForFunction(() => { const o = document.querySelector('#chkOutcome'); return o && o.dataset.outcome === 'VIOLATION'; });
  assert.ok(await a.$(blk('.bc-ghost-VIOLATION')), 'the violating placement is marked on the chart'); assert.ok((await a.$eval(blk('.bc-ghost'), (e) => e.title)).includes('Vi phạm'));
  await a.screenshot({ path: path.join(SHOTS, 'a3-desktop-violation-dialog.png') });
  const keep = await planRow(pD.id);
  await a.click('#savePlan'); await a.waitForSelector('#ovBox');   // refused without a reason; offered the override because the coordinator may
  assert.deepEqual([Number((await planRow(pD.id)).revision), (await planRow(pD.id)).override_reason], [Number(keep.revision), null], 'a violating drop is not saved without an override reason');
  await a.type('#f-override_reason', 'Điều phối viên chấp nhận chồng lấn có kiểm soát'); await a.click('#ovBtn'); await dialogClosed(a);
  const ov = await planRow(pD.id); assert.equal(ov.override_reason, 'Điều phối viên chấp nhận chồng lấn có kiểm soát');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action LIKE 'BERTH_PLAN%' AND reason = @r", { r: ov.override_reason }))[0].n >= 1, true, 'the override is audited');
  await a.waitForSelector(blk(`.bc-over[data-plan="${pD.id}"]`));
  await a.screenshot({ path: path.join(SHOTS, 'a3-desktop-override.png') });

  // ---- concurrent edit: the coordinator opens the dialog by a drop, another coordinator saves the same draft first; the stale save is refused
  const cur = await planRow(pD.id);
  const d3 = await drag(a, blk(`[data-plan="${pD.id}"]`), 30, 0); await d3.up(); await a.waitForSelector('#cf', { visible: true });
  const other = await apiFetch(c, 'PUT', `/api/v1/berth-plans/${pD.id}`, { voyage_id: vD, berth_id: berth.id, position_start_m: 200, position_end_m: 320, planned_start: at(60), planned_end: at(70), required_cranes: 2 }, { 'If-Match': `"${cur.revision}"` });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  await a.click('#savePlan'); await a.waitForFunction(() => { const m = document.querySelector('#fmsg'); return m && !m.hidden && m.textContent.includes('thay đổi ở nơi khác'); }, { timeout: 8000 });
  assert.equal(Number((await planRow(pD.id)).position_start_m), 200, 'the other coordinator\'s version stands');
  await a.waitForSelector('#cf [data-close]', { visible: true }); await a.click('#cf [data-close]'); await dialogClosed(a);

  // ---- a drop outside the berth is clamped; Escape cancels a drag
  const draft = await a.evaluate((id) => !!document.querySelector(`#bcPlot [data-plan="${id}"]`), pD.id);
  void draft;

  // ---- proposal: drag it; it becomes a draft marked as adjusted only when saved
  await a.evaluate(() => BC.load({ silent: true }));
  const prop = blk(`.bc-proposal[data-voyage="${vT}"]`); await a.waitForSelector(prop);
  const d4 = await drag(a, prop, 25, 0); await d4.up(); await a.waitForSelector('#cf', { visible: true }); await a.waitForSelector('#chkResult #chkOutcome', { timeout: 6000 }).catch(async () => { throw new Error('no check result: ' + JSON.stringify(await a.evaluate(() => ({ msg: document.querySelector('#fmsg') && document.querySelector('#fmsg').textContent, errs: [...document.querySelectorAll('.fe')].map((e) => e.textContent).filter(Boolean), vals: ['berth_id', 'position_start_m', 'position_end_m', 'planned_start', 'planned_end', 'required_cranes'].map((k) => document.querySelector('#f-' + k) && document.querySelector('#f-' + k).value) })))); });
  await a.click('#savePlan'); await dialogClosed(a);
  const pr = (await q("SELECT TOP 1 id, plan_status, source, proposal_id FROM dbo.berth_plans WHERE voyage_id = @v", { v: vT }))[0];
  assert.deepEqual([pr.plan_status, pr.source], ['DRAFT', 'LOCAL_OPTIMIZER_ADJUSTED']); assert.ok(pr.proposal_id);
  assert.equal((await q("SELECT TOP 1 decision FROM dbo.berth_plan_decisions WHERE voyage_id = @v ORDER BY id DESC", { v: vT }))[0].decision, 'MODIFIED');

  // ---- tray: a queued vessel without a plan is dragged onto the chart (UC-028 2a); size = LOA, 12 h default, then the usual dialog
  const vN = await queued(`KN-${sfx}`, { loa: 150 });
  const free = await mkBerth(a, `K${sfx}3`); await a.evaluate(() => BP.load({ silent: true })); await selectBerth(a, free.id);   // an empty berth, so the dropped place is free whatever the time of day
  await a.evaluate(() => VR.loadQueue({ silent: true })); await a.waitForSelector(`#bcTray [data-drag=chip][data-voyage="${vN}"]`);
  const d5 = await drag(a, `#bcTray [data-drag=chip][data-voyage="${vN}"]`, 80, 40, { toSelector: '#bcPlot' }); await d5.up();
  await a.waitForSelector('#cf', { visible: true }); await a.waitForSelector('#chkResult #chkOutcome');
  const tf = await a.evaluate(() => ({ ps: Number(document.querySelector('#f-position_start_m').value), pe: Number(document.querySelector('#f-position_end_m').value), st: document.querySelector('#f-planned_start').value, en: document.querySelector('#f-planned_end').value }));
  assert.equal(tf.pe - tf.ps, 150, 'the stretch is the vessel\'s LOA'); assert.equal((new Date(tf.en) - new Date(tf.st)) / H, 12, 'default stay of the tray drop');
  assert.equal(await a.$eval('#chkOutcome', (e) => e.dataset.outcome), 'MISSING_DATA', 'the crane count is never invented: the server asks for it'); assert.ok(await a.$(blk('.bc-ghost-MISSING_DATA')));
  await a.type('#f-required_cranes', '2'); await a.click('#cf button[type=submit]'); await a.waitForFunction(() => document.querySelector('#chkOutcome') && document.querySelector('#chkOutcome').dataset.outcome === 'PASS');
  await a.click('#savePlan'); await dialogClosed(a).catch(async () => { throw new Error('tray save blocked: ' + await a.$eval('#vdlg', (e) => e.innerText.slice(300, 1700))); });
  assert.equal((await q("SELECT plan_status, source FROM dbo.berth_plans WHERE voyage_id = @v", { v: vN }))[0].plan_status, 'DRAFT');
  await a.waitForFunction((v) => !document.querySelector(`#bcTray [data-voyage="${v}"]`), { timeout: 8000 }, vN);

  // ---- roles: the manager sees the same chart but cannot drag or use the tray
  await b.evaluate(() => BP.load({ silent: true })); await selectBerth(b, berth.id); await b.waitForSelector('#bcPlot .bc-approved');
  assert.equal(await b.$('#bcPlot [data-drag]'), null, 'no draggable block for the manager'); assert.equal(await b.$eval('#bcTray', (e) => e.hidden), true);
  assert.equal((await apiFetch(b, 'POST', '/api/v1/berth-plans', { voyage_id: vN, berth_id: berth.id, position_start_m: 0, position_end_m: 100, planned_start: at(80), planned_end: at(90) })).status, 403, 'the server also refuses it');

  // ---- refresh safety: a hint arrives while a block is being dragged; the chart is not redrawn under the hand, the drop still works
  await a.evaluate(() => BC.load({ silent: true }));
  const live = blk(`[data-plan="${(await q("SELECT TOP 1 id FROM dbo.berth_plans WHERE voyage_id = @v", { v: vN }))[0].id}"]`); const dragged = await drag(a, live, 20, 30);
  const mark = await a.evaluate(() => { const el = document.querySelector('.bc-dragging'); window.__node = el; return !!el; }); assert.equal(mark, true);
  const n0 = await a.evaluate(() => BC.s.berths.length);
  await apiFetch(c, 'POST', '/api/v1/berths', { berth_code: `K${sfx}2`, berth_type: 'CONTAINER', length_m: 300, max_depth_m: 12, available_cranes: 2, allows_dangerous: false });   // BERTHS_CHANGED hint
  await a.waitForFunction((n) => BC.s.berths.length === n + 1, { timeout: 8000 }, n0);
  assert.equal(await a.evaluate(() => window.__node.isConnected && window.__node.classList.contains('bc-dragging')), true, 'the dragged block was not replaced by the refresh');
  await dragged.up(); await a.waitForSelector('#cf', { visible: true });
  // The dialog grows when the server's check result arrives (it pushes the Close button down, below the fold at 800 px): wait for it before clicking.
  await a.waitForSelector('#chkResult #chkOutcome'); await S.clickVisible(a, '#cf [data-close]'); await dialogClosed(a);
  await a.waitForFunction((n) => document.querySelectorAll('#bcBerth option').length === n + 1, {}, n0);   // the refresh was applied after the drag

  // ---- a drag cancelled with Escape changes nothing
  const e1 = await drag(a, live, 15, 15); await a.keyboard.press('Escape'); await e1.up(); await new Promise((r) => setTimeout(r, 150));
  assert.equal(await a.$('#cf'), null, 'cancelled drag opens no dialog');

  // ---- error and loading states: the chart request fails, then recovers on retry
  await a.setRequestInterception(true);
  const failing = (req) => { if (req.url().includes('/chart')) req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Lỗi thử nghiệm' } }) }); else req.continue(); };
  a.on('request', failing);
  await a.select('#bcDays', '1'); await a.waitForSelector('#bcState .lmsg, #bcState [data-retry=chart]');
  assert.ok((await a.$eval('#bcState', (e) => e.textContent)).includes('Không tải được biểu đồ'));
  a.off('request', failing); await a.setRequestInterception(false);
  await a.click('#bcState [data-retry=chart]'); await a.waitForFunction(() => document.querySelector('#bcState').textContent.trim() === '' && document.querySelector('#bcPlot'), { timeout: 8000 });   // loading, then recovered
  await a.select('#bcDays', '3');

  // ---- responsive layout: tablet and phone keep the chart inside its own scroll area (no page overflow) and readable
  await selectBerth(a, berth.id);
  for (const [name, w, h] of [['tablet', 820, 1100], ['phone', 390, 844]]) {
    await a.setViewport({ width: w, height: h }); await a.evaluate(() => { BC.s.sig = ''; BC.draw(); }); await a.waitForSelector('#bcPlot');
    const m = await a.evaluate(() => { const sc = document.querySelector('#bcScroll'); return { pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, scrollW: sc.scrollWidth, clientW: sc.clientWidth, blocks: document.querySelectorAll('#bcPlot .bc-blk').length, plotH: document.querySelector('#bcPlot').offsetHeight }; });
    const ov = await a.evaluate(() => { const r = [...document.querySelectorAll('.bc-x span')].map((e) => e.getBoundingClientRect()); return r.some((x, i) => i > 0 && x.left < r[i - 1].right - 0.5); });
    assert.equal(ov, false, `${name}: time-axis labels do not overlap`);
    assert.ok(m.pageOverflow <= 1, `${name}: the page itself does not scroll sideways (${m.pageOverflow})`); assert.ok(m.scrollW >= m.clientW, `${name}: the chart scrolls inside its box`); assert.ok(m.blocks >= 5 && m.plotH >= 240);
    await a.evaluate(() => document.querySelector('#bch').scrollIntoView()); await a.screenshot({ path: path.join(SHOTS, `a3-${name}.png`) });
  }
  for (const x of [ca, cb, cc, cg]) await x.close();
});

test('A3 empty state: a berth without plans shows an empty chart message, not an error', { skip, timeout: 120000 }, async () => {
  const { page: a, context: ca } = await newPage(); await openPage(a, users.coord);
  const lonely = await mkBerth(a, `K${sfx}9`); await a.evaluate(() => BP.load({ silent: true })); await a.evaluate(() => BC.load({ silent: true }));
  await a.waitForFunction((id) => [...document.querySelectorAll('#bcBerth option')].some((o) => o.value === String(id)), {}, lonely.id);
  await selectBerth(a, lonely.id);
  assert.ok((await a.$eval('#bcPlot', (e) => e.textContent)).includes('Không có kế hoạch, bảo trì hay tàu đang cập'));
  assert.equal(await a.$eval('#bcState', (e) => e.textContent.trim()), '');
  await ca.close();
});
