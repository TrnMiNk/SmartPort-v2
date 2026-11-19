# SmartPort V2 API

Node.js 24 + Express 5 over SQL Server. Scope: M1 (vessel arrival/departure) and M2 (berth scheduling) plus minimum dependencies. Design: `docs/architecture/`, `docs/database/schema.md`, `docs/api/contracts.md`.

## Configuration (environment only)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SP_DB_NAME` | yes | none | Dedicated SmartPort V2 database. Legacy and system names are refused. |
| `SP_DB_SERVER` | no | `localhost` | SQL Server instance |
| `SP_ODBC_DRIVER` | no | `ODBC Driver 18 for SQL Server` | ODBC driver name |
| `SP_DB_ENCRYPT` | no | `true` | Set `false` only for a local instance without a trusted certificate |
| `SP_PORT` | no | `3000` | |
| `SP_HOST` | no | `127.0.0.1` | Loopback by default; set explicitly to listen on other interfaces |
| `SP_CORS_ORIGIN` | no | `http://localhost:5500` | Single trusted frontend origin |
| `SP_AI_ETA_URL` | no | none | ETA forecast provider (UC-016). Unset means the forecast is `UNAVAILABLE`, never simulated |
| `SP_AI_BERTH_URL` | no | none | Berth recommendation provider (UC-027; no use case calls it yet) |
| `SP_AI_API_KEY` | no | none | Optional bearer key for AI providers. Environment only; sent in the Authorization header; never logged |
| `SP_COOKIE_SECURE` | no | `true` | Set `false` only for local HTTP |
| `SP_LOGIN_MAX_FAILURES` | no | `5` | UC-001 |
| `SP_LOGIN_LOCK_MINUTES` | no | `15` | Proposed value (UC001 A-2) |
| `SP_SESSION_IDLE_MINUTES` | no | `30` | UC-002 |

No secret is stored. Windows (trusted) authentication is used.

## Commands

```
npm install
SP_DB_NAME=<dedicated database> npm run migrate        # apply versioned migrations (checksum-checked)
SP_DB_NAME=<db> npm run seed                           # reference data, development only (idempotent, UTF-8 safe)
SP_DB_NAME=<db> npm run seed:demo                      # demo ports and agents so the forms have options (fictional)
npm run test:unit                                      # no database needed
SP_DB_NAME=<db> SP_TEST_DB=<db> npm run test:integration   # disposable database only
SP_DB_NAME=<db> npm start
```

Create a user (password read from stdin, never from the command line):

```
echo <password> | SP_DB_NAME=<db> node scripts/create-user.js --username coord01 --name "Điều phối viên 1" --roles DIEU_PHOI_VIEN
```

Do not apply seed files with `sqlcmd` unless it is given `-f 65001`; its default code page stores Vietnamese text wrongly (this happened once; `test/integration/seed.test.js` guards it).

## Endpoints

`GET /api/v1/health`; `/auth/login`, `/auth/me`, `/auth/logout`; `/ships` (list, create, read, `PATCH`, `deactivate`, `history`); `/voyages` (create, list, read); `/catalog/ship-types|ports|agents`. Details and permissions: `docs/api/contracts.md` §2 and §2a.

## Layout

```
src/routes/          path → controller and middleware (no logic)
src/controllers/     parse input, call service, shape response
src/services/        business rules and audit
src/repositories/    SQL only, parameterized
src/validation/      boundary validation
src/http/            session and role middleware, error contract
src/security/        password hashing, session tokens
src/db/              connection and migration runner
migrations/          versioned SQL; rollback/ holds the down scripts (not run by the runner)
seeds/               reference data, separate from migrations
test/unit/           no database
test/integration/    real SQL Server, transactions rolled back or test rows removed
```

## Status

Modules 1 and 2 are implemented (migrations 0001 to 0008). The API refuses to start on a schema that does not match the shipped migrations. Set-up, demo accounts, PowerShell commands and limitations: root `README.md`. Endpoints: `docs/api/contracts.md`. Current state and go/no-go: `docs/release/release-readiness.md`. The shell examples above use bash syntax; in PowerShell set `$env:SP_DB_NAME` first.
