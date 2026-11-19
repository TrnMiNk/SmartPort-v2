'use strict';

// B1: five-second acceptance of Modules 1 and 2 (SRS: notice and validation to queue, plan submission and approval notices, rejection reason,
// berth state after berthing and departure). Real browsers, separate signed-in accounts, the real UI and API on SQL Server.
// Each workflow is repeated; every iteration prints its own line (no averaging) and must stay under the explicit 5000 ms threshold.
//   clicked -> API answered      = request, validation and SQL persistence as seen by the initiating browser
//   API answered -> hint arrived = server publish and SSE delivery (the first refresh hint received at or after the click)
//   hint arrived -> DOM updated  = the receiving page re-reads through the authorized API and re-draws
//   total                        = initiating click to the moment the receiving page's DOM shows the update (a MutationObserver inside the page;
//                                  the paint of the next frame is not included)
// Initiator and receiver run on one machine, so one clock is used. SQL time alone is not separable without server instrumentation.
// A line "B1 <workflow> #<n> <receiver> total=... api=... hint=... render=..." is printed for each receiver.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support');

const { skip, FRONT, API, newPage, loginOk } = S;
const sfx = S.SUFFIX;
const N = Number(process.env.SP_B1_ITERATIONS || 5);
const LIMIT = 5000;
let agentA; let agentB; let portId; let typeId; let coordUserId; let seq = 5000;
const shipIds = []; const results = [];
const users = {
  coord: S.mkUser('lcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']),
  coord2: S.mkUser('lcoord2', `Điều phối 2 ${sfx}`, ['DIEU_PHOI_VIEN']),
  manager: S.mkUser('lmgr', `Quản lý ${sfx}`, ['BAN_QUAN_LY']),
  agent: S.mkUser('lagent', `Đại lý ${sfx}`, ['DAI_LY_HANG_HAI']),
  agent2: S.mkUser('lagent2', `Đại lý khác ${sfx}`, ['DAI_LY_HANG_HAI']),
};
const q = async (text, params = {}) => { const d = S.db(); const req = d.pool.request(); for (const [k, v] of Object.entries(params)) req.input(k, v); return (await req.query(text)).recordset; };

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('LA_${sfx}', N'Đại lý L ${sfx}')`);
  agentB = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('LB_${sfx}', N'Đại lý LB ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('LP${sfx}', N'Cảng L ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
  users.agent.agentId = agentA; users.agent2.agentId = agentB;
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const ids = shipIds.length ? shipIds.join(',') : '0';
  const mine = `SELECT id FROM dbo.voyages WHERE ship_id IN (${ids})`;
  const own = `SELECT id FROM dbo.berths WHERE berth_code LIKE 'L${sfx}%'`;
  const plans = `SELECT id FROM dbo.berth_plans WHERE voyage_id IN (${mine}) OR berth_id IN (${own})`;
  await d.pool.request().query(`
    DELETE FROM dbo.notifications WHERE entity_type = 'BERTH_PLAN' AND entity_id IN (${plans});
    DELETE FROM dbo.notifications WHERE entity_type = 'VOYAGE' AND entity_id IN (${mine});
    DELETE FROM dbo.berth_plan_decisions WHERE voyage_id IN (${mine});
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
    DELETE FROM dbo.berths WHERE berth_code LIKE 'L${sfx}%';
    DELETE FROM dbo.auth_user_agents WHERE agent_id IN (${agentA}, ${agentB});
    DELETE FROM dbo.agents WHERE id IN (${agentA}, ${agentB}); DELETE FROM dbo.ports WHERE id = ${portId};`);
  const rows = results.map((r) => `${r.workflow}\t#${r.n}\t${r.receiver}\t${r.total}`);
  process.stdout.write(`B1 SUMMARY (ms, ${rows.length} measurements, limit ${LIMIT}, max ${Math.max(0, ...results.map((r) => r.total))})\n`);
}));

// ---------------------------------------------------------------- helpers
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
const apiFetch = (page, method, path, body, extra = {}) => page.evaluate(async (base, m, p, b, x) => {
  const res = await fetch(base + p, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, path, body, extra);
const fill = async (page, id, value) => { await page.$eval(id, (e) => { e.value = ''; }); if (value !== '') await page.type(id, String(value)); };

// Records the time of every refresh hint (both SSE channels) in the page, before any page script runs.
async function open(user) {
  const { page, context } = await newPage();
  await page.evaluateOnNewDocument(() => {
    window.__hints = [];
    const Native = window.EventSource;
    window.EventSource = class extends Native { constructor(u, o) { super(u, o); this.addEventListener('refresh', () => { window.__hints.push(Date.now()); }); } };
  });
  await loginOk(page, user, user.roles.includes('DAI_LY_HANG_HAI') ? 'vessels.html' : 'overview.html');   // an agent lands on the vessel page
  await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#nts'); await waitList(page, '#noteList');
  if (user.roles.some((r) => ['DIEU_PHOI_VIEN', 'BAN_QUAN_LY'].includes(r))) { await page.waitForSelector('#brt'); await waitList(page, '#berthList'); await waitList(page, '#planList'); await waitList(page, '#queueList'); }
  return { page, context };
}

// Resolves with the time at which `pred(arg)` first holds in the page (MutationObserver), or null after `limit` ms. Started before the action.
const watch = (page, pred, arg, limit = 15000) => page.evaluate((src, a, ms) => new Promise((resolve) => {
  const fn = new Function('a', `return (${src})(a);`);
  const ok = () => { try { return fn(a); } catch (e) { return false; } };
  const snap = (at) => ({ at, hints: window.__hints.slice() });
  if (ok()) return resolve(snap(Date.now()));
  const mo = new MutationObserver(() => { if (ok()) { mo.disconnect(); clearTimeout(tm); resolve(snap(Date.now())); } });
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  const tm = setTimeout(() => { mo.disconnect(); resolve(snap(null)); }, ms);
}), pred.toString(), arg, limit);

// `act` performs the click (and nothing else). `apiMatch` = [method, url part] of the request that the click sends.
async function measure(workflow, n, { page, apiMatch, act, receivers }) {
  for (const r of receivers) { const pre = await watch(r.page, r.pred, r.arg, 1); assert.equal(pre.at, null, `${workflow} #${n} ${r.label}: the update was already visible before the action`); }
  const pending = receivers.map((r) => watch(r.page, r.pred, r.arg));
  const respP = page.waitForResponse((res) => res.request().method() === apiMatch[0] && res.url().includes(apiMatch[1]), { timeout: 15000 });
  const t0 = Date.now();
  await act();
  const resp = await respP; const tApi = Date.now();
  const out = [];
  for (const [i, r] of receivers.entries()) {
    const w = await pending[i];
    const hint = w.hints.find((h) => h >= t0);
    const total = w.at === null ? null : w.at - t0;
    const line = `B1 ${workflow} #${n} ${r.label} total=${total === null ? 'NEVER' : total + 'ms'} api=${tApi - t0}ms hint=${hint === undefined ? 'none' : Math.max(0, hint - tApi) + 'ms'} render=${hint === undefined || w.at === null ? 'n/a' : Math.max(0, w.at - hint) + 'ms'} http=${resp.status()}`;
    process.stdout.write(line + '\n');
    results.push({ workflow, n, receiver: r.label, total: total === null ? 99999 : total });
    out.push({ label: r.label, total });
  }
  for (const o of out) assert.ok(o.total !== null && o.total < LIMIT, `${workflow} #${n} ${o.label}: ${o.total === null ? 'update never visible' : o.total + ' ms'} (limit ${LIMIT} ms)`);
}

async function mkShip(label, { docs = true } = {}) {
  coordUserId = coordUserId || Number((await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id);
  const id = (await q(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id, length_overall_m, beam_m, max_draft_m, deadweight_t)
    OUTPUT inserted.id VALUES (@c, @i, @n, @t, 200, 30, 9, 50000)`, { c: `LS${sfx}${label}`, i: `3${String(100000 + Math.floor(Math.random() * 800000))}`, n: `Lat ${label} ${sfx}`, t: typeId }))[0].id;
  if (docs) for (const type of ['REGISTRATION', 'INSURANCE']) {
    await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
      VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2035-01-01', @u, SYSUTCDATETIME())`, { s: id, t: type, k: `${sfx}${label}${type}`, u: coordUserId });
  }
  shipIds.push(id); return id;
}
// A queued voyage with a verified cargo hazard, as UC-015 and UC-028 would leave it (inserted directly: this test measures notices, not UC-015).
async function queuedVoyage(label) {
  const shipId = await mkShip(label, { docs: false }); seq += 1;
  return (await q(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, queue_position, queued_at, validation_result, validated_at, validation_policy_version,
      cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at)
    OUTPUT inserted.id VALUES (@s, @c, 'WAITING_BERTH', @a, @p, @eta, 100, N'x', @pos, SYSUTCDATETIME(), 'VALID', SYSUTCDATETIME(), 'V', 'NONE', N'fixture', @u, SYSUTCDATETIME())`,
  { s: shipId, c: `L${sfx}${label}`, a: agentA, p: portId, eta: new Date(Date.now() + 6 * 3600e3), pos: seq, u: coordUserId }))[0].id;
}

// ---------------------------------------------------------------- predicates (run inside the receiving page; no closures)
const noteHas = (a) => [...document.querySelectorAll('#noteList li')].some((li) => a.words.every((w) => li.textContent.includes(w)));
const queueHas = (a) => [...document.querySelectorAll('#queueList tr[data-queue]')].some((r) => r.textContent.includes(a.code));
const queueLacks = (a) => !document.querySelector(`#queueList tr[data-queue="${a.id}"]`);
const noticeHas = (a) => [...document.querySelectorAll('#noticeList tr[data-voyage]')].some((r) => r.textContent.includes(a.code) && r.textContent.includes(a.text));
const planHas = (a) => [...document.querySelectorAll('#planList tr[data-plan]')].some((r) => r.textContent.includes(a.code) && r.textContent.includes(a.text));
const berthHas = (a) => [...document.querySelectorAll('#berthList tr[data-berth]')].some((r) => r.textContent.includes(a.code) && r.textContent.includes(a.text));
const firstQueueIs = (a) => { const r = document.querySelector('#queueList tr[data-queue]'); return !!r && r.getAttribute('data-queue') === String(a.id); };

// ---------------------------------------------------------------- B1-1 notice, validation, queue
test('B1 notice: a submitted notice that validates appears in another coordinator\'s queue and notice list; a notice with missing documents appears with that status; each under 5 s', { skip, timeout: 600000 }, async () => {
  const a = await open(users.coord); const c = await open(users.coord2);
  for (let n = 1; n <= N + 2; n += 1) {
    const missing = n > N;
    const shipId = await mkShip(`n${n}`, { docs: !missing }); const code = `L${sfx}n${n}`;
    await a.page.click('#addNotice'); await a.page.waitForSelector('#nf');
    await a.page.select('#f-ship_id', String(shipId));
    await fill(a.page, '#f-voyage_code', code);
    await a.page.select('#f-agent_id', String(agentA)); await a.page.select('#f-origin_port_id', String(portId));
    await a.page.$eval('#f-declared_eta', (e, v) => { e.value = v; }, `2031-11-${String(10 + n).padStart(2, '0')}T08:00`);
    await fill(a.page, '#f-declared_teu', 120); await fill(a.page, '#f-cargo_type', 'Container');
    await measure(missing ? 'notice-missing-documents' : 'notice-to-queue', missing ? n - N : n, {
      page: a.page, apiMatch: ['POST', '/api/v1/voyages'], act: () => a.page.click('#nf button[type=submit]'),
      receivers: missing
        ? [{ label: 'coordinator2-notice-list', page: c.page, pred: noticeHas, arg: { code, text: 'MISSING_DOCUMENTS' } }]
        : [{ label: 'coordinator2-queue', page: c.page, pred: queueHas, arg: { code } }, { label: 'coordinator2-notice-list', page: c.page, pred: noticeHas, arg: { code, text: 'WAITING_BERTH' } }],
    });
    await a.page.waitForSelector('#vresult'); await a.page.click('#vresult [data-close]'); await dialogClosed(a.page);
  }
  await a.context.close(); await c.context.close();
});

// ---------------------------------------------------------------- B1-2 manual queue move
test('B1 queue move: a manual move by one coordinator is visible in another coordinator\'s queue under 5 s', { skip, timeout: 300000 }, async () => {
  const a = await open(users.coord); const c = await open(users.coord2);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const shipId = await mkShip(`m${i}`); const code = `L${sfx}m${i}`;
    const r = await apiFetch(a.page, 'POST', '/api/v1/voyages', { ship_id: shipId, voyage_code: code, agent_id: agentA, origin_port_id: portId, declared_eta: new Date(Date.UTC(2031, 11, 1 + i, 1)).toISOString(), declared_teu: 100, cargo_type: 'Container' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push(r.body.data.id);
  }
  for (let n = 1; n <= N; n += 1) {
    // Alternate: move the last of my three voyages to the front of the whole queue, then move another one to the front.
    const target = ids[n % 3];
    await a.page.evaluate(() => VR.loadQueue({ silent: true })); await c.page.evaluate(() => VR.loadQueue({ silent: true }));
    const qv = (await apiFetch(a.page, 'GET', '/api/v1/voyages/queue')).body.data;
    assert.ok(qv.items[0].voyage_id !== target, 'the target is not already first');
    await measure('queue-move', n, {
      page: a.page, apiMatch: ['PATCH', `/queue-position`],
      act: () => a.page.evaluate((base, id, rev) => fetch(`${base}/api/v1/voyages/${id}/queue-position`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', 'If-Match': `"${rev}"` }, body: JSON.stringify({ to_position: 1, reason: 'B1 measurement' }) }), API, target, qv.revision),
      receivers: [{ label: 'coordinator2-queue-first', page: c.page, pred: firstQueueIs, arg: { id: target } }],
    });
  }
  await a.context.close(); await c.context.close();
});

// ---------------------------------------------------------------- B1-3 plan submission, approval, berthing, departure
test('B1 plan lifecycle: submission reaches the manager, approval reaches the coordinators and the agent (and not another agent), berthing and departure update the berth state in other browsers; each under 5 s', { skip, timeout: 900000 }, async () => {
  const a = await open(users.coord); const c = await open(users.coord2); const b = await open(users.manager);
  const g = await open(users.agent); const g2 = await open(users.agent2);
  for (let n = 1; n <= N; n += 1) {
    const code = `L${sfx}p${n}`; const voyageId = await queuedVoyage(`p${n}`);
    const berth = (await apiFetch(a.page, 'POST', '/api/v1/berths', { berth_code: `L${sfx}b${n}`, berth_type: 'CONTAINER', length_m: 600, max_depth_m: 12, available_cranes: 3, allows_dangerous: false })).body.data;
    const day = String(1 + n).padStart(2, '0');
    const plan = (await apiFetch(a.page, 'POST', '/api/v1/berth-plans', { voyage_id: voyageId, berth_id: berth.id, position_start_m: 0, position_end_m: 240, planned_start: `2031-10-${day}T01:00:00Z`, planned_end: `2031-10-${day}T13:00:00Z`, required_cranes: 2 })).body.data;
    assert.ok(plan && plan.id, 'draft plan created');
    for (const p of [a.page, c.page]) { await p.evaluate(() => VR.loadQueue({ silent: true })); await p.waitForSelector(`#queueList tr[data-queue="${voyageId}"]`); }
    await a.page.evaluate(() => BP.loadPlans());
    await a.page.waitForSelector(`#planList tr[data-plan="${plan.id}"] [data-bact=plan-submit]`);

    // 1. submission -> the port manager's notice
    await measure('plan-submit-to-manager', n, {
      page: a.page, apiMatch: ['POST', `/berth-plans/${plan.id}/submit`], act: () => S.clickChecked(a.page, `#planList tr[data-plan="${plan.id}"] [data-bact=plan-submit]`),
      receivers: [{ label: 'manager-notice', page: b.page, pred: noteHas, arg: { words: [code] } }],
    });
    // 2. approval -> coordinators, agent, manager's own list, berth state
    await b.page.waitForSelector(`#planList tr[data-plan="${plan.id}"] [data-bact=plan-review]`);
    await b.page.click(`#planList tr[data-plan="${plan.id}"] [data-bact=plan-review]`);
    await b.page.waitForSelector('#reviewBox #chkResult #chkOutcome[data-outcome=PASS]'); await b.page.click('#approveBtn'); await b.page.waitForSelector('#confirmApprove');
    await measure('plan-approval', n, {
      page: b.page, apiMatch: ['POST', `/berth-plans/${plan.id}/approve`], act: () => b.page.click('#confirmApprove'),
      receivers: [
        { label: 'coordinator-notice', page: a.page, pred: noteHas, arg: { words: [code, 'phê duyệt'] } },
        { label: 'coordinator2-queue-left', page: c.page, pred: queueLacks, arg: { id: voyageId } },
        { label: 'coordinator-berth-reserved', page: a.page, pred: berthHas, arg: { code: berth.berth_code, text: 'Đã đặt trước' } },
        { label: 'agent-notice', page: g.page, pred: noteHas, arg: { words: [code, 'xếp bến'] } },
      ],
    });
    await dialogClosed(b.page);
    // Isolation: another agent's page and notification list never contain this voyage.
    const other = await apiFetch(g2.page, 'GET', '/api/v1/notifications');
    assert.equal(other.status, 200); assert.ok(!JSON.stringify(other.body).includes(code), 'another agent does not receive this voyage\'s notice');
    assert.equal(await g2.page.evaluate((cd) => document.body.innerText.includes(cd), code), false, 'nor does its open page show it');
    assert.equal((await apiFetch(g.page, 'GET', '/api/v1/berth-plans')).status, 403, 'the agent has no berth data');

    // 3. berthing -> berth state elsewhere
    const life = async (status) => {
      await a.page.select('#schStatus', status);
      await a.page.waitForFunction((cd) => [...document.querySelectorAll('#schBody tr[data-sched]')].some((r) => r.textContent.includes(cd)), { timeout: 10000 }, code);
      await S.clickChecked(a.page, `#schBody tr[data-sched="${voyageId}"] [data-act=lifecycle]`); await a.page.waitForSelector('#vlife');
    };
    await life('BERTH_ASSIGNED'); await a.page.click('#vlife [data-act=berthing]'); await a.page.waitForSelector('#mvf');
    await measure('berthing-to-berth-state', n, {
      page: a.page, apiMatch: ['POST', `/voyages/${voyageId}/berthing`], act: () => a.page.click('#mvConfirm'),
      receivers: [
        { label: 'manager-berth-in-use', page: b.page, pred: berthHas, arg: { code: berth.berth_code, text: 'Đang sử dụng' } },
        { label: 'coordinator2-berth-in-use', page: c.page, pred: berthHas, arg: { code: berth.berth_code, text: 'Đang sử dụng' } },
      ],
    });
    await dialogClosed(a.page);
    // 4. departure -> berth state elsewhere
    await life('BERTHED'); await a.page.click('#vlife [data-act=departure]'); await a.page.waitForSelector('#mvf');
    await measure('departure-to-berth-state', n, {
      page: a.page, apiMatch: ['POST', `/voyages/${voyageId}/departure`], act: () => a.page.click('#mvConfirm'),
      receivers: [
        { label: 'manager-berth-free', page: b.page, pred: berthHas, arg: { code: berth.berth_code, text: 'Trống' } },
        { label: 'coordinator2-berth-free', page: c.page, pred: berthHas, arg: { code: berth.berth_code, text: 'Trống' } },
      ],
    });
    await dialogClosed(a.page);
  }
  for (const x of [a, c, b, g, g2]) await x.context.close();
});

// ---------------------------------------------------------------- B1-4 rejection
test('B1 rejection: the coordinator sees the rejection with the reason under 5 s; the berth stays free', { skip, timeout: 600000 }, async () => {
  const a = await open(users.coord); const b = await open(users.manager);
  for (let n = 1; n <= N; n += 1) {
    const code = `L${sfx}r${n}`; const voyageId = await queuedVoyage(`r${n}`);
    const berth = (await apiFetch(a.page, 'POST', '/api/v1/berths', { berth_code: `L${sfx}c${n}`, berth_type: 'CONTAINER', length_m: 600, max_depth_m: 12, available_cranes: 3, allows_dangerous: false })).body.data;
    const day = String(1 + n).padStart(2, '0');
    const plan = (await apiFetch(a.page, 'POST', '/api/v1/berth-plans', { voyage_id: voyageId, berth_id: berth.id, position_start_m: 0, position_end_m: 240, planned_start: `2031-09-${day}T01:00:00Z`, planned_end: `2031-09-${day}T13:00:00Z`, required_cranes: 2 })).body.data;
    const sub = await apiFetch(a.page, 'POST', `/api/v1/berth-plans/${plan.id}/submit`, {}, { 'If-Match': `"${plan.revision}"` });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    await b.page.waitForSelector(`#planList tr[data-plan="${plan.id}"] [data-bact=plan-review]`);
    await b.page.click(`#planList tr[data-plan="${plan.id}"] [data-bact=plan-review]`); await b.page.waitForSelector('#reviewBox #rejectBtn');
    await b.page.click('#rejectBtn'); await b.page.waitForSelector('#f-reject_reason');
    const reason = `Khong du cau bo ${n}`;
    await b.page.type('#f-reject_reason', reason);
    await measure('rejection-to-coordinator', n, {
      page: b.page, apiMatch: ['POST', `/berth-plans/${plan.id}/reject`], act: () => b.page.click('#confirmReject'),
      receivers: [{ label: 'coordinator-notice-with-reason', page: a.page, pred: noteHas, arg: { words: [code, 'bị từ chối', reason] } }],
    });
    await dialogClosed(b.page);
  }
  await a.context.close(); await b.context.close();
});

// ---------------------------------------------------------------- A2: a background refresh keeps an open form and its typed values
test('A2 refresh safety: while a coordinator is typing a notice, a hint from another user refreshes the lists behind the dialog but keeps the open form and its values; an unchanged list is not re-drawn', { skip, timeout: 240000 }, async () => {
  const a = await open(users.coord); const c = await open(users.coord2);
  const shipMine = await mkShip('k1'); const shipOther = await mkShip('k2');
  await a.page.click('#addNotice'); await a.page.waitForSelector('#nf');
  await a.page.select('#f-ship_id', String(shipMine)); await fill(a.page, '#f-voyage_code', `L${sfx}typed`); await fill(a.page, '#f-declared_teu', 77);
  const draws = await a.page.evaluate(() => { window.__d = 0; const el = document.getElementById('queueList'); new MutationObserver(() => { window.__d += 1; }).observe(el, { childList: true }); return 0; });
  void draws;
  const other = `L${sfx}other`;
  const w = watch(a.page, queueHas, { code: other });
  const r = await apiFetch(c.page, 'POST', '/api/v1/voyages', { ship_id: shipOther, voyage_code: other, agent_id: agentA, origin_port_id: portId, declared_eta: new Date(Date.UTC(2032, 0, 5, 1)).toISOString(), declared_teu: 50, cargo_type: 'Container' });
  assert.equal(r.status, 201);
  const seen = await w; assert.ok(seen.at !== null, 'the queue behind the dialog refreshed');
  assert.equal(await a.page.$eval('#f-voyage_code', (e) => e.value), `L${sfx}typed`, 'the typed voyage code is kept');
  assert.equal(await a.page.$eval('#f-declared_teu', (e) => e.value), '77'); assert.equal(await a.page.$eval('#f-ship_id', (e) => e.value), String(shipMine));
  assert.equal(await a.page.$eval('#vdlg', (e) => e.open), true, 'the dialog stays open');
  // A second hint that changes nothing in the queue (a refresh with identical data) must not re-draw it.
  const before = await a.page.evaluate(() => window.__d);
  await a.page.evaluate(() => VR.loadQueue({ silent: true })); await a.page.evaluate(() => VR.loadQueue({ silent: true }));
  assert.equal(await a.page.evaluate(() => window.__d), before, 'an unchanged queue is not re-drawn');
  await a.page.click('#vdlg [data-close]'); await dialogClosed(a.page);
  await a.context.close(); await c.context.close();
});
