# Evidence: AI readiness (UC015 with UC016, and UC027)

Date: 2026-11-19. No AI provider exists and none was called. **Nothing in this file is evidence that an AI works.** Mocked results are labelled as mocked. Databases: disposable `SmartPortV2_Verify4` and `SmartPortV2_Mig`; no database was reset, reseeded or deleted. No migration was added. Legacy repositories were only read.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 98 of 98 (8 new: 7 `MOCK` contract tests in `ai.contract.test.js`, 1 config test) |
| `cd API && npm run test:integration` (with `SP_MIGRATION_TEST_DB`; the new pre-flight check found an empty queue) | passed: 147 of 147 (1 new: notification hints) |
| `cd Front && npm test` | passed: 53 of 53 |
| `cd Front && npm run test:e2e` | passed: 48 of 48 in 3 consecutive runs (1 new: agent notice without the berth channel) |

## 2. Real results versus mocked results

| Item | Kind | Result |
|---|---|---|
| Provider call: timeout aborts, HTTP error, unreachable, oversized answer, key only in the Authorization header, no key, query, payload or body in the log line, a failing logger changes nothing | **MOCK** (local stand-in provider) | passed |
| ETA response check (shape, ISO time with offset, confidence 0..1, model version length) and the existing adapter tests | **MOCK** | passed (5 + 3) |
| Berth request check (1 to 20 distinct vessels, a berth, timestamp) and response check (vessels and berths of the request only, ranks 1..k without gaps, times, score 0..1, wait ≥ 0, no proposal means `NO_FEASIBLE_PLACEMENT`) | **MOCK** | passed |
| No URL configured: ETA and berth adapters answer `UNAVAILABLE / NOT_CONFIGURED` and make no call | real code path, no provider | passed |
| UC-015 with no provider: voyage `WAITING_BERTH` in 0.08 to 0.24 s, run row `ai_status = UNAVAILABLE`, screen says "chưa có dự báo AI" | **real** (browser, API, SQL Server) | passed |
| Real AI forecast, real berth proposals, real latency of a provider, model quality (MAE, utilization) | none exists | **not executed: no provider, no data** |

## 3. Technical defects fixed

| Defect | Change | Evidence |
|---|---|---|
| Recipients without the berth permission (agents) saw new notices only after up to 30 s (UC-030 5 s criterion) | `GET /realtime/notifications` (any signed-in user, content-free hints on plan submit, approve, reject); the page re-reads its own notifications | Integration: hint within 5 s, no ids in the hint, 401 without a session. Browser: approval notice reaches the agent's open page in 181 to 273 ms (3 runs). The browser test **timed out** (about 10 s) when the change was temporarily disabled, so it detects the defect |
| Queue tests failed with confusing messages after a failed run left voyages in the queue | `npm run test:integration` stops first and names the leftovers (read-only; `SP_ALLOW_DIRTY_QUEUE=1` overrides). It also refuses the demo database `SmartPortV2_DemoRun2` | Run against `DemoRun2`: refused with the list; run against `Verify4` (empty queue): started and passed |

## 4. Not changed, with reasons

- **Audit-query timeouts:** the query took 11 ms on 12,920 rows, so a timeout is a lock wait, not a slow scan. No blocking session was found afterwards and it did not recur. Cause unknown; the test dumps blocking sessions if it recurs.
- **M-1 (5-minute tolerance for edited actual times):** business policy, left as documented; options are in `docs/architecture/ai-integration-readiness.md` section 10.
- **Test isolation redesign** (queue-independent tests): not done; the guard is a mitigation.
- **Size cap** in the provider call covers only the declared `Content-Length` (recorded as a `shortcut:` comment).

## 5. Not verified

Everything that needs a provider: success path of UC-015 step 3, UC-016 AC-1 and AC-3, UC-027 AC-1 to AC-3, NFR-PER-02, NFR-ACC-04. Several API processes (the hint channel is in-process).
