# Evidence: B2 performance (50 users), B6 security, harness resources (2026-11-19)

Databases: `SmartPortV2_LoadB2` (new, disposable, for the load test), `SmartPortV2_VerifyFinal` and `...VerifyFinalMig` (isolated verification). `SmartPortV2_DemoFinal` and all earlier databases were not touched. No registry, TCP or system setting was changed. Suites ran one after the other.

## 1. Windows socket pressure (Phase 2)
| Observation | Result |
|---|---|
| Processes before, during and after a browser E2E run (sampled every 3 s) | msedge 5 to 14 and back to 5; node 5 to 8 and back to 5. No process is left behind: **no leak in the harness** |
| TCP during 31 browser tests | Established stays at 44 to 74; TIME_WAIT grows about 10 per second (747 after 70 s) and decays afterwards; shares: front server port about 33%, API port about 42%, the rest browser debugging and other loopback traffic. This is connection churn from many short-lived browser contexts (each context opens fresh connections; the servers answer `Cache-Control: no-store`), not an accumulation of open sockets |
| Limits | dynamic port range 16384; peak TIME_WAIT seen 1190 (about 7%): **ports were not exhausted** |
| Host | 16 logical CPUs, 16 GB RAM with only 2.7 GB free before any test, non-paged pool about 919 MB, paged pool 765 MB |
| The failing request | `net::ERR_NO_BUFFER_SPACE` (Windows WSAENOBUFS) on `GET /js/icons.js` during a sign-in page load (chain of 2026-11-19, `docs/testing/a3-chart-evidence.md` §6) |
Reading: the error is raised by the operating system's socket layer, the machine is under memory and non-paged-pool pressure, and the harness neither leaks processes nor exhausts ports. That is **consistent with** a host-level buffer shortage but **not proven** (no kernel pool tracing was done, and the system limits were deliberately not changed). It is not classified as an application defect: no application code is on the failing path (a static file request). Harness change: none was justified by the evidence (no leak found). Mitigations available without touching the system: fewer browser contexts per test, or running E2E on a machine with more free memory; not done.

## 2. B2: what the SRS requires and what was tested
NFR-PER-07: "serve at least 50 users at the same time; usual operations (look-ups, saving a form) answer in at most 3 seconds". The SRS names no percentile, so this report gives p50, p95, p99 and the maximum, counts every request above 3 s, and treats the requirement as met only if **no** request of a usual operation exceeded 3000 ms and none failed. (Assumption PF-1; the owner may relax it to a percentile.)
Tool: `API/scripts/load-test.js` (no new dependency). It creates 50 real users (agents 20, coordinators 15, managers 5, yard 10; 5 agent organisations, 120 ships with documents, 3 berths), starts the API as a **separate process**, signs all 50 in at once (real login, real cookies), opens the refresh channels as the browser does (80 SSE connections), then every user loops over the screens of their role: look-ups (voyage list, ships, schedule, queue, berth status, plans, chart, notifications, session), and safe state changes (arrival notice with validation and queueing, UC-026 placement check, cargo hazard save, manual queue move with revision check). Phase A is a steady workload with think time 0.5 to 1.5 s for 60 s; phase B has no think time for 30 s (stress). Eight authorization refusals are checked first. Afterwards: consistency checks, then the run's own rows are removed.
Command: `SP_DB_NAME=SmartPortV2_LoadB2 node scripts/load-test.js --confirm-disposable --users 50 --seconds 60 --burst-seconds 30 --out <file.json>` (the database must be new, empty, migrated and seeded; refuses other names).
What this is: 50 independent signed-in **HTTP** sessions against one API process and one SQL Server on **one machine** (client, API and database share 16 cores). What it is not: a full-browser test, a network test, a multi-process or production-host test.

## 3. B2 results (JSON of each run in `docs/testing/load-results/`)
| Run | Users | Login (all at once) | Phase A steady | Phase B stress |
|---|---|---|---|---|
| 1 (before the fix, sync scrypt) | 50 | **p50 1499 ms, max 1510 ms (all 50 answered together)** | 3000 req, 48.9 req/s, 0 failed, p50 10 / p95 37 / p99 233 / max 613 ms, 0 over 3 s | 12066 req, 400.9 req/s, 0 failed, p50 118 / p95 184 / p99 234 / max 341 ms |
| 2 (after the fix, final code) | 50 | **p50 294 ms, max 307 ms** | 3003 req, 49.1 req/s, 0 failed, p50 12 / p95 42 / p99 108 / max 270 ms, 0 over 3 s | 12106 req, 402.3 req/s, 0 failed, p50 120 / p95 176 / p99 214 / max 329 ms, 0 over 3 s |
| 3 (headroom only) | 100 | max 602 ms | 3968 req, 96 req/s, 0 failed, p99 195 / max 359 ms | 7871 req, 390 req/s, 0 failed, p50 249 / p95 344 / p99 401 / max 551 ms |
Per operation (run 2, phase A, ms p50 / p95 / p99 / max): arrival notice save + validate + queue 40 / 126 / 562 / 613 (120 notices, all 201); placement check 13 / 28 / 42 / 66; cargo hazard save 12 / 24 / 35 / 36; queue move 13 / 26 / 35 / 35 (41 moves, conflicts answered 409 as designed); lists and look-ups 7 to 12 / 18 to 26 / up to 280 / up to 290. All other operations are in the JSON.
Authorization: all eight refusals returned the expected status (401 without or with a bad session; 403 for agent on berth plans and the berth channel, coordinator on approval, yard on notices, manager on queue moves, an agent submitting for another agent's ship). SSE: 80 of 80 channels opened, thousands of refresh hints delivered.
SQL Server: 0 deadlocks in every run; lock waits 1079 totalling 5.2 s over the whole 90 s run (run 2). The counter "lock timeouts" rose by about 900 per run: it also counts zero-wait lock attempts (the ETA worker polls with READPAST and UPDLOCK), so it is **not** read as application failures (no request failed).
Resources (sampled every 2 s, run 2): API process up to 195% CPU of one core at peak in the stress phase (about 30 to 45% in phase A), 248 MB working set; SQL Server working set 348 MB; whole-machine CPU at most 57%; free RAM never below 1.4 GB; TIME_WAIT at most 236, established at most 584.
Consistency after each run: `check-consistency.js` 9 of 9; 120 voyages created = 120 notices accepted (201); 0 voyages without history; 0 duplicate voyage codes; 120 validation runs.
**Verdict:** under this test (50 users, mixed Module 1 and 2 workload, one machine, one API process) the requirement was met: **0 failures and 0 requests above 3 s**, slowest 613 ms (steady) and 341 ms (stress); even 100 users stayed below 0.6 s. The result says nothing about browser rendering time, a network, several API processes, a larger data volume (the database held about 120 voyages) or a different host.

## 4. Defect found by the load test and fixed
Sign-in used `crypto.scryptSync`: 50 simultaneous sign-ins blocked the event loop and all answered after about 1.5 s (100 would reach about 3 s), stalling every other request meanwhile. The login path now uses the asynchronous scrypt (thread pool): 50 sign-ins answer in 0.3 s, 100 in 0.6 s. Same hash format and verification; unit test added (agreement with the sync check and a non-blocking event loop). Severity: Medium (performance, availability under a login burst).

## 5. B6: security verification
HTTP on loopback unless stated. All checks below are automated in `security.http.test.js`, `security.https.test.js`, `security.e2e.test.js` and `config.test.js`, plus `npm audit`.
| # | Check | Result |
|---|---|---|
| 1 | `npm audit` API and Frontend (registry reachable) | 0 vulnerabilities in both; no dependency was changed |
| 2 | Authentication, lock, expiry | existing tests: lock after 5 failures, uniform error, sliding 30-minute expiry (tested by setting the stored expiry, **not** by waiting 30 real minutes), logout kills the token; new: each login gets a new token (no fixation), a copied cookie dies at logout while another session of the user lives, the raw token is never in a body or stored (only its hash) |
| 3 | RBAC | every route family of Modules 1 and 2 refused to each role that may not use it (403) and to anonymous users (401); the 8 load-test refusals; denial audited; server-side (the menu hiding is only usability) |
| 4 | SQL injection | six payloads (quote, UNION, stacked statements, WAITFOR, xp_cmdshell) in login, search, filters, ids, page and stored text: no 500, bounded lists, no delay, tables intact, stored as text and read back identical. Code review of every `${}` inside SQL: only constant fragments, allow-listed column names and `@parameter` lists; all request values are bound parameters. **No finding** |
| 5 | XSS | browser test: hostile text in ship name, cargo, berth name, maintenance reason, override reason, rejection reason and voyage code shown as text on the lists, chart (tooltips, labels), berth detail, lifecycle and plan review dialogs and notices, for coordinator and manager: nothing ran, no element or event attribute was created. **No finding** (the screens escape every field) |
| 6 | CSRF | session cookie `SameSite=Lax`; every state change is a POST/PUT/PATCH/DELETE with a JSON body; a cross-site form (text/plain, urlencoded, multipart) with a valid cookie is refused (400/415) and creates nothing; GET requests have no side effects; CORS allows only the exact configured origin with credentials (other origins, `null`, look-alike hosts get no CORS headers and no preflight approval). **No finding** under the current design; the protection rests on Lax plus JSON-only bodies |
| 7 | Input validation and limits | body over 100 kB gives 413 in the error contract, malformed or deeply nested JSON 400, page size over 100 or negative 400, unknown fields 400, errors carry no SQL, stack or paths. **Not present: a general rate limit** (only the sign-in lock): Low/Medium, production-dependent (reverse proxy) |
| 8 | Cookie attributes | `sp_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age 1800 and `Secure` when configured (default is secure); `sp_auth` is a readable non-secret presence marker (documented design) |
| 9 | HTTPS | local TLS proxy with a throw-away self-signed certificate, pinned (checking never disabled): TLS 1.2 or newer negotiated, cookies `Secure; HttpOnly; SameSite=Lax`, session works over TLS, an untrusted certificate is refused, plain HTTP gets nothing from the TLS port, TLS 1.1 refused. **Not tested:** a browser with Secure cookies, HSTS, certificate management, a production proxy |
| 10 | Secrets in logs | the API process output after sign-ins (right and wrong password), bad requests and an injection id contains no password, token, cookie, hash or SQL text |
| 11 | CORS and production configuration | single exact origin; new guard: with `NODE_ENV=production` the API refuses to start with `SP_COOKIE_SECURE=false` or a non-https `SP_CORS_ORIGIN` (unit test); `SP_COOKIE_SECURE` defaults to true; the API binds to loopback by default |
Findings (none High):
- **B6-1 Medium, fixed:** blocking password hashing (section 4).
- **B6-2 Low, fixed:** production could start with an insecure cookie or an http origin; now refused.
- **B6-3 Medium, open, SRS NFR-SEC-06:** sensitive data is **not encrypted at rest** (both databases report `is_encrypted = 0`; no column encryption). Needs a deployment decision (SQL Server TDE or Always Encrypted); not changed here.
- **B6-4 Low, open (production):** no general rate limit; no Content-Security-Policy or HSTS headers (the API sends nosniff and no-referrer; HSTS and CSP belong to the TLS proxy and the web host); the repository's static server is a development server.
- **B6-5 Info, deviation:** SRS says JWT; the system uses opaque server-side sessions in an HttpOnly cookie (revocable at once). MFA is shown on the sign-in page but not enforced.
- Account lock can be used to lock someone out (inherent to NFR-SEC-05, 15-minute lock).
This is a focused review, not a penetration test; the result is "no High finding in what was tested" (NFR-SEC-01's criterion), not a proof of absence.

## 6. Test changes made because of failures seen during this slice
Chart test: a click on the dialog's Close button failed intermittently (2 of 6 chains plus 1 of 14 isolated runs before the fix) because the dialog grows when the server's check result arrives and pushed the button below the 800 px viewport at that moment (evidence: button rect at y=813, found, dialog open); the test now waits for the result first; 14 of 14 isolated runs passed afterwards. Session-expiry test: the click starts the redirect, so puppeteer sometimes reported the vanished page context; that specific error is now the expected outcome while the redirect is still asserted. `support.js` gained `clickVisible` (diagnostics on failure).

## 7. Final regression (sequential)
| Suite | Result |
|---|---|
| API unit | passed 126 of 126 |
| SQL integration (includes `security.http`, `security.https`, `berth-chart`, migrations) | passed 211 of 211 |
| Frontend unit | passed 60 of 60 |
| Load test, final code, 50 users | login max 317 ms; steady 3013 requests, 0 failed, 0 over 3 s, max 236 ms; stress 14569 requests (485 req/s), 0 failed, max 217 ms; 8 of 8 refusals; 9 of 9 consistency checks (`load-results/b2-run4-final.json`) |
| Browser E2E complete suite, chain A | 59, 58 (chart Close button: dialog grew under the click), 58 (session-expiry click raced the redirect) |
| chain B | 59, 59, 58 (`vessels.e2e` paging test: sign-in did not complete within 15 s; no diagnostics existed then, cause unknown) |
| chain C (final code: waits fixed, sign-in diagnostics added) | **59, 59, 59** |
Reading: the two failures of chain A had demonstrated causes in the tests (a layout shift under a click; a click that starts a redirect) and were fixed; 14 of 14 isolated runs of the chart test and the session-expiry file passed afterwards. The chain B failure at sign-in has an **unknown cause** (the page and API log were not captured then; `loginOk` now reports them); together with the earlier blank-page recurrence it keeps the intermittent sign-in failures **unresolved** (about 2 in 27 complete suites over this slice, on a host that is short of memory). The last three complete runs were clean, which does not prove stability.
