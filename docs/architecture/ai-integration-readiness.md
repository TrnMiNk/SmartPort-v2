# AI integration readiness (UC015 with UC016, and UC027)

Date: 2026-11-19. Scope: assessment and provider-independent preparation only. No AI provider exists, no AI result was produced, and UC027 is not implemented. Sources: SRS lines for UC-015, UC-016, UC-027, FR-VES-05, FR-BRT-05, FR-BRT-12, NFR-PER-02, NFR-PER-06, NFR-ACC-04 (`SmartPort/runtime-verification/final-acceptance/usecases.txt`, read only); legacy preparation notes `SmartPort/UC016_AI_DATA_MODEL_AUDIT.md` and `SmartPort/ai-eta/README.md` (read only, evidence not requirements); the V2 code and schema.

## 1. Deterministic business logic versus AI inference

| Part | Kind | Where | AI needed |
|---|---|---|---|
| UC-015 documents, vessel restrictions, policy outcome, reasons, audit, queue entry | Deterministic (policy `UC015-POLICY-V1`) | `validationService`, `policy/validationPolicy.js` | No |
| Queue order (priority, then effective ETA, then entry time) | Deterministic; uses the forecast ETA **only when** a valid forecast exists, else the declared ETA | `policy/queueOrder.js`, `queueRepository` | Reads the AI output |
| ETA forecast (UC-016, step 3 of UC-015) | **AI inference** | `ai/etaAdapter.js` | Yes |
| Placement rules (loa, draft, type, cranes, overlap, buffer, hazard, maintenance) | Deterministic (`UC026-RULES-V2`, 9 rules) | `placementService`, `policy/placementRules.js` | No |
| Berth proposals (UC-027) | **AI inference** (or an optimization algorithm, see 6.2) | `ai/berthAdapter.js` (contract only) | Yes |
| Approving or rejecting a plan | Human decision | UC-030, UC-031 | No |

Rule kept: an AI answer never replaces a deterministic check. A proposal is checked again by the UC-026 rules before it is shown (UC-027 BR-1), and it never becomes a plan without UC-028 to UC-030.

## 2. AI-dependent acceptance criteria

| Criterion | Source | Inputs | Output | Timing | Failure behaviour | Status |
|---|---|---|---|---|---|---|
| UC-015 step 3: call the ETA forecast, queue by forecast ETA and priority | SRS UC-015 | voyage code, IMO, origin port, declared ETA (+ ship, speed, history, weather per UC-016) | predicted ETA, confidence | 10 s timeout (`AI_TIMEOUT_MS`) | 3a: use the declared ETA, label "chưa có dự báo AI", continue, log the error | Failure path **verified** (unit + browser, no provider). Success path **not verified** with a real provider |
| UC-015 AC-1: a valid voyage in the queue within 5 s | SRS | , | , | 5 s total | With AI down the voyage is still queued at once (measured 0.1 to 0.2 s) | Met without AI. With a slow provider (up to 10 s) AC-1 conflicts with the 10 s timeout, **unverified** |
| UC-016 AC-1: show declared ETA, predicted ETA, deviation (hours) and confidence together | SRS UC-016 | , | 4 values | , | , | **Not met**: the result dialog shows predicted ETA and confidence only; no deviation, no history of predictions (5a) |
| UC-016 AC-2: when the AI fails the business flow continues | SRS | , | , | , | as 3a | Passed (without a provider) |
| UC-016 / NFR-ACC-04: forecast error measured by MAE on a test set, **MAE below the declared ETA's deviation**; the model is re-evaluated and retrained when data changes | SRS NFR-ACC-04 | actual arrival times (labels) | MAE report | offline | , | **Blocked**: no labelled data, no model |
| UC-027 AC-1: proposals within 10 s for up to 20 queued vessels | SRS NFR-PER-02 | queue (20), berth states | 1 to 3 ranked proposals per vessel | 10 s | 3a: message and manual placement (UC-028); the manual path exists | **Blocked**: no provider; not implemented |
| UC-027 AC-2: every AI proposal is stored for quality review; **also the human final decision** (FR-BRT-12, UC-027 business rule) | SRS | , | stored request, response, proposals, decision | , | , | **Schema gap** (see 7): response and decision have no column |
| UC-027 BR-1: proposals respect UC-026 | SRS | , | , | , | , | Rules engine exists; the recheck step is not built |
| NFR-ACC-04 for berth proposals: model quality evaluated periodically | SRS | decisions and outcomes | quality report | offline | , | Blocked (no proposals, no decisions) |

## 3. Current AI architecture (what exists)

```
voyage notice -> validationService (deterministic) -> if VALID -> etaAdapter.predict(...)   OUTSIDE any DB transaction
                                                                  |
                          providerHttp.callProvider: timeout (10 s), optional Bearer key, 1 MB cap on the declared size, one log line per call
                                                                  |
                  validateEtaResponse: ISO time with offset, confidence 0..1, model_version 1..40  -> AVAILABLE | UNAVAILABLE(reason)
                                                                  |
        voyage_eta_predictions (declared ETA, status, predicted ETA, deviation, confidence, model, failure reason, input hash/JSON)
        voyage_validation_runs.ai_status; queue uses predicted ETA only when AVAILABLE
berthAdapter.recommend(...)  contract + validators + UNAVAILABLE behaviour only; nothing calls it yet
```

- No provider URL set means `UNAVAILABLE / NOT_CONFIGURED`. Nothing is simulated, anywhere. The screens say "chưa có dự báo AI".
- Configuration (environment only): `SP_AI_ETA_URL`, `SP_AI_BERTH_URL`, `SP_AI_API_KEY` (optional bearer key), `AI_TIMEOUT_MS` (system parameter, 10000). The key is placed only in the Authorization header. The log line holds the adapter name, the provider's origin and path, outcome, reason, HTTP status and duration; it never holds the URL query, the key, the request payload or the response body (tested).
- Every provider failure (HTTP error, unreachable, timeout, oversized or malformed answer) becomes a stored reason and the business flow continues.
- Added in this task (reused, not rewritten): `src/ai/providerHttp.js` (shared call, key, cap, log), `validateEtaResponse` split out of the ETA adapter (same reasons as before), `src/ai/berthAdapter.js` (request check up to 20 vessels, response check, UNAVAILABLE behaviour), config entries, tests.

## 4. Source data: what is available

| Data | For | Available in V2 now |
|---|---|---|
| Declared ETA (current and as recorded at each validation run) | ETA, queue | Yes (`voyages.declared_eta`, `voyage_eta_predictions.declared_eta`). No history of later ETA changes (UC-018 not built) |
| Ship type, LOA, beam, draft, deadweight; cargo type, TEU, priority; origin port | ETA, berth | Yes |
| Actual times | ETA labels | **ATA exists** from UC-022 and ATD from UC-023, but only demo or test data. **Semantics problem:** V2's ATA is the **berthing** time (UC-022 records when the vessel is berthed). An ETA model predicts **arrival**. Berthing time = arrival + waiting for a berth, so training on it would learn port congestion as "lateness". V2 has no separate arrival-at-port time |
| Vessel speed, position (AIS) | ETA | **No** source (UC-016 names speed as an input; legacy audit: AIS absent) |
| Weather | ETA | **No** source |
| Historical voyages of the same ship or route | ETA | Only what the system itself will record from now on; real volume is zero today |
| Port congestion | ETA | Derivable from V2's own queue and berth states, but only from the time the system is used |
| Berth catalog, berth states, approved plans, maintenance, the UC-026 rules, the queue with effective ETA | UC-027 | **Yes, all local** |
| Past placement decisions and outcomes (to evaluate proposals) | UC-027 quality | Only after use (plans approved, rejected, actual berthing and departure); none stored for proposals |

## 5. What a realistic ETA model needs

The SRS asks for a model using historical data, vessel speed and weather, judged by MAE against the declared ETA. That needs, per voyage: a snapshot taken at a known time before arrival (as-of), the declared ETA at that time, AIS speed and position known at that time, forecast weather issued before that time, and a verified actual **arrival** time. Using any value that was known only afterwards (an ATA, a later ETA, observed weather) leaks the answer and makes the measured error meaningless. The legacy folder `ai-eta/` already defines this dataset contract (schema v2, time split, leakage checks, ridge baseline, MAE/RMSE/bias report, `serving_approved=false`). It has no real dataset and no trained model.

| Option | Can run locally | Needs outside | Verdict |
|---|---|---|---|
| **A. Statistical correction of the declared ETA** (per origin port and ship type, median historical delay) | Yes | Historical voyages with **arrival** times (a few hundred at least, volume is the owner's call) | Only option that can start without third-party data. Weak but honest. Cannot be trained today: no history. Becomes possible after real use, or with a history file from the port |
| **B. ML model with AIS and weather** (the SRS target; legacy pipeline as the starting design) | Training and serving can be local (Python service) | AIS source (commercial or terrestrial receiver; open NOAA data covers US waters only), weather (ECMWF open data is CC-BY, ERA5 for history), licences, **a labelled history**, credentials and likely cost | Right target, not feasible now: no data, no licence, no model |
| **C. A general LLM asked "what is the ETA?"** | No | API key, cost | **Rejected.** It has no ship position, speed or weather; its numbers cannot be calibrated, are not reproducible, and cannot meet "MAE below the declared ETA's deviation" except by luck. It may help to explain a result in words, never to produce the number |

Required decisions before building: the definition of the **arrival** event and who records it; the meaning of `confidence` (for example "probability that the error is within X hours", which must then be calibrated; the SRS does not define it); the horizon and population the target applies to; the minimum sample and the acceptance margin for the MAE comparison.

## 6. UC-027 options

### 6.1 What the AI would need
Queue (up to 20) with effective ETA, priority and ship facts; berth states with busy and maintenance intervals; the UC-026 rule set. All of it exists locally (the request contract in `berthAdapter.js`).

### 6.2 Options

| Option | Local | Needs outside | Notes |
|---|---|---|---|
| **A. Deterministic optimizer** inside the API or a small local service: for each vessel enumerate berth and earliest start that passes the UC-026 rules, rank by expected waiting time and berth utilization | Yes | Nothing | It is a constraint search, not machine learning. The SRS says "thuật toán AI" (AI algorithm). Whether a heuristic counts as AI is a **business decision**. Reuses the rule engine, so BR-1 holds by construction |
| **B. External optimization or ML service** with the berth contract | Possible | Provider, credentials, cost, a model owner | Needs the provider's own validation; the V2 side is ready (adapter) |
| **C. A general LLM producing placements** | No | API key | Rejected: cannot be trusted to satisfy hard constraints; every output would need the UC-026 recheck and most would fail; no reproducibility |

Recommended: **A** first. It is the only option that can be implemented and verified end to end now, and its quality can be measured (see 7). If the owner requires machine learning, B can reuse the same contract.

## 7. How quality is verified, not just connectivity

- **Connectivity tests** (what the contract tests in `ai.contract.test.js` do, with mocked providers): the adapter handles good, malformed, slow and failing answers. They prove nothing about whether any forecast or placement is good. Their names start with `MOCK`.
- **ETA quality** (NFR-ACC-04): time-split backtest on voyages with verified arrival times; per voyage one as-of snapshot; signed error = predicted ETA − actual arrival, in hours; report n, MAE, RMSE, bias for the model **and** for the declared ETA on the **same cohort**; report the share of voyages the model refused to answer; test set never used for tuning. Pass condition quoted from the SRS: model MAE below the declared ETA's MAE.
- **Berth proposal quality**: replay historical or demo queues; for the same queue compare mean waiting time and berth utilization of (1) proposal rank 1, (2) first-come-first-served manual baseline, (3) the human final decision when stored; every proposal rechecked by UC-026 (target: 0 violations). Latency measured with 20 queued vessels against the 10 s limit.
- **Reporting rule**: results from mocks, fixtures or demo data are labelled as such and never reported as AI acceptance.

## 8. Schema gaps found for UC-027 (not changed in this task)

`berth_plan_inferences` stores only the request (`request_json`); the **response** is not stored although UC-027 step 5 and AC-2 say request and response are stored. No table stores the **human final decision** (FR-BRT-12, UC-027 business rule), and `berth_plan_proposals` has no end position (the plan has `position_end_m`). Proposed migration 0006 (needs approval; follows the rule "migrations for schema changes", rollback required): add `response_json` (nullable, `ISJSON` check) to the inferences, and a decision record (proposal id, plan id or "manual", decided by, decided at, reason) linked to the proposal.

## 9. Credentials, data and decisions still needed

| Need | Why | Owner |
|---|---|---|
| Choose the approach: 6.2 A (local optimizer) or B (provider); ETA option A or B | Nothing can be implemented without it | Project owner |
| Definition of the **arrival** event and its recorder; whether to add an `actual_arrival_at` | ETA labels | Business owner |
| Meaning of `confidence`; MAE sample size and margin; horizon | Acceptance of FR-VES-05 | Business owner |
| A history of voyages with arrival times, ETA changes and licence to use it | Training and evaluation | Port or agents |
| AIS source and weather source: licence, credentials, cost | ETA option B | Project owner |
| A provider endpoint, contract confirmation and `SP_AI_*` values (kept in the environment, never in files) | Real integration | Provider owner |
| Approval of migration 0006 | UC-027 storage | Project owner |

## 10. Other acceptance risks reviewed (Phase 4)

| Risk | Finding | Action |
|---|---|---|
| UC-030 notices within 5 s for recipients that only polled every 30 s | Users without the berth permission (agents) had no push channel. | **Fixed** (technical defect): `GET /realtime/notifications` for any signed-in user, a content-free hint on plan submit, approve and reject; the page re-reads its own notifications. Measured 273 ms in the browser; the same test fails without the change (timeout) |
| SQL integration test isolation | Queue tests need an otherwise empty queue; leftovers of a failed run produced confusing failures | **Mitigated**: `npm run test:integration` now stops before the run and names the leftovers (read-only; `SP_ALLOW_DIRTY_QUEUE=1` to override). Not redesigned: making every test queue-independent is a larger change |
| Unexplained audit-query timeouts | The query takes 11 ms on 12,920 rows and the table has no blocking by itself; a timeout of 15 s or more means a lock wait. No blocker was found afterwards; the test dumps blocking sessions if it recurs | **Open, cause unknown** |
| M-1 (5-minute tolerance for edited actual times) | A business policy, not a defect | **Question for the owner** (see the integration evidence): keep 5 minutes, no tolerance, or an explicit "I edited the time" checkbox |

## 11. Update 2026-11-19: local optimizer for UC-027 (approved direction)
Option 6.2 A was built: `policy/berthOptimizer.js` (policy `UC027-OPT-V1`), service, migration 0006, API and screens (see `docs/use-cases/UC027.md` section 16). It is a deterministic optimizer, **not** the AI the SRS describes. Classification against the SRS: the 10 s criterion (for the local engine), storing proposals and the human decision, the manual path and UC-026 compliance are met; "an AI service at `/recommend/berth`" and the periodic model-quality evaluation of NFR-ACC-04 are **not fulfilled**. `berthAdapter.js` stays for a future external provider; nothing calls it. On constructed scenarios the optimizer shows no waiting-time improvement over a first-fit baseline, so no quality claim is made. All policy parameters are provisional (section 16.3 of the UC).

## 12. Update 2026-11-19: hardening of the local optimizer
Policy V2 (beam search that keeps queue priority), a shared occupancy rule that fixes a defect where a berthed vessel past its planned departure stopped blocking its stretch, and provenance values that never call the local algorithm an AI model (`LOCAL_OPTIMIZER` against `AI` for a real external provider). Quality on constructed scenarios: not worse than first-fit and usually better; no real-data or AI-quality claim. The SRS AI service and periodic model evaluation (NFR-ACC-04) remain unfulfilled. Details: `docs/use-cases/UC027.md` section 17 and `docs/testing/uc027-hardening-evidence.md`.
