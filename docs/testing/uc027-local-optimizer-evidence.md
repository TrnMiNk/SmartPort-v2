# Evidence: UC027 local berth optimization (policy UC027-OPT-V1)

Date: 2026-11-19. **The engine is a deterministic optimizer. It is not machine learning and no AI accuracy is claimed anywhere in this file.** All data are constructed fixtures (no real port data exists). Databases: a **new** disposable `SmartPortV2_UC027` (created, migrated 0001 to 0006, seeded; used for the regression), the scratch `SmartPortV2_Mig` (migration tests, as before). `SmartPortV2_Verify4`, `SmartPortV2_DemoRun1` and `SmartPortV2_DemoRun2` were **not** migrated, reset, reseeded or deleted; the two plan test files still pass on `Verify4` (backward compatible). Legacy repositories were not touched.

## 1. Commands and results (on `SmartPortV2_UC027`)

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 108 of 108 (10 new optimizer tests; the AI contract tests of the previous task are included) |
| `cd API && npm run test:integration` (`SP_DB_NAME` and `SP_TEST_DB` = `SmartPortV2_UC027`, `SP_MIGRATION_TEST_DB` = `SmartPortV2_Mig`) | passed: 160 of 160 (8 recommendation tests, 5 migration 0006 tests, all Module 1 and 2 tests including UC022 to UC031, concurrency of planning, approval and rejection) |
| `cd Front && npm test` | passed: 54 of 54 (1 new) |
| `cd Front && npm run test:e2e` (`SP_E2E_DB=SmartPortV2_UC027`) | passed: 49 of 49 in 3 consecutive runs (1 new UC-027 scenario) |
| `node API/scripts/evaluate-optimizer.js 30` (offline, no database) | ran: table in 4 |
| `berth-plans` and `berth-plan-approval` tests on `Verify4` (no migration 0006) | passed: 14 of 14 and 15 of 15 |

## 2. UC027 acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| AC-1 response within 10 s for up to 20 queued vessels, **local engine** | **passed** | 20 voyages, 8 berths, 2 reservations and a maintenance window: engine 307 and 392 ms, end to end 534 and 553 ms on SQL Server; browser click to result 120 to 193 ms (5 voyages). Fixture data |
| AC-1 against an **external AI provider** | **blocked** | no provider |
| AC-2 every proposal stored for quality review | **passed** | request snapshot and SHA-256, full answer, per-vessel outcome (also unschedulable), each proposal with its UC-026 result and explanation |
| FR-BRT-12 the final human decision is stored | **passed** (with a limit) | ACCEPTED, MODIFIED, IGNORED recorded and re-classified when a draft is edited; a plan made by hand without opening a recommendation has no decision row |
| AC-3 the manual path works | **passed** | UC-028 unchanged; unschedulable and ignored vessels planned by hand (integration and browser) |
| BR-1 proposals respect UC-026 | **passed** | 47 proposals in the 20-voyage run, 0 violations; every shown proposal re-checked by UC-026 and by an independent call to the check endpoint; 0 candidates were refused in that run, and a unit test proves a refused candidate is dropped |
| More than 20 vessels refused before any work | **passed** | 400, no row stored |
| Unschedulable vessels get explicit reasons; missing data is not a pass | **passed** | unverified hazard, missing TEU, LOA longer than every berth |
| Recommendation never creates or approves a plan | **passed** | no plan after a request; approval only by another account |
| Reproducible for the same snapshot | **passed** | replaying the stored snapshot gives the same proposals; two replays identical; hash of the stored snapshot equals the stored hash |
| Rules checked again at save, submit and approval | **passed** | a clash approved after the recommendation makes the old proposal fail at save (OVERLAP); an overridden clashing plan is refused at approval |
| Simultaneous requests and drafts | **passed** | two requests both succeed; three drafts from one proposal give one plan and one decision |
| Roles | **passed** | coordinator only; manager, warehouse, agent, technician 403 with audit; no session 401; reading needs M2 view |
| Screen distinguishes the algorithm from unavailable predictive AI | **passed** | banner "không phải mô hình học máy", "Dự báo AI: chưa có"; score labelled as utility, not confidence (browser) |
| SRS: an AI service at `/recommend/berth`, AI model, periodic quality evaluation (NFR-ACC-04) | **not fulfilled** | not built; needs a provider or model and real decision data |

## 3. Migration 0006 (`SmartPortV2_Mig`, then a fresh database)

Forward on a database holding rows in the old shape: existing request and proposal rows unchanged and given the defaults. New constraints tested (engine kind, JSON, hash, duration, outcome, counts, decision links, one decision per plan, one ignore per vessel). Rank unique per vessel replaces the per-request rule (the old rule is proven first). Rollback refuses, and drops nothing, in each case: a plan from a proposal, a decision, a vessel outcome, a proposal, a request; it succeeds once none is left; re-apply works and records the file's checksum. A brand-new database migrated 0001 to 0006 cleanly. Earlier migration files were not edited. `SmartPortV2_Mig` ends with 0006 applied.

## 4. Quality: optimizer against a first-fit baseline (CONSTRUCTED scenarios, not evidence of real quality)

30 seeded scenarios, 20 vessels, 7 berths, mean per scenario. The baseline simulates a coordinator who takes the earliest feasible slot in berth code order; it is not real manual data.

| Metric | Optimizer | First-fit |
|---|---|---|
| Vessels placed / unschedulable | 18.9 / 1.1 | 18.9 / 1.1 |
| Mean waiting (h) | 4.65 | **4.39** |
| Maximum waiting (h) | 28.07 | **27.17** |
| Unused berth length (share) | **0.38** | 0.40 |
| Unused cranes (share) | **0.15** | 0.17 |
| Occupied berth hours / makespan (h) | 375.7 / 93.8 | 375.8 / 93.6 |

Reading: the optimizer did **not** reduce waiting (it is about 0.26 h higher); it fits vessels marginally tighter. **No improvement is claimed.** The first weights (fit terms worth up to 9 h) were worse (4.71 h); they were changed to waiting-first on the SRS ordering, not tuned to beat the baseline, and the result is still not better. In the 20-voyage integration fixture both rules gave the same waiting (1.15 h mean) and the optimizer used berths with less unused length (0.37 against 0.47).

## 5. Not verified or open

- Real port data, real queues, real manual baseline; quality over time; a periodic evaluation (NFR-ACC-04).
- All policy parameters P-1 to P-9 are unapproved assumptions (see UC027 section 16.3).
- A vessel that overstays its planned time is not modelled; a hand-made plan leaves no decision row.
- Several API processes; browsers other than Edge. `Verify4`, `DemoRun1` and `DemoRun2` need migration 0006 (with authorization) before the feature can be used there.
