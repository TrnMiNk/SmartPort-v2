# Module 2: voyage-state decision and design of the planning slice (UC027 to UC031)

Date: 2026-11-19. Status: **design for review**, with the decisions of the project owner recorded in section 5. Section 2 is the analysis that led to decision C-1. Sections 3 and 4 are the plan for UC-027, UC-030 and UC-031, which are not implemented.

## 1. Sources read

`usecases.txt` UC-021, UC-022, UC-023, UC-025, UC-030 (lines 2420 to 2860); SRS FR-VES-08 (line 535) and the arrival flow (lines 543 to 549); `docs/database/schema.md` §4; the baseline migration (`voyages`, `berth_plans`); the UC records UC027 to UC031.

## 2. Conflict C-1: what does "Đã xếp bến" mean?

### Evidence

| Source | What it says |
|---|---|
| SRS FR-VES-08 and UC-021 BR | Lifecycle: Đã thông báo → Hồ sơ hợp lệ → Chờ cập bến → **Đã xếp bến** → Đang làm hàng → Hoàn tất làm hàng → Đã thanh toán → Đã rời cảng. ATA and ATD are recorded with the actor. |
| UC-030 step 6 | On approval: plan "Đã duyệt", berth "Đã đặt trước", **voyage "Đã xếp bến"**. So the state is set by the approval, before the vessel arrives. |
| UC-022 | Precondition: approved plan and voyage "Đã xếp bến". Effects: ATA recorded, berth "Đang sử dụng", voyage updated "theo vòng đời". Scope note: in Đợt 1 the voyage goes "from Đã xếp bến" to the working and departure states per UC-023. |
| UC-023 | Precondition: the vessel "đã cập bến" (UC-022). Scope note: from "Đã xếp bến" straight to "Đã rời cảng"; "Đang làm hàng", "Hoàn tất làm hàng" and "Đã thanh toán" are skipped. |
| UC-025 BR-1 / schema §4 | Berth "Đang sử dụng" if an approved plan contains now **and its voyage is BERTHED**; "Đã đặt trước" if an approved plan starts later. |
| Schema (Milestone 0) | Voyage states: ANNOUNCED, MISSING_DOCUMENTS, REJECTED, VALIDATED, WAITING_BERTH, BERTHED, DEPARTED. `CK_voyages_ata`: BERTHED and DEPARTED need an ATA. `CK_voyages_queue_state`: WAITING_BERTH needs a queue position and no other state has one. |

### Your three hypotheses

| Hypothesis | Consistent with | In conflict with |
|---|---|---|
| H1: an approved plan represents the berth assignment | UC-030 (the approval is what assigns the berth), UC-022 precondition ("approved plan"), UC-025, UC-021 BR-3 | UC-030 step 6 only in that it also names a voyage state |
| H2: WAITING_BERTH remains the voyage state before physical arrival | UC-025 BR-1 (a berth is "in use" only when the voyage is BERTHED, so before that the voyage is not), the schema checks, UC-020 (queue) | UC-030 step 6 (voyage "Đã xếp bến" at approval); SRS lifecycle order, which has "Đã xếp bến" as its own step after "Chờ cập bến" |
| H3: BERTHED represents actual physical berthing | UC-022 effects (ATA recorded, berth in use), `CK_voyages_ata`, UC-023 precondition | The SRS has no state named for "berthed": the next documented state after "Đã xếp bến" is "Đang làm hàng", which Đợt 1 skips |

### Finding

H1, H2 and H3 together form a consistent reading that fits every rule about berths, ATA, ATD, the queue and the schema. They contradict only one sentence: **UC-030 step 6, "trạng thái chuyến tàu Đã xếp bến" at approval**, together with the SRS lifecycle that gives "Đã xếp bến" its own place. Read literally, the specification says: approval makes the voyage "Đã xếp bến"; UC-022 then records ATA; in Đợt 1 there is no state after that until "Đã rời cảng". Under that reading the schema's BERTHED would be the specification's "Đã xếp bến" but would have to be set at approval, when no ATA exists, which `CK_voyages_ata` forbids.

So the schema and the literal specification cannot both be right. This is a real conflict in the sources, not something to settle by code.

### Options

1. **Derived label (recommended provisionally).** Keep the seven stored states. Show "Đã xếp bến" as a label for WAITING_BERTH with an APPROVED plan, and "Đã cập bến" for BERTHED. Approval writes the plan state, history and notifications, not a new voyage state. No migration. Open points: whether an approved voyage stays in the UC-020 queue (today WAITING_BERTH requires a queue position), and whether the label of BERTHED must read "Đã xếp bến" for the business.
2. **Add a stored state** ASSIGNED between WAITING_BERTH and BERTHED. Fits UC-030 literally, needs a migration (the state check, the queue-state check, status history), and then BERTHED still has no counterpart in the SRS lifecycle. It adds a state the lifecycle can only partly justify.

No state was added. UC-024, UC-025 and UC-026 do not change a voyage state, so this slice is not affected. **The decision is needed before UC-030.** Question for the owner: "Khi kế hoạch được duyệt, chuyến tàu có rời hàng đợi chờ cập bến ngay không, và 'Đã xếp bến' là trạng thái sau khi duyệt hay sau khi cập bến?"

## 3. Design for UC-028 to UC-031 (next slice)

### 3.1 Findings that change the design

| # | Finding | Consequence |
|---|---|---|
| F-1 | `CK_bp_reviewed` requires `constraint_check_json.passed = true` for PENDING_APPROVAL, APPROVED and COMPLETED plans. UC-028 allows a plan with violations to be submitted when the coordinator gives an override reason. | The two cannot both hold. Either the stored `passed` means "acceptable for submission" (violations overridden), which makes the JSON say something the check did not, or a migration changes the constraint to `passed = true OR override_reason IS NOT NULL`. **Recommended: the migration**, so `passed` keeps one meaning. Needs approval. |
| F-2 | Overlap of intervals cannot be a CHECK or a plain index. | Enforce in the saving transaction (UC-026 A-2): lock the berth row first, run `placementService.evaluateForPlan` on the transaction, then write. |
| F-3 | `UX_bp_open_plan_per_voyage` allows one PENDING or APPROVED plan per voyage. | Already a database safeguard against two open plans for one voyage. A second submission of the same voyage fails on the index; the service maps it to 409. |
| F-4 | The "approved no-self-approval rule" in the request is recorded in UC-030 as A-2 "proposed, needs approval", not as an approved rule. | Implement it as asked (the approver may not be `submitted_by_user_id`, 409 `SELF_APPROVAL`, audited), and keep A-2 listed until the business confirms. Today the roles are disjoint (coordinator submits, `BAN_QUAN_LY` approves), so the rule only matters for a user holding both. |
| F-5 | C-1 above. | UC-030's effect on the voyage and the queue is undecided. |

### 3.2 Transaction and lock order

One global order avoids deadlocks: queue state row (only if the queue changes) → berth row → voyage row → plan row. Every statement that locks sets `LOCK_TIMEOUT 5000` and maps a timeout to 503 `BERTH_BUSY` (same pattern as `QUEUE_BUSY`).

| Operation | Steps in one transaction |
|---|---|
| UC-028 save draft | Check (UC-026) for display only; store the draft with the check JSON and source (MANUAL, AI, AI_ADJUSTED); a draft reserves nothing. |
| UC-029 submit | Lock berth → re-run the check on the transaction → refuse if MISSING_DATA, or if VIOLATION without an override reason (F-1) → PENDING_APPROVAL, submitter, history, notification to BAN_QUAN_LY, audit. Pending plans count as neighbors, so a second submission that conflicts with a first sees it. |
| UC-030 approve | Lock berth → plan row with `If-Match` → refuse `SELF_APPROVAL` → re-run the check excluding this plan (maintenance added since is caught: 409 `BUSINESS_RULE_VIOLATION` with the failing rule) → APPROVED, approver, history, notifications to agent and coordinator, audit; publish a refresh hint (UC-025). |
| UC-031 reject | Plan row with `If-Match`; reason required; REJECTED; history; notify the coordinator with the reason; audit. No berth lock needed because nothing is reserved. |

Concurrent cases to test: two coordinators submitting overlapping plans (one must fail), two approvals of overlapping plans (second fails at the re-check), approval and rejection of the same plan at once (revision decides), maintenance added between submit and approve.

### 3.3 RBAC

M2_BERTHS: `edit` (coordinator) saves drafts and submits; `approve` (BAN_QUAN_LY) approves and rejects; `view` reads. The server checks every call. UI buttons follow the permission only for usability.

### 3.4 Connection to the queue and the schedule

- Eligible voyages for planning are WAITING_BERTH without an open plan (the check already requires WAITING_BERTH).
- UC-021 already reads APPROVED and COMPLETED plans for berth, start and end, so an approval appears in the schedule with no change there.
- UC-025 already derives RESERVED from approved plans; approvals publish `BERTHS_CHANGED` hints.
- What approval does to the queue position is C-1.

### 3.5 UC-027 (AI recommendation)

Requirements read from the specification: up to 20 vessels, 1 to 3 ranked placements each (berth, position, start, end, expected wait, score), 10 s timeout, store request, response and every proposal with the model version, proposals must obey UC-026, no simulated AI, manual path when unavailable.

| Part | Verifiable without a provider | Status plan |
|---|---|---|
| Request validation (at most 20 vessels, queued voyages) | yes | implement |
| Adapter with timeout, malformed answer, provider error → UNAVAILABLE with a reason (same pattern as `etaAdapter`, URL from `SP_AI_BERTH_URL`) | yes, against a local stand-in through the real adapter code | implement; the success path is tested against the stand-in only |
| Re-check every proposal with UC-026 before showing it; drop or flag violators | yes | implement |
| Storage in `berth_plan_inferences` and `berth_plan_proposals`, UNAVAILABLE stored with its reason | yes | implement |
| Manual path offered when UNAVAILABLE | yes (belongs with UC-028) | implement with UC-028 |
| AC-1 "answer within 10 s for 20 vessels" | **no** (no provider, decision D3) | **blocked**; never reported as passed |
| Score scale and objective weights (UC-027 A-2) | no (business decision) | stays an assumption |

### 3.6 Proposed order

1. UC-028 manual path (drafts and the plan form on the queue) and UC-029 submit, after the answer to F-1.
2. UC-030 and UC-031 after the answer to C-1 and F-4.
3. UC-027 adapter, storage and re-check in parallel, with AC-1 reported as blocked.

## 4. Questions for the business owner

1. **C-1:** after approval, does the voyage leave the waiting queue, and what is "Đã xếp bến"?
2. **F-1:** may a plan with violations be submitted with an override reason (UC-028), and may the stored result then say `passed = false`?
3. **F-4:** confirm that the submitter may not approve their own plan.
4. **UC-026 A-4:** how is dangerous cargo recorded on the arrival notice (today only the priority class)?
5. **UC-026 A-7:** must planning refuse an OUT_OF_SERVICE berth?

## 5. Decisions of 2026-11-19 (project owner) and what was done

### 5.1 C-1: BERTH_ASSIGNED (decision implemented with UC-030 on 2026-11-19, migration 0005)

**Decision.** A voyage whose berth plan is approved gets the new state `BERTH_ASSIGNED` ("Đã xếp bến") and leaves the waiting queue. `BERTHED` is only set by the actual berthing (UC-022) and needs an ATA. This replaces the derived-label option of section 2.

**Consistency check made before any code (result: consistent, with the deviations listed below).**

| Source or constraint | Result with BERTH_ASSIGNED |
|---|---|
| SRS FR-VES-08 lifecycle | "Đã xếp bến" sits after "Chờ cập bến": matches. |
| UC-030 step 6 (voyage "Đã xếp bến" on approval) | Matches literally. |
| UC-022 precondition ("Đã xếp bến" and an approved plan) | Matches. The effect (ATA, berth in use) moves the voyage to BERTHED. |
| UC-023 (from "Đã xếp bến" to "Đã rời cảng", working states skipped) | Matches if BERTHED is the stage after berthing. |
| UC-021 lifecycle (BR-1) | Must list BERTH_ASSIGNED between WAITING_BERTH and BERTHED. |
| UC-025 derivation | Unchanged: in use needs BERTHED; an approved plan with a voyage not yet berthed is "Đã đặt trước". |
| `CK_voyages_status` | Must add the value. |
| `CK_voyages_valid_result` | Must add the value (a validated voyage). |
| `CK_voyages_queue_state` | No change: it already demands a null queue position for every state except WAITING_BERTH, which is the "leaves the queue" rule. |
| `CK_voyages_ata` | No change: BERTH_ASSIGNED needs no ATA. |
| Status history | `to_status` has no check constraint; a history row is written. |
| Application lists of states | `voyageService`, `scheduleValidation`, the schedule filter, the front pill map must learn the value. |
| The queue | Approval must take the queue lock, clear the position and close the gap (positions must stay contiguous), with a `voyage_queue_changes` or audit trace. |
| Placement check (UC-026) | Already requires WAITING_BERTH, so an assigned voyage cannot get a second plan. |

**Update 2026-11-19.** The state change is now applied by UC-030 and migration 0005 (see section 6). The paragraph below is the earlier reasoning for waiting. **Why it was not applied earlier.** The state change happens at approval (UC-030), which is not part of this slice; the UC-028/029 code does not change voyage state or queue (tested). Applying it belongs to a migration `0005` with UC-030, including its rollback (a rollback must refuse while BERTH_ASSIGNED voyages exist).

**Remaining specification deviations (to confirm with the business).**
- D-1: `BERTHED` is a state the SRS lifecycle does not name (after "Đã xếp bến" it lists "Đang làm hàng", which Đợt 1 skips). It is used as the stage "đã cập bến" that UC-022/023 and UC-025 need.
- D-2: the specification does not say that an approved voyage leaves the "Chờ cập bến" queue; this decision does.
- D-3: UC-020 queue screens and the schedule must show assigned voyages somewhere else (the schedule does, through the plan).

### 5.2 F-1: constraint evaluation versus authorization to accept a violation (implemented)

- The evaluation keeps its meaning: `passed` is true only when every rule passed. A failed check is stored as it is.
- An override is separate: reason, who, when and which rules (`override_*` columns, audit action `BERTH_PLAN_OVERRIDE`). The right to override is the permission `override` (coordinator only, derived from UC-028 and kept apart from the SRS matrix in `permissions.js`).
- Never overridable: missing data (also the database refuses it) and an out-of-service berth.
- `CK_bp_reviewed` was replaced, not weakened: a submitted plan needs a pass, or an override reason plus a check whose outcome is VIOLATION. The migration and its rollback were tested; the rollback refuses to run when it would lose override or hazard data.
- **Still open (F-1b).** UC-030 says a plan with a violation cannot be approved and re-runs the check at approval, but an overridden plan has a violation by design. The approval use case needs a rule: for example, the approver sees the overrides and the re-check may fail only on the rules that were overridden, and an approval with overrides needs an explicit confirmation. Also open: whether overlap (BR-01) and dangerous goods (BR-03) may be overridden at all.

### 5.3 F-4: no self-approval (database safeguard now, service at UC-030)

`CK_bp_no_self_approval` (migration 0004) forbids a plan whose approver is its submitter, so no code path can store it. The approval endpoint (UC-030) will refuse earlier with 409 `SELF_APPROVAL` and an audit row; that test belongs with UC-030 because the endpoint does not exist. The database rule is tested now (insert refused, a different approver accepted).

### 5.4 UC-026 changes (implemented)

Reefer is no longer read as hazardous; the request field `dangerous_goods` was removed; BR-03 uses the voyage's verified cargo hazard (`NONE`, `DANGEROUS`, or not verified, which is MISSING_DATA at a berth without the label); an out-of-service berth is a violation that cannot be overridden and a deactivated berth is refused. See `docs/use-cases/UC026.md` A-4, A-5, A-7.

### 5.5 Questions still open

1. F-1b: how does approval treat an overridden plan, and which rules may never be overridden (BR-01, BR-03)?
2. Who verifies the cargo hazard, and should the arrival notice carry the agent's declaration as a field?
3. D-1 to D-3 above.

## 6. Decisions of 2026-11-19, second part, and what was done

### 6.1 F-1b: what approval accepts (implemented in UC-030)

- A plan is approved only when the placement check passes **at the moment of approval**, on current data, inside the transaction that holds the queue, berth and voyage locks. The stored result is never trusted, and `passed` keeps its meaning.
- An override reason only lets a violating plan reach review. BR-01 (overlap) and BR-03 (dangerous goods) are among the rules, so they cannot be approved while violated; neither can any other failing rule, nor missing data.
- Only approved and completed plans count as reservations at approval. A plan waiting for a decision does not block another; the first approval wins and the other is then refused (tested with simultaneous approvals).
- **Deviation and gap.** Spec UC-030 6a asks to re-plan (UC-033, out of scope) and UC-031 handles rejection (not built, by instruction). A pending plan that cannot pass therefore stays pending: it is told to its submitter and never approved, but nobody can dispose of it until UC-031 exists. The earlier rule "an override is accepted at submission" (UC-029) is unchanged.

### 6.2 F-4: no self-approval

Service: 409 `SELF_APPROVAL`, audited as FAILED, checked before the re-check. Database: `CK_bp_no_self_approval`. Tested with a user who holds both roles, three simultaneous attempts, and a direct SQL update.

### 6.3 C-1: BERTH_ASSIGNED (implemented)

Approval moves the voyage `WAITING_BERTH` to `BERTH_ASSIGNED`, clears the queue position, closes the gap behind it, records `LEFT_QUEUE` in the queue history and a status history row. Consistency with the schedule (UC-021 shows it with berth and planned bar), the berth state (UC-025 shows "Đã đặt trước") and UC-022 (the database accepts `BERTHED` with an ATA and then the berth is in use) was tested.

**Specification deviations to keep on record.**
- D-1: `BERTHED` is a state the SRS lifecycle does not name; it is the stage "đã cập bến" that UC-022, UC-023 and UC-025 need while "Đang làm hàng" is skipped in Đợt 1.
- D-2: the specification does not say that an approved voyage leaves the waiting queue.
- D-4: UC-030 says the berth becomes "Đã đặt trước" and the voyage "Đã xếp bến"; both hold, but UC-025 shows the berth as reserved only while its approved plan is current or in the future (a vessel that never arrives keeps the berth reserved until an operator acts, which UC-022/023 will have to address).
- D-5: notices to the yard, cranes and gate (UC-030 step 7) are not built (Modules 3 to 5).

## 7. UC-031 (2026-11-19)

Rejection is implemented as specified (reason required, only a pending plan, notice with the reason to the submitter, berth unchanged). Resolved: the gap noted in 6.1: a pending plan that cannot pass at approval can now be rejected, so it no longer waits indefinitely. Interpretation recorded in UC-031 A-2: "returned to the coordinator" is a notice plus a new draft for the same voyage; the rejected plan is final. No new state, no migration. Notification read marks for role-addressed notices remain shared by everyone with the role (assumption N-1 in UC-029 A-5); that is consistent across approval, rejection and submission notices.

## 8. UC-022 and UC-023 (2026-11-19)

The voyage lifecycle now runs end to end: ... WAITING_BERTH, BERTH_ASSIGNED (UC-030), BERTHED (UC-022, ATA), DEPARTED (UC-023, ATD). No migration: `ata`, `atd` and their checks existed. Decisions: berthing needs the real berth (wrong berth refused, UC-033 not built); a berthed vessel keeps its plan "in use" until departure whatever the plan times (the berth query no longer requires the plan start to have passed for a BERTHED voyage); departure completes the plan (existing `COMPLETED` state) and a completed plan blocks overlaps only until the actual departure (`berthStatusRepository.neighbors`), so the berth can be reused at once and history stays. Lock order is the module's: berth, voyage, plan.
