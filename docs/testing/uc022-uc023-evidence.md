# Evidence: UC022 (confirm berthing) and UC023 (confirm departure)

Date: 2026-11-19. Verification databases: disposable `SmartPortV2_Verify4` (API integration and browser e2e) and `SmartPortV2_Mig` (migration tests). No migration was added: `voyages.ata`, `voyages.atd`, `CK_voyages_ata`, `CK_voyages_atd` and the plan state `COMPLETED` already existed. Earlier evidence: `uc031-evidence.md`.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 90 of 90 (4 new, `movement.validation.test.js`) |
| `cd API && npm run test:integration` (with `SP_MIGRATION_TEST_DB`) | passed: 146 of 146 (7 new in `voyage-movement.http.test.js`; all earlier tests included) |
| `cd Front && npm test` | passed: 53 of 53 |
| `cd Front && npm run test:e2e` | passed: 45 of 45 in 3 consecutive runs (1 new two-account scenario) |

## 2. Criteria

| Criterion or flow | Test | Status |
|---|---|---|
| UC022 main flow: plan made and approved through the API by another account, then berthing: `BERTHED`, ATA = now, plan stays `APPROVED`, queue untouched, history and audit rows | integration "UC-022 main flow" | passed |
| UC022 AC-1 berth "Đang sử dụng" (before: "Đã đặt trước") | integration; e2e (both accounts' open pages follow) | passed |
| UC022 AC-2 ATA shown: schedule bar source `ACTUAL`; lifecycle dialog | integration; e2e | passed |
| UC022 AC-3 history with actor, audit with old and new state | integration | passed |
| 2a edited time needs a reason (refused without; accepted with, stored exactly); future time refused; bad format refused | integration; unit; e2e (error shown, nothing changed, then confirmed) | passed |
| 4a other berth than the plan: 409 `WRONG_BERTH`; occupied stretch: 409 `BERTH_OCCUPIED` | integration | passed |
| No approved plan / not `BERTH_ASSIGNED` (a waiting voyage): 409 with the rule and status | integration | passed |
| 5a stale revision 409 with `current_revision`; duplicate confirmation 409; three simultaneous confirmations give one (one history row, one audit row) | integration | passed |
| Permissions: only the coordinator; manager, warehouse, agent, technician 403 (audited DENIED); no session 401; unknown voyage 404; no button for port management and a forced call is refused | integration; e2e | passed |
| UC023 main flow: `DEPARTED` with ATD, plan `COMPLETED`, berth "Trống", voyage history, plan history (APPROVED>COMPLETED), audit, schedule still shows the berth with actual times | integration; e2e | passed |
| UC023 AC-2 berth free for later intervals: another vessel is planned and approved for the same stretch and time right after; the completed plan is kept | integration | passed |
| Berth availability after departure considers other approved plans ("Đã đặt trước") and maintenance windows ("Bảo trì") | integration | passed |
| 2a (voyage not berthed): 409 `NOT_BERTHED`; ATD before ATA 409; future ATD 400; edited time needs a reason; stale 409; duplicate 409; three simultaneous departures give one | integration | passed |
| Whole chain through the real API only: notice, automatic validation and queue, hazard verification, plan, submit, approve (other account), berthing, departure; history of 6 transitions; audit rows | integration "end to end through the real API only" | passed |
| Browser: two accounts, planning, approval, then the coordinator confirms berthing and departure from the schedule dialog; berth list and schedule follow; the manager has no movement button | e2e | passed |
| UC021 and UC025 rechecked on data made by the real UC030/022/023 flow (not hand-inserted plan rows) | integration (schedule `ACTUAL` bars, berth states) | passed |

## 3. Quality review

- **Existing behaviour changed on purpose** (documented in `m2-planning-design.md` §8): the berth-state query shows a `BERTHED` voyage as in use even when the plan start is still in the future; plan overlap checks treat a `COMPLETED` plan as ending at the actual departure. Both are covered by the tests above and the earlier Module 2 tests still pass.
- Migration consistency: no migration added; nothing to roll back.
- Legacy repositories and non-disposable databases were not touched. Verification databases were not deleted.
- Test mistakes found on the way (no product defect): BIGINT values compared as numbers (revision, plan id); the end-to-end test first lacked ship documents (MISSING_DOCUMENTS, correct policy behaviour) and its clean-up missed validation runs and ETA predictions (fixed; clean-up verified).

## 4. Not verified

- AI-dependent criteria: none are claimed. The ETA provider is not configured (UC027 not started).
- A delay beyond 5 seconds cannot be excluded for users without the live channel (they refresh every 30 s).
- Several API processes; browsers other than Edge; a vessel that was assigned a berth but never arrives (no rule specified; the berth stays reserved).
- UC-033 (re-planning when the vessel uses another berth) is not built; that case is refused.
