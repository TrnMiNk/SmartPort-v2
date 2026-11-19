'use strict';

// Browser end-to-end tests for UC-010, UC-011 and UC-013: vessel registry and arrival notices, Front -> API -> SQL Server.
// Set-up and the disposable-database requirement are described in support.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('./support');

const { skip, FRONT, API, newPage, onPage, loginOk, cookies } = S;
const sfx = S.SUFFIX;
let agentA; let agentB; let portId; let typeId;
const imos = [];
let imoCounter = 100000 + Math.floor(Math.random() * 700000);
const nextImo = () => { const v = '7' + String(imoCounter++).padStart(6, '0'); imos.push(v); return v; };

const users = {
  coord: S.mkUser('vcoord', `Điều phối ${sfx}`, ['DIEU_PHOI_VIEN']),
  agent: S.mkUser('vagent', `Đại lý ${sfx}`, ['DAI_LY_HANG_HAI']),
  yard: S.mkUser('vyard', `Kho bãi ${sfx}`, ['NHAN_VIEN_KHO_BAI']),
  tech: S.mkUser('vtech', `Kỹ thuật ${sfx}`, ['KY_THUAT_VIEN']),
};
const db = { get pool() { return S.db().pool; }, get sql() { return S.db().sql; } };
const q = async (text, params = {}) => {
  const req = db.pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(text)).recordset;
};

test.before(() => S.start(users, async (d) => {
  const run = async (text) => (await d.pool.request().query(text)).recordset[0].id;
  agentA = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('EA_${sfx}', N'Đại lý E2E A ${sfx}')`);
  agentB = await run(`INSERT INTO dbo.agents (agent_code, agent_name) OUTPUT inserted.id VALUES ('EB_${sfx}', N'Đại lý E2E B ${sfx}')`);
  portId = await run(`INSERT INTO dbo.ports (port_code, port_name) OUTPUT inserted.id VALUES ('EP${sfx}', N'Cảng E2E ${sfx}')`);
  typeId = (await d.pool.request().query("SELECT id FROM dbo.ship_types WHERE type_code = 'CONTAINER'")).recordset[0].id;
  users.agent.agentId = agentA;
}), { timeout: 90000 });

test.after(() => S.stop(users, async (d) => {
  const list = imos.map((i) => `'${i}'`).join(',') || "''";
  await d.pool.request().query(`
    DECLARE @ships TABLE (id INT); INSERT INTO @ships SELECT id FROM dbo.ships WHERE imo_number IN (${list});
    DECLARE @voyages TABLE (id INT); INSERT INTO @voyages SELECT id FROM dbo.voyages WHERE ship_id IN (SELECT id FROM @ships);
    UPDATE dbo.voyages SET latest_eta_prediction_id = NULL WHERE id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.voyage_drafts WHERE submitted_voyage_id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.voyage_validation_runs WHERE voyage_id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.voyage_eta_predictions WHERE voyage_id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.voyage_queue_changes WHERE voyage_id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.voyage_status_history WHERE voyage_id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.berth_plans WHERE voyage_id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.voyages WHERE id IN (SELECT id FROM @voyages);
    DELETE FROM dbo.ship_documents WHERE ship_id IN (SELECT id FROM @ships);
    DELETE FROM dbo.ships WHERE id IN (SELECT id FROM @ships);
    DELETE FROM dbo.auth_user_agents WHERE agent_id IN (${agentA}, ${agentB});
    DELETE FROM dbo.agents WHERE id IN (${agentA}, ${agentB}); DELETE FROM dbo.ports WHERE id = ${portId};
    DELETE FROM dbo.berths WHERE berth_code LIKE 'EB${sfx}%';`);
}));

const waitList = (page, id) => page.waitForFunction((sel) => { const el = document.querySelector(sel); return el && !el.textContent.includes('Loading…') && el.innerHTML.length > 0; }, {}, id);
async function openVessels(page, user, landing = 'overview.html') {
  await loginOk(page, user, landing);
  await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#reg');
  await waitList(page, '#shipList');
  await waitList(page, '#noticeList');
}
const dialogClosed = (page) => page.waitForFunction(() => { const d = document.querySelector('#vdlg'); return !d || !d.open; });
const apiFetch = (page, method, path, body, extra = {}) => page.evaluate(async (base, m, p, b, x) => {
  const res = await fetch(base + p, { method: m, credentials: 'include', headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...x }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}, API, method, path, body, extra);
// Types a search and waits for the debounced request with the full text to come back and be rendered.
const searchFor = async (page, text) => {
  await page.$eval('#shipQ', (e) => { e.value = ''; });
  const answered = page.waitForResponse((r) => r.url().includes('/api/v1/ships?') && r.url().includes('search=' + encodeURIComponent(text)));
  await page.type('#shipQ', text);
  await answered;
  await waitList(page, '#shipList');
};
const hasRow = (page, text) => page.waitForFunction((t) => [...document.querySelectorAll('#shipList tr[data-ship]')].some((r) => r.textContent.includes(t)), {}, text);
const fillShip = async (page, v) => {
  await page.waitForSelector('#vf');
  if (v.imo !== undefined) await page.type('#f-imo_number', v.imo);
  if (v.name !== undefined) await page.type('#f-ship_name', v.name);
  if (v.type !== undefined) await page.select('#f-ship_type_id', String(v.type));
  if (v.flag !== undefined) await page.type('#f-flag_state', v.flag);
  if (v.agent !== undefined) await page.select('#f-operator_agent_id', String(v.agent));
  for (const [k, id] of [['loa', 'length_overall_m'], ['beam', 'beam_m'], ['draft', 'max_draft_m'], ['dwt', 'deadweight_t']]) if (v[k] !== undefined) await page.type('#f-' + id, String(v[k]));
};
const goodShip = (name, imo = nextImo()) => ({ imo, name, type: typeId, flag: 'VN', agent: agentA, loa: 180, beam: 30, draft: 10, dwt: 20000 });
// Creates a vessel through the form. After saving, the vessel's detail page opens (UC-010 step 5); this closes it.
async function addShipUi(page, v) {
  await page.click('#addShip');
  await fillShip(page, v);
  await page.click('#vf button[type=submit]');
  await page.waitForSelector('#vdetail');
  await page.click('#vdetail [data-close]');
  await dialogClosed(page);
}

test('UC-010: a coordinator creates a vessel in the browser; it appears in the list and is stored in SQL Server with an audit row', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Alpha ${sfx}`);
  await page.click('#addShip');
  await fillShip(page, v);
  await page.click('#vf button[type=submit]');
  // UC-010 step 5: the saved vessel's detail page opens, with its data and the first history entry.
  await page.waitForSelector('#vdetail');
  const detail = await page.$eval('#vdetail', (e) => e.textContent);
  assert.ok(detail.includes(v.name) && detail.includes(`IMO ${v.imo}`) && detail.includes('Tàu container'), 'detail shows the saved data, got: ' + detail);
  await page.waitForFunction(() => document.querySelector('#vhist ol li') !== null);
  assert.match(await page.$eval('#vhist', (e) => e.textContent), /Created/);
  await page.click('#vdetail [data-close]');
  await dialogClosed(page);
  await page.waitForFunction((t) => !document.querySelector('#banner').hidden && document.querySelector('#banner').textContent.includes(t), {}, v.name);
  await searchFor(page, v.imo);
  await hasRow(page, v.name);
  const row = (await q('SELECT * FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0];
  assert.equal(row.ship_name, v.name);
  assert.equal(row.ship_code, 'IMO' + v.imo);
  assert.equal(Number(row.length_overall_m), 180);
  assert.equal(row.operator_agent_id, agentA);
  assert.equal(row.is_active, true);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.audit_events WHERE action = 'SHIP_CREATE' AND outcome = 'SUCCESS' AND entity_id = @e", { e: String(row.id) }))[0].n, 1);
  await context.close();
});

test('UC-010: a duplicate IMO shows the error under the IMO field, keeps the dialog open and stores nothing new', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Dup ${sfx}`);
  await addShipUi(page, v);
  await page.click('#addShip');
  await fillShip(page, { ...goodShip(`E2E Dup2 ${sfx}`, v.imo) });
  // This wait timed out once in about 10 full runs without a visible cause. If it recurs, say what the page showed and what the API answered.
  const answered = page.waitForResponse((r) => r.url().includes('/api/v1/ships') && r.request().method() === 'POST', { timeout: 15000 }).then((r) => r.status()).catch(() => 'no response');
  await page.click('#vf button[type=submit]');
  try { await page.waitForFunction(() => document.querySelector('#e-imo_number').textContent.includes('đã tồn tại'), { timeout: 12000 }); }
  catch (e) { throw new Error('duplicate IMO message missing: api=' + (await answered) + ' dialog=' + JSON.stringify(await page.evaluate(() => { const d = document.querySelector('#vdlg'); return { open: d && d.open, text: d && d.innerText.slice(0, 400) }; }))); }
  assert.equal(await page.evaluate(() => document.querySelector('#vdlg').open), true);
  assert.equal(await page.$eval('#f-imo_number', (e) => e.getAttribute('aria-invalid')), 'true');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].n, 1);
  assert.equal(await page.$eval('#vf button[type=submit]', (b) => b.disabled), false, 'form usable again after the error');
  await context.close();
});

test('UC-010: an empty or invalid form shows server field errors, marks the fields and focuses the first one', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  await page.click('#addShip');
  await page.waitForSelector('#vf');
  await page.click('#vf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#e-imo_number').textContent.length > 0 && document.querySelector('#e-length_overall_m').textContent.length > 0);
  for (const f of ['imo_number', 'ship_name', 'ship_type_id', 'length_overall_m', 'beam_m', 'max_draft_m', 'deadweight_t']) {
    assert.ok((await page.$eval('#e-' + f, (e) => e.textContent)).length > 0, f);
  }
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-imo_number');
  await page.type('#f-imo_number', '12AB567');
  await page.click('#vf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#e-imo_number').textContent.includes('7 chữ số'));
  await context.close();
});

test('UC-011: edit sends only changed fields and bumps the revision; saving without changes is refused locally', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Edit ${sfx}`);
  await addShipUi(page, v);
  await searchFor(page, v.imo);
  await hasRow(page, v.name);
  await page.click('tr[data-ship] [data-act=edit]');
  await page.waitForSelector('#vf');
  await page.click('#vf button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#fmsg').textContent.includes('Không có thay đổi'));
  await page.$eval('#f-ship_name', (e) => { e.value = ''; });
  await page.type('#f-ship_name', `${v.name} Renamed`);
  await page.type('#f-reason', 'Sửa tên tàu');
  await page.click('#vf button[type=submit]');
  await dialogClosed(page);
  await hasRow(page, `${v.name} Renamed`);
  const row = (await q('SELECT id, ship_name, revision FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0];
  assert.equal(row.ship_name, `${v.name} Renamed`);
  assert.equal(Number(row.revision), 2);
  const audit = (await q("SELECT old_json, new_json, reason FROM dbo.audit_events WHERE action = 'SHIP_UPDATE' AND entity_id = @e", { e: String(row.id) }))[0];
  assert.equal(JSON.parse(audit.old_json).ship_name, v.name);
  assert.equal(audit.reason, 'Sửa tên tàu');
  await context.close();
});

test('UC-010 5a: a server error keeps the dialog open and keeps everything the user typed', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Fail ${sfx}`);
  await page.setRequestInterception(true);
  const handler = (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/v1/ships')) {
      r.respond({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': FRONT, 'Access-Control-Allow-Credentials': 'true' },
        body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' } }) });
    } else r.continue();
  };
  page.on('request', handler);
  await page.click('#addShip');
  await fillShip(page, v);
  await page.click('#vf button[type=submit]');
  await page.waitForFunction(() => { const m = document.querySelector('#fmsg'); return m && !m.hidden && m.textContent.includes('Đã xảy ra lỗi'); });
  assert.equal(await page.$eval('#f-imo_number', (e) => e.value), v.imo);
  assert.equal(await page.$eval('#f-ship_name', (e) => e.value), v.name);
  assert.equal(await page.$eval('#f-length_overall_m', (e) => e.value), '180');
  assert.equal(await page.$eval('#vf button[type=submit]', (b) => b.disabled), false, 'the user can retry');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].n, 0);
  page.off('request', handler);
  await page.setRequestInterception(false);
  await page.click('#vf button[type=submit]'); // the retry now succeeds with the same data
  await page.waitForSelector('#vdetail');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].n, 1);
  await context.close();
});

test('UC-011 AC-1: the detail page lists every change with who, when, why and old to new values', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Hist ${sfx}`);
  await addShipUi(page, v);
  await searchFor(page, v.imo);
  await hasRow(page, v.name);
  await page.click('tr[data-ship] [data-act=edit]');
  await page.waitForSelector('#vf');
  await page.$eval('#f-ship_name', (e) => { e.value = ''; });
  await page.type('#f-ship_name', `${v.name} B`);
  await page.type('#f-reason', 'Đổi tên để thử lịch sử');
  await page.click('#vf button[type=submit]');
  await dialogClosed(page);
  await hasRow(page, `${v.name} B`);
  await page.click('tr[data-ship] [data-act=detail]');
  await page.waitForFunction(() => document.querySelectorAll('#vhist ol > li').length === 2);
  const text = await page.$eval('#vhist', (e) => e.textContent);
  assert.match(text, /Created/);
  assert.match(text, /Updated/);
  assert.ok(text.includes(users.coord.username), 'who');
  assert.ok(text.includes('Đổi tên để thử lịch sử'), 'why');
  assert.ok(text.includes(`Name: ${v.name} → ${v.name} B`), 'old to new');
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, 'when, in UTC+7');
  await context.close();
});

test('UC-011: saving a record that someone else changed reloads the newest data and asks the user to check it', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Stale ${sfx}`);
  await addShipUi(page, v);
  await searchFor(page, v.imo);
  await hasRow(page, v.name);
  await page.click('tr[data-ship] [data-act=edit]');
  await page.waitForSelector('#vf');
  await q("UPDATE dbo.ships SET ship_name = N'Changed elsewhere', revision = revision + 1 WHERE imo_number = @i", { i: v.imo });
  await page.$eval('#f-flag_state', (e) => { e.value = ''; });
  await page.type('#f-flag_state', 'SG');
  await page.click('#vf button[type=submit]');
  await page.waitForFunction(() => { const m = document.querySelector('#fmsg'); return m && !m.hidden && m.textContent.includes('người khác'); });
  assert.equal(await page.$eval('#f-ship_name', (e) => e.value), 'Changed elsewhere', 'form shows the newest data');
  assert.equal((await q('SELECT flag_state FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].flag_state, 'VN', 'the stale edit was not applied');
  await context.close();
});

test('UC-013: a coordinator submits an arrival notice; ETA entered as UTC+7 is shown the same and stored as UTC; a duplicate is refused', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Notice ${sfx}`);
  await addShipUi(page, v);
  await page.click('#addNotice');
  await page.waitForSelector('#nf');
  const code = `E2E-${crypto.randomBytes(2).toString('hex')}`;
  const submit = async () => {
    await page.select('#f-ship_id', String((await q('SELECT id FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].id));
    await page.type('#f-voyage_code', code);
    await page.select('#f-agent_id', String(agentA));
    await page.select('#f-origin_port_id', String(portId));
    await page.$eval('#f-declared_eta', (e) => { e.value = '2026-12-01T08:00'; e.dispatchEvent(new Event('input')); });
    await page.type('#f-declared_teu', '120');
    await page.type('#f-cargo_type', 'Container');
    await page.click('#nf button[type=submit]');
  };
  await submit();
  // UC-015 runs automatically: the result dialog shows the outcome. The dev policy needs documents, so the new vessel has none.
  await page.waitForSelector('#vresult');
  assert.ok((await page.$eval('#vresult', (e) => e.textContent)).includes('MISSING_DOCUMENTS'));
  await page.click('#vresult [data-close]');
  await dialogClosed(page);
  await page.waitForFunction((c) => [...document.querySelectorAll('#noticeList tbody tr')].some((r) => r.textContent.includes(c) && r.textContent.includes('2026-12-01 08:00') && r.textContent.includes('MISSING_DOCUMENTS')), {}, code);
  const row = (await q('SELECT v.declared_eta, v.status, v.priority_class FROM dbo.voyages v JOIN dbo.ships s ON s.id = v.ship_id WHERE s.imo_number = @i AND v.voyage_code = @c', { i: v.imo, c: code }))[0];
  assert.equal(row.declared_eta.toISOString(), '2026-12-01T01:00:00.000Z');
  assert.equal(row.status, 'MISSING_DOCUMENTS');
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_status_history h JOIN dbo.voyages x ON x.id = h.voyage_id JOIN dbo.ships s ON s.id = x.ship_id WHERE s.imo_number = @i", { i: v.imo }))[0].n, 2);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyage_validation_runs r JOIN dbo.voyages x ON x.id = r.voyage_id JOIN dbo.ships s ON s.id = x.ship_id WHERE s.imo_number = @i", { i: v.imo }))[0].n, 1, 'one audited run');
  // "Validate again" on a notice that is still incomplete replays nothing new into history: the outcome is decided again from current data.
  await page.click(`#noticeList tr[data-voyage] [data-act=revalidate]`);
  await page.waitForSelector('#vresult');
  await page.click('#vresult [data-close]');
  await dialogClosed(page);
  // The same notice again is refused with a message on the voyage code field.
  await page.click('#addNotice');
  await page.waitForSelector('#nf');
  await submit();
  await page.waitForFunction(() => document.querySelector('#e-voyage_code').textContent.includes('đã tồn tại'));
  assert.equal(await page.evaluate(() => document.querySelector('#vdlg').open), true);
  await context.close();
});

test('UC-011: deactivation asks for a reason, is refused while a voyage is unfinished, then works and hides the vessel', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Deact ${sfx}`);
  await addShipUi(page, v);
  const shipId = (await q('SELECT id FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].id;
  const created = await apiFetch(page, 'POST', '/api/v1/voyages', { ship_id: shipId, voyage_code: 'DEACT-1', agent_id: agentA, origin_port_id: portId, declared_eta: '2026-12-01T08:00:00+07:00', declared_teu: 1, cargo_type: 'x' });
  assert.equal(created.status, 201);
  await searchFor(page, v.imo);
  await hasRow(page, v.name);
  await page.click('tr[data-ship] [data-act=deactivate]');
  await page.waitForSelector('#df');
  await page.click('#df button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#e-reason').textContent.length > 0);
  await page.type('#f-reason', 'Hết khai thác');
  await page.click('#df button[type=submit]');
  await page.waitForFunction(() => { const m = document.querySelector('#fmsg'); return !m.hidden && m.textContent.includes('DEACT-1'); });
  assert.equal((await q('SELECT is_active FROM dbo.ships WHERE id = @i', { i: shipId }))[0].is_active, true, 'refused: unchanged');
  await q("UPDATE dbo.voyages SET status = 'REJECTED' WHERE ship_id = @i", { i: shipId });
  await page.click('#df button[type=submit]');
  await dialogClosed(page);
  await page.waitForFunction((t) => ![...document.querySelectorAll('#shipList tr[data-ship]')].some((r) => r.textContent.includes(t)), {}, v.name);
  assert.equal((await q('SELECT is_active FROM dbo.ships WHERE id = @i', { i: shipId }))[0].is_active, false);
  await page.click('#shipInactive');
  await page.waitForFunction((t) => [...document.querySelectorAll('#shipList tr[data-ship]')].some((r) => r.textContent.includes(t) && r.textContent.includes('Inactive')), {}, v.name);
  // UC-011 AC-2: a deactivated vessel cannot be chosen when creating an arrival notice.
  await page.click('#addNotice');
  await page.waitForSelector('#nf');
  assert.ok(!(await page.$$eval('#f-ship_id option', (os) => os.map((o) => o.textContent))).some((t) => t.includes(v.imo)), 'inactive vessel is not offered');
  await context.close();
});

test('agent: sees only its own vessels, no vessel buttons, submits a notice for its own vessel; the form offers only its own agent and no priority', { skip, timeout: 120000 }, async () => {
  const { page: cp, context: cc } = await newPage();
  await openVessels(cp, users.coord);
  const own = goodShip(`E2E Own ${sfx}`, nextImo());
  const foreign = { ...goodShip(`E2E Foreign ${sfx}`, nextImo()), agent: agentB };
  await addShipUi(cp, own);
  await addShipUi(cp, foreign);
  await cc.close();

  const { page, context } = await newPage();
  await openVessels(page, users.agent, 'vessels.html');
  assert.deepEqual(await page.$$eval('#nav a', (as) => as.map((a) => a.dataset.r)), ['vessels']);
  assert.equal(await page.$eval('#addShip', (b) => b.hidden), true);
  assert.equal(await page.$eval('#addNotice', (b) => b.hidden), false);
  await searchFor(page, 'E2E');
  await hasRow(page, own.name);
  const texts = await page.$$eval('#shipList tr[data-ship]', (rs) => rs.map((r) => r.textContent));
  assert.ok(texts.every((t) => !t.includes('E2E Foreign')), 'foreign vessel is not listed');
  assert.equal(await page.$('[data-act=edit]'), null, 'no edit buttons for an agent');
  await page.click('#addNotice');
  await page.waitForSelector('#nf');
  assert.equal(await page.$('#f-priority_class'), null, 'agents cannot set priority');
  const agentOptions = await page.$$eval('#f-agent_id option', (os) => os.map((o) => o.value).filter(Boolean));
  assert.deepEqual(agentOptions, [String(agentA)]);
  assert.equal(await page.$eval('#f-agent_id', (e) => e.value), String(agentA), 'single agent is preselected');
  const shipOptions = await page.$$eval('#f-ship_id option', (os) => os.map((o) => o.textContent));
  assert.ok(shipOptions.some((t) => t.includes(own.imo)) && !shipOptions.some((t) => t.includes(foreign.imo)));
  await page.select('#f-ship_id', String((await q('SELECT id FROM dbo.ships WHERE imo_number = @i', { i: own.imo }))[0].id));
  await page.type('#f-voyage_code', 'AGENT-1');
  await page.select('#f-origin_port_id', String(portId));
  await page.$eval('#f-declared_eta', (e) => { e.value = '2026-12-05T14:30'; });
  await page.type('#f-declared_teu', '50');
  await page.type('#f-cargo_type', 'Bulk');
  await page.click('#nf button[type=submit]');
  await page.waitForSelector('#vresult');
  await page.click('#vresult [data-close]');
  await dialogClosed(page);
  assert.equal(await page.$('#que') && await page.$eval('#que', (e) => e.hidden), true, 'agents do not see the whole queue');
  await page.waitForFunction(() => [...document.querySelectorAll('#noticeList tbody tr')].some((r) => r.textContent.includes('AGENT-1') && r.textContent.includes('2026-12-05 14:30')));
  // Forced calls outside the UI are still refused by the API.
  assert.equal((await apiFetch(page, 'POST', '/api/v1/ships', { imo_number: nextImo() })).status, 403);
  const foreignId = (await q('SELECT id FROM dbo.ships WHERE imo_number = @i', { i: foreign.imo }))[0].id;
  assert.equal((await apiFetch(page, 'GET', `/api/v1/ships/${foreignId}`)).status, 404);
  await context.close();
});

test('view-only role (warehouse staff): no add or edit controls, and the API refuses forced writes', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.yard);
  assert.equal(await page.$eval('#addShip', (b) => b.hidden), true);
  assert.equal(await page.$eval('#addNotice', (b) => b.hidden), true);
  assert.equal(await page.$('[data-act=edit]'), null);
  assert.equal(await page.$$eval('#shipList thead th', (ths) => ths.some((t) => t.textContent === 'Actions')), false);
  assert.equal((await apiFetch(page, 'POST', '/api/v1/ships', { imo_number: nextImo() })).status, 403);
  assert.equal((await apiFetch(page, 'POST', '/api/v1/voyages', {})).status, 403);
  await context.close();
});

test('technician: the page is closed in the UI and the API refuses every vessel call', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await loginOk(page, users.tech);
  await page.goto(`${FRONT}/vessels.html`);
  await page.waitForSelector('#gohome');
  assert.equal(await page.$('#reg'), null, 'registry is not rendered');
  for (const [m, p] of [['GET', '/api/v1/ships'], ['GET', '/api/v1/voyages'], ['GET', '/api/v1/catalog/ports'], ['POST', '/api/v1/ships']]) {
    assert.equal((await apiFetch(page, m, p, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p}`);
  }
  await context.close();
});

test('states: empty search, loading error with Retry, and recovery', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  await searchFor(page, `no-such-vessel-${sfx}`);
  await page.waitForFunction(() => document.querySelector('#shipList').textContent.includes('Không có dữ liệu'));
  await page.setRequestInterception(true);
  let block = true;
  const handler = (r) => { if (block && r.url().includes('/api/v1/ships')) r.abort(); else r.continue(); };
  page.on('request', handler);
  await page.$eval('#shipQ', (e) => { e.value = ''; });
  await page.type('#shipQ', 'x');
  await page.waitForFunction(() => document.querySelector('#shipList').textContent.includes('Không tải được danh sách tàu'));
  block = false;
  await page.click('#shipList [data-retry=ships]');
  await page.waitForFunction(() => !document.querySelector('#shipList').textContent.includes('Không tải được') && !document.querySelector('#shipList').textContent.includes('Loading…'));
  page.off('request', handler);
  await context.close();
});

test('security: vessel names are shown as text, never as HTML (no script injection)', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const imo = nextImo();
  const evil = `<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> ${sfx}`;
  const res = await apiFetch(page, 'POST', '/api/v1/ships', { imo_number: imo, ship_name: evil, ship_type_id: typeId, length_overall_m: 100, beam_m: 20, max_draft_m: 8, deadweight_t: 1000 });
  assert.equal(res.status, 201);
  await page.reload();
  await page.waitForSelector('#reg');
  await searchFor(page, imo);
  await hasRow(page, imo);
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'no injected script ran');
  assert.ok((await page.$eval('#shipList tr[data-ship] td', (td) => td.textContent)).includes('<img src=x'), 'the markup is displayed as plain text');
  assert.equal(await page.$('#shipList img'), null);
  await context.close();
});

test('paging: ten rows per page, next and previous work and the buttons are disabled at the ends', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  for (let i = 0; i < 12; i += 1) {
    const res = await apiFetch(page, 'POST', '/api/v1/ships', { imo_number: nextImo(), ship_name: `Pg${sfx} ${String(i).padStart(2, '0')}`, ship_type_id: typeId, length_overall_m: 100, beam_m: 20, max_draft_m: 8, deadweight_t: 1000 });
    assert.equal(res.status, 201);
  }
  await searchFor(page, `Pg${sfx}`);
  await page.waitForFunction(() => document.querySelectorAll('#shipList tr[data-ship]').length === 10 && document.querySelector('#shipList .tfoot').textContent.includes('of 12'));
  assert.equal(await page.$eval('[data-pg="ship:prev"]', (b) => b.disabled), true);
  await page.click('[data-pg="ship:next"]');
  await page.waitForFunction(() => document.querySelectorAll('#shipList tr[data-ship]').length === 2);
  assert.equal(await page.$eval('[data-pg="ship:next"]', (b) => b.disabled), true);
  await page.click('[data-pg="ship:prev"]');
  await page.waitForFunction(() => document.querySelectorAll('#shipList tr[data-ship]').length === 10);
  await context.close();
});

test('session expiry while using the page sends the user to login with the expiry notice', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  await q(`UPDATE s SET revoked_at = SYSUTCDATETIME() FROM dbo.auth_sessions s JOIN dbo.auth_users u ON u.user_id = s.user_id
           WHERE u.username = @u AND s.revoked_at IS NULL`, { u: users.coord.username });
  // The click itself starts the redirect to the sign-in page, so puppeteer may report that the page context vanished while it was still clicking: that is the expected outcome here.
  await Promise.all([onPage(page, 'login.html'), page.click('#addShip').catch((e) => { if (!/Cannot find context|Execution context was destroyed|Target closed|Session closed/i.test(e.message)) throw e; })]);
  assert.ok(page.url().includes('reason=expired'));
  await context.close();
});

test('the session cookie stays HttpOnly and no vessel data is placed in storage', { skip, timeout: 60000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  assert.equal((await cookies(page)).find((c) => c.name === 'sp_session').httpOnly, true);
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  assert.ok(!stored.includes('imo_number') && !stored.includes('ship_name'));
  await context.close();
});

test('UC-013 3a: a draft is saved without validation, reloaded into the form, submitted (UC-015 runs) and a second draft can be discarded', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const v = goodShip(`E2E Draft ${sfx}`);
  await addShipUi(page, v);
  const code = `DR-${crypto.randomBytes(2).toString('hex')}`;
  await page.click('#addNotice');
  await page.waitForSelector('#nf');
  await page.type('#f-voyage_code', code); // incomplete on purpose
  await page.click('#saveDraft');
  await dialogClosed(page);
  await page.waitForFunction((c) => [...document.querySelectorAll('#draftList tr[data-draft]')].some((r) => r.textContent.includes(c)), {}, code);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyages WHERE voyage_code = @c", { c: code }))[0].n, 0, 'a draft is not a notice');
  // Edit: the form is refilled from the draft; complete it and submit.
  await page.click(`#draftList tr[data-draft] [data-act=draft-edit]`);
  await page.waitForSelector('#nf');
  assert.equal(await page.$eval('#f-voyage_code', (e) => e.value), code);
  await page.select('#f-ship_id', String((await q('SELECT id FROM dbo.ships WHERE imo_number = @i', { i: v.imo }))[0].id));
  await page.select('#f-agent_id', String(agentA));
  await page.select('#f-origin_port_id', String(portId));
  await page.$eval('#f-declared_eta', (e) => { e.value = '2026-12-03T09:00'; });
  await page.type('#f-declared_teu', '10');
  await page.type('#f-cargo_type', 'Container');
  await page.click('#nf button[type=submit]');
  await page.waitForSelector('#vresult');
  await page.click('#vresult [data-close]');
  await dialogClosed(page);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dbo.voyages WHERE voyage_code = @c", { c: code }))[0].n, 1);
  await page.waitForFunction((c) => ![...document.querySelectorAll('#draftList tr[data-draft]')].some((r) => r.textContent.includes(c)), {}, code);
  // A second draft is discarded.
  const code2 = `DR2-${crypto.randomBytes(2).toString('hex')}`;
  await page.click('#addNotice');
  await page.waitForSelector('#nf');
  await page.type('#f-voyage_code', code2);
  await page.click('#saveDraft');
  await dialogClosed(page);
  await page.waitForFunction((c) => [...document.querySelectorAll('#draftList tr[data-draft]')].some((r) => r.textContent.includes(c)), {}, code2);
  await page.click(`#draftList tr[data-draft] [data-act=draft-discard]`);
  await page.waitForFunction((c) => ![...document.querySelectorAll('#draftList tr[data-draft]')].some((r) => r.textContent.includes(c)), {}, code2);
  await context.close();
});

test('UC-020: valid notices enter the berth queue; the coordinator moves one with a reason; a stale queue is reloaded; the agent does not see the queue', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const reviewer = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id;
  const made = [];
  for (const [i, eta] of [['A', '2027-06-01T08:00:00+07:00'], ['B', '2027-06-02T08:00:00+07:00']]) {
    const imo = nextImo();
    const ship = await apiFetch(page, 'POST', '/api/v1/ships', { imo_number: imo, ship_name: `E2E Queue${i} ${sfx}`, ship_type_id: typeId, operator_agent_id: agentA, length_overall_m: 180, beam_m: 30, max_draft_m: 10, deadweight_t: 20000 });
    assert.equal(ship.status, 201);
    for (const t of ['REGISTRATION', 'INSURANCE']) {
      await q(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename, storage_key, mime_type, file_size_bytes, review_status, valid_until, reviewed_by_user_id, reviewed_at)
        VALUES (@s, @t, N'f.pdf', @k, 'application/pdf', 1000, 'APPROVED', '2035-01-01', @u, SYSUTCDATETIME())`, { s: ship.body.data.id, t, k: crypto.randomBytes(8).toString('hex'), u: reviewer });
    }
    const v = await apiFetch(page, 'POST', '/api/v1/voyages', { ship_id: ship.body.data.id, voyage_code: `Q${i}-${crypto.randomBytes(2).toString('hex')}`, agent_id: agentA, origin_port_id: portId, declared_eta: eta, declared_teu: 5, cargo_type: 'x' });
    assert.equal(v.status, 201);
    assert.equal(v.body.data.status, 'WAITING_BERTH', JSON.stringify(v.body.data.validation));
    made.push({ id: v.body.data.id, code: v.body.data.voyage_code });
  }
  await page.reload();
  await page.waitForSelector('#queueList tr[data-queue]');
  const pos = (id) => page.$eval(`#queueList tr[data-queue="${id}"] td`, (e) => Number(e.textContent));
  const [a, b] = made;
  const posA = await pos(a.id); const posB = await pos(b.id);
  assert.ok(posA < posB, 'earlier ETA is ahead');
  await page.click(`#queueList tr[data-queue="${b.id}"] [data-act=move]`);
  await page.waitForSelector('#qf');
  await page.$eval('#f-to_position', (e) => { e.value = ''; });
  await page.type('#f-to_position', String(posA));
  await page.click('#qf button[type=submit]'); // no reason
  await page.waitForFunction(() => document.querySelector('#e-reason').textContent.length > 0);
  await page.type('#f-reason', 'Ưu tiên theo điều phối');
  await page.click('#qf button[type=submit]');
  await dialogClosed(page);
  assert.equal(await pos(b.id), posA);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: b.id }))[0].n, 1);
  // UC-020 6a in the browser: someone else changes the queue while this view is open, so the next move is refused (409) and the queue is reloaded.
  // Since A2 an open queue refreshes itself when another user moves a voyage, so the stale view of 6a is produced the way it happens for real: the refresh hint
  // is lost (a hint is not proof of delivery). This page's refresh channel is closed before the other coordinator moves the voyage.
  await page.evaluate(() => { BP.s.es.close(); });
  const before = await apiFetch(page, 'GET', '/api/v1/voyages/queue');
  const staleText = await page.$eval('#queueList .tfoot', (e) => e.textContent);
  const otherMove = await apiFetch(page, 'PATCH', `/api/v1/voyages/${a.id}/queue-position`, { to_position: posA, reason: 'Điều phối viên khác' }, { 'If-Match': `"${before.body.data.revision}"` });
  assert.equal(otherMove.status, 200);
  await page.click(`#queueList tr[data-queue="${b.id}"] [data-act=move]`);
  await page.waitForSelector('#qf');
  await page.$eval('#f-to_position', (e) => { e.value = ''; });
  await page.type('#f-to_position', String(posA + 1));
  await page.type('#f-reason', 'Thử với hàng đợi cũ');
  await page.click('#qf button[type=submit]');
  await dialogClosed(page);
  await page.waitForFunction(() => { const b = document.querySelector('#banner'); return !b.hidden && b.textContent.includes('vừa được người khác thay đổi'); });
  await page.waitForFunction((t) => document.querySelector('#queueList .tfoot') && document.querySelector('#queueList .tfoot').textContent !== t, {}, staleText);
  assert.equal(await pos(a.id), posA, 'the view was reloaded with the other coordinator\'s order');
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyage_queue_changes WHERE voyage_id = @v', { v: b.id }))[0].n, 1, 'the refused move wrote nothing');
  await context.close();

  const { page: ap, context: ac } = await newPage();
  await openVessels(ap, users.agent, 'vessels.html');
  assert.equal(await ap.$eval('#que', (e) => e.hidden), true);
  assert.equal((await apiFetch(ap, 'GET', '/api/v1/voyages/queue')).status, 403);
  await ac.close();
});

test('UC-021: the schedule lists voyages with berth, ATA and ATD, filters by berth and agent, draws a Gantt bar at the stored times, and is closed to agents', { skip, timeout: 120000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  const reviewer = (await q('SELECT user_id FROM dbo.auth_users WHERE username = @u', { u: users.coord.username }))[0].user_id;
  const berthCode = `EB${sfx}A`;
  const berthId = (await q(`INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes) OUTPUT inserted.id VALUES (@c, N'Bến E2E', 'CONTAINER', 300, 12, 2)`, { c: berthCode }))[0].id;
  const ship = await apiFetch(page, 'POST', '/api/v1/ships', { imo_number: nextImo(), ship_name: `E2E Sched ${sfx}`, ship_type_id: typeId, operator_agent_id: agentA, length_overall_m: 180, beam_m: 30, max_draft_m: 10, deadweight_t: 20000 });
  assert.equal(ship.status, 201);
  const mkVoyage = async (code, eta) => (await apiFetch(page, 'POST', '/api/v1/voyages', { ship_id: ship.body.data.id, voyage_code: code, agent_id: agentA, origin_port_id: portId, declared_eta: eta, declared_teu: 5, cargo_type: 'x' })).body.data;
  const planned = await mkVoyage('SCH-P', '2026-01-10T07:00:00+07:00');
  const unplanned = await mkVoyage('SCH-N', '2026-01-10T15:00:00+07:00');
  // Approved plan 08:00-20:00 (UTC+7) on the test berth. Module 2 does not exist yet, so the fixture is inserted directly.
  await q(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json,
      submitted_by_user_id, submitted_at, approved_by_user_id, approved_at) VALUES (@v, @b, 'APPROVED', 'MANUAL', 0, 100, '2026-01-10T01:00:00Z', '2026-01-10T13:00:00Z', 1, 0, N'TEST', N'{"passed":true}', @u, SYSUTCDATETIME(), (SELECT TOP 1 user_id FROM dbo.auth_users WHERE user_id <> @u ORDER BY user_id), SYSUTCDATETIME())`, { v: planned.id, b: berthId, u: reviewer });
  const only = async (sel, value) => { await page.select(sel, String(value)); await waitList(page, '#schBody'); };
  await page.reload();
  await page.waitForSelector('#sch');
  await page.waitForFunction((n) => document.querySelectorAll('#schBerth option').length > 1 && [...document.querySelectorAll('#schBerth option')].some((o) => o.textContent.includes(n)), {}, berthCode);
  await only('#schAgent', agentA);
  await page.waitForFunction(() => [...document.querySelectorAll('#schBody tr[data-sched]')].length >= 2);
  const row = (code) => page.$$eval('#schBody tr[data-sched]', (rs, c) => (rs.find((r) => r.textContent.includes(c)) || {}).textContent, code);
  assert.ok((await row('SCH-P')).includes(berthCode), 'berth comes from the approved plan');
  assert.ok(!(await row('SCH-N')).includes(berthCode));
  // AC-1: filter by berth returns only the planned voyage; a berth with no match shows the empty state.
  await only('#schBerth', berthId);
  await page.waitForFunction(() => document.querySelectorAll('#schBody tr[data-sched]').length === 1);
  assert.ok((await row('SCH-P')).length > 0);
  await only('#schStatus', 'DEPARTED');
  await page.waitForFunction(() => document.querySelector('#schBody').textContent.includes('Không có dữ liệu'));
  await only('#schStatus', '');
  // AC-2: the Gantt bar equals the stored plan (08:00-20:00 on 2026-01-10 in UTC+7 = 33.33% and 50% of the day).
  await only('#schBerth', '');
  await page.click('[data-sv=gantt]');
  await page.$eval('#schDate', (e) => { e.value = '2026-01-10'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector(`.tlr[data-lane="${berthId}"] .blk`);
  const bar = await page.$eval(`.tlr[data-lane="${berthId}"] .blk`, (e) => ({ left: parseFloat(e.style.left), width: parseFloat(e.style.width), title: e.title }));
  assert.ok(Math.abs(bar.left - 33.3333) < 0.01 && Math.abs(bar.width - 50) < 0.01, JSON.stringify(bar));
  assert.ok(bar.title.includes('2026-01-10 08:00') && bar.title.includes('2026-01-10 20:00'), bar.title);
  const marker = await page.$eval('.tlr[data-lane="0"] .blk', (e) => ({ left: parseFloat(e.style.left), cls: e.className }));
  assert.ok(Math.abs(marker.left - 62.5) < 0.01 && marker.cls.includes('st-eta'), JSON.stringify(marker)); // 15:00 = 62.5% of the day
  // The lifecycle opens from a bar.
  await page.click(`.tlr[data-lane="${berthId}"] .blk`);
  await page.waitForSelector('#vlife');
  assert.ok((await page.$eval('#vlife', (e) => e.textContent)).includes('Lifecycle'));
  await page.click('#vlife [data-close]');
  await dialogClosed(page);
  // A week view still shows it, and a window with nothing in it shows the empty state.
  await page.click('[data-sw=week]');
  await page.waitForSelector(`.tlr[data-lane="${berthId}"] .blk`);
  await page.$eval('#schDate', (e) => { e.value = '2030-01-01'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#schBody').textContent.includes('Không có dữ liệu'));
  assert.equal((await q('SELECT COUNT(*) AS n FROM dbo.voyages WHERE id IN (@a, @b)', { a: planned.id, b: unplanned.id }))[0].n, 2);
  await context.close();

  // Agents do not see the schedule, and the API refuses them.
  const { page: ap, context: ac } = await newPage();
  await openVessels(ap, users.agent, 'vessels.html');
  assert.equal(await ap.$eval('#sch', (e) => e.hidden), true);
  assert.equal((await apiFetch(ap, 'GET', '/api/v1/voyages/schedule')).status, 403);
  await ac.close();
});

test('UC-021 5a: a schedule load error shows a message with Retry, shows no partial data, and recovers', { skip, timeout: 90000 }, async () => {
  const { page, context } = await newPage();
  await openVessels(page, users.coord);
  await page.waitForFunction(() => !document.querySelector('#schBody').textContent.includes('Loading…'));
  await page.setRequestInterception(true);
  let block = true;
  const handler = (r) => { if (block && r.url().includes('/api/v1/voyages/schedule')) r.abort(); else r.continue(); };
  page.on('request', handler);
  await page.select('#schStatus', 'BERTHED');
  await page.waitForFunction(() => document.querySelector('#schBody').textContent.includes('Không tải được lịch tàu'));
  assert.equal(await page.$('#schBody tr[data-sched]'), null, 'no rows are shown as if complete');
  block = false;
  await page.click('#schBody [data-retry=schedule]');
  await page.waitForFunction(() => { const t = document.querySelector('#schBody').textContent; return !t.includes('Không tải được') && !t.includes('Loading…'); });
  page.off('request', handler);
  await context.close();
});
