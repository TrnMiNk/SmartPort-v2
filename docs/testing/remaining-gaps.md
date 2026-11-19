# Remaining gaps: Modules 1 and 2 (audit of 2026-11-19)

Audit only. Nothing here was fixed. Classes: **A** defect or inconsistency in the current code, **B** missing or unstable evidence, **C** business decision needed, **D** needs a real AI or external data source, **E** outside the two modules (other UCs), **F** operational or deployment limit. Severity: High, Medium, Low. "Mandatory" means the SRS requires it for the two modules; "Optional" means it is a quality or convenience item.

> **Update 2026-11-19:** A1 is fixed (fail-closed version and checksum check at startup, `docs/demo/final-demo-readiness.md` section 4). F3 stays open until the demo accounts are seeded with the owner's password. Other rows are unchanged.

> **Update 2026-11-19 (E2E):** B3/A4: the UC027 detached-node failure had a confirmed cause (test raced a background list reload) and is fixed in the test; 5 of 5 complete E2E runs passed. The UC021 blank sign-in page did not reproduce and its cause is **unproven**; diagnostics were added. Evidence: `docs/testing/e2e-stability-evidence.md`.

> **Update 2026-11-19 (A2/B1):** A2 closed in code and tests: validation and queue moves now send content-free hints on the berth channel (see `docs/testing/a2-b1-realtime-evidence.md`). B1: 201 browser measurements across 3 suite runs, all under 5000 ms (max 169 ms) for notice-to-queue, queue move, plan submission, approval, rejection reason, berthing and departure; measured on one process, idle machine. Still open: B2 (50 users, 3 s), F1 (hints in-process, multi-process not implemented), notices to Modules 3 to 5 (E4), the asynchronous-ETA reorder is not timed.

> **Update 2026-11-19 (A3):** A3 closed in code and tests: the time x position chart with drag and drop through the UC-026 dialog (FR-BRT-03, UC-028), evidence `docs/testing/a3-chart-evidence.md`. Open on the chart: assumptions CH-1 to CH-3 need approval; no keyboard drag; large queues untested. B3/UC021: one recurrence was diagnosed as `net::ERR_NO_BUFFER_SPACE` on a script request (environmental, this machine); earlier occurrences unproven; still not resolved.

> **Update 2026-11-19 (B2, B6, A5):** B2 met under the stated limits (0 failures, none above 3 s, 50 users, one machine); B6 no High finding, two defects fixed, new open items B6-3 (NFR-SEC-06, no encryption at rest, Medium, mandatory SRS) and B6-4 (rate limit, CSP/HSTS: production-dependent); A5 reconciliation done. Evidence `docs/testing/b2-b6-evidence.md`.

> **Update 2026-11-19 (security closure):** B6-3 (NFR-SEC-06): TDE verified on a disposable database (192 integration tests unchanged, restore proved with and without the certificate, no measurable load impact; `docs/testing/tde-evidence.md`, `docs/architecture/encryption-at-rest.md`); **not closed** until enabled on the target database with certificate custody and the owner's decisions (ENC-1). Release go/no-go in `docs/release/release-readiness.md`.

## 1. Issue register
| ID | Class | Sev | UC | Criterion | Issue | Depends on | Completion action | SRS |
|---|---|---|---|---|---|---|---|---|
| A1 | A / F | High | all | startup safety | `assertSchemaReady` only checks that `schema_migrations` has a row. API starts on a database without migration 0008 (and 0006/0007) and then fails at notice validation and ETA history. All demo and verification databases except `SmartPortV2_UC027` and `SmartPortV2_Mig` are in this state | none | make startup compare the applied versions with the latest and refuse to start (fail closed); then migrate or recreate demo data by the documented procedure with the owner's permission | Mandatory (reliability) |
| A2 | A | Medium | UC015, UC020, UC025 | refresh | No refresh hint when a notice is validated or the queue is moved; a second coordinator sees it after the 30 s timer or a reload | none | publish a queue hint on validation and queue move, plus a test | Optional (SRS 5 s concerns notices and berth state; see B1) |
| A3 | A | Medium | UC027, UC028 | main flow step 6 | The plan chart "time x position" and drag and drop are not built; proposals and placement are tables and forms | UI design decision | build the chart on the existing check endpoint, or record a deviation accepted by the owner | Mandatory if the SRS wording is binding (C5) |
| A4 | A | Low | UC027 | usability | The click on "Lưu và gửi duyệt" can be lost when the plan list re-draws at the same moment (E2E "Node is detached") | none | do not re-draw while a button is pressed; keep the test deterministic | Optional |
| A5 | A | Low | docs | consistency | Stale statuses and acceptance lines in UC013, UC015, UC020, UC021, UC025, UC026, UC028, UC029, UC030 headers; `two-modules-demo.md` says AI proposals are not available | none | update text only, no status change | Mandatory (documentation honest) |
| B1 | B | High | UC025, UC030 | 5 s | No assertion at 5 s for plan approval, berthing, departure and notices to yard/cranes/gate; tests wait 8 s. Measured about 0.1 to 0.3 s on open pages | none | add 5 s assertions in the browser tests and a measured table | Mandatory |
| B2 | B | High | NFR | at least 50 users, at most 3 s | Not executed | a load tool and a test database | run a documented load test, record the result | Mandatory |
| B3 | B | Medium | tests | stability | Browser E2E not clean today (50 of 51 three times, a different test each time: UC-021 blank page, UC-027 detached node twice) | A4, machine cleanup | find the cause (leftover Edge/Node processes, static server, load), then require repeated clean runs | Optional but needed before sign-off |
| B4 | B | Medium | all | concurrency | An unexplained SQL lock wait was seen earlier; only one API process tested | none | reproduce with logging; test two API processes (hints, worker, jobs) | Optional |
| B5 | B | Low | all | browsers | Only Edge | none | one pass in a second browser | Optional |
| B6 | B | Medium | security | NFR security | `npm audit`, HTTPS and the `Secure` cookie, a real 30-minute session wait not executed | environment | run and record | Mandatory (security NFR) |
| B7 | B | Low | UC001 | MFA | MFA is not enforced (design copy only) | C6 | decide and implement or defer | Depends |
| C1 | C | High | UC015 | step 4, AC-1 | The asynchronous ETA design (queue on the declared ETA, forecast later) deviates from "queue by the forecast ETA". Needs business acceptance and wording change (AE-1 to AE-6) | owner | accept or reject; if rejected, a synchronous design cannot meet 5 s with a 10 s provider | Mandatory decision |
| C2 | C | Medium | UC026, UC027 | rules | Unapproved assumptions: UC026 A-1 to A-3, A-6; UC027 P-1 to P-10; UC020 Q-1 to Q-3; M-1 to M-5, D-4, N-1 | owner | review and approve or change; then update tests | Mandatory decision |
| C3 | C | Medium | UC015 | policy | The validation policy (`UC015-POLICY-V1`) is a development assumption (A-1) | owner | approve the policy content | Mandatory decision |
| C4 | C | Low | UC013 | unverified cargo at a labelled berth, TEU 0 | open questions (P-7) | owner | decide | Optional |
| C5 | C | Medium | UC027 | what counts as "AI" | whether the local optimizer is acceptable for the UC or an AI service is required | owner | decide; the provenance already separates the two | Mandatory decision |
| C6 | C | Low | UC001 | MFA scope | enforce MFA in this delivery or not | owner | decide | Optional |
| D1 | D | High | UC015, UC016 | AI ETA | No real ETA provider, model, AIS or weather data. Real forecast, quality and MAE cannot be verified | data, model, provider | integrate and evaluate; until then every forecast test is a mock | Mandatory in the SRS, blocked |
| D2 | D | High | UC027 | AI berth | No AI service `/recommend/berth`, no trained model, no periodic quality evaluation (NFR-ACC-04) | data, model | same | Mandatory in the SRS, blocked |
| D3 | D | Medium | UC016 | MAE | the SRS defines no actual-arrival event; labels do not exist (`docs/architecture/eta-semantics.md`) | business definition | define the arrival event and collect labels | Blocked |
| E1 | E | Medium | UC033 | re-plan | Re-plan after a refused approval or a vessel at another berth is not built (refused instead) | module scope | next module | Out of scope |
| E2 | E | Medium | UC012, UC014 | documents, partner API | Documents for validation are inserted by SQL; no upload or review | module scope | next module | Out of scope |
| E3 | E | Low | UC017, UC018, UC034, UC007, billing | other modules | Not started, by instruction | none | none | Out of scope |
| E4 | E | Medium | UC030 | notices to Modules 3 to 5 | Yard, cranes and gate are not built, so their notices cannot be delivered or measured | those modules | when they exist | Out of scope |
| F1 | F | Medium | realtime | scaling | SSE hints and the worker refresh are in-process; several API processes see hints late | B4 | shared channel (database or broker) if more than one process is needed | Optional |
| F2 | F | Low | tests | isolation | Integration and E2E share one database; the guard stops on a dirty queue; chains must run sequentially | none | per-run database or cleanup | Optional |
| F3 | F | Medium | demo | data | Demo databases cannot run the current code (A1) | A1 | see `docs/demo/final-demo-readiness.md` | Mandatory for the demo |

## 2. Mandatory SRS items that are not yet satisfied
A1 (fail-closed startup), B1, B2, B6, A3 or its accepted deviation, C1, C2, C3, C5, D1, D2, A5. Items D1, D2, D3 cannot be closed in this repository without a provider and data.

## 3. AI requirements that cannot be verified now
Real ETA forecast and its confidence, MAE and any ETA accuracy target; the AI berth service and any proposal quality against real data; periodic evaluation NFR-ACC-04; behaviour and load of a real provider. Local tests use labelled mocks and a deterministic local optimizer. None of these may be reported as AI evidence.

## 4. Business decisions needed
C1 asynchronous ETA acceptance; C2 assumption sets; C3 validation policy; C5 optimizer versus AI service; C4 and C6 as minor.

## 5. Minimum remaining slices and priority order
1. **Slice 1 (A1, F3):** fail-closed startup version check, then a demo database created by the documented procedure (or a migrated copy, with the owner's permission). Smallest, highest risk reduction.
2. **Slice 2 (B1, A2, A4, B3):** assert 5 s events in the browser, add the queue hint, remove the re-render race, require repeated clean E2E runs.
3. **Slice 3 (B2, B6):** NFR run: 50 users, 3 s; `npm audit`; HTTPS cookie check.
4. **Slice 4 (A3):** plan chart, or an accepted deviation.
5. **Slice 5 (A5):** update stale UC documents (text only), after the owner's decisions C1 to C3.
6. **Then, by decision:** UC033, UC012, AI providers (D1 to D3).

## 6. What would allow a status change
- UC026 to Completed: owner accepts the assumptions (C2) and the header text is updated.
- UC015, UC016, UC027 to Completed: C1, C3, C5 decided and, for the AI parts, D1 and D2 satisfied. Without them they remain Implemented.
- UC020, UC025, UC028, UC030: B1, A2 and A3 closed, then the owner decides.
No status was changed by this audit.

## 7. Unapproved business assumptions (must not be treated as requirements) and new items, 2026-11-19
| Item | Where | State |
|---|---|---|
| Validation policy content `UC015-POLICY-V1` (A-1) and asynchronous ETA design AE-1..AE-6 | UC015 | development assumptions / V2 design decision, not accepted |
| Queue order Q-1..Q-3 | UC020 | unapproved |
| Berthing tolerance M-1, M-2..M-5, an assigned vessel that never arrives keeps the berth (D-4) | UC022/UC023 | unapproved except where an owner decision is recorded in the UC file |
| Berth state assumptions A-2..A-5 | UC025 | unapproved |
| Placement rules A-1..A-3, A-6 (engineering); A-4, A-5, A-7 (owner decisions) | UC026 | as stated |
| Optimizer parameters P-1..P-10 | UC027 | unapproved |
| Override permission for the coordinator; role-notice shared read mark N-1 | UC028/UC029 | unapproved |
| C-1, F-1, F-1b, F-4 | UC030 | owner decisions recorded in the UC file |
| A-2 (a rejected plan is final), A-5 (a user with both roles may reject their own plan) | UC031 | unapproved |
| **CH-1** time on the x axis, position on y; **CH-2** snap 15 min / 1 m; **CH-3** tray drop: stretch = LOA and a 12 h default stay | plan chart | new, unapproved UI assumptions (`docs/testing/a3-chart-evidence.md`) |
| **PF-1** NFR-PER-07 is met only if no usual request exceeds 3 s and none fails (the SRS names no percentile) | B2 | new, unapproved reading |
| Opaque HttpOnly sessions instead of JWT; MFA not enforced | NFR-SEC-02, UC001 | deviation / decision C6 |
New open items: **B6-3** encryption at rest (NFR-SEC-06) needs a deployment decision (TDE or Always Encrypted); **B6-4** rate limiting, CSP, HSTS at the web host; **H-1** one intermittent browser-test failure at sign-in (`sign-in did not complete`, chain of 2026-11-19, cause unknown; diagnostics added) besides the diagnosed `ERR_NO_BUFFER_SPACE` recurrence.

**ENC-1** (assumption, unapproved): every table of the database is in scope of NFR-SEC-06, so database-level encryption at rest (TDE) satisfies it. **H-1** update: one unknown-cause sign-in failure, now with diagnostics; 0 recurrences in 6 suites since.
