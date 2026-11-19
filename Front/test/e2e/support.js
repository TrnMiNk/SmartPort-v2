'use strict';

// Shared set-up for the browser end-to-end tests: starts the real API (child process) on SQL Server, the static
// frontend server and a headless browser, creates throwaway users and removes them at the end.
// Needs a disposable, migrated and seeded SmartPort V2 database in SP_E2E_DB and an installed Chrome or Edge.
//   SP_E2E_DB=SmartPortV2_Verify2 npm run test:e2e
// Without SP_E2E_DB the suites are "not executed"; without a browser they are "unavailable". Passwords are random per
// run and never printed. Defaults avoid a running dev stack; use SP_E2E_API_PORT=3000 SP_E2E_FRONT_PORT=5500 to test
// the real default configuration (js/config.js on disk and the API default CORS origin).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DB = process.env.SP_E2E_DB;
const API_DIR = path.resolve(__dirname, '..', '..', '..', 'API');
const API_PORT = Number(process.env.SP_E2E_API_PORT || 3101);
const FRONT_PORT = Number(process.env.SP_E2E_FRONT_PORT || 5601);
const USE_DEFAULT_CONFIG = API_PORT === 3000 && FRONT_PORT === 5500;
const FRONT = `http://localhost:${FRONT_PORT}`;
const API = `http://localhost:${API_PORT}`;
const API_LOOPBACK = `http://127.0.0.1:${API_PORT}`;

function findBrowser() {
  return [
    process.env.SP_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean).find((p) => fs.existsSync(p));
}

const browserPath = findBrowser();
const skip = !DB ? 'SP_E2E_DB not set: browser e2e not executed'
  : !browserPath ? 'unavailable: no Chrome or Edge found (set SP_BROWSER)' : false;

const SUFFIX = crypto.randomBytes(3).toString('hex');
const mkUser = (key, displayName, roles, agentId = null) => ({
  username: `e2e_${key}_${SUFFIX}`, displayName, roles, agentId, password: crypto.randomBytes(12).toString('base64url'),
});

const state = { browser: null, apiProc: null, frontServer: null, db: null, apiLog: '' };

// `prepare(db)` runs after the database is open and before users are created, so a suite can insert the catalog rows
// its users need (for example an agent to link an agent account to).
async function start(users, prepare) {
  if (skip) return;
  const puppeteer = require('puppeteer-core');
  const { loadConfig } = require(path.join(API_DIR, 'src', 'config'));
  const { createPool } = require(path.join(API_DIR, 'src', 'db', 'connection'));
  const { createUser } = require(path.join(API_DIR, 'src', 'services', 'userProvisioning'));

  const { sql, connect } = createPool(loadConfig({ SP_DB_NAME: DB }).db);
  state.db = { sql, pool: await connect() };
  if (prepare) await prepare(state.db);
  for (const u of Object.values(users)) {
    await createUser(state.db, { username: u.username, displayName: u.displayName, password: u.password, roleCodes: u.roles, agentId: u.agentId });
  }

  state.apiProc = spawn(process.execPath, ['src/server.js'], {
    cwd: API_DIR,
    env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16', SP_DB_NAME: DB, SP_PORT: String(API_PORT), SP_HOST: '127.0.0.1', SP_CORS_ORIGIN: FRONT, SP_COOKIE_SECURE: 'false' },
  });
  state.apiProc.stdout.on('data', (d) => { state.apiLog += d; });
  state.apiProc.stderr.on('data', (d) => { state.apiLog += d; });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${API_LOOPBACK}/api/v1/health`)).ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
    if (i === 59) throw new Error('API did not start: ' + state.apiLog);
  }

  const { createServer } = require('../../scripts/serve');
  state.frontServer = createServer(USE_DEFAULT_CONFIG ? {} : { apiBaseUrl: API });
  await new Promise((r) => state.frontServer.listen(FRONT_PORT, '127.0.0.1', r));
  state.browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}

// `cleanup(db)` lets a suite remove its own data first (rows that reference the users or catalogs it created).
async function stop(users, cleanup) {
  if (state.browser) await state.browser.close();
  if (state.frontServer) await new Promise((r) => state.frontServer.close(r));
  if (state.apiProc) state.apiProc.kill();
  if (!state.db) return;
  if (cleanup) await cleanup(state.db);
  for (const u of Object.values(users)) {
    const r = await state.db.pool.request().input('u', state.db.sql.NVarChar(100), u.username).query('SELECT user_id FROM dbo.auth_users WHERE username = @u');
    if (r.recordset[0]) {
      await state.db.pool.request().input('id', state.db.sql.BigInt, r.recordset[0].user_id).query(`
        DELETE FROM dbo.notifications WHERE recipient_user_id = @id; DELETE FROM dbo.voyage_drafts WHERE owner_user_id = @id; DELETE FROM dbo.auth_sessions WHERE user_id = @id; DELETE FROM dbo.auth_user_roles WHERE user_id = @id;
        DELETE FROM dbo.auth_user_agents WHERE user_id = @id; DELETE FROM dbo.auth_users WHERE user_id = @id;`);
    }
  }
  await state.db.pool.close();
}

async function newPage() {
  const context = await state.browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1280, height: 800 });
  const requests = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  // Diagnostics for intermittent failures: console errors, uncaught page errors, failed requests and HTTP errors, with the time since the page was
  // opened. Printed with the failure message (see signIn and diagnostics()), never used to retry.
  const t0 = Date.now(); const diag = [];
  const note = (kind, text) => { diag.push(`+${Date.now() - t0}ms ${kind} ${text}`); if (diag.length > 60) diag.shift(); };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') note(`console.${m.type()}`, m.text().slice(0, 200)); });
  page.on('pageerror', (e) => note('pageerror', String(e.message || e).slice(0, 300)));
  page.on('requestfailed', (r) => note('requestfailed', `${r.method()} ${r.url()} ${(r.failure() || {}).errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/v1/')) note('http' + r.status(), r.url()); });
  page.diag = diag;
  // DOM lifecycle: record when the lists are re-drawn (their children replaced), so a "Node is detached" failure can be matched to a redraw.
  await page.evaluateOnNewDocument(() => {
    window.__draws = [];
    const t0 = performance.now();
    const watch = () => {
      for (const id of ['planList', 'queueList', 'berthList', 'schBody']) {
        const el = document.getElementById(id);
        if (el && !el.__watched) {
          el.__watched = true;
          new MutationObserver(() => { window.__draws.push(`+${Math.round(performance.now() - t0)}ms ${id} redrawn (${el.querySelectorAll('tr').length} rows)`); if (window.__draws.length > 40) window.__draws.shift(); }).observe(el, { childList: true });
        }
      }
    };
    new MutationObserver(watch).observe(document, { childList: true, subtree: true });
  });
  return { page, context, requests };
}

// Click an element that a live list may re-draw. A detached-node failure now carries the page diagnostics and the redraw log.
async function clickChecked(page, selector) {
  try { await page.waitForSelector(selector); await page.click(selector); } catch (e) {
    throw new Error(`${e.message} selector=${selector} ${await diagnostics(page)}`);
  }
}

// Click an element that must be visible; a failure carries what the dialog and the element looked like (for intermittent "not clickable" failures).
async function clickVisible(page, selector) {
  try { await page.waitForSelector(selector, { visible: true }); await page.click(selector); } catch (e) {
    const info = await page.evaluate((sel) => { const el = document.querySelector(sel); const r = el && el.getBoundingClientRect(); const d = el && el.closest('dialog');
      return { found: !!el, rect: r && [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], dialogs: document.querySelectorAll('dialog').length, dialogOpen: d ? d.open : null, dialogHtmlLen: d ? d.innerHTML.length : null, ready: document.readyState }; }, selector).catch((x) => ({ unreadable: x.message }));
    throw new Error(`${e.message} selector=${selector} ${JSON.stringify(info)} ${await diagnostics(page)}`);
  }
}

// What the page looks like right now plus the collected diagnostics (for failure messages).
async function diagnostics(page) {
  const dom = await page.evaluate(() => ({
    url: location.href, ready: document.readyState, bodyChildren: document.body ? document.body.children.length : -1,
    text: document.body ? document.body.innerText.slice(0, 120) : '',
    scripts: [...document.scripts].map((s) => s.src.split('/').slice(-2).join('/')).filter(Boolean).join(','),
    draws: window.__draws || [],
    globals: ['$', 'SP_AUTH', 'SP_CONFIG', 'ic'].map((g) => `${g}=${typeof window[g] === 'undefined' ? 'missing' : 'ok'}`).join(' '),
  })).catch((e) => ({ unreadable: String(e.message) }));
  return JSON.stringify({ dom, events: page.diag || [] });
}

const onPage = (page, name) => page.waitForFunction((n) => location.pathname.endsWith(n), {}, name);

async function signIn(page, user, password = user.password) {
  await page.goto(`${FRONT}/login.html`);
  // The sign-in form was once missing right after goto() in a full run ("No element found for selector: #le"). Wait for it, and if it
  // is still missing say where the page is, so a recurrence can be diagnosed instead of retried.
  try { await page.waitForSelector('#le', { timeout: 10000 }); } catch (e) {
    throw new Error('sign-in form missing: ' + await diagnostics(page));
  }
  await page.type('#le', user.username);
  await page.type('#lp', password);
  await page.click('#lsub');
}

async function loginOk(page, user, landing = 'overview.html') {
  await signIn(page, user);
  // If the sign-in does not complete, say what the page and the API process show instead of a bare timeout.
  try { await onPage(page, landing); await page.waitForSelector('#meName'); } catch (e) {
    const msg = await page.evaluate(() => { const m = document.querySelector('#lmsg'); return m && !m.hidden ? m.textContent : ''; }).catch(() => '(page not readable)');
    throw new Error(`sign-in did not complete (${String(e.message).slice(0, 80)}): page message=${JSON.stringify(msg)} apiLogTail=${JSON.stringify(state.apiLog.slice(-300))} ${await diagnostics(page)}`);
  }
}

async function cookies(page) {
  const client = await page.createCDPSession();
  return (await client.send('Network.getAllCookies')).cookies;
}

module.exports = {
  skip, SUFFIX, FRONT, API, API_LOOPBACK, mkUser, start, stop, newPage, onPage, signIn, loginOk, cookies, diagnostics, clickChecked, clickVisible,
  db: () => state.db,
};
