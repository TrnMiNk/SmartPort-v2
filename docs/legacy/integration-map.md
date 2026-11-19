# Legacy integration map

Verified in this audit by reading configuration, route mounts, and client classes. Request and response schemas were not compared field by field.

## 1. Layers and request path

```
Browser (SmartPort-FE, static HTML/JS)
   │  /api/v1/...          js/api.js, js/auth.js, js/pages/*.js
   ▼
Spring Boot-style layer (QLDAPM, Gradle, package smartport_m1m)
   │  controllers keep the /api/v1 prefix; API clients call Node at
   │  smartport.node-api.base-url (default http://localhost:5000)
   ▼
Node.js backend (backend-nodejs, Express 5)
   │  mounts /api/..., and /api/v1/auth, /api/v1/admin, /api/v1/integration
   ▼
SQL Server (mssql) — tables from backend-nodejs/database/migrations
```

Confirmed in code:
- FE calls `/api/v1/...` (examples: `js/api.js` line 40 `/api/v1/berths`, `js/auth.js` line 57 `/api/v1/auth/login`).
- Spring controllers map `/api/v1/...` (examples: `AuthController` `@RequestMapping("/api/v1/auth")`, `VesselController` `/api/v1/vessels`, `OperationsController` `/api/v1`).
- Spring clients call Node `/api/...` paths. Example: `VesselController` calls `reads.get("/api/ships/" + id, ...)`.
- Node mounts (`server.js` lines 55–67): `/api/v1/auth`, `/api/v1/admin`, `/api/realtime/m2`, `/api/eta-alerts`, `/api/replanning-alerts`, `/api/voyages` (four routers), `/api` (two berth routers), `/api/ships`, `/api/v1/integration`. Inline `/api/ships` routes are in `server.js`.

Translation rule (observed, not documented): the Spring layer removes `/v1` when calling Node for voyage, vessel, berth, and alert paths. Auth, admin, and partner integration keep `/api/v1` on both sides.

Confirmed exceptions:
- Realtime: FE `js/realtime.js` requests `/api/v1/realtime/m2/events`. Spring `OperationsController` maps `/realtime/m2/events` and `/realtime/m2/snapshot`. Node mounts `/api/realtime/m2`. Spring proxies `text/event-stream` (`OperationsApiClient` sets `Accept: text/event-stream`).

## 2. Auth and session

- Browser session: cookie `smartport_session` (seen in Spring tests and `Uc028PlanAcceptanceProxyTest`).
- Spring forwards the incoming cookie and `Idempotency-Key`/`If-Match` headers to Node. Spring tests check that the demo key `X-UC015-Key` is stripped on session-protected routes (`Uc028PlanAcceptanceProxyTest`).
- Node enforces RBAC with `sessionGuard`, `coordinatorGuard`, `managementGuard`, and `berthReadGuard` (`routes/berthPlanning.js`).
- Partner (UC-014): API key checked in Node `routes/partnerIntegration.js`. Spring `PartnerIntegrationController` proxies `POST /api/v1/integration/voyages`.

## 3. AI integration

| Consumer | Config | Target | Observed |
|---|---|---|---|
| Node ETA (UC-016, HTTP path) | `ETA_AI_BASE_URL`, `ETA_AI_MODE=MODEL`, `ETA_AI_MODEL_VERSIONS`, `ETA_AI_API_KEY`, `ETA_AI_TIMEOUT_MS` (default 10000, max 10000) | `POST {base}/predict/eta` | `ai-eta/eta_ml/api.py` exposes `POST /predict/eta` and `GET /health`. The predict handler always returns `UNAVAILABLE / NOT_CONFIGURED`. Health says `preparation_only`, `modelReady: false`. |
| Node ETA (UC-015 auto path) | No config. Adapter defaults to an inline stub | none | Stub returns `NOT_CONFIGURED` without a network call (`etaPredictionAdapter.js` line 8). The automatic path never reaches the HTTP adapter (see G3). |
| Node berth recommendation (UC-027) | `BERTH_AI_BASE_URL` | `POST {base}/recommend/berth` | Not in `ai-eta`. Without config, returns `MODEL_NOT_CONFIGURED`. |

Contract check: the Node ETA request and response shape (`aiStatus`, `predictionSource`, `predictedEta`, `etaConfidence`, `modelVersion`) matches the normalizer in `etaPredictionAdapter.js`. The `ai-eta` stub's response shape matches the UNAVAILABLE branch. A real `AVAILABLE` response shape is not implemented anywhere in the repo.

## 4. Database

- Driver: `mssql` (Node), SQL Server. Config via `db.js` and `.env`.
- Migrations: `backend-nodejs/database/migrations/001`–`019`. Some files `ALTER` tables that no migration creates: `ships` (altered in 001), `berths` (used in services, not created or altered by any migration).
- Node services use `dbo.` names directly in SQL text (not an ORM). Transactions use `SERIALIZABLE` where documented (for example, UC-014/UC-015 in `P1_AUTOMATIC_VOYAGE_VALIDATION.md`).

## 5. Event and realtime path

- Node `realtimeM2.js` exposes `/snapshot` and `/events` (SSE) backed by an in-process `eventHub`.
- Node services publish after commit (`queue.updated`, `berth_plan.*`). Per the P1 doc, delivery failure does not roll back the committed transaction.
- Spring `OperationsApiClient` streams SSE from Node. FE `realtime.js` subscribes to `berth_plan.created|updated|submitted|approved|rejected|replaced`.

Not verified: notification to coordinators or agents (UC-013/015 steps) outside SSE. The P1 doc states SSE is not proof of delivery.

## 6. Environment and runtime

- Spring Node base URL default: `http://localhost:5000` (`application.properties` line 9, overridable by `SMARTPORT_NODE_API_BASE_URL`).
- FE dev server: `scripts/serve.py` (`npm start`).
- Node start: `server.js` (`npm start`). Preflight: `scripts/local-preflight.js` (`npm run check:local`).
- Local startup guide: `../SmartPort/LOCAL_STARTUP.md` (Doc-only in this audit).

## 7. Known integration constraints (doc-only)

- Demo flags: `UC015_LOCAL_DEMO_ONLY` returns 403 outside demo mode (P1 doc, code confirmed in `automaticVoyageValidation.js`).
- Manual validation requires a coordinator session and the local operator key (P0 doc, code confirmed in `routes/voyageValidation.js`).

## 8. Diagram of the UC-029 to UC-030 flow (confirmed by code)

```
FE berth-planning.js ─submit─► Spring POST /berth-plans/{id}/submit ─► Node berthPlanning.js
                                                                      ├─ berth_plans (UPDATE status)
                                                                      ├─ berth_plan_status_history (INSERT)
                                                                      └─ planning_audit (INSERT)
FE berth-planning.js ─approve─► Spring POST /berth-plans/{id}/approve ─► Node (managementGuard)
                                                                      └─ same tables; publish berth_plan.approved
```
