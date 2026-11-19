'use strict';

// B6 XSS in real browsers: hostile text stored through the API in every free-text field a Module 1/2 screen shows (ship name, cargo, berth name, override reason,
// rejection reason, notification text, voyage code) must be shown as text, never run or turned into elements or attributes. Covers the lists, the chart (tooltips and
// labels), the dialogs (berth detail, lifecycle, plan review) and the notification list, for the coordinator and the manager.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support');

const { skip, FRONT, API, newPage, loginOk } = S;
const sfx = S.SUFFIX;
const PAYLOAD = '"><img src=x onerror="window.__xss=(window.__xss||0)+1"><svg onload="window.__xss=(window.__xss||0)+1"></svg>\' onmouseover="window.__xss=1" x=\'';
const SHORT = '"><img src=x onerror=window.__xss=1>';   // for columns that hold only a short text
const users = { coord: S.mkUser('xcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']), manager: S.mkUser('xmgr', `Quản lý ${sfx}`, ['BAN_QUAN_LY']) };
let agentA; let portId; let typeId; let coordUserId; const shipIds = [];
const q = async (text, params = {}) => { const d = S.db(); const req = d.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('XA_${sfx}', N'Đại lý X ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('XP${sfx}', N'Cảng X ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const ids = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'X${sfx}%'`;
  const plans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own})`;
  await d.pool.request().query(`
    DELETE FROM dbo.berth_maintenance WHERE berth_id IN (${own});
    DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (${plans});
    DELETE FROM dbo.berth_plan_status_history WHERE plan_id IN (${plans});
    DELETE FROM dbo.berth_plans WHERE id IN (${plans});
    DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (${mine}); DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (${mine});
    DELETE FROM dbo.voyages WHERE ship_id IN (${ids}); DELETE FROM dbo.ships WHERE id IN (${ids});
    DELETE FROM dbo.berths WHERE berth_code LIKE 'X${sfx}%';
    DELETE FROM dbo.auth_user_agents WHERE agent_id = ${agentA}; DELETE FROM dbo.agents WHERE id = ${agentA}; DELETE FROM dbo.ports WHERE id = ${portId};`);
}));

const apiFetch = (page, method, p, body, extra = {}) => page.evaluate(async (base, m, u, b, x) => {
  const res = await fetch(base + u, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, p, body, extra);
const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
// What an injection would leave behind: a run script, an element made from the text, or an event attribute.
const injected = (page) => page.evaluate(() => ({ ran: window.__xss || 0, imgs: document.querySelectorAll('img[src="x"]').length, svgs: document.querySelectorAll('svg[onload]').length,
  handlers: document.querySelectorAll('[onerror],[onload],[onmouseover],[onfocus],[onclick]').length }));

test('XSS: hostile text in ship name, cargo, berth name, override and rejection reasons is shown as text on every Module 1/2 screen and dialog; nothing runs and no element or attribute is created', { skip, timeout: 240000 }, async () => {
  coordUserId = Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  const { page: a, context: ca } = await newPage(); await loginOk(a, users.coord, 'overview.html'); await a.goto(`${FRONT}/vessels.html`); await a.waitForSelector('#brt');
  const { page: m, context: cm } = await newPage(); await loginOk(m, users.manager, 'overview.html'); await m.goto(`${FRONT}/vessels.html`); await m.waitForSelector('#brt');
  const berth = (await apiFetch(a, 'POST', '/api/v1/berths', { berth_code: `X${sfx}1`, berth_name: PAYLOAD, berth_type: 'CONTAINER', length_m: 400, max_depth_m: 12, available_cranes: 3, allows_dangerous: false })).body.data;
  assert.ok(berth && berth.id, 'berth with a hostile name is stored as text');
  const shipId = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t) OUTPUT inserted.id VALUES (@c, @i, @n, @t, 200, 30, 9, 50000)`,
    { c: `XS${sfx}`, i: `6${String(100000 + Math.floor(Math.random() * 800000))}`, n: PAYLOAD, t: typeId }))[0].id; shipIds.push(shipId);
  const vId = (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version,
      cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, @eta, 100, @cargo, 30001, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V', 'NONE', @basis, @u, SYSUTCDATETIME())`,
  { s: shipId, c: `X${sfx}<i onfocus=1>`, a: agentA, p: portId, eta: new Date(Date.now() + 6 * 3600e3), cargo: SHORT, basis: SHORT, u: coordUserId }))[0].id;
  // A plan that breaks a rule on purpose (stretch shorter than the ship) so the coordinator may override it with a hostile reason.
  const t = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const draft = await apiFetch(a, 'POST', '/api/v1/berth-plans', { voyage_id: vId, berth_id: berth.id, position_start_m: 0, position_end_m: 100, planned_start: t(30), planned_end: t(40), required_cranes: 2, override_reason: PAYLOAD });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const sub = await apiFetch(a, 'POST', `/api/v1/berth-plans/${draft.body.data.id}/submit`, {}, { 'If-Match': `"${draft.body.data.revision}"` });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const rej = await apiFetch(m, 'POST', `/api/v1/berth-plans/${draft.body.data.id}/reject`, { reason: PAYLOAD }, { 'If-Match': `"${sub.body.data.revision}"` });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  // a second plan stays pending so the manager's review dialog shows the override reason
  const v2 = (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version,
      cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, @eta, 100, @cargo, 30002, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V', 'NONE', N'x', @u, SYSUTCDATETIME())`,
  { s: shipId, c: `X${sfx}-2`, a: agentA, p: portId, eta: new Date(Date.now() + 7 * 3600e3), cargo: SHORT, u: coordUserId }))[0].id;
  const d2 = await apiFetch(a, 'POST', '/api/v1/berth-plans', { voyage_id: v2, berth_id: berth.id, position_start_m: 0, position_end_m: 100, planned_start: t(50), planned_end: t(60), required_cranes: 2, override_reason: PAYLOAD });
  const s2 = await apiFetch(a, 'POST', `/api/v1/berth-plans/${d2.body.data.id}/submit`, {}, { 'If-Match': `"${d2.body.data.revision}"` }); assert.equal(s2.status, 200, JSON.stringify(s2.body));
  // maintenance must fall inside the default 3-day chart window, which starts at 00:00 UTC+7 today (+70 h fell outside it in the evening)
  await q(`INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, status, reason, created_by) VALUES (@b, @f, @t, 'ACTIVE', @r, N'test')`, { b: berth.id, f: new Date(Date.now() + 26 * 3600e3), t: new Date(Date.now() + 28 * 3600e3), r: PAYLOAD });

  for (const [who, page] of [['coordinator', a], ['manager', m]]) {
    await page.reload(); await page.waitForSelector('#brt');
    for (const id of ['#berthList', '#planList', '#queueList', '#noteList', '#noticeList']) await waitList(page, id);
    await page.waitForSelector('#bcPlot'); await page.select('#bcBerth', String(berth.id));
    await page.waitForFunction((b) => document.querySelector('#bcPlot') && document.querySelector('#bcPlot').dataset.berth === String(b), {}, berth.id);
    await page.select('#schStatus', 'WAITING_BERTH').catch(() => null);
    const text = await page.evaluate(() => document.body.innerText);
    assert.ok(text.includes('<img src=x'), `${who}: the hostile text is visible as text`);
    assert.deepEqual(await injected(page), { ran: 0, imgs: 0, svgs: 0, handlers: 0 }, `${who}: lists, chart and notices`);
    // the chart's tooltips and labels, the berth detail dialog
    const titles = await page.$$eval('#bcPlot [title]', (els) => els.map((e) => e.getAttribute('title')));
    assert.ok(titles.some((x) => x.includes('<img') || x.includes('Bảo trì')), `${who}: chart tooltips carry the text escaped`);
    await page.click(`#berthList tr[data-berth="${berth.id}"] [data-bact=detail]`); await page.waitForSelector('#bdetail');
    assert.deepEqual(await injected(page), { ran: 0, imgs: 0, svgs: 0, handlers: 0 }, `${who}: berth detail`);
    await page.click('#bdetail [data-close]'); await dialogClosed(page);
  }
  // the manager's review dialog shows the plan with the hostile override reason; the schedule lifecycle dialog shows the voyage
  await m.waitForSelector(`#planList tr[data-plan="${d2.body.data.id}"] [data-bact=plan-review]`); await m.click(`#planList tr[data-plan="${d2.body.data.id}"] [data-bact=plan-review]`); await m.waitForSelector('#reviewBox');
  assert.deepEqual(await injected(m), { ran: 0, imgs: 0, svgs: 0, handlers: 0 }, 'plan review dialog'); assert.ok((await m.$eval('#reviewBox', (e) => e.innerText)).includes('<img'));
  await m.click('#reviewBox [data-close]'); await dialogClosed(m);
  await a.select('#schStatus', 'WAITING_BERTH');
  await a.waitForFunction((v) => document.querySelector(`#schBody tr[data-sched="${v}"] [data-act=lifecycle]`), { timeout: 10000 }, vId);
  await a.click(`#schBody tr[data-sched="${vId}"] [data-act=lifecycle]`); await a.waitForSelector('#vlife');
  assert.deepEqual(await injected(a), { ran: 0, imgs: 0, svgs: 0, handlers: 0 }, 'lifecycle dialog');
  // the rejection reason reaches the coordinator's notification list as text
  assert.ok((await a.$eval('#noteList', (e) => e.innerText)).includes('<img') || (await a.$eval('#planList', (e) => e.innerText)).includes('<img'), 'the rejection reason is displayed as text');
  await ca.close(); await cm.close();
});
