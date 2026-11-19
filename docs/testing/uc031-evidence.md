# Evidence: UC031 (reject a berth plan)

Date: 2026-11-19. Verification database: disposable `SmartPortV2_Verify4`. No migration was added: the plan table already has `rejection_reason` with `CK_bp_reject_reason`. Earlier evidence: `uc029-uc030-evidence.md`.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 86 of 86 |
| `cd API && npm run test:integration` (with `SP_MIGRATION_TEST_DB`) | passed: 139 of 139 (4 new UC-031 tests; all Module 1 and 2 tests included) |
| `cd Front && npm test` | passed: 53 of 53 |
| `cd Front && npm run test:e2e` | passed: 44 of 44 in 3 consecutive runs (1 new two-account scenario) |

## 2. Criteria

| Criterion or flow | Test | Status |
|---|---|---|
| Main flow: pending plan becomes `REJECTED` with the reason (trimmed), revision, history row (actor, reason), audit (previous and new state, before and after) | integration "UC-031 main flow" | passed |
| AC-1 the coordinator gets the reason within 5 s | notice row to the submitter only (integration; manager, warehouse, agent, technician do not see it); e2e: appears on the dispatcher's open page within the 5 s wait, without reload | passed |
| AC-2 berth state unchanged: no reservation, berth "Trống", voyage status and queue position and queue order unchanged, no queue history row | integration; e2e | passed |
| 4a no reason refused (empty, blank, null, over 500, unknown field) and nothing changes; `CK_bp_reject_reason` refuses a blank reason in the database | integration; e2e (empty box shows the error, plan stays pending; cancel keeps it pending) | passed |
| 5a plan already decided: draft, approved, rejected give 409 `NOT_PENDING` with the status; stale revision 409 with the current revision; `If-Match` required | integration | passed |
| Authorization: only port management; coordinator, warehouse, agent, technician 403 (audited DENIED); no session 401; unknown plan 404; the dispatcher has no reject control and a forced call is refused | integration; e2e | passed |
| A rejected plan is final: not approvable, not editable, not submittable; a new draft for the same voyage is accepted and goes through submit and approve; the old plan stays REJECTED; only the new plan holds the berth | integration; e2e (new draft accepted) | passed |
| Concurrency: three simultaneous rejections give one (one history row, one notice); rejection against approval, 3 rounds, gives exactly one decision and plan and voyage always agree; queue stays 1..n | integration | passed |
| Rejection does not move the voyage to `BERTH_ASSIGNED` | integration; e2e | passed |
| Approved plans and the approved voyage stay as they were when someone tries to reject them | integration | passed |
| Visible status and reason in the plan list; role-based buttons | e2e | passed |

## 3. Quality review

- **Migration consistency:** the recorded checksums of 0001 to 0005 equal the files on disk in Verify4, Mig and Verify3 (read-only check). 0005 was corrected once earlier on 2026-11-19 on the two databases that held the first version (documented in `uc029-uc030-evidence.md`); no database holds a different version now.
- **Notification read semantics:** a notice addressed to a role has one read mark shared by all users with the role (UC-029 A-5). Rejection and approval notices are addressed to one user, so their read mark is personal. Verified that read marks cannot be set by users the notice is not addressed to.
- **Intermittent e2e failures** (UC-021 5a, UC-010 duplicate IMO): not seen in 3 full runs here. Causes still not proven; diagnostics kept; no retries added.
- **A test mistake found on the way:** a helper default made a "no reason" case send a valid reason and actually reject the plan; the test now sends `null`. No product defect.
- Legacy repositories and non-disposable databases were not touched.

## 4. Not verified

- A 5 s measurement on a clock for users without the refresh channel (they poll every 30 s).
- Several API processes; browsers other than Edge.
- UC-022, UC-023, UC-027 (not started).
