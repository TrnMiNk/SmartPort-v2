# Final acceptance matrix: Modules 1 and 2 (audit of 2026-11-19)

This is an **audit**. No code, schema, database or UC status was changed. A recorded status changes only with evidence and an owner decision; where this audit thinks the evidence supports another status, it says so as a **candidate**, and the recorded status stays. Sources: the SRS (`SmartPort/runtime-verification/final-acceptance/usecases.txt`, read only), `docs/use-cases/*.md`, `docs/traceability.md`, the evidence files in `docs/testing/`, the code, the migrations 0001 to 0008, and the test runs of this audit.

## 1. Evidence base of this audit

| Item | Result |
|---|---|
| API unit tests (`npm run test:unit`) | **passed 113 of 113** (run for this audit) |
| SQL Server integration (`npm run test:integration`, disposable DB `SmartPortV2_UC027`, migrations 0001 to 0008; migration tests on `SmartPortV2_Mig`) | **passed 188 of 188** (run for this audit) |
| Front unit (`npm test`) | **passed 55 of 55** (run for this audit) |
| Browser E2E (`npm run test:e2e`, Edge, same DB) | **not clean in this audit: 50 of 51 in each of three full runs; a different test failed each time** (details in 2). The previous day's report of 51 of 51 three times is not reproduced today |
| Read-only checks of the other databases | section 4 and `docs/demo/final-demo-readiness.md` |
| Real AI provider, real AIS, real arrival labels | none exist; every forecast in the tests comes from a labelled mock |

The suites ran one after the other. Nothing here is evidence of AI quality.

### 2. The E2E failures of this audit (investigated, not retried away)
| Run | Failing test | Message | Reading |
|---|---|---|---|
| 1 (chain) | UC-027 in the browser | step not captured (the chain log keeps only the summary); the test passed when run alone | same family as run 3 |
| 2 | UC-021 schedule | `sign-in form missing: url=.../login.html body=""` (the page is blank) | the **known intermittent failure** returns (earlier: UC-021 5a, UC-010); cause **still unproven**; a blank page right after `goto` points at the static server or the machine, not at the application logic |
| 3 | UC-027 in the browser | `Node is detached from document` at the click on "Lưu và gửi duyệt" (`recommendations.e2e.test.js:143`) | the plan list was **re-drawn between finding and clicking the button** (it reloads after the draft was saved). A race between the test and the live refresh, and a small real risk: a person clicking at that instant loses the click (low severity). Not a data defect |
These count as **B (missing stable evidence) and F (reliability)**, not as UC failures: every assertion of the failing tests that ran before the race passed. Until E2E is clean on repeated runs, "51 of 51" must not be quoted as a stable result.

## 3. Summary

| Group | UCs | Recorded status | Count |
|---|---|---|---|
| Direct, Module 1 | UC013, UC015, UC020, UC021, UC022, UC023 | Completed: UC013, UC021, UC022, UC023. Implemented: UC015, UC020 | 4 Completed, 2 Implemented |
| Direct, Module 2 | UC024 to UC031 | Completed: UC024, UC029 (manual path), UC031. Implemented: UC025, UC026, UC027 (local), UC028, UC030 | 3 Completed, 5 Implemented |
| **All 14 direct UCs** | | | **7 Completed, 7 Implemented, 0 Blocked, 0 Not Started** |
| Supporting | UC001, UC002, UC010, UC011 Completed; UC005 Implemented; UC016 Implemented (non-AI); UC006, UC007, UC012 Analyzed (not built) | | 4 Completed, 2 Implemented, 3 not built |

The recorded statuses are consistent with the evidence, **except** that the headers and acceptance lines of several UC files are stale (section 5). Candidates for a status change after an owner decision: UC026 (all three criteria evidenced, header obsolete). Nothing else.

## 4. Per-UC audit
Notation: **P** passed, **PP** partly, **NE** not executed, **B** blocked. "Mock" means a labelled stand-in for a provider.

### UC013 Arrival notice (Module 1). Recorded: Completed
- **Purpose:** agent or coordinator announces a vessel arrival (ship, voyage, origin port, declared ETA, cargo, TEU), drafts allowed, duplicate and scope checks.
- **Criteria and evidence:** AC-1 history with time and actor **P** (integration `flow.http`, e2e `vessels`); AC-2 no duplicate vessel and voyage **P**; AC-3 agent only for its own vessel **P**; AC-4 reaches validation and queue within 5 s **P** (0.08 to 0.24 s measured; the UC file still says "not executed", stale).
- **Implemented:** notice, drafts (create, edit, discard, submit, idempotent), automatic hand-off to UC-015, agent scoping, UTC+7 entry.
- **Missing / unverified:** documents for the validation (UC-012) are inserted by SQL in every test and demo: there is no upload or review. UC-014 (partner API) not in scope.
- **Assumptions:** draft handling A-6. **Deviations:** none known.

### UC015 Automatic validation and queue entry. Recorded: Implemented
- **Purpose:** validate a notice by deterministic policy, forecast the ETA, queue valid voyages by ETA and priority, no human step.
- **Criteria and evidence:** AC-1 queue within 5 s **P** with the AI unavailable or slow (mock 5.5 s: submission 34 to 45 ms; mock silent: 25 to 32 ms); AC-2 invalid never queued **P**; AC-3 determinism **P**; AC-4 audit record per run **P**; AC-5 no human confirmation **P**; AC-6 policy failure writes nothing **P**; AC-7 infrastructure failure not converted **P**; 3a (10 s) **P with mocks** (real 10 s wait with a mock); step 3 real AI forecast **NE**; step 4 queue by forecast **P with mocks**.
- **Implemented:** `validationService`, policy `UC015-POLICY-V1`, asynchronous ETA (migration 0008), worker, durable jobs.
- **Missing / unverified:** a real provider; the first queue placement uses the declared ETA (deviation from the wording of step 4); several API processes.
- **Assumptions:** policy content A-1 (development assumption), AE-1 to AE-6. **Deviations:** AE-1 (async), 3a is met in effect.

### UC020 Berth queue. Recorded: Implemented
- **Purpose:** show the waiting queue in order, let a coordinator move a voyage with a reason.
- **Criteria and evidence:** AC-1 reason and actor on every change **P** (integration, schema); AC-2 correct order after a change **P** for the person who moves; AC-3 stale view refused with 409 **P** (two coordinators test). The three lines in the UC file still say "pending" (stale).
- **Missing / unverified:** a second coordinator's open queue is **not refreshed by a hint** when a voyage enters or is moved (hints exist for plans, berths and forecasts, not for queue changes): it updates on the next reload. Step 6 (tell Module 2) is satisfied only by Module 2 reading the queue.
- **Assumptions:** Q-1 to Q-3 ordering (unapproved). **Deviations:** none known.

### UC021 Vessel schedule (list and Gantt). Recorded: Completed
- **Criteria and evidence:** AC-1 filters **P**; AC-2 bar at the stored times **P** (integration, e2e); verified with data made by the real UC-030, UC-022 and UC-023 flow (the old "fixtures only" limitation is gone; the header text is stale).
- **Missing / unverified:** none against the criteria. **Known flaky:** E2E UC-021 test (section 2).

### UC022 Confirm berthing. Recorded: Completed
- **Criteria and evidence:** AC-1 berth "Đang sử dụng" **P**; AC-2 ATA shown **P**; AC-3 history and audit **P** (integration `voyage-movement`, e2e two accounts); exceptions 2a, 4a (wrong berth refused), no plan, 5a **P**.
- **Missing:** UC-033 re-plan when the vessel uses another berth (refused instead; out of scope). **Assumptions:** M-1 (5-minute tolerance), M-2 to M-5; D-4 (an assigned vessel that never arrives keeps the berth). **Deviations:** the SRS term "Đã xếp bến" is the new state `BERTH_ASSIGNED` (decision C-1).

### UC023 Confirm departure. Recorded: Completed
- **Criteria and evidence:** AC-1 `DEPARTED` with ATD **P**; AC-2 berth free for later intervals, other approved plans and maintenance respected **P**; AC-3 history **P**; ATD before ATA, not berthed, concurrent, duplicate **P**.
- **Assumptions:** M-1, M-5 (plan becomes COMPLETED). **Missing:** billing clearance is out of scope for this delivery (SRS: from Đợt 3).

### UC024 Berth catalog. Recorded: Completed
- **Criteria and evidence:** AC-1 new berth usable without code change **P**; AC-2 unique code, concurrent creation **P**; AC-3 edit with plans warns and confirms **P** (integration, e2e).
- **Missing / unverified:** none against the criteria.

### UC025 Berth state. Recorded: Implemented
- **Criteria and evidence:** AC-2 derived states **P** (unit and integration, all five labels); AC-3 connection loss warning and recovery **P**; AC-1 change visible within 5 s: **PP**: catalog changes and hints are proven; plan approval, berthing and departure updates are proven with **8 s waits**, not asserted at 5 s; maintenance changes cannot occur (UC-034 not built).
- **Assumptions:** A-2 to A-5. **Missing:** measurement of the 5 s for those events; the SSE hint is in-process.

### UC026 Placement check. Recorded: Implemented
- **Criteria and evidence:** AC-1 every violation names rule and reason **P**; AC-2 saved plans have no violation unless overridden **P for manual and local-optimizer plans** (draft save, submission and approval all recheck; database `CK_bp_reviewed`; the UC header still says UC-028/029 are not built, stale); AC-3 buffer from parameters **P**. Occupancy of a berthed vessel until actual departure **P** (defect fixed in the hardening slice, regression tests).
- **Candidate for Completed** once the owner accepts the documented assumptions (A-4, A-5, A-7 were owner decisions; A-1 to A-3, A-6 are engineering).

### UC027 Berth recommendation. Recorded: Implemented (local optimizer)
- **Criteria and evidence:** AC-1 10 s for 20 vessels **P for the local engine** (engine 262 ms, end to end 335 ms; fixture data), **B for an external AI**; AC-2 proposals and the human decision stored **P** (migrations 0006, 0007); AC-3 manual path **P**; BR-1 UC-026 on every proposal **P** (0 violations); provenance `LOCAL_OPTIMIZER` not "AI" **P**.
- **Not fulfilled (SRS):** an AI service at `/recommend/berth`; a trained model; periodic quality evaluation (NFR-ACC-04); **the plan chart "thời gian x vị trí" of main-flow step 6 is not built** (proposals are shown as tables); quality against real data is unknown (on constructed scenarios V2 is not worse than first-fit).
- **Assumptions:** P-1 to P-10 (unapproved).

### UC028 Manual plan and adjustment. Recorded: Implemented
- **Criteria and evidence:** AC-1 violation always warns **P**; AC-2 override has reason and audit **P**; AC-3 override plan has source and reason **P** (`MANUAL`, `LOCAL_OPTIMIZER`, `LOCAL_OPTIMIZER_ADJUSTED`; `AI` reserved).
- **Missing:** the drag-and-drop plan chart (placement is a form; every save is a server check). **Assumptions:** override needs the permission `override` for the coordinator.

### UC029 Submit for approval. Recorded: Completed (manual path)
- **Criteria and evidence:** AC-1 reaches `PENDING_APPROVAL` **P**; AC-2 manager notified **P** (browser, push within about 0.1 to 0.2 s); AC-3 no plan with unresolved violation **P**.
- **Assumptions:** N-1 (a role notice has one shared read mark). **Missing:** none for the manual path; AI-sourced plans now exist through the local optimizer (tests pass).

### UC030 Approve a plan. Recorded: Implemented
- **Criteria and evidence:** AC-2 refused if a rule fails **P** (recheck at approval, hazard, maintenance, overlap, out-of-service); AC-3 only `BAN_QUAN_LY` **P**; AC-4 audit **P**; AC-1 all parties within 5 s **PP**: the submitter and the voyage's agent users are measured (about 0.1 to 0.3 s on open pages, agents by hint); the **yard, cranes and gate notices belong to Modules 3 to 5** (out of scope).
- **Assumptions:** C-1, F-1, F-1b, F-4 (owner decisions). **Deviations:** "re-plan" after a failed approval is not built (UC-033).

### UC031 Reject a plan. Recorded: Completed
- **Criteria and evidence:** AC-1 reason to the coordinator within 5 s **P** (browser, open page); AC-2 berth state unchanged **P**; 4a reason required **P**; 5a already decided **P**; concurrency with approval **P**.
- **Assumptions:** A-2 a rejected plan is final (new draft instead of resubmission), A-5 a user with both roles may reject their own plan.

### Supporting
- **UC016 ETA forecast display (Implemented, non-AI):** display of the four values, history with queue effect, UNAVAILABLE and PENDING states **P** (mock for values); real forecast, data and model **B**; MAE **B** (no actual-arrival event is defined by the SRS, see `docs/architecture/eta-semantics.md`).
- **UC001 / UC002 authentication (Completed):** lock after five failures, uniform error, logout, expiry **P**. Not executed: HTTPS `Secure` cookie, real 30-minute wait, MFA (design copy only). **UC005 RBAC (Implemented):** SRS matrix enforced on the server for every audited endpoint **P**; the admin screen is out of scope.
- **UC010 / UC011 ship registration (Completed):** create, search, edit with revisions, deactivate, history **P**. Ship **documents (UC-012)** are not built.
- **Notifications:** per-user and per-role notices, read marks, push hints (including users without berth permission) **P**; role notices share one read mark (N-1); push is in-process.

## 5. Cross-module consistency (Phase 4)
| # | Check | Evidence | Result | Residual |
|---|---|---|---|---|
| 1 | Approved plans and voyage states | `check-consistency.js` (9 checks, 24 demo voyages), integration for UC030 to UC031, UC022, UC023 | consistent | script is read-only and not part of the test run |
| 2 | Queue with manual moves and async ETA | `eta-async` tests: manual move kept, priority kept, two concurrent forecasts, positions 1..n | consistent | AE-2, AE-3 unapproved |
| 3 | Berth occupancy until actual departure | UC-027 hardening regression, UC-022/023 tests | consistent (one defect fixed earlier) | a vessel that never arrives (D-4) |
| 4 | Hazardous cargo | hazard consistency test across recommendation, draft, submit, approval | consistent | TEU 0 treated as missing (P-7); open question: unverified cargo at a labelled berth |
| 5 | Approval, rejection, audit | integration: audit rows for every state change; DENIED rows | consistent | none |
| 6 | Notices within 5 s for applicable recipients | browser measurements 0.05 to 0.3 s for open pages and agents | met for roles in scope | the **validation notice (UC-015 step 6) and queue changes are not pushed**: coordinators see them after the 30 s timer; yard/cranes/gate notices out of scope |
| 7 | Recommendation provenance and human decisions | migrations 0006, 0007 tests; integration decisions | consistent | decision only when a recommendation was used or ignored |
| 8 | Durable ETA jobs, stale results, restart | 13 async tests incl. SIGKILL and racing workers | consistent for one API process and several workers | refresh hint in-process |
| 9 | Concurrency and version conflicts | integration: simultaneous approval/rejection, drafts, queue moves, berthing, departure | consistent | single API process only |
| 10 | Migrations 0001 to 0008 | forward, rollback refusals and re-apply tests for 0003 to 0008 on a scratch DB; fresh DB migrated 0001 to 0008 | compatible | **the API starts on a database without 0008 and then fails** (section 6) |

## 6. Documentation drift (does not change a status, but must be fixed before sign-off)
UC013 AC-4 ("not executed, UC-015 not built"), UC015 header (says 5 s unverified and no async), UC020 acceptance lines ("pending"), UC021 header (fixtures only), UC025 header (UC-022/023/030 not built), UC026 header (UC-028/029 not built), UC028 and UC029 headers (UC-027 blocked), UC030 header ("not proven within 5 s", re-plan note). The traceability matrix rows are current. `docs/demo/two-modules-demo.md` says the AI berth proposals are not available (a local optimizer exists now).

## 7. Update 2026-11-19 (A2 and B1)
Gap A2 (no hint on validation and queue moves) is closed in code and tests; B1: 5 s measured in real browsers (201 measurements, slowest 169 ms) for notice-to-queue, queue move, plan submission, approval, rejection reason, berthing and departure. Cross-module check 6 and the UC020, UC025 and UC030 lines above that said "not asserted at 5 s" or "not pushed" are superseded by `docs/testing/a2-b1-realtime-evidence.md`. Remaining: load (B2), multi-process (F1), Modules 3 to 5 recipients. Recorded UC statuses are unchanged.

## 8. Update 2026-11-19 (A3)
Gap A3 (plan chart and drag and drop) is closed in code and tests; UC027 step 6, UC028 steps 1, 2, 4, 2a, UC026 4a and FR-BRT-03 now have a chart (evidence `docs/testing/a3-chart-evidence.md`). The "not built" statements about the chart in sections 4 and 6 above are superseded. Recorded UC statuses are unchanged (UC026 to UC028 stay Implemented until the owner decides). E2E: three consecutive clean complete runs (58 of 58) after two earlier chains with one environmental failure each; UC021's blank page has one diagnosed recurrence (`ERR_NO_BUFFER_SPACE`), cause of earlier ones unproven.

## 9. Update 2026-11-19 (B2, B6, A5)
- **B2 (NFR-PER-07):** measured with 50 independent signed-in HTTP sessions on one machine and one API process: 0 failures, 0 requests above 3 s, slowest 613 ms (steady) and 341 ms (stress); 100 users also below 0.6 s. A defect it exposed (synchronous password hashing: 50 simultaneous sign-ins took 1.5 s) was fixed (0.3 s). Not a browser, network, multi-process or production-host test. Evidence: `docs/testing/b2-b6-evidence.md`.
- **B6 (NFR-SEC-01/02/04/05):** `npm audit` 0 vulnerabilities (API and Frontend); SQL injection, XSS, CSRF/CORS, cookies, limits, secrets in logs, RBAC and HTTPS (local TLS proxy, pinned certificate) are covered by automated regression tests: no High finding in what was tested. Fixed: blocking hashing, insecure production configuration accepted. **Open:** NFR-SEC-06 (data encrypted at rest: both databases unencrypted), no general rate limit, CSP/HSTS belong to the web host, MFA not enforced, JWT replaced by opaque sessions (deviation).
- **A5:** UC status lines, acceptance wording and the traceability reconciliation were brought in line with the code (`docs/traceability.md`, last section). Recorded statuses unchanged. Statements in sections 4 to 6 above about 5 s not asserted, the chart not built, or hints missing are superseded by the A2/B1/A3 updates.
- **Unapproved business assumptions** are listed in `docs/testing/remaining-gaps.md` section 7 and must not be read as approved requirements.
- Counts of the recorded statuses are unchanged: 7 Completed and 7 Implemented of the 14 direct UCs.

## 10. Update 2026-11-19 (security closure and release readiness)
NFR-SEC-06: solution (TDE) verified, not enabled; B6-3 stays open (`docs/testing/tde-evidence.md`). Release checklist and what blocks full SRS acceptance: `docs/release/release-readiness.md`. Recorded UC statuses unchanged.
