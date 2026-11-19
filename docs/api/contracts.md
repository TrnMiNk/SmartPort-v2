# SmartPort V2 API contracts (M1 and M2)

**Base URL:** `/api/v1`. **Format:** JSON UTF-8. Timestamps ISO 8601 in UTC (`2026-12-01T08:00:00Z`); the UI shows UTC+7.
**Status legend:** **implemented** (in `API/`, tested), **planned** (contract fixed, not yet implemented).

## 1. Conventions

### 1.1 Success envelope

```json
{ "success": true, "data": { ... } }
```

Lists use `data` with `items`, `total`, `page`, `size`:

```json
{ "success": true, "data": { "items": [ ... ], "total": 42, "page": 0, "size": 20 } }
```

### 1.2 Error envelope (one contract, rule 04)

```json
{ "success": false, "error": { "code": "VALIDATION_FAILED", "message": "Dữ liệu không hợp lệ.",
  "details": [ { "field": "username", "message": "..." } ] } }
```

`details` appears only for `VALIDATION_FAILED`. No stack trace, SQL or internal identifier is ever returned.

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Invalid body, parameter or header; malformed JSON |
| 401 | `UNAUTHENTICATED` | No session, expired, revoked or forged token |
| 401 | `INVALID_CREDENTIALS` | Wrong username or password (same message for both cases) |
| 403 | `FORBIDDEN` | Authenticated, role not allowed |
| 403 | `ACCOUNT_INACTIVE` | Account deactivated |
| 404 | `NOT_FOUND` | Unknown route or resource |
| 409 | `CONFLICT` | Stale `If-Match` revision, or concurrent change (planned) |
| 409 | `BUSINESS_RULE_VIOLATION` | A state transition or rule is refused, with `details` naming the rule (planned) |
| 413 | `VALIDATION_FAILED` | Body larger than 100 KB (JSON); file larger than 10 MB (documents) |
| 423 | `ACCOUNT_LOCKED` | Account locked after repeated failures |
| 503 | `DATABASE_UNAVAILABLE` | Health check cannot reach the database |
| 503 | `POLICY_UNAVAILABLE` | No effective validation policy (UC015 BR-4, planned) |
| 500 | `INTERNAL_ERROR` | Any unexpected failure |

### 1.3 Authentication and roles

- Session cookie `sp_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` unless `SP_COOKIE_SECURE=false` (local HTTP only). A second cookie `sp_auth=1` (readable by the frontend, same attributes, not a secret) must accompany it; the API refuses a session without it. Deleting it signs a browser out when the server cannot be reached (UC-002 4a). Both cookies are re-issued with the idle lifetime on every accepted request.
- `GET /auth/me` and `POST /auth/login` return `user.permissions`: an object mapping a feature code (`M1_VESSELS`, `M2_BERTHS`, `M3_CARGO`, `M4_YARD`, `M5_BILLING`, `M6_IOT`, `M7_MONITORING`, `M8_REPORTS`, `ADMIN`) to the actions the roles grant (`view`, `edit`, `approve`, `notice`, `view_own`). It follows the SRS matrix (`docs/use-cases/UC005.md` §3). The frontend uses it only to choose what to show; the API checks every request.
- Role codes (legacy-compatible): `QUAN_TRI_HE_THONG` (Administrator), `DIEU_PHOI_VIEN` (Coordinator), `DAI_LY_HANG_HAI` (Shipping agent), `BAN_QUAN_LY` (Port management, approves berth plans, decision D5).
- Default deny: an endpoint without an allowed role list returns 403.
- Roles are read on every request. Role changes take effect on the next request.

### 1.4 Concurrency

Mutable resources return `ETag: "<revision>"`. Updates require `If-Match: "<revision>"`. A stale value returns `409 CONFLICT` and the current representation in `error.details.current` (planned). This matches the FE client, which sends `If-Match` with quotes.

### 1.5 Idempotency and duplicates

- Voyage notices (UC-013): one notice per ship and voyage code. A duplicate returns `409` with the existing `voyageId`.
- Other creates use the natural keys in `docs/database/schema.md`. No `Idempotency-Key` table exists in the baseline.

### 1.6 Auditing

Every state-changing endpoint writes `audit_events`. Denied attempts are audited with `outcome = DENIED`.

## 2. Implemented endpoints

### GET `/api/v1/health` (implemented)

Public. Returns `200 {success:true,data:{status:"ok",database:"ok"}}` when the database answers, otherwise `503 DATABASE_UNAVAILABLE`.

### POST `/api/v1/auth/login` (implemented; UC-001)

Request:
```json
{ "username": "coord01", "password": "..." }
```
Response `200` and `Set-Cookie: sp_session=...`:
```json
{ "success": true, "data": { "user": { "id": 3, "username": "coord01", "displayName": "Điều phối viên 1", "roles": ["DIEU_PHOI_VIEN"] } } }
```
Errors: `400 VALIDATION_FAILED`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_INACTIVE`, `423 ACCOUNT_LOCKED`.
Audit: `LOGIN` with `SUCCESS`, `FAILED` (`WRONG_PASSWORD`, `UNKNOWN_USER`, `LOCKED_AFTER_FAILURES`) or `DENIED`.

### GET `/api/v1/auth/me` (implemented)

Requires session. Response `200`:
```json
{ "success": true, "data": { "user": { "id": 3, "username": "coord01", "displayName": "Điều phối viên 1", "roles": ["DIEU_PHOI_VIEN"] } } }
```
Errors: `401 UNAUTHENTICATED`.

### DELETE `/api/v1/auth/logout` (implemented; UC-002)

Requires session. Revokes the session and clears the cookie. Response `204` with no body. Audit: `LOGOUT`.

## 2a. Implemented: vessels, arrival notices, catalogs (UC-010, UC-011, UC-013)

Single resources are returned as `data: { ... }` (snake_case) with `ETag: "<revision>"`; lists as `data: { items, total, page, size }` (page is zero-based, size 1 to 100, default 20). Unknown body fields are refused. Revisions are numbers. Times are ISO 8601 UTC.

| Method and path | Permission (`M1_VESSELS` action) | Request | Success | Errors |
|---|---|---|---|---|
| `POST /ships` | `edit` | `imo_number` (7 digits), `ship_name`, `ship_type_id`, `length_overall_m`, `beam_m`, `max_draft_m`, `deadweight_t`; optional `flag_state`, `operator_agent_id` | 201 ship | 400 field errors; 409 `CONFLICT` (`details.field = imo_number`) |
| `GET /ships?search=&includeInactive=&page=&size=` | `view` or `view_own` | `search` matches IMO prefix or name part; wildcards are literal | 200 list; agents see only vessels of their agents | 400 |
| `GET /ships/:id` | `view` or `view_own` | | 200 ship | 404 (also outside an agent's scope or malformed id) |
| `GET /ships/:id/history` | `view` or `view_own` | | 200 `{ items: [{ at, actor, action, reason, changes: [{ field, old, new }] }] }`, oldest first | 404 |
| `PATCH /ships/:id` | `edit` | `If-Match: "<revision>"` and any subset of the create fields, optional `reason` | 200 ship, `ETag` | 400 (missing `If-Match`, empty or invalid body); 404; 409 `CONFLICT` (`details.current_revision`, or duplicate IMO) |
| `POST /ships/:id/deactivate` | `edit` | `If-Match`, `{ reason }` (required) | 200 ship | 409 `BUSINESS_RULE_VIOLATION` (`SHIP_HAS_UNFINISHED_VOYAGE` with `details.voyages`, or `SHIP_ALREADY_INACTIVE`); 409 stale |
| `POST /voyages` | `notice` | `ship_id`, `voyage_code`, `agent_id`, `origin_port_id`, `declared_eta` (ISO 8601 with offset), `declared_teu` (integer 0 or more), `cargo_type`; optional `service_request`, `priority_class` (coordinator only) | 201 voyage with `status: ANNOUNCED`. UC-015 is **not** run yet | 400; 403 (agent outside its scope); 409 `SHIP_NOT_FOUND`, `SHIP_INACTIVE`, `CONFLICT` (`details.rule = DUPLICATE_NOTICE`, `existing_voyage_id`) |
| `GET /voyages?status=&ship_id=&page=&size=` | `view` or `view_own` | | 200 list (agents: their agents' voyages) | 400 |
| `GET /voyages/:id` | `view` or `view_own` | | 200 voyage with `history` | 404 |
| `GET /catalog/ship-types`, `/catalog/ports`, `/catalog/agents` | `view`, `view_own` or `notice` | | 200 `{ items: [{ id, code, name }] }` (ship types also `cargo_class`); agents see only their own agents | |

Every refusal (403, 409) of a state-changing call is written to `audit_events` as `DENIED` or `FAILED`; successes are written in the same transaction as the change. The earlier planned rows below are superseded by this table for these endpoints.

## 2b. Implemented: automatic validation, drafts, queue (UC-013, UC-015, UC-020)

| Method and path | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `POST /voyages` | `notice` | as 2a | 201 voyage (status after UC-015) plus `validation` | as 2a; infrastructure failure still gives 201 with `validation.state = NOT_RUN` |
| `POST /voyages/:id/validate` | `notice` | `{}` | 200 voyage plus `validation`; a decided voyage returns `replayed: true` and changes nothing | 404; 503 `POLICY_UNAVAILABLE` |
| `GET /voyages/queue` | `view` | | 200 `{ revision, items: [{ voyage_id, position, voyage_code, ship_name, imo_number, priority_class, effective_eta, eta_source (AI or DECLARED), agent_name }] }` | 403 for agents |
| `PATCH /voyages/:id/queue-position` | `edit` | `If-Match: "<queue revision>"`, `{ to_position, reason }` | 200 queue (new revision) | 400 field errors; 409 `QUEUE_CHANGED` (`details.current_revision`) or `NOT_IN_QUEUE`; 503 `QUEUE_BUSY` |
| `POST /voyage-drafts` | `notice` | allow-listed subset of the notice fields | 201 draft `{ id, payload, status, revision }` | 400 |
| `GET /voyage-drafts`, `GET /voyage-drafts/:id` | `notice` | | 200; only the owner's open drafts | 404 for another user's draft |
| `PUT /voyage-drafts/:id` | `notice` | `If-Match`, payload | 200 draft | 400; 409 stale or not open |
| `DELETE /voyage-drafts/:id` | `notice` | `If-Match` | 204 | 409 stale or not open |
| `POST /voyage-drafts/:id/submit` | `notice` | `{}` | 201 voyage plus `validation`; a repeated submit returns the same voyage with 200 | 400 field errors (draft stays open); 409 duplicate or not open |

`validation` object: `{ state: DECIDED, result: VALID | MISSING_DOCUMENTS | REJECTED, reason_code, reason, policy_version, rules: [{ id, outcome }], ai: { status: AVAILABLE | UNAVAILABLE, label, predicted_eta, confidence }, replayed }`, or `{ state: NOT_RUN, code, message }`. Details and sources: `docs/policies/uc015-uc020-policy-v1.md`. The planned rows for these endpoints in section 3 are superseded by this table.

### UC-021 schedule (implemented)

| Method and path | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `GET /voyages/schedule?view=list\|gantt&status=&agent_id=&berth_id=&from=&to=&page=&size=` | `view` | `from` and `to` are ISO 8601 with offset, both or neither, `from` < `to`, at most 31 days; required for `gantt`. List pages by `page`/`size`; Gantt returns up to 500 rows | 200 `{ view, items, total, page, size, truncated }`; item: `id, voyage_code, status, priority_class, ship_name, imo_number, agent_id, agent_name, declared_eta, ata, atd, berth_id, berth_code, berth_name, planned_start, planned_end, start_at, end_at, bar_source (ACTUAL or PLAN or null)` | 400 field errors; 403 (agents, technicians) |
| `GET /catalog/berths` | `view` | | 200 `{ items: [{ id, code, name }] }` (read only; berths belong to Module 2) | 403 |

`berth_*` and `planned_*` come from the latest APPROVED or COMPLETED berth plan. `start_at` is the ATA, else the planned start; `end_at` is the ATD, else the planned end. Ordered by `start_at` (else declared ETA), then id.

## 2c. Implemented: Module 2 first slice (UC-024, UC-025, UC-026)

Feature `M2_BERTHS` in the SRS matrix: `view` (coordinator, management, warehouse staff, administrator) reads; `edit` (coordinator) changes. Agents and technicians get 403. Same envelope, error contract and `If-Match` rules as section 1.

| Method and path | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `GET /berths?page=&size=` | view | | 200 `{ items, total, page, size }` of berths | 400 |
| `GET /berths/:id` | view | | 200 berth, `ETag` | 404 |
| `POST /berths` | edit | `berth_code`, `berth_type` (CONTAINER or BULK), `length_m`, `max_depth_m` (> 0), `available_cranes` (integer >= 0), `allows_dangerous` (boolean); optional `berth_name` (default: the code), `longitude` and `latitude` (both or neither) | 201 berth, `ETag` | 400 field errors; 409 `CONFLICT` (`details.field = berth_code`) |
| `PATCH /berths/:id` | edit | `If-Match`, any subset of the create fields plus `operational_status`, `reason`, `confirm_affected_plans` | 200 berth | 400; 404; 409 stale (`details.current_revision`), duplicate code, or `BUSINESS_RULE_VIOLATION` with `details.rule = BERTH_HAS_PLANS`, `requires_confirmation` and `plans` when length or depth changes and the berth has DRAFT, PENDING_APPROVAL or APPROVED plans and `confirm_affected_plans` is not true |
| `GET /berths/status` | view | | 200 `{ as_of, items }`; item = berth plus `state` (AVAILABLE, IN_USE, MAINTENANCE, RESERVED, OUT_OF_SERVICE), `maintenance`, `current_plan`, `next_plan` | |
| `GET /berths/:id/detail` | view | | 200 berth state plus `upcoming_plans` and `upcoming_maintenance` (10 each) | 404 |
| `GET /realtime/m2/events` | view | | `text/event-stream`; `event: refresh` with `{ type, berth_id }` when the catalog changes (later: plan, berthing and maintenance events). A hint only: clients re-read and also reload on reconnect | 401, 403 |
| `POST /berth-plan-checks` | view | `voyage_id`, `berth_id`, `position_start_m`, `position_end_m`, `planned_start`, `planned_end` (ISO 8601 with offset), optional `required_cranes`, `dangerous_goods` | 200 `{ voyage_id, voyage_code, berth_id, berth_code, rules_version, outcome (PASS, VIOLATION, MISSING_DATA), passed, buffer_m, rules: [{ id, outcome, reason, details? }] }`; rule ids: LOA_FIT, DRAFT_FIT, BERTH_TYPE, CRANES, OVERLAP, SAFETY_BUFFER, DANGEROUS_GOODS, MAINTENANCE. Stores nothing | 400; 409 `VOYAGE_NOT_IN_QUEUE`; 503 `PARAMETER_UNAVAILABLE` |

`BERTH_CREATE` and `BERTH_UPDATE` write an audit row with old and new values; refusals (403, 409) are recorded as DENIED or FAILED.

## 2d. Implemented: manual berth plans (UC-028, UC-029) and cargo hazard (UC-026 BR-03)

Plan endpoints use M2_BERTHS: `view` reads, `edit` writes. Accepting a violation also needs `override` (coordinator only, derived from UC-028). A plan has `ETag` = its revision; changes need `If-Match`. Voyage state and queue are never changed by these endpoints.

| Method and path | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `POST /berth-plans` | edit | `voyage_id`, `berth_id`, `position_start_m`, `position_end_m`, `planned_start`, `planned_end`, `required_cranes`; optional `source` (only `MANUAL`), `override_reason` (1 to 500) | 201 plan with status `DRAFT`, `check` (the UC-026 result as it was, `passed` unchanged), `override_*` fields | 400 fields (`dangerous_goods` and `source` AI are refused); 403; 409 `BUSINESS_RULE_VIOLATION` with `details.rule`: `CONSTRAINT_VIOLATION` (`requires_override`, `check`), `INSUFFICIENT_DATA`, `NOT_OVERRIDABLE`, `DRAFT_EXISTS`, `VOYAGE_HAS_OPEN_PLAN`, `VOYAGE_NOT_IN_QUEUE`; 503 `BERTH_BUSY` |
| `PUT /berth-plans/:id` | edit | as create (same `voyage_id`), `If-Match` | 200 plan (checked again) | as create; 409 stale (`details.current_revision`) or `NOT_DRAFT` |
| `POST /berth-plans/:id/submit` | edit | `If-Match`; optional `{ override_reason }` | 200 plan `PENDING_APPROVAL`, submitter and time; notice to `BAN_QUAN_LY` | 400; 403; 404; 409 as above plus `NOT_DRAFT`; refused with `CONSTRAINT_VIOLATION` when a rule fails now and no override reason exists |
| `GET /berth-plans?status=&voyage_id=&page=&size=` | view | | 200 `{ items, total, page, size }` | 400 |
| `GET /berth-plans/:id` | view | | 200 plan with `history` | 404 |
| `PUT /voyages/:id/cargo-hazard` | M1 `edit` | `cargo_hazard` (`NONE` or `DANGEROUS`), `basis` (1 to 500) | 200 voyage with `cargo_hazard`, `cargo_hazard_basis`, `cargo_hazard_verified_at` | 400; 403 (agents cannot certify); 404 |

Changes to `POST /berth-plan-checks` (UC-026, rules version `UC026-RULES-V2`): the `dangerous_goods` field is removed; the result has 9 rules (new `BERTH_IN_SERVICE`), `outcome` is MISSING_DATA when any rule lacks data, and `overridable` tells whether a violation could be accepted with an override. Audit actions: `BERTH_PLAN_CREATE`, `BERTH_PLAN_UPDATE`, `BERTH_PLAN_SUBMIT`, `BERTH_PLAN_OVERRIDE` (reason, overridden rules, violations), `CARGO_HAZARD_VERIFY`; refusals are recorded as DENIED or FAILED.

## 2e. Implemented: approval (UC-030) and notifications (UC-029)

| Method and path | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `POST /berth-plans/:id/approve` | M2 `approve` (`BAN_QUAN_LY`) | `If-Match` (plan revision), `{ confirm: true }` | 200 plan `APPROVED` (`approved_by_user_id`, `approved_at`, `check` = the result made now) plus `voyage: { id, status: BERTH_ASSIGNED, queue_position: null, left_queue_position }` | 400; 403 (audited DENIED); 404; 409 `BUSINESS_RULE_VIOLATION` with `details.rule`: `NOT_PENDING` (`plan_status`), `SELF_APPROVAL`, `VOYAGE_NOT_IN_QUEUE`, `CONSTRAINT_VIOLATION_AT_APPROVAL` (`check`, `had_override`); 409 `CONFLICT` stale (`current_revision`); 503 `BERTH_BUSY` |
| `POST /berth-plans/:id/reject` | M2 `approve` (`BAN_QUAN_LY`) | `If-Match`, `{ reason }` (1 to 500, required) | 200 plan `REJECTED` with `rejection_reason`; the submitter is notified with the reason; voyage, queue and berth unchanged | 400 (no reason); 403 (audited); 404; 409 `NOT_PENDING` (`plan_status`: draft, approved, completed or already rejected) or stale (`current_revision`); 503 `BERTH_BUSY` |
| `POST /voyages/:id/berthing` | M1 `edit` (coordinator) | `If-Match` (voyage), `{ berth_id, actual_time?, reason? }` | 200 voyage `BERTHED` with `ata` | 400; 403 (audited); 404; 409 `NOT_BERTH_ASSIGNED`, `NO_APPROVED_PLAN`, `WRONG_BERTH`, `BERTH_OCCUPIED`, stale; 503 `BERTH_BUSY` |
| `POST /voyages/:id/departure` | M1 `edit` (coordinator) | `If-Match` (voyage), `{ actual_time?, reason? }` | 200 voyage `DEPARTED` with `atd`; plan `COMPLETED` | 400; 403 (audited); 404; 409 `NOT_BERTHED`, `ATD_BEFORE_ATA`, stale; 503 `BERTH_BUSY` |
| `GET /realtime/notifications` | any signed-in user | , | `text/event-stream`: content-free `refresh` hints (`{"type":"NOTIFICATION"}`) when a plan is submitted, approved or rejected; the client then re-reads `GET /notifications` | 401 |
| `POST /berth-recommendations` | M2 `edit` (`DIEU_PHOI_VIEN`) | `{ voyage_ids? }` (1 to 20 distinct queued voyages; default the first 20 of the queue) | 201 recommendation: `engine` (`LOCAL_OPTIMIZER`, `is_machine_learning: false`, `predictive_ai: UNAVAILABLE`), `policy_version`, `status` (`RECOMMENDED` or `NO_FEASIBLE_PLACEMENT`), `snapshot_hash`, `duration_ms`, per vessel: `outcome`, `reasons`, `proposals` (rank 1 to 3: berth, positions, times, `expected_wait_h`, `required_cranes`, `score` (utility, not confidence), `reasons`, `uc026` result) | 400 (more than 20, duplicates, not in the queue); 401; 403 (audited); 409 `QUEUE_EMPTY` |
| `GET /berth-recommendations/:id` | M2 `view` | , | 200 the stored recommendation with the human decisions | 401, 403, 404 |
| `POST /berth-recommendations/:id/ignore` | M2 `edit` | `{ voyage_id, reason? }` | 200 recommendation with the decision `IGNORED` | 400, 403, 404, 409 `ALREADY_IGNORED` |
| `GET /voyages/:id/eta-predictions` | M1 view (an agent: its own voyages) | , | 200 `{ voyage_id, total, items }`, newest first. Item: `id`, `sequence` (1 is the first), `requested_at`, `declared_eta` (at that time), `status` (`AVAILABLE` or `UNAVAILABLE`), `label` ("chưa có dự báo AI" when unavailable), `predicted_eta`, `deviation_h` (predicted minus declared), `confidence`, `confidence_meaning`, `model_version`, `reason`, `source` (`{kind: EXTERNAL_AI, model_version}` or `{kind: NONE, reason}`), `input_hash`. Values of a forecast are null when none exists | 401; 403; 404 |
| `GET /notifications?unread=&page=&size=` | any signed-in user | | 200 `{ items: [{ id, title, body, entity_type, entity_id, created_at, read_at, for_role }], total, unread, page, size }`: only rows addressed to the user or to one of their roles | 400; 401 |
| `POST /notifications/:id/read` | any signed-in user | | 200 the notification with `read_at` (a role notice has one shared read mark); repeating is harmless | 404 for a notice not addressed to the user |

In one transaction the approval locks the queue, the berth, the voyage and the plan (in that order), repeats the placement check on current data (only APPROVED and COMPLETED plans count as reservations), and then changes the plan, the voyage (`WAITING_BERTH` to `BERTH_ASSIGNED`, history row), the queue (positions behind it move up, `LEFT_QUEUE` history row, queue revision) and writes the notices and the audit rows. After the commit a refresh hint is sent on `/realtime/m2/events` (`PLAN_SUBMITTED`, `PLAN_APPROVED`, `NOTIFICATION`). Voyage states: `ANNOUNCED, MISSING_DOCUMENTS, REJECTED, VALIDATED, WAITING_BERTH, BERTH_ASSIGNED, BERTHED, DEPARTED`.

## 3. Planned endpoints: Module M1 (vessel arrival and departure)

Each row gives the use case, allowed roles, request, success response, and main errors. Status is **planned** until implemented and tested.

| Method and path | UC | Roles | Request | Success | Main errors |
|---|---|---|---|---|---|
| `POST /ships` | UC-010 | DIEU_PHOI_VIEN | `{imo_number, ship_name, ship_type_code, flag_state, operator_agent_id, length_overall_m, beam_m, max_draft_m, deadweight_t}` | 201 ship | 400 (IMO format, dimensions), 409 IMO exists |
| `GET /ships?search=&page=&size=` | UC-011 | DIEU_PHOI_VIEN, QUAN_TRI_HE_THONG | query | 200 list | 400 |
| `GET /ships/:id` | UC-011 | DIEU_PHOI_VIEN, QUAN_TRI_HE_THONG, DAI_LY_HANG_HAI (own agent only) | — | 200 ship | 404 |
| `PATCH /ships/:id` | UC-011 | DIEU_PHOI_VIEN | editable fields, `reason` | 200 ship, `ETag` | 409 CONFLICT, 400 IMO duplicate |
| `POST /ships/:id/deactivate` | UC-011 | DIEU_PHOI_VIEN | `{reason}` | 200 ship | 409 BUSINESS_RULE_VIOLATION (open voyage exists, UC-011 6a) |
| `POST /ships/:id/documents` | UC-012 | DIEU_PHOI_VIEN, DAI_LY_HANG_HAI (own agent only) | multipart: `file` (PDF, JPEG, PNG, ≤10 MB), `document_type_code`, `voyage_id?`, `valid_from?`, `valid_until?` | 201 document (`review_status: PENDING`) | 400 type or size, 404 |
| `PATCH /ship-documents/:id/review` | UC-012 | DIEU_PHOI_VIEN | `{review_status: APPROVED|REJECTED, review_note?, valid_from?, valid_until?}` (note required for REJECTED) | 200 document | 400, 409 |
| `POST /voyages` | UC-013 | DAI_LY_HANG_HAI (own agent), DIEU_PHOI_VIEN | `{ship_id, voyage_code, agent_id, origin_port_id, declared_eta, declared_teu, cargo_type, service_request?, priority_class?}` | 201 voyage with `status` after validation (UC-015 runs in the same request, bounded by the AI timeout) | 400, 409 duplicate, 409 ship inactive or missing profile |
| `POST /voyages/:id/validate` | UC-015 | DIEU_PHOI_VIEN | — (re-run for an `ANNOUNCED` or `MISSING_DOCUMENTS` voyage) | 200 voyage with decision and reasons | 409 wrong status, 503 POLICY_UNAVAILABLE |
| `GET /voyages/queue` | UC-020 | DIEU_PHOI_VIEN, BAN_QUAN_LY | — | 200 ordered list (`queue_position`, predicted ETA, priority) | — |
| `PATCH /voyages/:id/queue-position` | UC-020 | DIEU_PHOI_VIEN | `{to_position, reason}` (reason required) | 200 queue entry, `ETag` | 400 reason missing, 409 CONFLICT |
| `GET /voyages/schedule?view=list\|gantt&from=&to=&status=&ship_id=&berth_id=` | UC-021 | DIEU_PHOI_VIEN, BAN_QUAN_LY, QUAN_TRI_HE_THONG | query | 200 items | 400 range |
| `POST /voyages/:id/berthing` | UC-022 | DIEU_PHOI_VIEN | `{ata?, reason?}` (`reason` required when ATA is edited) | 200 voyage (`BERTHED`), berth state derived | 409 no approved plan, 409 CONFLICT |
| `POST /voyages/:id/departure` | UC-023 | DIEU_PHOI_VIEN | `{atd?, reason?}` | 200 voyage (`DEPARTED`) | 409 not berthed, 409 CONFLICT |

**UC-015 result contract** (returned by `POST /voyages` and `POST /voyages/:id/validate`):

```json
{
  "voyage": { "id": 12, "status": "WAITING_BERTH", "queuePosition": 3 },
  "validation": {
    "result": "VALID",
    "reason": null,
    "policyVersion": "UC015-POLICY-V0",
    "rules": [ { "id": "REQUIRED_FIELDS", "outcome": "PASS" }, { "id": "IMO_FORMAT", "outcome": "PASS" } ]
  },
  "ai": { "status": "UNAVAILABLE", "label": "chưa có dự báo AI", "predictedEta": null }
}
```

`result` is one of `VALID`, `MISSING_DOCUMENTS`, `REJECTED`. `ai.status` is `AVAILABLE` or `UNAVAILABLE`; `UNAVAILABLE` is a labeled fallback, not an error.

## 4. Planned endpoints: Module M2 (berth scheduling)

| Method and path | UC | Roles | Request | Success | Main errors |
|---|---|---|---|---|---|
| `GET /berths?page=&size=` | UC-024, UC-025 | BAN_QUAN_LY, DIEU_PHOI_VIEN | query | 200 list | — |
| `POST /berths` | UC-024 | DIEU_PHOI_VIEN | `{berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes, allows_dangerous, longitude?, latitude?}` | 201 berth | 400 (code duplicate, values ≤ 0) |
| `PATCH /berths/:id` | UC-024 | DIEU_PHOI_VIEN | editable fields | 200 berth, `ETag` | 409 BUSINESS_RULE_VIOLATION (affected plans listed, UC-024 6a), 409 CONFLICT |
| `GET /berths/status?at=` | UC-025 | DIEU_PHOI_VIEN, BAN_QUAN_LY | `at` (default now) | 200 `[ {berthId, state, voyageId?, planId?, maintenanceId?} ]` with state `Trống`, `Đang sử dụng`, `Bảo trì`, `Đã đặt trước` | — |
| `POST /berth-plans/check` | UC-026 | DIEU_PHOI_VIEN, BAN_QUAN_LY | `{voyage_id, berth_id, position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m?}` | 200 `{passed, results: [{rule, passed, reason}]}` | 400 missing data (UC-026 6a) |
| `POST /berth-plans/proposals` | UC-027 | DIEU_PHOI_VIEN | `{voyage_ids: [1..20]}` | 200 `{status: AVAILABLE, proposals: [...]}` or `{status: UNAVAILABLE, reason}` | 400 more than 20 voyages, 503 is **not** used: UNAVAILABLE is returned as a labeled result |
| `GET /berth-plans/proposals?voyage_id=` | UC-027 | DIEU_PHOI_VIEN | query | 200 list of stored proposals (FR-BRT-12) | — |
| `POST /berth-plans` | UC-028 | DIEU_PHOI_VIEN | `{source: MANUAL|AI|AI_ADJUSTED, voyage_id, proposal_id?, berth_id, position_start_m, position_end_m, planned_start, planned_end, required_cranes, override_reason?}` | 201 plan `DRAFT` | 400, 409 BUSINESS_RULE_VIOLATION (constraint failed without override, UC-028 3a) |
| `PUT /berth-plans/:id` | UC-028 | DIEU_PHOI_VIEN | same fields, `If-Match` | 200 plan | 409 CONFLICT, 409 status not DRAFT |
| `POST /berth-plans/:id/submit` | UC-029 | DIEU_PHOI_VIEN | `{}` | 200 plan `PENDING_APPROVAL` | 409 constraints not passed (UC-029 2a) |
| `POST /berth-plans/:id/approve` | UC-030 | BAN_QUAN_LY | `{confirm: true}` (UC-030 step 5) | 200 plan `APPROVED`; berth state derived | 409 constraints changed (UC-030 6a), 403 |
| `POST /berth-plans/:id/reject` | UC-031 | BAN_QUAN_LY | `{reason}` (required) | 200 plan `REJECTED` | 400 reason missing, 409 already decided |
| `GET /berth-plans?status=&page=&size=` | UC-029, UC-030 | DIEU_PHOI_VIEN, BAN_QUAN_LY | query | 200 list | — |
| `GET /berth-plans/:id` | UC-030 | DIEU_PHOI_VIEN, BAN_QUAN_LY | — | 200 plan with constraint results, proposal, overrides | 404 |

Approval and rejection are the only transitions that set `APPROVED` or `REJECTED` (state machine in the service; `berth_plan_status_history` records each transition).

## 5. Planned: notifications and realtime

| Method and path | Purpose | Roles |
|---|---|---|
| `GET /notifications?unread=true&page=&size=` | In-app notifications for the caller (D6) | any authenticated user |
| `POST /notifications/:id/read` | Mark read | recipient only |
| `GET /realtime/m2/snapshot` | Current berth states (UC-025 refresh) | DIEU_PHOI_VIEN, BAN_QUAN_LY |
| `GET /realtime/m2/events` | SSE stream: `berth.changed`, `plan.changed`, `notification.created`. Refresh hints only | DIEU_PHOI_VIEN, BAN_QUAN_LY |

SSE carries identifiers and revisions only. The client re-reads the resource with an authorized request.

## 6. Contract conflicts with the legacy frontend (to resolve in Milestone 3)

| Endpoint family | Legacy FE expects (`Front/js/api.js`, legacy `SmartPort-FE`) | This contract | Resolution |
|---|---|---|---|
| M2 list reads (`/berths`, `/berth-plans`, `/replanning-alerts`, `/voyages/schedule`) | Top-level `{items,total,page,size}` without the envelope | `{success, data: {items,...}}` | Use the envelope everywhere. Update the FE validators (small change, Milestone 3) |
| `/berth-plans/proposals` | Bare array for GET, `{status, proposals}` for POST | Envelope in both | Same as above |
| `/berths/status` | Bare array | Envelope with `items` | Same as above |
| Role labels | UI labels only | Role codes from §1.3 | No change needed |
| Login and me | `{success, data:{user:{id,username,displayName,roles}}}`, logout `204` | Same | Compatible (implemented) |

The legacy FE is not changed in `../SmartPort-FE`. Changes are made under `Front/`. `Front/` now holds the GitHub import (commit `8b065c8`, static sample-data UI). The client code this table refers to (`js/api.js`) exists only in the uncommitted working tree of `../SmartPort-FE`, not in `Front/`; see `docs/frontend/import-notes.md` §6.

## 7. Out of scope for this delivery

UC-014 (partner API), UC-017 to UC-019 (ETA alerts and updates), UC-032 to UC-035 (replanning and maintenance UI), UC-084 (release from billing). Their endpoints are not part of this contract.

Note (UC-027): `POST /berth-plans` accepts an optional `proposal_id`. The `source` is then set by the server (`AI` if the plan equals the proposal, `AI_ADJUSTED` if changed) and the decision is recorded; sending `source` together with `proposal_id` is a 400. `PUT /berth-plans/:id` re-classifies a plan that came from a proposal.

Note (UC-027 provenance, migration 0007): `source` of a berth plan is `MANUAL`, `LOCAL_OPTIMIZER` (equals a proposal of the local deterministic optimizer), `LOCAL_OPTIMIZER_ADJUSTED` (changed after it), or `AI` / `AI_ADJUSTED` (reserved for an actual external AI provider; none exists). The recommendation field `engine.kind` is `LOCAL_OPTIMIZER`, or `EXTERNAL_AI` (a historical `EXTERNAL_PROVIDER` is shown as `EXTERNAL_AI`). `policy_version` is `UC027-OPT-V2` for new requests; stored V1 snapshots stay replayable. UC-026 (`POST /berth-plan-checks`, save, submit, approve) treats a BERTHED vessel as occupying its stretch until its actual departure.

Note (UC-016): `GET /voyages/:id` carries the latest prediction as `eta` (same shape, or null), and the `ai` field of a validation result carries the same fields; a replayed result shows the stored forecast. Terminology and the missing definition of the actual arrival at port: `docs/architecture/eta-semantics.md`.

Note (asynchronous ETA, migration 0008): `POST /voyages` and `POST /voyages/:id/validate` answer immediately; `validation.ai.status` is `PENDING` (label "đang chờ dự báo AI") while a provider is configured and the forecast is running, `UNAVAILABLE / NOT_CONFIGURED` when none is configured. A prediction item (history, `eta`, `ai`) also carries `completed_at`, `attempts` and `queue_effect` (`REORDERED`, `UNCHANGED`, `NOT_APPLIED_LEFT_QUEUE`, `NOT_APPLIED_SUPERSEDED`, `KEPT_MANUAL_POSITION`); `source` is `{kind: PENDING}` while pending. Queue items carry `eta_status` (the status of the latest prediction) and `eta_source` (`AI` only for an available forecast). The refresh hint `ETA_UPDATED` is sent on `GET /realtime/m2/events` when a forecast is stored.

Note (berth plan chart, FR-BRT-03, 2026-11-19): `GET /api/v1/berths/:id/chart?from=<ISO 8601 with offset>&to=<ISO 8601 with offset>` (permission: M2 view; window at most 14 days, `to` after `from`; 400 with field errors, 404 unknown berth, 401/403 as for the other berth reads). Read only. Returns `berth {id, berth_code, berth_name, berth_type, length_m, operational_status, revision}`, `from`, `to`, `as_of`, `plans[]` and `maintenance[]`. Each plan: `plan_id, voyage_id, voyage_code, ship_name, voyage_status, plan_status` (DRAFT, PENDING_APPROVAL, APPROVED or COMPLETED; rejected and superseded plans are omitted), `source, from_proposal, position_start_m, position_end_m, planned_start, planned_end, required_cranes, revision, check_passed` (the stored UC-026 result), `has_override, ata, atd`, `occupies_from, occupies_to` (physical occupancy by the shared rule of `repositories/occupancy.js`; `occupies_to` is null while a BERTHED vessel is still alongside after its planned end) and `physically_berthed`. A UC-027 proposal is not stored as a plan, so it never appears here. Additive change: queue items (`GET /voyages/queue`) also carry `length_overall_m` (the ship's LOA, null if unknown). Evidence: `docs/testing/a3-chart-evidence.md`.
