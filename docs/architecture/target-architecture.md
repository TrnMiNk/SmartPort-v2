# SmartPort V2 target architecture (Milestone 0)

**Status:** Accepted for Milestone 0. Scope: M1 (vessel arrival/departure) and M2 (berth scheduling) plus minimum dependencies.
**Decision record:** `docs/architecture/ADR-001-single-node-api.md` (D7).
**Related:** `docs/database/schema.md`, `docs/api/contracts.md`, `.claude/plans/smartport-v2-roadmap.md`.

## 1. Components

| Component | Location | Responsibility | Technology |
|---|---|---|---|
| Frontend | `Front/` (to be created, Milestone 3) | Screens for M1 and M2. Calls the API only through one client module. | Static HTML/CSS/JS, as in the legacy FE (reused) |
| API | `API/` | Business rules, authorization, validation, audit, notifications, AI adapters | Node.js 24, Express 5, `mssql` with `msnodesqlv8` |
| Database | `API/migrations/`, `API/seeds/` | Schema, constraints, reference data | SQL Server (local instance for development) |
| AI services | Outside this repo | ETA forecast (UC-016), berth recommendation (UC-027) | Provider not chosen (D3). Adapter contract only |

Realtime (UC-025) and notification refresh use Server-Sent Events from the API. SSE is a refresh signal only. It is not proof of delivery (`docs/legacy/critical-gaps.md` G9).

## 2. API layering (rule 04)

```
HTTP request
  → src/routes/            wire path, middleware, controller (no logic)
  → src/http/auth.js       session resolution and default-deny role checks
  → src/controllers/       parse input, call service, shape response
  → src/validation/        boundary validation, returns field errors
  → src/services/          business rules (UC rules, policies, state transitions, audit)
  → src/repositories/      SQL only, parameterized, no decisions
  → SQL Server
```

Errors: every failure is an `AppError` with a code (`src/errors.js`). Unknown errors become `INTERNAL_ERROR` with no details. Stack traces, SQL and internal identifiers never reach the client (`src/http/errorHandler.js`).

## 3. Authentication and authorization

- Login creates an opaque session token (32 random bytes). The client receives it in an `HttpOnly`, `SameSite=Lax` cookie. The database stores only its SHA-256 hash (`auth_sessions.token_hash`).
- A readable presence cookie `sp_auth` must accompany the session cookie. Deleting it ends the browser's session when the server cannot be reached at logout (UC-002 4a); it is not a security control (UC002 A-4, A-5). Both cookies are re-issued on every accepted request.
- Roles map to features through the SRS permission matrix (`API/src/security/permissions.js`); endpoints use `requirePermission(feature, actions)`, default deny, with denials audited. The API also returns `permissions` so the frontend can hide menus; it never replaces the server check.
- Idle timeout is sliding (default 30 minutes, UC-002). Logout revokes the row, so the next request fails at once (UC-002 acceptance).
- Five consecutive failures lock the account (UC-001). Lock duration is configurable (default 15 minutes, see UC001 A-2).
- Roles are read on every request (`resolvePrincipal`). A role change takes effect on the next request (UC-005 acceptance).
- Authorization is server-side for every protected route, default deny: `requireRole()` with no roles denies everything. Frontend role checks are usability only (`.claude/rules/03-frontend-rules.md`).
- Agent accounts act only for linked agents (`auth_user_agents`). Ownership checks are in the services that touch voyages (UC-013, UC-015).

**Deviation from specification:** UC-001 says "token JWT". V2 uses server-side opaque sessions, because UC-002 requires revocation before expiry and the legacy FE contract uses cookies. Recorded in `docs/use-cases/UC001.md`.

## 4. Business policies

- **Voyage validation (UC-015):** a pure, versioned policy module. Input: a voyage notice and the vessel's documents and state. Output: `VALID`, `MISSING_DOCUMENTS` or `REJECTED`, with reasons and the policy version. Equal inputs and version give equal outputs. Each run writes one audit event. Policy content is not yet approved (UC015 A-1). Until it is, the policy module fails closed (no `VALID` without an effective policy, UC015 BR-4).
- **Berth constraints (UC-026):** a pure function over vessel and berth data, returning pass or violation per rule (LOA, draft, berth type, cranes, overlap BR-01, buffer BR-02, dangerous goods BR-03, maintenance). Overlap and buffer are checked inside a transaction that locks the berth row, so two concurrent plans cannot both pass.
- **Berth availability (decision 5):** operational status (`berths.operational_status`: `IN_SERVICE` or `OUT_OF_SERVICE`) is stored. Time-dependent availability is derived at query time from approved plans, voyage state and maintenance intervals. It is never stored as a flag that can go stale. Derived display states: `Đang sử dụng` (an approved plan contains now and the voyage is `BERTHED`), `Đã đặt trước` (an approved plan starts in the future), `Bảo trì` (an active maintenance interval contains now), `Trống` otherwise.

## 5. AI integration

- Adapters live behind an interface with explicit timeout (`AI_TIMEOUT_MS`, default 10 000, from the specification).
- Results are stored with `ai_status` (`AVAILABLE` or `UNAVAILABLE`) and a failure reason. An unavailable service produces the labeled fallback required by UC-015 3a and UC-027 3a. It never produces a simulated forecast.
- Without a working provider (D3), the AI-dependent acceptance criteria are reported as **blocked**, not passed.

## 6. Notifications (D6)

In-app notifications are rows in `notifications` addressed to a user or a role. Email is deferred. SSE pushes unread counts and refresh hints only.

## 7. Audit (rule 04)

Every state-changing operation writes one `audit_events` row: actor, action, entity type and id, outcome (`SUCCESS`, `DENIED`, `FAILED`), reason, and JSON before and after where relevant. Policy decisions also record the policy version and the rules evaluated.

## 8. Open items

- Deployment target and driver (Windows only with `msnodesqlv8`, or cross-platform with `tedious` and SQL authentication). Owner: project owner. Blocks production deployment, not development.
- AI provider contracts (D3). Owner: project owner and AI owner.
- Policy content for UC-015 (A-1 in `docs/use-cases/UC015.md`). Owner: project owner.

## 9. Legacy reuse rules

- Legacy repositories are read-only (`CLAUDE.md` §2). Nothing is copied without review.
- Reused: migration structure and CHECK constraints (rewritten in `API/migrations/0001_baseline.sql`), UC logic after review, legacy tests as reference evidence only.
- Not reused: the Spring proxy layer (`QLDAPM`), the hard-coded connection in the GitHub backend, and its schema (`ship_code` without IMO, no validation or authentication).
