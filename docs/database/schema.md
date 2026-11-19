# SmartPort V2 database design (baseline)

**Source of truth:** `API/migrations/0001_baseline.sql` (migrations) and this document (design rationale).
**Engine:** SQL Server. **Migration runner:** `API/src/db/migrate.js` (checksums, fail closed on edits).
**Rollback:** `API/migrations/rollback/0001_baseline.down.sql` (destructive, disposable databases only).
**Seeds:** `API/seeds/dev_seed.sql` (reference data, idempotent, separate from migrations).

## 1. Verification of baseline assumptions (decision D4)

Legacy evidence was read in read-only mode from the local `CangThongMinh_UC015_Test` database (schema only, no data). `CangThongMinh` was not modified. The legacy repository has no `CREATE TABLE` for `ships`, `berths`, `ports` or `agents` (gaps G1, G2). The live schema is therefore the only evidence for their columns.

| Table | Legacy column evidence | V2 decision | Reason |
|---|---|---|---|
| `ships` | `ship_code`, `ship_name`, `ship_type` (text), `capacity`, `current_berth_id`, `status`, `imo_number`, `length_overall`, `draft`, `is_active` | Keep `ship_code`, `ship_name`, `imo_number` (NOT NULL, UNIQUE, 7 digits). `ship_type` becomes FK to `ship_types`. `length_overall`, `draft` renamed to `length_overall_m`, `max_draft_m`. Add `beam_m`. `capacity` renamed to `deadweight_t` (the specification says "tổng trọng tải"). `current_berth_id` and `status` removed | FR-VES-01 requires IMO, LOA, width, draft and total deadweight. Berth presence is derived from plans (§4). `capacity` semantics are **not confirmed**; see A-1 |
| `berths` | `berth_code`, `berth_name`, `length`, `status`, `max_depth_m`, `berth_type`, `available_cranes`, `allows_dangerous`, `longitude`, `latitude`, `is_active`, `revision` | Keep all. `length` renamed to `length_m`. `status` renamed to `operational_status` with domain `IN_SERVICE` / `OUT_OF_SERVICE` | Decision 5: operational status and time-dependent availability are separate. The legacy `status` domain is not known; see A-2 |
| `ports` | `port_code`, `port_name`, `is_active` | Keep, add `country_code`, `revision` | Required for voyage origin (UC-013 "cảng đi") |
| `agents` | `agent_name`, `is_active` | Add `agent_code` (UNIQUE NOT NULL) | Needed to identify agents in the API and in agent scope checks |
| `voyages` | Legacy statuses include `PLANNED` (default) and `QUEUED` | V2 status set: `ANNOUNCED`, `MISSING_DOCUMENTS`, `REJECTED`, `VALIDATED`, `WAITING_BERTH`, `BERTHED`, `DEPARTED` | The specification (FR-VES-08 and UC-013 to UC-023) defines these lifecycle names. Legacy `PLANNED` and `QUEUED` do not appear in the specification. See A-3 |
| `ship_documents` | Ship-level only. Validity as `DATETIME2` | Add nullable `voyage_id` (D2). Validity as `DATE`. `document_type_code` FK. MIME and size CHECK | D2: voyage-specific documents and validity. Dates have no time component |
| `voyage_eta_predictions` | Legacy table present | Kept, with the same CHECK logic for `AVAILABLE` / `UNAVAILABLE` | UC-016 result storage. Latest forecast referenced from `voyages` |
| `berth_plans` | Legacy statuses `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `SUPERSEDED`, `COMPLETED` | Kept. One open plan per voyage enforced by a filtered unique index | UC-029 and UC-030. Specification's approval step |
| `berth_maintenance` | Legacy `ACTIVE` / `CANCELLED` | Kept as the source for maintenance intervals | Needed by UC-026 check 5. UC-034 and UC-035 UIs are out of scope |
| auth tables | `auth_users`, `auth_sessions` (`token_hash VARBINARY(32)`), `auth_roles`, `auth_user_roles` | Kept, same shape. Added `auth_user_agents` | Matches legacy migration 011. Agent scope (A-7 in UC015) |
| audit | `planning_audit`, `ship_audit_log`, `auth_user_audit_log` (three tables) | Replaced by one `audit_events` table | Rule 04 needs one record shape. Three tables duplicated it |

Assumptions that remain open are listed in §7.

## 2. Table groups and migration order

Migration `0001_baseline.sql` creates tables in this order, so every foreign key points to an existing table:

1. Catalogs: `ports`, `agents`, `ship_types`, `document_types`, `system_parameters`
2. Vessels: `ships`, `voyages`, `voyage_status_history`, `voyage_queue_changes`, `voyage_eta_predictions`, then the circular FK `voyages.latest_eta_prediction_id`
3. Documents: `ship_documents`
4. Berths and planning: `berths`, `berth_maintenance`, `berth_plan_inferences`, `berth_plan_proposals`, `berth_plans`, `berth_plan_status_history`
5. Authentication: `auth_users`, `auth_roles`, `auth_user_roles`, `auth_user_agents`, `auth_sessions`
6. Notifications and audit: `notifications`, `audit_events`

Applied with the runner, the migration creates 24 baseline tables, plus the filtered indexes `UX_bp_open_plan_per_voyage`, `IX_bp_berth_time`, `IX_notif_user_unread`, and the audit index. The runner creates `dbo.schema_migrations` separately, so 25 tables exist in total. Rollback was verified: 24 tables dropped, and re-application recreated them (evidence in `docs/testing/milestone-0-evidence.md`).

## 3. Integrity rules in the schema (rule 05)

| Rule | Mechanism |
|---|---|
| IMO unique, 7 digits | `UQ_ships_imo`, `CK_ships_imo_digits` |
| Vessel dimensions and deadweight > 0 (UC-010) | `CK_ships_dimensions` |
| One notice per vessel and voyage code (UC-013) | `UQ_voyages_ship_code` |
| `BERTHED` and later need `ata`; `DEPARTED` needs `atd >= ata` | `CK_voyages_ata`, `CK_voyages_atd` |
| Only `VALID` voyages reach `VALIDATED` or later (BR-1, BR-4) | `CK_voyages_valid_result` |
| `WAITING_BERTH` needs a queue position; other statuses have none | `CK_voyages_queue_state` |
| Document size 1 byte to 10 MB (UC-012) | `CK_sd_size` |
| Document MIME is PDF, JPEG or PNG (UC-012) | `CK_sd_mime` |
| Document validity ends after it starts | `CK_sd_validity` |
| A rejected document needs a note; review fields must match review status | `CK_sd_rejected_note`, `CK_sd_review_fields` |
| Maintenance start before end (UC-034) | `CK_bm_period` |
| Plan start before end; position end after start | `CK_bp_period`, `CK_bp_position` |
| A plan in `PENDING_APPROVAL` or `APPROVED` must have passed constraints (UC-029, UC-030) | `CK_bp_reviewed` (checks `constraint_check_json.passed = true`) |
| One open plan per voyage (UC-029) | `UX_bp_open_plan_per_voyage` (filtered unique) |
| AI proposal source requires a proposal reference (FR-BRT-12) | `CK_bp_source_proposal` |
| Proposal rank 1 to 3 (FR-BRT-05) | `CK_bpp_rank` |
| Override reason 1 to 500 characters (UC-028) | `CK_bp_override` |
| Rejection needs a reason (UC-031) | `CK_bp_reject_reason` |
| Queue change reason is non-blank (UC-020). ETA change history (UC-018) is out of scope and has no table in this baseline | `CK_vqc_reason` |
| Audit outcome is `SUCCESS`, `DENIED` or `FAILED`; JSON is valid | `CK_audit_outcome`, `CK_audit_*_json` |
| Session expiry after creation | `CK_as_expiry` |

Rules that need more than one row (berth overlap BR-01, buffer BR-02, maintenance overlap) are enforced in the service inside a transaction that locks the berth row. They are not expressible as a single CHECK without a trigger, and triggers are avoided in this baseline.

## 4. Berth availability model (decision 5)

- `berths.operational_status` (`IN_SERVICE` or `OUT_OF_SERVICE`) is the only stored berth status.
- Availability at time `t` is computed from:
  - `berth_plans` with `plan_status = 'APPROVED'` and `planned_start <= t < planned_end`, joined to the voyage;
  - `berth_maintenance` with `status = 'ACTIVE'` and `starts_at <= t < ends_at`;
  - `berths.operational_status`.
- Display state (UC-025): `Bảo trì` if maintenance contains `t`; `Đang sử dụng` if an approved plan contains `t` and its voyage is `BERTHED`; `Đã đặt trước` if an approved plan starts after `t`; `Trống` otherwise.

Advantage: no stored flag can drift from the plans. Cost: a time-range query per berth. Index `IX_bp_berth_time` supports it.

## 5. Concurrency

Mutable master and planning rows carry `revision` (`ships`, `berths`, `voyages`, `berth_plans`, `berth_maintenance`, `system_parameters`, `ports`, `agents`, `ship_types`, `ship_documents`). Updates must check the expected revision (`If-Match` in the API, see `docs/api/contracts.md` §5). Conflicts return `409` and reload the record (UC-020 and UC-028 exception flows).

## 6. Data retention

Audit and status history rows are append-only in the application. No application code updates or deletes them. Notifications keep `read_at` for history.

## 7. Open assumptions

| ID | Assumption | Affected |
|---|---|---|
| A-1 | `capacity` in the legacy `ships` table is interpreted as total deadweight (`deadweight_t`). Not confirmed by any legacy document. | UC-010 |
| A-2 | Legacy `berths.status` values are unknown. V2 uses `IN_SERVICE` / `OUT_OF_SERVICE`. Existing legacy data must be mapped before migration; the baseline targets an empty database. | UC-024, UC-025 |
| A-3 | The voyage lifecycle names in the specification are authoritative. Legacy `PLANNED` and `QUEUED` are not used. | UC-013 to UC-023 |
| A-4 | `priority_class` (`STANDARD`, `MAIN_LINE`, `REEFER_OR_HAZARD`) is the operational interpretation of "độ ưu tiên". The specification examples are "tàu tuyến chính" and "hàng lạnh/nguy hiểm". | UC-015 step 4, UC-020 |
| A-5 | Berth position is a metre offset along the quay (`position_start_m`, `position_end_m`). | UC-026, UC-028 |
| A-6 | Voyage-level documents (D2) store validity on the document row. Whether a voyage requires a specific document type is policy content (UC015 A-1). | UC-012, UC-015 |
| A-7 | Agent scope is a link table (`auth_user_agents`). Vessel ownership is `ships.operator_agent_id` for display only. | UC-013, UC-015 |

## 7a. Migration 0002 (UC-013 drafts, UC-015, UC-020)

New tables: `validation_policies` (version, JSON config, SHA-256 checksum, effective window), `vessel_restrictions`, `voyage_validation_runs` (one audited row per run), `voyage_drafts` (private drafts with revision), `voyage_queue_state` (single row, queue revision). Rollback: `migrations/rollback/0002_validation_queue_drafts.down.sql`, verified 29 → 24 → 29 tables. Policy catalog: `docs/policies/uc015-uc020-policy-v1.md`.

## 7b. Migrations 0003 and 0004 (UC-028/029, UC-026 changes, decision F-4)

0003: `berth_plans` gets `override_by_user_id`, `override_at`, `override_rules` and the all-or-nothing constraint `CK_bp_override_set`; `CK_bp_reviewed` is replaced (a submitted plan needs `passed = true`, or an override reason together with a check whose `outcome` is VIOLATION, so missing data can never be overridden); `UX_bp_draft_per_voyage` allows one draft per voyage; `voyages` gets the verified cargo hazard (`cargo_hazard`, basis, verifier, time; `CK_voyages_cargo_hazard`). 0004: `CK_bp_no_self_approval`, the submitter cannot be the approver. Rollbacks: `migrations/rollback/0003_...down.sql` refuses to run (THROW 50031 or 50032, nothing changed) when plans with an override or voyages with a verified hazard exist, so no data is lost; `0004` only drops the constraint. Verified in `test/integration/migration-0003-0004.test.js` on a scratch database. Planned for UC-030 (not applied): `BERTH_ASSIGNED` voyage state, see `docs/architecture/m2-planning-design.md` §2.

## 7c. Migration 0005 (decision C-1, UC-030)

`voyages`: `CK_voyages_status` and `CK_voyages_valid_result` accept `BERTH_ASSIGNED` (the second now also states `validation_result IS NOT NULL`: in SQL Server a CHECK passes when its expression is UNKNOWN, so a NULL result used to slip through). `CK_voyages_queue_state` and `CK_voyages_ata` are unchanged and fit: an assigned voyage has no queue position and needs no ATA; `BERTHED` still needs one. `voyage_queue_changes` gets `change_type` (`MOVE` for all existing rows, `LEFT_QUEUE` when a voyage leaves the queue) and `to_position` becomes nullable, tied by `CK_vqc_positions`. Rollback (`rollback/0005_...down.sql`) refuses to run while `BERTH_ASSIGNED` voyages or `LEFT_QUEUE` rows exist. Rehearsed forward and back on a database that held voyages (`SmartPortV2_Verify3`) with identical data fingerprints at every step, and verified with constraints and rollback in the migration test.

## 8. Reproduction

```
cd API
set SP_DB_NAME=SmartPortV2_Verify2   # disposable database; never a legacy name
npm run migrate
sqlcmd -S localhost -E -C -I -d SmartPortV2_Verify2 -i seeds/dev_seed.sql
npm run test:unit
set SP_TEST_DB=SmartPortV2_Verify2 && npm run test:integration
```

## Migration 0006: berth recommendations (UC-027, 2026-11-19)
`berth_plan_inferences` gains `engine_kind` (`LOCAL_OPTIMIZER` or `EXTERNAL_PROVIDER`), `snapshot_hash` (SHA-256 of the canonical snapshot), `response_json`, `duration_ms`, `completed_at`; `model_version` holds the algorithm version. New `berth_plan_inference_vessels` (one row per vessel of a request: queue position, effective ETA and its source, outcome `RECOMMENDED` or `UNSCHEDULABLE`, candidates considered and refused by UC-026, reasons). `berth_plan_proposals` gains `position_end_m` and `explanation_json`, and the rank is unique per vessel inside a request (`UQ_bpp_rank_vessel`, replacing `UQ_bpp_rank`, which allowed only three proposals per request). New `berth_plan_decisions` (the final human choice: `ACCEPTED`, `MODIFIED` or `IGNORED`, linked to the proposal and the plan; one decision per plan, one ignore per vessel of a request). A plan made from a proposal carries `source = AI` or `AI_ADJUSTED` and `proposal_id` (columns that existed). Rollback `rollback/0006_berth_recommendations.down.sql` refuses to run while any plan from a proposal, decision, vessel outcome, proposal or request exists. Existing rows are untouched (verified).

## Migration 0007: recommendation provenance (UC-027, 2026-11-19)
`berth_plans.source` is widened to `VARCHAR(30)` and may be `MANUAL`, `AI`, `AI_ADJUSTED`, `LOCAL_OPTIMIZER` or `LOCAL_OPTIMIZER_ADJUSTED`; every non-manual source needs a `proposal_id`. `berth_plan_inferences.engine_kind` may be `LOCAL_OPTIMIZER`, `EXTERNAL_AI` or the historical `EXTERNAL_PROVIDER`. Plans that came from a `LOCAL_OPTIMIZER` request and carried `AI` / `AI_ADJUSTED` are relabelled (one audit row records the count); no other row changes. Rollback `rollback/0007_recommendation_provenance.down.sql` refuses to run while a `LOCAL_OPTIMIZER` plan or an `EXTERNAL_AI` request exists. Verified forward, rollback refusals and re-apply on a scratch database. Occupancy (not a schema change): `repositories/occupancy.js` defines when a plan occupies its stretch for UC-026 and UC-027.

## Migration 0008: durable ETA prediction jobs (UC-015 / UC-016, 2026-11-19)
`voyage_eta_predictions.ai_status` may be `PENDING` (a result-less row; the row is the job). New columns: `completed_at`, `attempts`, `claim_token` and `claimed_until` (the lease), `queue_effect`. One `PENDING` row per voyage (`UX_vep_one_pending`); `IX_vep_claim` serves the claim query. `voyage_validation_runs.ai_status` may be `PENDING`. Old rows and the rules for `AVAILABLE` and `UNAVAILABLE` are unchanged. Rollback `rollback/0008_eta_prediction_jobs.down.sql` refuses to run while a `PENDING` prediction or run exists or any row holds completion, attempt or queue-effect information. Verified forward, refusals, rollback and re-apply on a scratch database.
