# Evidence: UC015 asynchronous ETA slice

Date: 2026-11-19. This is a **V2 design decision subject to business acceptance**: UC-015 is not Completed. **No real AI provider, no ETA model and no AIS data exist; none was built or simulated.** Every provider in the tests is a local MOCK (a stand-in function or a small HTTP server) returning a fixed forecast after a chosen delay, or never, or garbage. The tests prove the workflow (latency independence, queue behaviour, safety, reliability), not AI quality. Database: my disposable `SmartPortV2_UC027` (now migrated to 0008) and the scratch `SmartPortV2_Mig` (migration tests). `DemoRun2`, `Verify4` and the other existing databases were not migrated, reset, reseeded or deleted. UC027 code and behaviour were not changed. The suites ran one after the other in a single chain.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 113 of 113 |
| `cd API && npm run test:integration` (`SP_DB_NAME` and `SP_TEST_DB` = UC027 database, `SP_MIGRATION_TEST_DB` = Mig) | passed: 188 of 188 (13 new in `eta-async.http.test.js`, 3 in `migration-0008.test.js`, the ETA tests of `flow.http.test.js` adapted; UC013, UC015, UC016, UC020, UC021, UC022, UC023, UC025 to UC031 and UC027 tests included) |
| `cd Front && npm test` | passed: 55 of 55 |
| `cd Front && npm run test:e2e` (`SP_E2E_DB` = UC027 database) | passed: 51 of 51 in 3 consecutive runs (the 2 ETA browser tests rewritten for the asynchronous flow) |

## 2. Measured latency (MOCK providers)

| Provider behaviour | Notice submission (API) | Forecast stored after the request | Queue |
|---|---|---|---|
| none configured | under 2 s (asserted; the answer is already known: UNAVAILABLE / NOT_CONFIGURED) | , | declared ETA |
| answers after 0.7 s | 38 ms | about 0.78 s | reordered when it arrives |
| answers after 5.5 s | 34 to 45 ms (limit of UC-015 AC-1: 5000 ms) | about 5.53 to 5.56 s | unchanged until it arrives, then reordered |
| never answers (10 s limit) | 25 to 32 ms | about 10.06 to 10.07 s (UNAVAILABLE / TIMEOUT) | unchanged |
| browser, provider answers after 1.5 s | result dialog after 262 to 349 ms | dialog updates by itself | tag "declared · AI pending", then "AI forecast" |
Before this change the same slow provider (5.5 s) made the submission take 5.53 and 5.54 s.

## 3. Criteria and tests

| Criterion | Test | Status |
|---|---|---|
| No provider configured: immediate UNAVAILABLE, no job, queued on the declared ETA | integration | passed |
| Provider within 1 s: immediate PENDING answer; forecast arrives; effective ETA = forecast, declared ETA kept; the voyage moves; queue history (actor `system:eta`), audit (`VOYAGE_ETA_PREDICTION`), coordinator notice, prediction history with the effect | integration | passed (MOCK) |
| Provider after 5.5 s: submission independent; queue changes only when the forecast arrives | integration | passed (MOCK) |
| Provider silent: closed at the 10 s limit as UNAVAILABLE / TIMEOUT; queue unchanged | integration | passed (MOCK, real 10 s wait) |
| Malformed answer, HTTP error, unreachable: UNAVAILABLE with the reason; no forecast; queue untouched | integration | passed (MOCK) |
| Two forecasts finishing at once: final order by the rules, positions 1..n, each move recorded | integration | passed |
| Priority kept (a priority vessel stays ahead of a standard vessel with a much earlier forecast) | integration | passed |
| A manually moved voyage keeps its place (KEPT_MANUAL_POSITION); the forecast is still stored | integration | passed |
| A voyage that left the queue (plan approved through the real API, BERTH_ASSIGNED) before the forecast returned: not reordered, status unchanged, approved plan unchanged, others unchanged | integration | passed |
| Stale and duplicate results: expired claim taken by another worker; the late result and a repeated result change nothing; one history row, one move | integration | passed |
| Several workers racing: six jobs, six provider calls, six answers | integration | passed |
| Job claimed too often: closed as UNAVAILABLE / ABANDONED, no provider call | integration | passed |
| Restart: a job claimed by a killed process (real OS process, SIGKILL) stays pending; after the lease a new worker finishes it (attempt 2) and applies it | integration | passed |
| Migration 0008: forward keeps old rows, new constraints, one pending row per voyage; rollback refuses while a PENDING row or new information exists and drops nothing; re-apply gives the same checksum | integration | passed |
| Browser: PENDING shown first with the explanation, the dialog and the queue update by themselves, four values in UTC+7, confidence only when it exists, queue effect shown, history; and the failure case (503) | browser | passed (MOCK HTTP server) |
| Regression UC013, UC015, UC016, UC020, UC021, UC022, UC023, berth plans, UC027 | integration, browser | passed |
| A real AI forecast; real provider behaviour and load | , | **not executed: no provider** |

## 4. Defects and changes found on the way
The first versions of the new tests assumed an empty queue; the database holds the voyages of the earlier tests of the same file, so positions are now compared relatively. No product defect was found by the new tests. A harness change was needed for the old ETA tests: they read the forecast from the submission response, which is now PENDING, so they wait for the job to finish.

## 5. Not verified, limits
Real provider and real forecast quality; several API processes (the refresh hint is in-process, the job claiming is not); a retry policy beyond 3 attempts; `DemoRun2` and `Verify4` lack migrations 0006 to 0008. The conflict of UC-015 AC-1 with 3a is resolved only by this design decision, which still needs business acceptance and a change of the specified wording ("queue by the forecast ETA" for the first placement).
