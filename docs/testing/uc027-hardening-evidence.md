# Evidence: UC027 quality hardening

Date: 2026-11-19. The engine is a deterministic optimizer, not machine learning; nothing here is evidence about AI quality or about a real port. Databases: `SmartPortV2_UC027` (mine, new, disposable; migrated to 0007), `SmartPortV2_Mig` (scratch for migration tests), and two NEW databases created to prove the demo procedure: `SmartPortV2_DemoRun2_Copy` (a copy of `DemoRun2`) and `SmartPortV2_Demo027` (fresh demo data). `SmartPortV2_DemoRun2` and `Verify4` were **not** migrated, reset, reseeded or deleted (checked after the copy: DemoRun2 still has 5 migrations, 24 voyages and no 0006 tables). Legacy repositories untouched.

## 1. Commands and results (on `SmartPortV2_UC027`)

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 113 of 113 (5 new optimizer tests: open-ended occupancy, queue priority, determinism, replay by policy version, bounded search) |
| `cd API && npm run test:integration` (`SP_DB_NAME` and `SP_TEST_DB` = UC027, `SP_MIGRATION_TEST_DB` = Mig) | passed: 167 of 167 (3 new recommendation tests: occupancy x2, hazard consistency; 4 migration 0007 tests; migration 0006 test adapted; all Module 1 and 2 tests including UC022 to UC031, concurrency, stale recommendations) |
| `cd Front && npm test` | passed: 54 of 54 |
| `cd Front && npm run test:e2e` (`SP_E2E_DB` = UC027) | passed: 49 of 49 in 3 consecutive runs (the UC-027 scenario now also checks the provenance label in the plan list) |
| `node API/scripts/evaluate-optimizer.js 40` | ran: tables in 4 |

**A false alarm of mine, investigated:** one chain of runs showed failures in unrelated suites (integration concurrency tests, UC-026, UC-011, and all browser auth tests timing out). Cause: I had started a second chain of the same tests while the first was still running on the same database and ports (I had not waited for its end marker). Run alone and one after the other, the same suites passed (167 of 167 and 49 of 49 three times). Not a product defect; no retries were used to hide anything. Another run of mine had left test fixtures in `SmartPortV2_UC027`; the new pre-flight guard stopped the next run and named them; I removed only the fixtures of that disposable database.

## 2. Defects confirmed and fixed

| Defect | How it was confirmed | Fix | Regression test |
|---|---|---|---|
| **Occupancy:** a BERTHED vessel whose planned departure had passed (no departure recorded) no longer blocked its stretch; UC-026, drafts and recommendations all treated it as free, contrary to UC-022 A-2 and UC-025 A-5 | An integration test written first failed on the old code: the recommendation returned proposals on the occupied berth | One shared definition `repositories/occupancy.js` used by the UC-026 neighbour query and by the recommendation snapshot (open-ended occupancy of a berthed vessel without ATD, early ATA, completed plan ends at ATD) | Integration: planned departure past (recommendation, UC-026 check and draft refused; free again after the departure), before the planned departure (beside it with the buffer); unit: open-ended reservation |
| **Provenance:** plans from the local optimizer were stored as `AI` / `AI_ADJUSTED` | Review of the sources used by migration 0006 | Migration 0007, new sources `LOCAL_OPTIMIZER`, `LOCAL_OPTIMIZER_ADJUSTED`; `AI` reserved for an external provider; labels in the UI; engine kind and policy version in the audit row | Migration tests (forward, relabel only local-origin rows, constraints, rollback refusals, re-apply); integration and browser check the new values |
| **Truncated parameter:** the longer source value was bound as `VARCHAR(20)`, so editing an accepted draft failed with a constraint error (HTTP 500) | The integration test of decisions failed after migration 0007 | Parameters widened to `VARCHAR(30)` | The same decision test (edit, edit back, MODIFIED and ACCEPTED) |

## 3. Occupancy and hazard consistency

Occupancy now follows one rule everywhere (UC-022, UC-025, UC-026, UC-027): the stretch is occupied until the actual departure. Hazard: one integration test runs labelled and ordinary berths, unverified, verified safe and dangerous cargo through recommendation, draft save (with and without override), submission and approval, and a hazard changed after a proposal. No contradiction between the engine and UC-026 was found: unverified cargo only at labelled berths (MISSING_DATA elsewhere, never overridable), dangerous cargo only at labelled berths (an override cannot survive approval), the change is caught at approval and by the next recommendation. Provisional assumptions that conflict with other records are listed, not silently changed: TEU 0 treated as missing (UC-013 allows 0), the dangerous-berth preference weight, and the open question whether unverified cargo may use a labelled berth.

## 4. Quality: first-fit baseline, V1 (greedy) and V2 (beam), identical constructed snapshots

4 load profiles x 40 seeds, 20 vessels, 4 to 7 berths, same maintenance and reservations. First-fit models a coordinator taking the earliest feasible slot; it is not real manual data. All variants place the same number of vessels.

| Profile | Mean wait (h): first-fit / V1 / **V2** | Mean worst wait (h): first-fit / V1 / **V2** | Worst single wait (h) | Unscheduled (mean) | V2 vs first-fit per seed: better / equal / worse | V1 vs first-fit | Slowest engine run (ms) V2 |
|---|---|---|---|---|---|---|---|
| moderate (ETA spread 60 h) | 4.27 / 3.90 / **3.49** | 26.4 / 24.2 / **22.68** | 104 (all) | 0.73 (all) | 28 / 6 / 6 | 22 / 2 / 16 | 7.4 |
| congested (24 h) | 13.25 / 13.39 / **12.62** | 40.45 / 40.25 / **38.63** | 112 (all) | 0.73 (all) | 30 / 6 / 4 | 14 / 7 / 19 | 6.7 |
| light (150 h) | 1.45 / 1.07 / **1.04** | 15.03 / 12.2 / **12.05** | 84 (all) | 0.73 (all) | 24 / 15 / 1 | 22 / 16 / 2 | 8.2 |
| few berths (48 h) | 23.82 / 23.71 / **23.45** | 50.45 / 50.3 / **50.45** | 106 (all) | 0.73 (all) | 11 / 29 / 0 | 8 / 23 / 9 | 3.9 |

Why V1 was not better than first-fit in the first test (4.65 h against 4.39 h): V1 ranks each vessel's candidates by cost and takes the best for that vessel alone; a tight berth for one vessel can block the ones behind it. The first fixture was one unlucky sample; across profiles V1 is mixed (worse than first-fit on 16 of 40 seeds in moderate traffic and on 19 of 40 in congested traffic). V2 keeps the queue order, gives every vessel its earliest feasible start, and uses a bounded beam search only to choose which berth and position, looking at the vessels behind. A variant that let earlier vessels wait in order to help later ones gave larger gains on few berths (21.35 h) but **was rejected** because it sacrifices queue priority. The beam width was chosen from these profiles, not from one fixture: on the earlier unrestricted variant (before the priority rule) width 4 gave 3.49 h, 8 gave 3.32 h and 16 gave 3.17 h in moderate traffic (width 16 took about twice the time of width 8, 14 ms); 8 was kept as a modest bound and was not tuned further. Honest limit: the gain in congested traffic is small (4.8 %) and in few-berth traffic marginal (1.6 %); the worst single wait and the unscheduled count do not change. In the 20-voyage integration fixture on SQL Server both rules gave equal waiting (1.19 h); V2 used berths with less unused length (0.37 against 0.47).

## 5. Performance and safeguards

20 waiting voyages, 8 berths, 2 reservations and a maintenance window, real SQL Server with a UC-026 check of every candidate: engine 262 ms, end to end 335 ms (earlier runs: 307 to 515 ms engine, 534 to 754 ms end to end); 17 recommended, 3 unschedulable, 47 proposals, 0 refused by UC-026, 0 violations in proposals shown. The search is bounded by a work counter (2000 candidate searches, then it continues greedily), not by time, so the result stays reproducible; a unit test proves a tiny cap gives the same result twice. Concurrency and stale recommendations: two simultaneous requests, three simultaneous drafts from one proposal (one plan, one decision), a clash approved after a recommendation (the old proposal is refused at save), a hazard changed after a proposal (refused at approval), and a berthed vessel (refused at save). Manual fallback: unschedulable and ignored vessels are planned by hand, drafts without a proposal stay `MANUAL`.

## 6. Migration and compatibility

Migration 0007 (new file; 0001 to 0006 unchanged). Forward on a scratch database: only plans that came from a `LOCAL_OPTIMIZER` request are relabelled, external and manual plans and every other column stay, one audit row records the count; new constraints hold; rollback refuses while a local-origin plan or an `EXTERNAL_AI` request exists and changes nothing, then succeeds and restores the 20-character column; re-apply records the same checksum. A brand-new database migrated 0001 to 0007 and a copy of `DemoRun2` migrated 0006 and 0007. Migration 0006's test was adapted to roll 0007 back first. API consumers: `source` shows the new values for local proposals (possible only since 0006, not deployed); `engine.kind` shows `LOCAL_OPTIMIZER`.

## 7. Demo databases (procedure in `docs/demo/uc027-enable-demo.md`)

Both paths were run: (A) a new database `SmartPortV2_Demo027`: created, migrated 0001 to 0007, seeded, demo data written, consistency 9 of 9; (B) `SmartPortV2_DemoRun2_Copy`: COPY_ONLY backup and restore under a new name, migrated, consistency 9 of 9, a recommendation on its demo queue (16 vessels, 16 recommended, 45 proposals, 0 non-PASS, 440 ms). The original `DemoRun2` was checked afterwards and is unchanged. The accounts of the copy keep the unknown passwords; the procedure resets them on the copy only. The backup file of the copy stays in the server's backup folder.

## 8. Not verified or open

Real data and real manual baselines; periodic quality evaluation (NFR-ACC-04); an AI service; all provisional parameters P-1 to P-7, P-9, P-10; several API processes; browsers other than Edge; the browser demo on the copy (the procedure was verified with scripts and an in-process recommendation, not by a manual login, because its passwords are unknown).
