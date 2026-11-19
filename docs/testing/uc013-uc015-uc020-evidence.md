# Evidence: UC013 (drafts, hand-off), UC015 (automatic validation), UC020 (queue)

Date: 2026-11-18. Database: disposable `SmartPortV2_Verify3`, created empty, migrated (0001, 0002) and seeded in this run. Node 24, SQL Server 16 on localhost, Edge through puppeteer-core.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 67 of 67 |
| `cd API && npm run test:integration` (sequential, `UV_THREADPOOL_SIZE=16`) | passed: 83 of 83 (16 schema, 18 auth, 22 vessels, 3 seed, 24 flow) |
| `cd Front && npm test` | passed: 48 of 48 |
| `cd Front && npm run test:e2e` (API 3000, Front 5500, real browser, real SQL Server) | passed: 33 of 33 |
| Migration 0002 rollback on `SmartPortV2_Rollback1` | passed: 29 → 24 → 29 tables |
| UC002 4a diagnostic: that e2e test alone, 25 runs | passed 25 of 25 |
| Full e2e suite repeated 5 times on `SmartPortV2_Verify2` | passed 5 of 5 (33 tests each) |

## 2. UC002 4a flake investigation

Earlier, 2 of about 30 runs failed ("offline notice never appeared"); a diagnostic dump was added to the test. After the libuv thread-pool fix (`UV_THREADPOOL_SIZE>=16`; the API process could stall for seconds under lock-waiting ODBC calls) and the `clearMarker` hardening in `auth.js`, there were 0 failures in 25 isolated runs, 5 full-suite runs and the final run. **The failure did not reproduce, and the cause is not proven.** The thread-pool stall is a plausible contributor, but that is a hypothesis, not a confirmed root cause. The diagnostic dump stays in the test, so a recurrence prints the URL, `#lmsg` HTML, page text and `readyState`.

## 3. UC015 criteria

| Criterion | Test | Status |
|---|---|---|
| AC-1 valid voyage queued within 5 s | integration "UC-015 valid notice" (measures duration; AI unconfigured, so no AI wait) | passed. With a real slow AI provider (up to 10 s) the 5 s criterion can be exceeded (assumption A-5); not verified with a real provider |
| AC-2 invalid never enters the queue | "missing documents", "expired required document", "pending or rejected review… restricted vessel" | passed |
| AC-3 determinism | unit "determinism", "policy version change"; integration "determinism" | passed |
| AC-4 audit per run (snapshot, version, rules, outcome, reason) | "valid notice" (run, audit_events, notification rows) | passed |
| AC-5 no human confirmation | no confirmation endpoint or UI exists; REJECTED is final without a manual step ("expired required document") | passed |
| AC-6 policy unavailable | "policy unavailable": notice stays ANNOUNCED, nothing valid recorded, retry works | passed |
| AC-7 infrastructure failure not converted to a business outcome | same test; intake returns 201 with `validation.state = NOT_RUN` | passed |
| Document checks (ship vs voyage scope, boundaries) | unit tests, "validity boundaries", "voyage-specific documents" | passed |
| AI fallback (timeout, unreachable, malformed), never shown as validated | unit adapter tests; integration "AI: unreachable, slow or malformed" | passed |
| AI success path | integration "AI success path" through the real adapter against a local stand-in | passed against a stand-in only; **not run against a real provider** (none exists, D3) |
| Authorization | "authorization: validation and queue endpoints follow the role matrix" | passed |
| Browser: result dialog, "Validate again" | e2e "UC-013: a coordinator submits…" | passed |

## 4. UC013 criteria (including the new 3a draft and hand-off)

| Criterion | Test | Status |
|---|---|---|
| AC-1..AC-3 (earlier slice) | e2e and integration, updated for the MISSING_DOCUMENTS status and two history rows | passed |
| AC-4 hand-off: submit triggers UC015 automatically | integration "valid notice"; e2e result dialog | passed |
| 3a save, edit, discard draft; private to the owner | integration "UC-013 drafts…" (2 tests); e2e "UC-013 3a" | passed |
| Submit draft: incomplete stays open with field errors | integration "submit draft" | passed |
| Idempotent and concurrent submit: one notice, one validation | integration "submit draft is idempotent" (repeat and simultaneous) | passed |
| Invalid state transitions (submit a discarded draft) | integration "discarded drafts…" | passed |
| Agent scope | integration "agent flow", "authorization" | passed |

## 5. UC020 criteria

| Criterion | Test | Status |
|---|---|---|
| AC-1 reason and actor on every reorder | integration "move: reason, actor and positions are stored", "reason is mandatory…" | passed |
| AC-2 correct order after a change, contiguous positions | "move…", "simultaneous submissions" | passed |
| AC-3 stale view refused 409 and reloaded | "two coordinators moving at once…" (one succeeds, one 409) | API passed. The browser reload on a 409 is implemented but **not covered by an e2e test** |
| Documented ordering (priority, ETA, tie-breakers) | unit `queue.order`; integration "ordering…", "forecast earlier than declared…" | passed |
| Browser: queue panel, move with reason, agent hidden | e2e "UC-020: valid notices enter the berth queue…" | passed |
| Step 6 notify M2 | not applicable until Module 2 | not executed |

## 6. Not verified

- Any real AI ETA provider (none exists).
- Response time above 5 s with a slow provider (A-5).
- Browser reaction to a queue 409 (no e2e).
- Load beyond 6 simultaneous submissions.
