# Evidence: role-based menus, UC-002 4a, vessel registry and arrival notices (UC-001, 002, 010, 011, 013)

Date: 2026-11-18. Environment: Windows 11, Node 24.14.0, SQL Server 16 (local), disposable database `SmartPortV2_Verify2` (migrated, seeded with `npm run seed`), headless Microsoft Edge via `puppeteer-core` 25.18.1. Status legend (rule 07): passed, failed, not executed, unavailable. The earlier evidence for UC-001 and UC-002 is in `docs/testing/uc001-uc002-evidence.md`; this file supersedes its open items.

## 1. Commands and results

| Suite | Command | Result |
|---|---|---|
| API unit | `cd API && npm run test:unit` | **passed** 41 of 41 |
| API integration (real SQL Server) | `cd API && SP_DB_NAME=SmartPortV2_Verify2 SP_TEST_DB=SmartPortV2_Verify2 npm run test:integration` | **passed** 59 of 59 (schema 16, auth 18, vessels and notices 22, seed encoding 3) |
| Front unit | `cd Front && npm test` | **passed** 46 of 46 |
| Browser e2e on the default ports (Front 5500, API 3000, `js/config.js` from disk) | `cd Front && SP_E2E_API_PORT=3000 SP_E2E_FRONT_PORT=5500 SP_E2E_DB=SmartPortV2_Verify2 npm run test:e2e` | **passed** 31 of 31 (auth 14, vessels 17) |
| Real start of both servers | API: `SP_DB_NAME=... SP_COOKIE_SECURE=false node src/server.js`; Front: `node scripts/serve.js` | **passed**: `config.js` points to port 3000; `/health` ok; preflight allows only `http://localhost:5500`; another origin is not allowed; `GET /ships` without a session returns 401 |
| Residue after the runs | SQL count of test users, agents, ships, voyages | 0, 0, 0, 0 |

Stability: the auth e2e file was run 12 more times after the last change with 0 failures. Before that change one test (UC-002 4a, "offline notice") failed in 2 of about 30 runs (§5).

## 2. UC-001 (login and menu by role)

| Criterion | Test | Status |
|---|---|---|
| AC-1 Only the menu the role is allowed | `auth.e2e`: each role sees only the menu the SRS matrix allows (technician, administrator, port management, warehouse staff, coordinator, agent) and lands on its first page; "Access not permitted" for a closed page. `permissions.test.js`: the matrix equals the SRS table for all 5 internal roles and 9 features, agent limited, default deny. `auth.http`: `me` and login return permissions per role. Backend: `vessels.http` authorization matrix (technician 403 on every vessel call, warehouse staff and port management read-only, administrator read-only, agent own records only, anonymous 401) with denied attempts audited | **passed** |
| AC-2 Locked after exactly five consecutive failures, for 15 minutes | `auth.http`: lock policy (fifth failure locks, `locked_until` between 14 and 15 minutes ahead; after the lock ends the count restarts and five more failures lock again; a correct password after the lock signs in and resets the counter); `auth.e2e`: five wrong passwords lock the account in the UI | **passed** |
| AC-3 Same message for wrong password and unknown user | `auth.http`, `auth.e2e` | **passed** |
| AC-4 Password never stored, logged or returned | `security.test.js`, `auth.http`, `auth.e2e` (HttpOnly cookie, no secret in page or storage) | **passed** |

Exception and alternative flows covered: wrong credentials, locked account, inactive account, empty form (no request sent), server unreachable, protected page without a session, second login while signed in.
Authorization denial: not applicable to login itself (public endpoint).

## 3. UC-002 (logout, session expiry)

| Criterion | Test | Status |
|---|---|---|
| AC-1 Old token refused after logout | `auth.http`, `auth.e2e` (replay of the captured cookie, with the presence marker, returns 401) | **passed** |
| AC-2 Forged token refused | `auth.http` (forged token with the marker; token without the marker) | **passed** |
| AC-3 Idle expiry after 30 minutes, sliding | `auth.http`: expired session refused; accepted request extends expiry to about 30 minutes; both cookies re-issued with `Max-Age=1800` on every accepted request | **passed**; limit: expiry simulated by stored timestamps, no real 30-minute wait |
| AC-4 Back to login after logout | `auth.e2e` (also at 390 px) | **passed** |
| Alternative flow 4a: token cannot be revoked because of a network error, the browser session is cleared and the token expires by time | `auth.test.js`: network error and 5xx clear the marker and redirect; client error (403) does not. `auth.http`: a valid token without the marker is refused, with the marker it is still valid (server session not revoked). `auth.e2e`: DELETE blocked, the browser lands on login with the offline notice, `sp_auth` is gone, the API answers 401 to this browser, the old token is still valid server-side when replayed with the marker | **passed** |

Specification step 2 (confirm sign-out with unsaved data): not applicable, no editable form with unsaved data on a dashboard page. Not tested.

## 4. UC-010, UC-011, UC-013

### UC-010 (create vessel)

| Criterion or flow | Test | Status |
|---|---|---|
| AC-1 No two vessels with one IMO | `vessels.http` duplicate (409 with field, audited as FAILED) and simultaneous creates (exactly one); `vessels.e2e` duplicate IMO shows the error under the IMO field | **passed** |
| AC-2 Errors in Vietnamese, clear, per field | `vessels.http` invalid input, unknown fields, unknown references; `vessels.validation` (IMO 7 digits, dimensions, boundaries); `vessels.e2e` empty form shows every field error, marks fields, focuses the first | **passed** |
| AC-3 Valid vessel saved and retrievable | `vessels.http` create then read; `vessels.e2e` create in the browser, row in SQL Server, audit row | **passed** |
| Main flow step 5: detail page after saving | `vessels.e2e`: detail dialog with data and history opens after saving | **passed** |
| Exception 5a: database error keeps the entered data | `vessels.e2e`: server error keeps the dialog and values, retry succeeds | **passed** |
| Authorization denial | `vessels.http` matrix; `vessels.e2e` view-only role, agent, technician | **passed** |
| Boundary | dimension 0.01 and 99999999.99, name 200 characters, IMO 6, 7, 8 digits | **passed** |

### UC-011 (search, update, deactivate)

| Criterion or flow | Test | Status |
|---|---|---|
| AC-1 History shows every change | `vessels.http` history (create, two updates, deactivate; actor, reason, old and new, oldest first; refused attempts excluded); `ship.history.test.js`; `vessels.e2e` detail page lists Created and Updated with who, when (UTC+7), why and old to new | **passed** |
| AC-2 A deactivated vessel cannot be chosen for a notice | `vessels.http` (409 SHIP_INACTIVE; hidden from the default list); `vessels.e2e` the notice form no longer offers it | **passed** |
| Exception 6a: deactivation refused while a voyage is unfinished | `vessels.http`, `vessels.e2e` (message names the voyage); allowed after the voyage is rejected | **passed** |
| Alternative 2a: no match shows "Không có dữ liệu" | `vessels.e2e` states test | **passed** |
| Alternative 5a: duplicate IMO on edit | `vessels.http` (409 with field) | **passed** (API); not repeated in the browser, the same error mapping as create |
| Concurrency | `vessels.http` two simultaneous updates (one 200, one 409); stale revision; `vessels.e2e` stale record reloads the newest data | **passed** |
| Search safety | `%`, `_`, `[`, `\` are not wildcards; paging; invalid parameters | **passed** |

### UC-013 (arrival notice)

| Criterion or flow | Test | Status |
|---|---|---|
| AC-1 Saved with status history (time, actor) | `vessels.http` (ANNOUNCED, one history row with actor, audit row); `vessels.e2e` (UTC+7 08:00 stored as 01:00 UTC and shown as 08:00) | **passed** |
| AC-2 No duplicate vessel and voyage | `vessels.http` duplicate and simultaneous (exactly one stored), same code on another vessel allowed; `vessels.e2e` message on the voyage code field | **passed** |
| Exception 4a: inactive or unknown vessel refused | `vessels.http` SHIP_INACTIVE, SHIP_NOT_FOUND | **passed** |
| Agent scope (own agent and own vessels), no priority for agents | `vessels.http`, `vessels.e2e` agent flow | **passed** |
| Main flow step 6: hand the notice to validation (UC-015) | Not built: UC-015 is outside this slice | **not executed** |
| Acceptance of UC-015 timing (queue within 5 s) | Depends on UC-015 | **not executed** |
| Alternative 3a: "Lưu tạm" kept in the browser | Not built | **not executed** |

## 5. Defects found and fixed

| Defect | Found by | Fix and regression test |
|---|---|---|
| ETA validator accepted impossible dates (2026-02-30 rolled to 2026-03-02) | `vessels.validation` unit test | Calendar fields checked after parsing; unit tests include 2025-02-29 and 2026-04-31 |
| `BIGINT revision` returned as a string, so every update was reported as a version conflict | `vessels.http` | Repositories expose revisions as numbers; covered by the update, deactivate and race tests |
| Session cookie expired 30 minutes after login even for active users | Review while adding the marker | Both cookies re-issued on every accepted request; `auth.http` test |
| Two simultaneous 401 responses redirected twice and dropped the "expired" notice | `vessels.e2e` | Redirect runs once; unit test "two simultaneous 401 responses redirect once" |
| A closed dialog kept the old form in the page | `vessels.e2e` selectors matched stale content | Dialog content cleared on close |
| Seed text stored with the wrong code page ("TÃ u container") because `sqlcmd` was run without UTF-8 | Browser e2e detail check | Seed applied through Node (`npm run seed`), idempotent corrections added; `seed.test.js` regression |
| Static server crashed on a request path with `%00`, and served `package.json` | Earlier slice | See `uc001-uc002-evidence.md` |
| "Sign out" hidden below 860 px | Earlier slice | See `uc001-uc002-evidence.md` |

Intermittent failure, not proven fixed: the UC-002 4a e2e test timed out waiting for the offline notice on the login page in 2 of about 30 runs, and passed 14 consecutive runs when repeated on its own. Not reproduced with diagnostics. A plausible race (the cookie deletion being applied after the login page's session check) was addressed by forcing the deletion to complete and by not auto-redirecting after an offline sign-out. After that change the file passed 12 consecutive runs. The cause is unconfirmed; if it recurs, the diagnostic in the test prints the page state.

## 6. Not executed, unavailable or open

| Item | Status |
|---|---|
| Hand-off of arrival notices to UC-015, queue timing, "Lưu tạm" draft | not built (UC-015 and draft are outside this slice) |
| Real 30-minute idle wait; HTTPS and `Secure` cookie behavior | not executed |
| Browsers other than headless Edge; accessibility audit; keyboard-only walkthrough | not executed |
| Deployment where the API and the frontend are on different registrable domains | not executed. The presence marker `sp_auth` can be deleted by the frontend only when both share the cookie host; this needs a deployment decision (shared parent domain or same site) |
| Mapping of "Overview" and "Operations" pages to module M7 and "Vessels & berths" to M1 and M2 | assumption A-6 in UC005; needs the business owner's confirmation |
| Scope limits "giới hạn" and "phạm vi bộ phận" for M7 and M8 | not defined in the SRS; treated as plain view |
| Other pages (cargo, yard, services, equipment, gis, admin) | still sample data; only their menu visibility is enforced |
