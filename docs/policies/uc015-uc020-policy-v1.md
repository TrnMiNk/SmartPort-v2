# UC-015 validation policy and UC-020 queue policy (version 1)

Status: implemented and tested (see `docs/testing/uc013-uc015-uc020-evidence.md`). Code: `API/src/policy/validationPolicy.js` (rules version `UC015-RULES-V1`), `API/src/policy/queueOrder.js`. The policy content (which documents are required) is data in table `validation_policies`, not code.

## 1. Documented rules (source: `usecases.txt` UC015 and UC020, SRS FR-VES-03/07/08, NFR-PER-01/06, legacy P1 doc)

| Id | Documented rule | Where used |
|---|---|---|
| D-1 | A notice with a required document missing is `MISSING_DOCUMENTS`; the agent is told which. | R05 |
| D-2 | A notice with an expired document, or a vessel that is not allowed, is `REJECTED`. | R03, R04, R06 |
| D-3 | A valid notice becomes `VALIDATED` then `WAITING_BERTH` and enters the queue; an invalid one never does. | UC015 flow, BR-3 |
| D-4 | Every status change writes status history with time and actor. | all |
| D-5 | AI ETA forecast has a 10 s timeout; on failure the voyage continues with the label "chưa có dự báo AI". | AI adapter |
| D-6 | A reorder of the queue has an actor and a reason; a stale view is refused with 409. | UC020 |
| D-7 | UC015 has no human confirmation step (project rule 06). | all |

## 2. Rules evaluated (in this order)

| Rule | Check | Failure outcome | Reason code |
|---|---|---|---|
| R01 REQUIRED_FIELDS | ship, voyage code, agent, origin port, ETA (valid instant), TEU, cargo type present | MISSING_DOCUMENTS | MISSING_REQUIRED_FIELD |
| R02 IMO_FORMAT | IMO is 7 digits | MISSING_DOCUMENTS | INVALID_IMO |
| R03 VESSEL_ACTIVE | vessel is active | REJECTED | VESSEL_INACTIVE |
| R04 VESSEL_NOT_RESTRICTED | no active row in `vessel_restrictions` covering the ETA date | REJECTED | VESSEL_PROHIBITED / VESSEL_RESTRICTED |
| R05 DOCUMENTS_PRESENT_APPROVED | every required document type has an approved document (SHIP scope: standing or attached to this voyage; VOYAGE scope: only this voyage) | MISSING_DOCUMENTS | DOCUMENT_MISSING / DOCUMENT_NOT_APPROVED |
| R06 DOCUMENTS_VALID_AT_ETA | the approved documents are valid on the ETA date | REJECTED | DOCUMENT_EXPIRED / DOCUMENT_NOT_YET_VALID |

**Precedence:** REJECTED beats MISSING_DOCUMENTS beats VALID. All rules are evaluated every run and all results are stored; the decision reason lists only the failures that decide the outcome, in rule order. Equal input under the same policy version always gives the same outcome and reason (unit-tested, including input-order independence).

**Infrastructure failure** (policy missing or checksum mismatch → `POLICY_UNAVAILABLE` 503, lock timeout, database error) is never turned into REJECTED or MISSING_DOCUMENTS: the notice stays ANNOUNCED and the response says `validation.state = NOT_RUN` with a code.

**Idempotency:** `POST /voyages/:id/validate` on a voyage that is already VALIDATED/WAITING_BERTH/REJECTED returns the stored decision with `replayed: true` and changes nothing. REJECTED is final.

**Audit (one row per run):** `voyage_validation_runs` holds input snapshot, policy version, each rule result, outcome, reason code and text, AI status, queue position, trigger (SUBMIT / REVALIDATE), actor and duration; an `audit_events` row and an in-app notification are written in the same transaction as the status change.

## 3. Policy configuration

Table `validation_policies(version, config_json, checksum, effective_from, effective_until)`. The checksum (SHA-256 of `config_json`) is verified on every load. Rows are immutable by convention: a new version is a new row. The development seed policy `UC015-POLICY-V1` requires ship-level `REGISTRATION` and `INSURANCE` documents.

## 4. UC-020 queue order

Tier first (MAIN_LINE and REEFER_OR_HAZARD = tier 1, STANDARD = tier 2), then effective ETA (AI forecast if AVAILABLE, otherwise the declared ETA), then queue entry time, then voyage id. A new entry is inserted at the first position it outranks. A coordinator may move an entry with a mandatory reason; the move carries the queue revision (`If-Match`), and a stale revision gives 409 `QUEUE_CHANGED`. Moves are serialised on one queue-state row; a lock timeout gives 503 `QUEUE_BUSY`. Each move writes `voyage_queue_changes` and an audit event.

## 5. Engineering assumptions (not stated by the sources; open for business review)

| Id | Assumption | Rationale |
|---|---|---|
| A-1 | The dev policy requires ship-level REGISTRATION and INSURANCE documents. | Spec gives no list; legacy invented none. Smallest set that exercises R05/R06. Replace by inserting a new policy version. |
| A-2 | An approved document with no validity dates is accepted. | Spec defines validity only when dates exist. |
| A-3 | The ETA reference date for document validity is the UTC+7 calendar date; boundaries are inclusive. | Spec displays times in UTC+7. |
| A-4 | `vessel_restrictions` is empty by default; no prohibited list is invented. | CLAUDE.md §7. |
| A-5 | Spec AC "valid voyage in queue within 5 s" conflicts with the 10 s AI timeout. Validation runs synchronously with the AI call bounded to 10 s, so a slow provider can exceed 5 s. | Documented conflict; no async worker exists. |
| A-6 | Server-side drafts (`voyage_drafts`) replace the spec's browser-only draft. | Explicit request for this slice. |
| A-7 | Only roles with `view` on M1_VESSELS (coordinator, management) read the queue; only `edit` (coordinator) reorders. Agents see only their own notices. | SRS matrix. |
| Q-1 | Priority outranks ETA. | "độ ưu tiên" is listed before ETA in the spec. |
| Q-2 | MAIN_LINE and REEFER_OR_HAZARD share one tier. | Spec names both as priority examples without ranking them. |
| Q-3 | Ties go to the earlier queue entry, then the lower id. | Deterministic order; no rule in the spec. |
| Q-4 | UC020 step 6 (notify module M2) is not applicable until Module 2 exists. | Module 2 is out of this slice. |

## 6. AI provider

No ETA forecast provider exists (decision D3). The adapter reads `SP_AI_ETA_URL`; with no URL it returns UNAVAILABLE / NOT_CONFIGURED and the voyage continues with the label "chưa có dự báo AI". The AVAILABLE path is tested only against a local stand-in served through the real adapter code. It has not been run against a real provider.

## 7. The 5 s criterion versus the 10 s AI timeout (analysis for review; nothing here is implemented)

**Sources.** SRS UC "Tiếp nhận thông báo tàu đến" (srs.txt lines 543-549): main flow validates, then calls the AI ETA forecast (step 3), then queues the voyage (step 4); alternative 3a says the AI has 10 s before the declared ETA and the label are used; acceptance criterion: a valid voyage appears in the queue within 5 s of submission. Read literally, a forecast that takes the full 10 s makes the 5 s criterion impossible, so the two statements conflict whenever the provider is slow. With no provider (the current state) or a fast one the criterion holds.

**What is verified.** Validation and queueing with no provider finish well inside 5 s (the integration test records the duration). The slow-provider case is not met by design: the call waits up to 10 s.

**Option A (current).** Synchronous: validate, wait up to 10 s for the AI, queue. Follows the SRS flow order. Fails the 5 s criterion only when the provider is slow.

**Option B (asynchronous forecast).** Validate and queue at once using the declared ETA (VALIDATED then WAITING_BERTH, no new state), then request the forecast afterwards and store it. This meets 5 s and keeps the documented states. It needs decisions that the sources do not give: (1) may a forecast that arrives later change the position of a voyage already queued (queue order uses the forecast when it exists, rule Q-1..Q-3)? (2) a durable job mechanism (no worker or outbox exists; see UC015 A-10); (3) what the coordinator sees while the forecast is pending. It also changes the SRS step order, so it is a business decision.

**Option C.** Lower the AI timeout to fit a 5 s budget. Contradicts the documented 10 s.

**Recommendation.** Keep Option A and keep UC015 AC-1 as "passed without a provider, unverified with a slow one". Take Option B to the business owner with the three questions above. It was not started, because that would settle open business rules.
