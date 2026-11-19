# ADR-001: Single Node.js/Express API over SQL Server

**Status:** Accepted (decision D7, approved by the user on 2026-11-16)
**Date:** 2026-11-16
**Deciders:** Project owner (approval recorded in the Phase 0 direction message)
**Scope:** Modules M1 (vessel arrival/departure) and M2 (berth scheduling) and their minimum dependencies.

## Context

Legacy SmartPort uses two backend layers. `../SmartPort/backend-nodejs` holds the working business logic for M1 and M2, with 19 SQL migrations and tests. `../SmartPort/QLDAPM` (Spring) mirrors the same endpoint paths and forwards calls to Node. The duplication has three costs (`docs/legacy/critical-gaps.md` G12):

- Every endpoint is declared twice, with different prefixes (`/api/v1` in Spring, `/api` in Node).
- Contract drift is possible. The Java tests check forwarding and headers, not the full response body.
- Each change crosses two codebases and two test suites.

Forces: the scope is limited to two modules. The team must deliver a working, testable system. The rules require separation of layers (`.claude/rules/02-architecture-rules.md`, `04-backend-rules.md`) and avoid unnecessary duplication (`CLAUDE.md` §8).

## Decision

Build one API service with Node.js (Express 5) over SQL Server. Use the `mssql` package with the `msnodesqlv8` driver and Windows (trusted) authentication, as the legacy backend does. Keep a single layered structure:

`routes → controllers → services → repositories → SQL Server`, with `validation` at the boundary, `http/` middleware for sessions and RBAC, and `security/` for hashing and tokens.

No Spring proxy layer is created in V2.

## Options considered

### Option A: Single Node.js/Express API (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low. One process, one test suite, one contract. |
| Reuse | High. Legacy Node services and tests can be reviewed and reused. Migrations are already in SQL. |
| Team familiarity | The legacy M1/M2 logic is in Node. |
| Risk | Express 5 and `msnodesqlv8` are native-adjacent: the driver loads a native module on Windows. Verified to load on this machine (Node 24.14). |

Pros: no duplicated contracts; one place for authorization; simplest deployment.
Cons: loses the Spring layer, if it had value. No such value was found in the legacy code (the Java layer only forwards).

### Option B: Keep two layers (Node domain API + Spring gateway)

| Dimension | Assessment |
|---|---|
| Complexity | High. Two frameworks, two build systems, two test suites. |
| Reuse | High for legacy code as-is. |
| Risk | Contract drift (G12) stays unless a shared contract generator is built, which adds more work. |

Rejected: duplication without a business reason. The gateway adds no authorization or validation the Node API does not already perform.

### Option C: Single Java/Spring service over SQL Server

| Dimension | Assessment |
|---|---|
| Complexity | Medium. Familiar to the legacy Spring code. |
| Reuse | Low. The M1/M2 business logic is in Node. It would need a rewrite of roughly the whole backend. |
| Risk | Rewrite risk. Delays Milestone 0 and the M1/M2 acceptance work. |

Rejected for this delivery: the reuse value of Node is higher, and no requirement favors Java.

## Trade-off analysis

The decision favors reuse of verified Node logic and a single contract over a second layer that adds no business function. The main risk is the driver: `msnodesqlv8` depends on the Windows ODBC driver and a native module. This is acceptable for the target environment (Windows SQL Server, trusted authentication). A cross-platform deployment would need the `tedious` driver with SQL authentication, a decision to take later with the credential owner.

## Consequences

- Easier: one contract (`docs/api/contracts.md`), one authorization layer, one test suite, direct reuse of legacy service logic after review.
- Harder: the Spring code in `QLDAPM` is not reused. Its tests do not carry over.
- To revisit: deployment target (Windows only, or cross-platform). Driver choice depends on it.
- Configuration is environment-only (`API/src/config.js`). Connection strings are built at runtime. No secret is stored.

## Action items

1. [x] Scaffold `API/` with the layered structure and environment configuration.
2. [x] Verify the `msnodesqlv8` driver loads and connects to a disposable SmartPort V2 database.
3. [ ] Review legacy M1/M2 services before reuse (Milestone 2 onward). Do not copy without review.
4. [ ] Confirm the deployment target and the driver for it (open item, see `docs/architecture/target-architecture.md` §8).
