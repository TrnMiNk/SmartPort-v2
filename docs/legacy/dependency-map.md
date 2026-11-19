# Legacy dependency map

Scope: UC-001 to UC-111 from `../SmartPort/runtime-verification/final-acceptance/usecases.txt`. Read-only. See `inventory.md` for titles and code-evidence status.

## Legend

- **Endpoints**: HTTP paths from the legacy Node backend (`../SmartPort/backend-nodejs`). Mounts come from `server.js`.
  - `code-confirmed`: the route exists and the UC has a test or migration that names it.
  - `route only`: the route exists, but no UC identifier appears in code.
  - `none`: no route found for the UC.
- **Tables**: from `backend-nodejs/database/migrations/`, when the migration names the UC or the table matches the endpoint's behavior. Not all table links were traced to code; these are marked where uncertain.
- **Prerequisites (UC to UC)**: from the spec's "Điều kiện tiên quyết" lines, naming another UC. **Doc-only**. Code was not checked for each link.

Backend mounts (`server.js`): `/api/v1/auth`, `/api/v1/admin`, `/api/realtime/m2`, `/api/eta-alerts`, `/api/replanning-alerts`, `/api/voyages` (four routers), `/api` (berth routers), `/api/ships` (documents), `/api/v1/integration` (partner). Inline `/api/ships` handlers are in `server.js`.

## Table: UC to endpoints, tables, prerequisites

| UC | Endpoints | Tables (migration) | Prerequisite UCs (doc-only) |
|---|---|---|---|
| UC-001 | `POST /api/v1/auth/login`, `GET /api/v1/auth/me` (route only) | auth_users, auth_sessions (011) | none |
| UC-002 | `DELETE /api/v1/auth/logout` (route only) | auth_sessions (011) | UC-001 |
| UC-003 | `POST /api/v1/admin/users` (code-confirmed) | auth_users, auth_user_audit_log (014) | UC-001 |
| UC-004 | `PATCH /api/v1/admin/users/:id/deactivate` (code-confirmed) | auth_users, auth_user_audit_log (014) | UC-001 |
| UC-005 | `GET /api/v1/admin/roles`, `PUT /api/v1/admin/users/:id/roles` (code-confirmed) | auth_roles, auth_user_roles (011) | UC-001 |
| UC-006 | none | — | UC-001 |
| UC-007 | none | — | UC-001 |
| UC-008 | none | auth_user_audit_log (014), no UC link | UC-001 |
| UC-009 | none | — | UC-001 |
| UC-010 | `POST /api/ships`, `GET /api/ships/:id` (code-confirmed, `server.js`) | ships (altered in 001; base table not in migrations) | none |
| UC-011 | `PUT /api/ships/:id`, `PATCH /api/ships/:id/deactivate`, `GET /api/ships/:id/history` (code-confirmed) | voyages, ship_audit_log (002) | UC-010 |
| UC-012 | `POST /api/ships/:shipId/documents`, `GET .../documents`, `GET .../documents/:documentId/download`, `PATCH .../review`, `POST .../revalidate` (code-confirmed) | ship_documents (003) | none explicit |
| UC-013 | `POST /api/voyages` (code-confirmed) | voyages (002), voyage_status_history, voyage_idempotency (004) | UC-010 |
| UC-014 | `POST /api/v1/integration/voyages` (code-confirmed) | ports, agents, integration_partners, partner_api_keys, partner_vessel_access, partner_voyage_idempotency (005) | none explicit (needs a ship record) |
| UC-015 | `POST /api/voyages/:id/validate`, `GET /api/voyages/queue` (code-confirmed) | columns added to ship_documents and voyages (006) | UC-013, UC-014 |
| UC-016 | `POST /api/voyages/:id/eta-prediction`, `GET /api/voyages/:id/eta-predictions` (code-confirmed) | voyage_eta_predictions (007) | UC-015, UC-018 |
| UC-017 | `GET /api/eta-alerts`, `GET /api/eta-alerts/:id`, `POST /api/eta-alerts/:id/dismiss` (code-confirmed) | eta_alert_dismissals (008) | UC-016 |
| UC-018 | `PUT /api/voyages/:id/eta` (code-confirmed) | voyage_eta_changes (009) | none explicit |
| UC-019 | `GET /api/voyages/:id/eta-history` (code-confirmed) | voyage_eta_changes (009) | none explicit |
| UC-020 | `GET /api/voyages/queue-state`, `PATCH /api/voyages/:id/queue-position` (code-confirmed) | voyage_queue_changes (009) | none explicit |
| UC-021 | `GET /api/voyages/schedule` (code-confirmed) | voyages (002); other tables not traced | none explicit |
| UC-022 | `POST /api/voyages/:id/berthing` (code-confirmed) | voyages (002); other tables not traced | UC-030 |
| UC-023 | `POST /api/voyages/:id/departure` (code-confirmed) | voyages (002); other tables not traced | UC-022 |
| UC-024 | `/api/berths` family (code-confirmed, `berthPlanning.js`) | berths: **not created in any migration** (gap) | none explicit |
| UC-025 | `GET /api/berths`, `GET /api/berths/status` (code-confirmed) | berths (gap, see UC-024) | UC-024 |
| UC-026 | `POST /api/berth-plans/check` (code-confirmed) | berth_plans (010) | UC-020 |
| UC-027 | `POST /api/berth-plans/proposals`, `GET /api/berth-plans/proposals` (code-confirmed) | berth_plan_inferences, berth_plan_proposals (015) | UC-020 |
| UC-028 | Route not located. Tests and Java proxy test exist. | Migration 016 (table changes not extracted) | UC-027 |
| UC-029 | `POST /api/berth-plans`, `PUT /api/berth-plans/:id`, `POST /api/berth-plans/:id/submit` (code-confirmed) | berth_plans (010), berth_plan_status_history (017) | UC-028 |
| UC-030 | `POST /api/berth-plans/:id/approve` (route only) | berth_plans (010) | UC-029 |
| UC-031 | `POST /api/berth-plans/:id/reject` (route only) | berth_plans (010) | UC-029 |
| UC-032 | `GET /api/replanning-alerts`, `POST /api/replanning-alerts/:id/:action` (code-confirmed) | replanning_alerts (018) | none explicit |
| UC-033 | `POST /api/berth-plans/:id/replan` (route only) | berth_plans (010) | UC-032 |
| UC-034 | `POST /api/berths/:id/maintenance` (code-confirmed) | berth_maintenance (010) | none explicit |
| UC-035 | `PUT /api/berths/:id/maintenance/:mid`, `PATCH .../cancel` (code-confirmed) | berth_maintenance (010) | UC-034 |
| UC-036 | none | — | none |
| UC-037 | none | — | none |
| UC-038 | none | — | none |
| UC-039 | none | — | UC-036, UC-037, UC-038 |
| UC-040 | none | — | UC-039 |
| UC-041 | none | — | UC-040 |
| UC-042 | none | — | UC-041 |
| UC-043 | none | — | UC-041 |
| UC-044 | none | — | UC-043 |
| UC-045 | none | — | UC-087 |
| UC-046 | none | — | UC-043, UC-044 |
| UC-047 | none | — | UC-046 |
| UC-048 | none | — | none explicit |
| UC-049 | none | — | UC-048 |
| UC-050 | none | — | none |
| UC-051 | none | — | UC-050 |
| UC-052 | none | — | none |
| UC-053 | none | — | UC-044 |
| UC-054 | none | — | UC-053 |
| UC-055 | none | — | UC-052 |
| UC-056 | none | — | none |
| UC-057 | none | — | none |
| UC-058 | none | — | UC-057 |
| UC-059 | none | — | UC-057 |
| UC-060 | none | — | UC-059 |
| UC-061 | none | — | UC-060 |
| UC-062 | none | — | UC-057 |
| UC-063 | none | — | UC-062 |
| UC-064 | none | — | UC-059, UC-060, UC-063 |
| UC-065 | none | — | none |
| UC-066 | none | — | UC-065 |
| UC-067 | none | — | UC-066 |
| UC-068 | none | — | UC-065 |
| UC-069 | none | — | none |
| UC-070 | none | — | UC-069 |
| UC-071 | none | — | UC-070 |
| UC-072 | none | — | UC-071 |
| UC-073 | none | — | UC-072 |
| UC-074 | none | — | UC-072 |
| UC-075 | none | — | UC-051 |
| UC-076 | none | — | UC-051 |
| UC-077 | none | — | UC-075, UC-076 |
| UC-078 | none | — | UC-077 |
| UC-079 | none | — | UC-077 |
| UC-080 | none | — | UC-079 |
| UC-081 | none | — | UC-079 |
| UC-082 | none | — | none |
| UC-083 | none | — | UC-079 |
| UC-084 | none | — | UC-083 |
| UC-085 | none | — | none |
| UC-086 | none | — | UC-085 |
| UC-087 | none | — | UC-085 |
| UC-088 | none | — | UC-087 |
| UC-089 | none | — | UC-087 |
| UC-090 | none | — | UC-087 |
| UC-091 | none | — | UC-087 |
| UC-092 | none | — | UC-089, UC-090, UC-091 |
| UC-093 | none | — | UC-001 |
| UC-094 | none | — | none |
| UC-095 | none | — | UC-094 |
| UC-096 | none | — | UC-085 |
| UC-097 | none | — | UC-085 |
| UC-098 | none | — | UC-097 |
| UC-099 | none | — | none |
| UC-100 | none | — | none |
| UC-101 | none | — | none |
| UC-102 | none | — | none |
| UC-103 | none | — | none |
| UC-104 | none | — | none |
| UC-105 | none | — | none |
| UC-106 | none | — | none |
| UC-107 | none | — | UC-105, UC-106 |
| UC-108 | none | — | none |
| UC-109 | none | — | UC-029 |
| UC-110 | none | — | none |
| UC-111 | none | — | UC-110 |

## Dependency chains (doc-only, from the table above)

- Vessel and voyage: UC-010 → UC-011, UC-013 → UC-015 (← UC-014) → UC-016 → UC-017.
- Voyage operations: UC-018 → UC-016 (also UC-015); UC-030 → UC-022 → UC-023.
- Queue to plan: UC-020 → UC-026, UC-027 → UC-028 → UC-029 → UC-030 / UC-031; UC-029 → UC-109.
- Replanning and maintenance: UC-032 → UC-033; UC-034 → UC-035.
- Cargo and yard (no code): UC-036/037/038 → UC-039 → UC-040 → UC-041 → UC-042 / UC-043 → UC-044 → UC-046 → UC-047; UC-044 → UC-053 → UC-054; UC-052 → UC-055; UC-057 → UC-058 / UC-059 → UC-060 → UC-061; UC-057 → UC-062 → UC-063; UC-065 → UC-066 → UC-067; UC-065 → UC-068.
- Service and billing (no code): UC-069 → UC-070 → UC-071 → UC-072 → UC-073 / UC-074; UC-051 → UC-075 / UC-076 → UC-077 → UC-079 → UC-080 / UC-081 / UC-083 → UC-084.
- IoT and maintenance (no code): UC-085 → UC-086 / UC-087 → UC-088 / UC-089 / UC-090 / UC-091 → UC-092; UC-094 → UC-095; UC-085 → UC-096 / UC-097 → UC-098.
- Reporting and backup: UC-105 + UC-106 → UC-107; UC-110 → UC-111.

## Doc-vs-code observations

- **UC-024 / UC-025 berths table.** Routes and tests reference berths, but no migration creates a `berths` table. Confirm where the table is defined before relying on UC-024 or UC-025 data.
- **UC-010 ships table.** `ships` is altered in migration 001 but not created in any migration.
- **UC-028 route.** Tests and a Java proxy exist, but no route was located in `berthPlanning.js` or `berthRecommendations.js`.
- **UC-030, UC-031, UC-033 linkage.** Routes exist, but no UC identifier appears in code. The link comes from the spec matrix.
- **UC-022, UC-023 tables.** The endpoints exist, but only `voyages` was traced in migrations. Other writes were not traced.
- **Spec prerequisites are not checked against code.** For example, UC-022 requires an approved plan (UC-030). The code check was not done per link.

## Gaps

- Tables for UC-021 to UC-023 and UC-028 to UC-033 were not fully traced.
- Frontend (`../SmartPort-FE`) was searched by UC identifier only. Its page-to-endpoint links were not mapped.
- The Java layer (`../SmartPort/QLDAPM`) was searched by UC identifier only. Its proxy routes were not mapped one by one.
- `ai-eta` was searched by UC identifier only. Its endpoints and behavior were not reviewed.
- UC-036 to UC-111 have no identifier in code. Behavior for these was not reviewed; the table reflects the spec only.
