# Critical gaps (legacy)

Each item lists sources, observed behavior, affected UCs, severity, a recommended resolution, and whether the conclusion is **confirmed** (checked in source) or **inferred** (reasoned from absence or indirect evidence). Nothing here was changed in legacy code.

Severity: **High** blocks a documented UC or a business rule. **Medium** weakens evidence or contracts. **Low** is naming or documentation.

## G1. `ships` table has no baseline migration — High

- **Sources:** `backend-nodejs/database/migrations/001_uc010_extend_ships.sql` (ALTER only); `002_uc011_ship_lifecycle.sql`; a search of all `*.sql` and `*.js` under `backend-nodejs`, `backend-nodejs-git-backup`, `QLDAPM/src`, `ai-eta`, and the repo root found no `CREATE TABLE` for `ships`. `server.js` and services query `dbo.ships` (for example `voyageOperations.js` lines 91, 166, 231).
- **Observed:** `ships` is extended and queried but never created in the repo.
- **Affected:** UC-010, UC-011, UC-012, UC-013, UC-015, UC-016, UC-021, UC-022, UC-023, UC-024, UC-025, UC-032.
- **Severity:** High.
- **Confirmed:** no creation in repo.
- **Inferred:** the table exists in a database created outside the repo (a schema snapshot or manual setup). Not verified.
- **Recommended resolution:** obtain the baseline schema from the database owner (or the original SQL Server database). Write a V2 baseline migration that creates `ships` with the columns the 001–002 migrations and services use. Test it on an empty database before the first V2 release.

## G2. `berths` table has no baseline migration — High

- **Sources:** same search as G1. `berthPlanning.js` lines 58, 72, 127, 151, 173, 188; `voyageOperations.js` lines 255, 305; `replanningImpact.js` line 78 query `dbo.berths`. No migration creates or alters it. Migration `010_m2_berth_planning_foundation.sql` creates `berth_plans`, `berth_maintenance`, `planning_audit`, `planning_idempotency`, but not `berths`.
- **Affected:** UC-024, UC-025, UC-026, UC-032, UC-034, UC-035, UC-021, UC-022, UC-023.
- **Severity:** High.
- **Confirmed:** no creation in repo.
- **Inferred:** created outside the repo, as with `ships`.
- **Recommended resolution:** same as G1. Also confirm the berth master data source (catalog maintained by UC-024 or seeded). Document it before V2 baseline work.

## G3. AI ETA is a stub, and the UC-015 automatic path never calls AI — High

- **Sources:**
  - `ai-eta/eta_ml/api.py` lines 66–73: `/health` returns `preparation_only`, `modelReady: false`. `/predict/eta` always returns `UnavailableResponse` (`NOT_CONFIGURED`).
  - `backend-nodejs/services/etaPredictionAdapter.js` line 8: inline stub `etaPredictionAdapter.predict` returns `unavailablePrediction` with no network call. Comment: "Keep inline UC015 off until an asynchronous workflow owns its longer network budget."
  - `services/voyageValidation.js` line 17: `adapter = etaPredictionAdapter` (the stub) by default. Line 51: `predictSafely(adapter, ...)`.
  - `services/automaticVoyageValidation.js` line 25: passes `options` only, with no adapter. `server.js` line 46 passes no adapter.
- **Observed:** UC-015 step 3 ("gọi dịch vụ AI dự báo ETA") is not performed. Every automatic run records `NOT_CONFIGURED`. The UC-015 acceptance criterion "valid voyage in queue within 5 s" is met without a forecast.
- **Affected:** UC-015 (main flow step 3), UC-016 (no real forecast), UC-017, UC-018/019 (prediction-dependent parts), UC-092 indirectly (not in scope yet).
- **Severity:** High.
- **Confirmed:** by code paths above.
- **Recommended resolution:** decide the AI provider contract for V2 before implementing UC-016. Then (a) provision a model service that returns `AVAILABLE` with the normalized fields, (b) wire the HTTP adapter into the UC-015 path or document an explicit "queued, forecast pending" outcome approved in the UC, and (c) add a test that fails when the automatic path returns `NOT_CONFIGURED` for a configured environment.

## G4. UC-015 timeout default is 1.5 s; specification says 10 s — Medium

- **Sources:** `services/voyageValidation.js` line 17 `etaTimeoutMs = 1500`. `routes/voyageValidation.js` line 24 accepts `etaTimeoutMs` but `server.js` does not pass it. Specification `usecases.txt` line 2212: "AI không phản hồi sau 10 giây".
- **Observed:** the UC-015 path uses 1.5 s unless a caller overrides it. Test `uc015-validation.test.js` line 179 sets `etaTimeoutMs: 10` explicitly.
- **Affected:** UC-015 (exception flow 3a). Also UC-016 HTTP path uses `ETA_AI_TIMEOUT_MS` default 10000, so the two paths differ.
- **Severity:** Medium. It has no effect until G3 is fixed (the stub returns at once).
- **Confirmed:** values in code and spec.
- **Recommended resolution:** align the default to the specification (10 s) for UC-015, or document a deliberate shorter budget with the business owner. Make the two paths share one timeout source.

## G5. Berth AI recommendation provider is not in the repo — High

- **Sources:** `services/berthRecommendationAdapter.js` lines 6, 9, 14: posts to `BERTH_AI_BASE_URL` + `/recommend/berth`; without config, returns `MODEL_NOT_CONFIGURED`. `ai-eta/eta_ml/api.py` has no `/recommend/berth`. Specification UC-027 (line 2661 onward) requires AI proposals within 10 s, up to 20 voyages.
- **Affected:** UC-027, UC-028 (proposal source), UC-029 (indirectly), UC-109 (model quality review).
- **Severity:** High for UC-027 completion.
- **Confirmed:** no `/recommend/berth` in `ai-eta`.
- **Inferred:** a provider exists elsewhere, or was planned but not built. Not verified.
- **Recommended resolution:** identify the provider owner. Define the request and response contract (the adapter's `recommend` input and output) in the V2 API spec before implementation. Without a provider, UC-027 can only be proven with the adapter's unavailable path.

## G6. UC-028 has no dedicated accept endpoint; naming is misleading — Low

- **Sources:** `routes/berthPlanning.js` line 32 and 52: `POST /berth-plans` accepts `proposalId` and creates a DRAFT (`services/berthPlanning.js` lines 247–264). `test/uc028-plan-acceptance-service.test.js` lines 44–46 confirms `source: 'AI'` and `proposalId`. Java `Uc028PlanAcceptanceProxyTest.java` covers draft create, edit (`PUT /berth-plans/{id}`), and submit (`/submit`), which are UC-028 and UC-029 steps.
- **Observed:** accepting a proposal is "create a draft from the proposal". Adjusting is "edit the draft". The Java test name suggests an accept endpoint that does not exist.
- **Affected:** UC-028, UC-029.
- **Severity:** Low. Behavior matches the spec's intent, but the contract is implicit.
- **Confirmed:** in code.
- **Recommended resolution:** write the UC-028 contract explicitly in the V2 API spec (proposal to draft, adjustment rules, audit fields). Rename the Java test or document the mapping.

## G7. Database traces: partly resolved, some writes still unknown — Medium

- **Traced in this audit (confirmed in source):**
  - UC-021: reads `voyages`, `ships`, `berth_plans`, `berths`, `agents` (`voyageOperations.js` 300–305).
  - UC-022 and UC-023: update `voyages`, `ships`, `berth_plans`; insert `voyage_status_history`, `planning_audit` (`voyageOperations.js` 52–263).
  - UC-028: insert `berth_plans` on draft creation (`berthPlanning.js` 242); reads `berth_plan_proposals`, `berth_plan_inferences` (252).
  - UC-029: update `berth_plans`; insert `berth_plan_status_history`, `planning_audit` (`berthPlanning.js` 31, 325, 336).
  - UC-030 and UC-031: update `berth_plans` (397, 406), `voyages` (416), insert `voyage_status_history` (422).
  - UC-032: `replanning_alerts` read and update, `berth_plans`, `berth_maintenance`, `ships`, `berths` read (`replanningImpact.js` 54–167).
- **Still unknown:**
  - UC-033 (replan): the replan service's exact writes not traced.
  - UC-021: the "shipping-line" mapping is not in these tables. Its source was not found.
  - UC-023 and UC-022: whether the `berths` status update is their responsibility or UC-024/025.
- **Severity:** Medium.
- **Recommended resolution:** trace UC-033 and the berth-status writers. Add a table-to-UC matrix to the V2 data model before schema work.

## G8. Documents are ship-level; the specification requires voyage-level — High

- **Sources:** `P1_AUTOMATIC_VOYAGE_VALIDATION.md` (line 28): "Source hiện chỉ có tài liệu gắn theo ship, chưa có VOY-05 voyage-specific documents/ownership." `ship_documents` (migration 003) keys on `ship_id`. Specification UC-015 line 2202 requires documents "còn hiệu lực" for the voyage's flow, and UC-015 1a expects missing-document rechecks per voyage.
- **Affected:** UC-012, UC-013, UC-014, UC-015.
- **Severity:** High for business correctness. The code applies one ship document set to all voyages of that ship.
- **Confirmed:** by P1 doc and by the `ship_id` key.
- **Recommended resolution:** decide in the V2 data model whether a voyage has its own document requirements. If yes, add a voyage-document entity and update UC-015 and UC-012 contracts.

## G9. Notification delivery is unverified — Medium

- **Sources:** specification UC-013 step 6 and UC-015 step 6 require notifying the coordinator or the agent. `P1_AUTOMATIC_VOYAGE_VALIDATION.md` (line 50): SSE "không được dùng làm bằng chứng notification delivery tới đại lý".
- **Affected:** UC-013, UC-015, UC-014 (agent response), UC-027 (approval notice).
- **Severity:** Medium.
- **Confirmed:** no delivery mechanism other than SSE was found in the code reviewed.
- **Recommended resolution:** define the notification channel and its acceptance test in the V2 architecture. Treat SSE as a UI refresh only.

## G10. Test evidence gaps for named UCs — Low

- **No dedicated test file:** UC-013 (Node). Covered only by the Java `VoyageHttpIntegrationTest` (per the P1 doc). UC-019 (covered inside `uc018-eta-update.test.js`). UC-033 (covered inside `m2-berth-plan-review.test.js`, no UC name).
- **Severity:** Low.
- **Confirmed:** from file names and contents.
- **Recommended resolution:** name test files by UC in V2 so evidence can be traced.

## G11. Acceptance evidence covers UC-010 to UC-035 only — Medium

- **Sources:** `FINAL_UC_ACCEPTANCE.md` line 1 (`UC010–UC035`). No acceptance row for UC-001 to UC-009. Specification UC-036 to UC-111 not in the acceptance scope.
- **Affected:** UC-001 to UC-009 have no acceptance status. UC-036 to UC-111 have no legacy evidence at all.
- **Severity:** Medium.
- **Confirmed:** doc scope.
- **Recommended resolution:** add UC-001 to UC-009 to the V2 acceptance plan. Decide on UC-036 onward per phase in the roadmap.

## G12. Two-layer API duplicates contracts — Medium (architecture decision)

- **Sources:** Spring controllers in `QLDAPM` mirror Node routes (for example `OperationsController` maps `/berths`, `/berth-plans`, `/voyages/queue-state`; Node has the same paths). Spring client classes call Node by path.
- **Observed:** each endpoint is declared twice, with the prefix changed (`/api/v1` in Spring, `/api` in Node). Contract drift is possible: the Java test suite checks headers and forwarding, not the full body.
- **Affected:** all UC-001 to UC-035 flows.
- **Severity:** Medium. It is an architecture decision, not a defect.
- **Confirmed:** by source.
- **Recommended resolution:** decide in Phase 0 whether V2 keeps one API layer or two. If two, generate or share the contract. Do not copy the proxy pattern without that decision (`.claude/rules/02-architecture-rules.md`).

## G13. Runtime and E2E acceptance not established — High (for release)

- **Sources:** `FINAL_UC_ACCEPTANCE.md` lines 3, 21, 23–45. Every UC in its scope is BLOCKED or PARTIAL. The FINAL doc states: "No VERIFIED RUNTIME/E2E or rollout."
- **Affected:** all UC-010 to UC-035.
- **Severity:** High for release readiness.
- **Confirmed:** doc claim (not re-verified here).
- **Recommended resolution:** list the runtime preconditions in the V2 roadmap (baseline data, provisioned policy, provider, key configuration) as explicit milestone entry criteria.

## Items checked and not gaps

- Demo guard for UC-015 (`UC015_LOCAL_DEMO_ONLY`) is implemented and tested.
- Manual validation guard (session, loopback, operator key) is implemented.
- Idempotency and SERIALIZABLE transactions are present in the UC-013/014/015 paths (per P1 doc, code confirmed by `voyages.js` and `partnerIntegration.js`).
