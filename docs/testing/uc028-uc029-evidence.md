# Evidence: UC028 (manual berth-plan draft), UC029 (submission), UC026 changes, migrations 0003 and 0004

Date: 2026-11-19. Verification database: disposable `SmartPortV2_Verify4` (migrated 0001 to 0004). Migration scratch database: `SmartPortV2_Mig` (created empty, kept, nothing dropped). API 3000, Front 5500, Edge through puppeteer-core. Earlier evidence: `uc024-uc026-evidence.md`.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 86 of 86 |
| `cd API && npm run test:integration` (with `SP_MIGRATION_TEST_DB` set) | passed: 123 of 123, including 14 plan tests (`berth-plans.http.test.js`), 5 migration tests, 14 berth tests; all Module 1 tests included |
| `cd Front && npm test` | passed: 52 of 52 |
| `cd Front && npm run test:e2e` | passed: 41 of 41 in 3 final consecutive runs |
| Migration test alone, twice in a row | passed 5 of 5 each time (repeatable from any state) |

## 2. UC028 criteria

| Criterion or flow | Test | Status |
|---|---|---|
| Main flow, manual: a placement is checked and saved as `DRAFT`, `source = MANUAL`, check result stored, history row, audit, voyage and queue unchanged | integration "UC-028: a manual draft is saved…"; e2e "UC-028/029" | passed |
| AC-1 a violation is always warned | integration and e2e: a violating save or edit is refused (409 `CONSTRAINT_VIOLATION`, every failed rule listed) and nothing is stored | passed |
| AC-2 every override has a reason and an audit row | integration (`BERTH_PLAN_OVERRIDE` row with reason and rules; empty or 501-character reason refused); database `CK_bp_override_set`; e2e (empty reason refused in the dialog) | passed |
| AC-3 override plan keeps source and reason | integration, e2e, migration test | passed for `MANUAL`; `AI` source refused (400) |
| 3a override only with a reason; reason sent with a clean placement is not stored as an override | integration | passed |
| Not overridable: missing data, unverified cargo, out-of-service berth | integration (409 `INSUFFICIENT_DATA`, `NOT_OVERRIDABLE`, nothing stored); e2e (no reason box offered) | passed |
| 5a concurrent change: stale revision, only drafts editable, simultaneous edits | integration (409 with current revision; 3 simultaneous edits give 1 success) | passed |
| One draft per voyage; no draft when an open plan exists; voyage must be queued | integration (4 simultaneous creations give 1 draft; `DRAFT_EXISTS`, `VOYAGE_HAS_OPEN_PLAN`, `VOYAGE_NOT_IN_QUEUE`); database `UX_bp_draft_per_voyage` | passed |
| Input validation | integration (9 bad inputs) | passed |
| Authorization: only the coordinator writes; management and warehouse read; agent and technician refused; no session 401; denials audited | integration; e2e (manager has no save or submit buttons and gets 403) | passed |
| Accept an AI proposal (step 2) and reject all proposals | needs UC-027 | **not executed (blocked: no AI provider)** |
| Plan chart with drag and drop (step 1) | not built; placement is entered in a form | **not executed** |

## 3. UC029 criteria

| Criterion or flow | Test | Status |
|---|---|---|
| AC-1 a passing draft becomes `PENDING_APPROVAL` with submitter and time, history, audit; voyage and queue unchanged; nothing approved | integration "UC-029 main flow"; e2e | passed |
| AC-2 the port manager receives the notice | notification row to `BAN_QUAN_LY` written in the same transaction (integration, e2e); its text says when the plan carries an override | **partly passed**: no way to read notifications is built |
| AC-3 no plan is saved with an unresolved violation | integration (check repeated at submission; maintenance added after the draft refuses it with 409, the plan stays a draft, the refusal is audited FAILED); database `CK_bp_reviewed` | passed |
| 2a violation without override refused; with a reason accepted and recorded (`passed` stays false) | integration; e2e | passed |
| An override saved with the draft is dropped when the check passes again | integration | passed |
| Missing data after the draft cannot be pushed through with a reason | integration | passed |
| Overlap with an existing approved plan: warned, only overridden explicitly, the approved plan untouched | integration | passed |
| 3a concurrency: two overlapping plans submitted at once, one passes; the same draft submitted three times at once, one notice; double creation | integration | passed |
| BR-1 only drafts can be submitted; another open plan refused | integration (`NOT_DRAFT`, `VOYAGE_HAS_OPEN_PLAN`); database `UX_bp_open_plan_per_voyage` | passed |
| Stale revision, missing `If-Match`, wrong role, unknown plan | integration | passed |
| No automatic approval; no approval path | integration (approve returns 404, no status can be set directly, no APPROVED row appears) | passed |

## 4. UC026 changes requested by the project owner

| Requirement | Test | Status |
|---|---|---|
| Reefer is not hazardous; the priority class is not evidence | unit; integration (a REEFER_OR_HAZARD voyage without verification gives MISSING_DATA) | passed |
| A client `dangerous_goods` value is not trusted | integration (field refused with 400, also `false`); unit | passed |
| Verified cargo data is used; unverified gives insufficient data at a berth without the label; the label berth needs no fact | unit, integration, e2e (unverified shows MISSING_DATA, then verified in the dialog) | passed |
| Cargo verification: coordinator only, basis required, audited; agent and management refused | integration; e2e | passed |
| Out-of-service berth cannot receive a new plan unless an exception exists; no exception mechanism exists | unit, integration (violation, not overridable); e2e | passed |
| Deactivated berth refused | integration (400 on `berth_id`) | passed |

## 5. Migrations

| Check | Test | Status |
|---|---|---|
| 0003 applies on a database that holds pending and approved plans; every existing plan column is unchanged; override columns empty | `migration-0003-0004.test.js` | passed |
| `CK_bp_reviewed` accepts a pass or a valid override; refuses a failed check without an override and an override over MISSING_DATA | migration test; plan test "database safeguards" | passed |
| Override columns are all-or-nothing; hazard columns are all-or-nothing | migration test, plan test | passed |
| One draft per voyage in the database | plan test | passed |
| 0004: submitter cannot be approver; a different approver is accepted | migration test, plan test | passed |
| Rollback 0003 refuses while an override or a verified hazard exists, changes nothing, then succeeds once they are gone, restoring the original constraint (a failed check cannot be submitted again) and keeping every plan unchanged | migration test | passed |
| Re-applying after the rollback | migration test | passed |
| Rollback 0004 | migration test | passed |

## 6. Intermittent failures in e2e runs

- **UC-021 5a** (`No element found for selector: #le` in the shared sign-in helper): seen once earlier. Since then: 25 of 25 isolated runs and more than 10 full runs passed. The helper now waits for the form and reports the URL and page text if it is still missing. **Not reproduced; cause not proven.**
- **UC-010 duplicate IMO** (a 15 s wait for the error text): seen once in about 8 full runs of this slice. 25 of 25 isolated runs passed, and no other full run failed. The wait now reports the API status and the dialog content on failure. **Not reproduced; cause not proven.** A possible cause, not established: the dialog's `close` event handler clears its content after the event fires asynchronously, so an immediately reopened dialog could be emptied. If the next report shows an empty dialog, that is the cause.
- No retry was added to any test.

## 7. Defects found and fixed while testing

- Queries ran in parallel on one transaction connection (`EREQINPROG`); the check now runs its queries one after another. Found by the first plan test run; the plan tests cover it.
- A test run that timed out left voyages in the queue of `SmartPortV2_Verify4`, which broke the UC-020 contiguity tests. The leftover rows of that one run (identified by their suffix) were removed with targeted DELETE statements; no database was dropped or reset.
- The permission test compared the SRS matrix with a matrix that now contained the use-case grant `override`. The grant is kept in a separate table and the test checks both.
- Test fixtures that inserted approved plans with the same submitter and approver were refused by the new `CK_bp_no_self_approval`; the fixtures now use a different approver.

## 8. Not verified

- UC-027 acceptance criteria (no AI provider), plans from AI proposals, the drag-and-drop chart.
- Reading notifications as the port manager.
- Approval and rejection (UC-030, UC-031) and the self-approval refusal in the service (only the database safeguard is tested).
- The state change to `BERTH_ASSIGNED` (decision recorded, applied with UC-030).
- Browsers other than Edge; several API processes (locks are in the database, but the refresh hints are in-process).
