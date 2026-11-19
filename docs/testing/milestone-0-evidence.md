# Milestone 0 — Evidence

Date: 2026-11-16. Environment: Windows 11, Node 24.14.0, npm 11.9.0, SQL Server (local instance, 16.0.1000.6), ODBC Driver 18, trusted authentication. Disposable databases created for this work: `SmartPortV2_Test`, `SmartPortV2_Verify1`, `SmartPortV2_Verify2`, `SmartPortV2_Rollback1`. Legacy databases `CangThongMinh` and `CangThongMinh_UC015_Test` were only read (schema metadata), never written.

Status legend (rule 07): **passed**, **failed**, **not executed**, **unavailable** (with reason).

## 1. Final verification run (fresh database `SmartPortV2_Verify2`)

| Step | Command | Result |
|---|---|---|
| Migrate | `SP_DB_NAME=SmartPortV2_Verify2 node src/db/migrate.js` | **passed**: `applied: 0001_baseline.sql` |
| Seed | `sqlcmd -I -b -i seeds/dev_seed.sql` | **passed**: exit 0 |
| Unit tests | `npm run test:unit` | **passed**: 17 of 17 |
| Integration tests | `SP_TEST_DB=SmartPortV2_Verify2 npm run test:integration` | **passed**: 26 of 26 |
| Residue check | count of `t_*` users, ships, voyages, berth plans | **passed**: 0, 0, 0, 0 |
| Schema row count | `dbo.schema_migrations`, `dbo.auth_roles` | 1 migration, 4 roles |

Integration tests are in two files: `test/integration/schema.test.js` (16 tests: 3 accepted cases, the positive ship and voyage, exactly 10 MB, and a voyage-specific document; 13 refused cases, negative or boundary) and `test/integration/auth.http.test.js` (10 HTTP tests). Each schema test runs in a transaction that is rolled back.

### Unit tests (17)

`test/unit/config.test.js` (6): required database name, defaults and explicit values, port range, refusal of legacy and system database names, migration list ordering and checksums.
`test/unit/security.test.js` (11): password hash verify and wrong password, fresh salt, malformed hash fails closed, token hash, login validation, role default deny and allow-list, cookie reading, error contract (no leak, malformed JSON).

### Integration tests (26)

Schema (16): positive ship and voyage; IMO digits; IMO unique; dimensions boundary (zero refused); BERTHED without ATA; WAITING_BERTH without queue position; duplicate voyage code per ship; document 10 MB + 1 byte refused; exactly 10 MB accepted; MIME refused; voyage-specific document; validity order; maintenance period; plan PENDING_APPROVAL without passed constraints; one open plan per voyage (filtered unique); queue position zero refused.

HTTP auth (10): login with cookie; generic message for wrong password and unknown user; lock on fifth failure and locked correct password refused; inactive account; `me` 401 and 200; logout 204 then old token 401; forged token 401; malformed JSON and invalid fields 400; health 200; unknown route 404.

## 2. Migration rollback (rule 05)

Database `SmartPortV2_Rollback1`:

| Step | Result |
|---|---|
| Apply `0001_baseline.sql` | **passed**: 24 tables |
| Run `migrations/rollback/0001_baseline.down.sql` | **passed**: exit 0, 0 tables remain |
| Delete history row, re-apply | **passed**: 24 tables again |

## 3. Server smoke test

Database `SmartPortV2_Verify1`, port 3999, server started with `node src/server.js`:

- `GET /api/v1/health` → **passed**: 200, `{"success":true,"data":{"status":"ok","database":"ok"}}`.
- `POST /api/v1/auth/login` with an unknown user → **passed**: 401, `INVALID_CREDENTIALS`, generic message.
- Server stopped after the check.

## 4. Defects found and fixed during this milestone

| Defect | How found | Fix | Regression evidence |
|---|---|---|---|
| T-SQL does not allow `=` between two boolean expressions (`CK_bp_submit_pair`, `CK_bp_approve_pair`) | `sqlcmd` syntax error at line 319 | Rewritten as explicit `AND`/`OR` pairs | Migration applies; pair constraints covered by `schema.test.js` open-plan test indirectly. Direct pair tests: **not executed** |
| Filtered indexes need `QUOTED_IDENTIFIER ON` | `sqlcmd` default session error (line 331) | `SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;` added to the migration header | Fresh database applies cleanly |
| Driver needs an explicit ODBC driver name | `[Microsoft][ODBC Driver Manager] Data source name not found` | Connection string built from `SP_ODBC_DRIVER` | Migration and integration tests connect |
| Role codes did not match legacy evidence | Review of `backend-nodejs` test codes | Renamed to `QUAN_TRI_HE_THONG`, `DIEU_PHOI_VIEN`, `DAI_LY_HANG_HAI`, `BAN_QUAN_LY` in seed, tests and docs | Fresh database seed: 4 roles; auth tests use `DIEU_PHOI_VIEN` |
| Pair of open-plan assertion accepted several errors | Test review | Test split into an accepted first insert and a refused second insert | Passes on `SmartPortV2_Verify1` and `SmartPortV2_Verify2` |

## 5. Not executed, unavailable, or blocked

| Item | Status | Reason |
|---|---|---|
| Frontend functional tests (`Front/`) | **not executed** | `Front/` not yet created. Copying the legacy frontend was blocked by the `protect-legacy` hook (it treats the copy command as a write inside a legacy repository). Planned for Milestone 3. |
| Endpoint tests for M1 and M2 | **not executed** | Endpoints are planned, not implemented (`docs/api/contracts.md`). |
| Policy tests for UC-015 | **not executed** | Policy content not approved (UC015 A-1, A-2). |
| AI adapter and provider tests (UC-016, UC-027) | **blocked** | No provider chosen (decision D3). Reported as blocked, not passed. |
| Idle-session expiry (UC-002 AC-3) | **not executed** | Needs an injectable clock. |
| Rule-level tests for berth constraints (UC-026) | **not executed** | Logic not written. |
| Concurrency test for berth overlap (A-2 in UC026) | **not executed** | Logic not written. |
| Direct test of the two boolean pair constraints | **not executed** | Covered only by the migration applying. |
| Audit row for user provisioning (UC005 A-3) | **open** | `createUser` does not yet write an audit event. |
| Legacy test suites | **not executed** | Read as reference only (CLAUDE.md §9). Legacy repositories not run. |

## 6. Use case status after Milestone 0

- **Implemented:** UC-001, UC-002 (backend only; frontend acceptance pending).
- **Analyzed:** the other 21 UC profiles (UC005, 006, 007, 010–013, 015, 016, 020–031).
- **Completed:** none. No UC has passing acceptance evidence for every criterion.
