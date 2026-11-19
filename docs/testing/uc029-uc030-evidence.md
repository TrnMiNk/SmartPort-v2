# Evidence: UC029 notifications, UC030 approval, migration 0005 (BERTH_ASSIGNED)

Date: 2026-11-19. Verification database: disposable `SmartPortV2_Verify4` (migrated 0001 to 0005). Migration scratch database: `SmartPortV2_Mig`. Rehearsal database with existing data: `SmartPortV2_Verify3`. API 3000, Front 5500, Edge through puppeteer-core. Earlier evidence: `uc028-uc029-evidence.md`.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 86 of 86 |
| `cd API && npm run test:integration` (with `SP_MIGRATION_TEST_DB`) | passed: 135 of 135 (10 new in `berth-plan-approval.http.test.js`, 7 in the migration test, all earlier Module 1 and 2 tests included) |
| `cd Front && npm test` | passed: 53 of 53 |
| `cd Front && npm run test:e2e` | passed: 43 of 43 in 3 consecutive runs (2 new scenarios) |
| Migration test alone, twice in a row | passed 7 of 7 each time |
| Rehearsal of 0003 to 0005 forward, back and forward on `SmartPortV2_Verify3` | data fingerprints identical at every step (see section 5) |

## 2. Before the migration: what the databases held

Read-only inspection (`inspect0005.js`): voyage states, the five state constraints, tables that reference `voyages`, history.

| Database | Migrations | Voyages | Plans | History rows |
|---|---|---|---|---|
| Verify4 | 0001 to 0004 | none | none | none |
| Verify3 | 0001, 0002 | 2 MISSING_DOCUMENTS, 2 WAITING_BERTH (queued) | none | none |
| Verify2 | 0001, 0002 | 12 MISSING_DOCUMENTS, 2 REJECTED | none | none |
| Mig | 0001 to 0004 | none | none | none |

No voyage was BERTHED or DEPARTED anywhere, so no existing row can conflict with the wider constraints. `voyage_status_history` has no state check, so the new state needs none there. Eight tables reference `voyages`; none is touched. Verify2 was not migrated.

## 3. UC030 criteria

| Criterion | Test | Status |
|---|---|---|
| Main flow: approver confirms, plan `APPROVED`, approver and time, voyage `BERTH_ASSIGNED`, queue position cleared, voyages behind it move up by one, queue stays 1..n, queue revision changes, `LEFT_QUEUE` history, voyage history, plan history, audit with decision details | integration "UC-030 main flow" | passed |
| AC-2 approval repeats the check on current data and never trusts the stored result: maintenance added, approved overlap (BR-01), berth out of service, cargo dangerous (BR-03), cargo verification withdrawn, ship data changed | integration "F-1b: approval re-checks everything" (6 cases; each: 409, plan and voyage unchanged, refusal audited FAILED, submitter notified) | passed |
| F-1b an overridden plan is not approved while a rule fails; BR-01 and BR-03 violations are never approved; once the cause is gone the plan is approvable and the decision records that it had an override; the stored result is replaced by the fresh one and the earlier failed result stays in the audit | integration "F-1b" (3 tests) | passed |
| Pending plans do not block each other; the first approval holds the berth | integration | passed |
| AC-3 only `BAN_QUAN_LY`: coordinator, warehouse, agent, technician get 403 audited; no session 401; `confirm` and `If-Match` required; stale revision 409; unknown plan 404; draft or decided plan 409 `NOT_PENDING`; voyage no longer queued 409 | integration "RBAC and request checks" | passed |
| F-4 no self-approval: a user with both roles is refused (service, audited, 3 simultaneous attempts); the database also refuses; another manager can approve | integration "F-4"; migration test; plan test | passed |
| Concurrency: three approvers on one plan give one approval, one queue exit, one history row, one notice; two overlapping plans approved at once give one approval; four plans approved at once keep the queue 1..n | integration "concurrency" | passed |
| AC-4 approval audit with approver | integration (`BERTH_PLAN_APPROVE`) | passed |
| AC-1 notices within 5 s | submitter and agent users receive rows in the approval transaction (integration); on an open page they appear within the 8 s the test waits (e2e) | **partly passed**: not measured against 5 s; yard, crane and gate notices are out of scope |
| 4a cancel at the confirmation keeps the plan pending | e2e | passed |
| 6a refusal: the dialog shows the failed rule, the approve button is disabled, a forced call is refused, the plan stays pending, the submitter is told | e2e "a plan that no longer passes" | passed |
| Re-plan after a refusal (UC-033) and rejection (UC-031) | not built | **not executed** |

## 4. UC029 notifications and the two-account scenario (real SQL Server, real browser)

| Check | Test | Status |
|---|---|---|
| `GET /notifications`: role users see the notice, everyone else does not; own rows only; unread filter, total, unread count; paging and bad input refused; 401 without a session | integration "notifications" | passed |
| Marking read: allowed to recipients only (404 otherwise), harmless twice, one audit row | integration | passed |
| Two accounts in two browser contexts: dispatcher A saves a draft and submits; manager B, who already has the page open, receives the notice and sees the plan with a review button within 5 s without reloading; the notice can be marked read | e2e "UC-029 + UC-030, two accounts" | passed |
| A cannot approve their own plan: no approve button, a forced call returns 403, the plan stays pending | e2e | passed |
| B reviews (stored check, fresh check), confirms, approves; plan `APPROVED` by B in SQL Server | e2e | passed |
| The voyage is removed from the active queue (B's queue panel, and A's page without reload); the voyage behind it stays | e2e | passed |
| The approved assignment appears in the vessel schedule (status filter `BERTH_ASSIGNED`, shows the berth) and in the berth status ("Đã đặt trước" with the voyage code) | e2e; integration (schedule list, Gantt bar, berth state) | passed |
| A's page receives the approval notice and a second approval attempt is refused | e2e | passed |
| UC-022 afterwards: `BERTHED` without an ATA is refused by the database, with an ATA accepted from `BERTH_ASSIGNED`, and the berth then shows "Đang sử dụng" | integration; migration test | passed (UC-022 itself is not built) |

UC029 acceptance: AC-1, AC-2 and AC-3 passed, so UC029 is **Completed for the manual path**; keeping an AI proposal reference (step 4) belongs to UC-027, which is blocked.

## 5. Migration 0005

| Check | Test | Status |
|---|---|---|
| Applies after 0003 and 0004; existing plans, voyages (queued ones included) and queue history rows unchanged; existing history becomes `MOVE` | migration test | passed |
| `BERTH_ASSIGNED` refused while it still has a queue position or no valid result; `BERTHED` without an ATA refused, with an ATA accepted; `LEFT_QUEUE` needs a from position and no to position; `MOVE` needs a to position; unknown change types refused | migration test | passed |
| Rollback refuses while `BERTH_ASSIGNED` voyages exist, then while `LEFT_QUEUE` rows exist, changing nothing; then succeeds, the original rules are back (the new state is refused again), the original queue history survived | migration test | passed |
| Re-applying after the rollback | migration test | passed |
| Forward, back and forward on `SmartPortV2_Verify3` (existing data: 2 queued voyages and 439 audit rows): fingerprints of voyages, history, queue changes, plans and audit identical before, after forward, after rollback and after re-applying | `rehearse.js` | passed |

**Defects in the migration found by its own tests and fixed before any real use.**
- A CHECK passes when its expression is UNKNOWN. The first version of `CK_vqc_positions` therefore accepted a `MOVE` row without a to position and a `LEFT_QUEUE` row without a from position, and the existing `CK_voyages_valid_result` accepted a NULL validation result. Both now state `IS NOT NULL` explicitly. The corrected file was applied after rolling the first version back with its own guarded rollback on the two disposable databases that had it (Verify4, Mig); no other database ever saw the first version.

## 6. Intermittent failures and what was learned

- **Lost clicks from live refresh.** The first run of the two-account scenario failed with "Node is detached from document": a refresh hint re-drew the plan list under the click, and the queue and schedule showed "Loading" on every hint. This is a usability defect, not only a test problem. Silent reloads now keep the screen when nothing changed (a signature of the data), show no "Loading", and keep the old content on a transient error. Covered by the e2e scenarios.
- **Refusal at approval was not announced to the submitter's open page**: no refresh hint was sent when the transaction rolled back. A hint is now sent after the refusal notice is written (found by the e2e test).
- **Ports 3000 and 5500 were held by two test servers left running by an earlier interrupted run**, making the next run fail with `EADDRINUSE`. They were my own test processes (`scripts/serve.js`, `src/server.js`); I stopped those two processes. The harness does not stop its children when the run is cut by a timeout, which is a known limitation.
- **UC-021 5a** and **UC-010 duplicate IMO** (intermittent in earlier runs): not seen in the 3 full runs here (43 tests each); causes still not proven, diagnostics kept. No retries were added.

## 7. Not verified

- Notices to the yard, cranes and gate; a 5 s measurement of the approval notices to the submitter and agent.
- Rejection (UC-031), re-plan (UC-033), UC-022, UC-023, UC-027 (no AI provider).
- Several API processes (refresh hints are in-process); browsers other than Edge.
- What an operator does with an approved voyage whose vessel never arrives (to be handled with UC-022/023).
