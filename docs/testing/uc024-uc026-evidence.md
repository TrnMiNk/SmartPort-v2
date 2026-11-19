# Evidence: UC024 (berth catalog), UC025 (berth state), UC026 (placement check)

Date: 2026-11-19. Database: disposable `SmartPortV2_Verify4` (empty, migrated 0001 and 0002, seeded on 2026-11-18). No migration was added for this slice. API on port 3000, Front on 5500, Edge through puppeteer-core. Earlier evidence: `uc021-evidence.md`, `uc013-uc015-uc020-evidence.md`.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 83 of 83 (11 new in `berth.policy.test.js`) |
| `cd API && npm run test:integration` | passed: 103 of 103 (13 new in `berths.http.test.js`; the 90 earlier tests, including auth, vessels, UC013, UC015, UC020 and UC021, still pass) |
| `cd Front && npm test` | passed: 52 of 52 (1 new) |
| `cd Front && npm run test:e2e` | 5 full runs: **4 passed 39 of 39, 1 failed 1 of 39** (see section 4); the 3 runs after the sign-in helper change all passed. New: 4 tests in `berths.e2e.test.js` |

## 2. Criteria

### UC-024

| Criterion | Test | Status |
|---|---|---|
| Main flow: create with all fields, list, audit with new values | integration "create"; e2e "UC-024" | passed |
| AC-1 a new berth is available to planning without a code change | integration (same request: in `GET /catalog/berths`, `GET /berths`, usable in the check); e2e (chosen in the check dialog) | passed (the planning screen UC-028 does not exist yet) |
| AC-2 duplicate code | integration (duplicate, other case, 4 at once → exactly one); e2e (error on the field) | passed |
| 5a values at or below zero | integration "validation" (8 cases, nothing stored); e2e | passed |
| 3a coordinates empty; both-or-neither | integration, unit | passed |
| Edit: changed fields only, revision, stale 409, audit old/new | integration "update" | passed |
| AC-3 / 5b edit size with open plans: list plans, confirm | integration; e2e (warning block lists the voyage; unchanged until confirmed; confirmed save audited) | passed |
| Authorization: coordinator changes; management, warehouse, admin read; agent, technician refused; no session 401; denials audited | integration; e2e (manager has no buttons and gets 403; agent has no panel and gets 403) | passed |

### UC-025

| Criterion | Test | Status |
|---|---|---|
| AC-2 derived states (free, reserved, in use, maintenance, out of service; late vessel; vessel still berthed after plan end; pending plan; future and cancelled maintenance) | unit "berth state"; integration (9 berths); e2e (states and filters) | passed |
| State is never set by a request (BR-2) | integration (unknown `state` field refused) | passed |
| AC-1 change visible within 5 s | integration (refresh hint received well within 5 s); e2e (a berth created by another user appears on an open page without reload in under 5 s) | **partly passed**: only catalog changes exist as events. Plan approval, berthing, departure and maintenance events cannot be tested until UC-030, UC-022, UC-023 and UC-034 exist |
| AC-3 / 3a connection loss | e2e: channel blocked → warning "Dữ liệu có thể chưa cập nhật" → browser retries → warning gone and the snapshot reloaded, including a change made while disconnected | passed for an unreachable channel. A stream cut in the middle was tried through network emulation, which did not cut the open stream, so it was not simulated |
| 5a filters by state and type, empty state | e2e | passed |
| Step 6 detail: vessel now, upcoming plans, maintenance | integration, e2e | passed |
| Channel access | integration (agent 403, no session 401) | passed |

### UC-026

| Criterion | Test | Status |
|---|---|---|
| AC-1 each rule named with outcome and reason; all violations listed together | unit (8 rules and boundaries: LOA equal and +1 cm, depth, type, cranes, buffer exactly 15 m and 1 cm less, touching times, touching maintenance); integration; e2e (LOA violation text, PASS, MISSING_DATA) | passed |
| AC-3 buffer from the parameter | integration (30 m changes the result; parameter removed → 503, no default) | passed |
| AC-2 saved plans have no violation unless overridden | needs UC-028/029 | **not executed** |
| 6a missing data is not a pass | unit, integration, e2e (no cranes entered) | passed |
| Nothing stored by the check | integration (plan and audit counts unchanged); e2e (no plan row) | passed |
| Determinism | unit (neighbor order, repeated), integration (4 simultaneous equal requests give identical bodies) | passed |
| Preconditions (voyage in queue, berth exists) | integration | passed |
| Authorization | integration (coordinator, manager, warehouse allowed; agent, technician refused); e2e (manager may check and cannot move) | passed |

## 3. Regression

All earlier suites ran in the same runs and passed: authentication (UC-001, UC-002 including 4a), vessel registry (UC-010, UC-011), notices and drafts (UC-013), automatic validation (UC-015), queue (UC-020 including the 409 in the browser) and schedule (UC-021).

## 4. The one failure in the regression runs

A full run failed `UC-021 5a` after 302 ms with `No element found for selector: #le`, thrown by the shared sign-in helper (the form was not in the page right after `goto`). It did not recur in the 4 other full runs, 3 of which came after the helper change. The sign-in form is drawn by script on load, so a race between the load event and the script is plausible, but the cause is **not proven**. The helper now waits up to 10 s for the form and, if it is still missing, fails with the URL and the first 300 characters of the page text, so a recurrence is diagnosed rather than retried. No retry was added. The earlier UC002 4a diagnostics are unchanged.

## 5. Not verified

- Events from plan approval, berthing, departure and maintenance (producers not built).
- A real stream interrupted in the middle; more than one API process (the hint channel is in-process, ADR-001).
- Berth data created by the planning use cases: plans and maintenance are fixtures inserted into the documented tables.
- Browsers other than Edge; load beyond a few dozen berths.
