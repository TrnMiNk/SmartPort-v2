# Release readiness and go/no-go (Modules 1 and 2), 2026-11-19

Verdict: **GO for a demonstration** on `SmartPortV2_DemoFinal` (preserved, healthy). **NO-GO for production and for full SRS acceptance** until the blockers in section 4 are closed. Nothing in this document changes a UC status.

## 1. Verified now (evidence in brackets)
| Area | Result |
|---|---|
| Startup and migrations | API refuses an incompatible schema (A1); `DemoFinal` passes the readiness check: migrations 0001 to 0008 with matching checksums (`tde-evidence.md` §6); rollback scripts exist for every migration |
| Demo database | 24 voyages in all lifecycle states, 8 berths, plans APPROVED 5 / COMPLETED 2 / PENDING 3 / REJECTED 1; `check-consistency` 9 of 9; six demo accounts with the expected roles, all active; read-only checks only |
| Core workflows (on isolated verification databases, never on `DemoFinal`) | notice, validation, queue; manual planning and UC-026 check; local optimizer proposals with provenance; chart with drag and drop; submit, approve, reject; berthing and departure: browser E2E 59 of 59 in the last clean runs (`b2-b6-evidence.md` §7, `a3-chart-evidence.md`) |
| Five-second criteria | measured in real browsers, slowest 169 ms (`a2-b1-realtime-evidence.md`) |
| 50 users, 3 s (NFR-PER-07) | met in a 50-user HTTP load test, slowest 613 ms (`b2-b6-evidence.md`) |
| Security | `npm audit` 0 vulnerabilities; SQL injection, XSS, CSRF/CORS, cookies, limits, logs, RBAC, TLS tested; no High finding (`b2-b6-evidence.md` §5); production refuses an insecure cookie or http origin |
| Encryption at rest | TDE verified on a disposable database (`tde-evidence.md`); **not enabled anywhere** |
| Tests today | API unit 126, SQL integration 211, Front unit 60, browser E2E 59 per suite |
| Handover material | source (`API/`, `Front/`), migrations and rollbacks, seeds, scripts (`db-admin`, `demo-data`, `check-consistency`, `load-test`, `tde-verify`), `README`s, `docs/` (requirements, UCs, traceability, evidence, architecture, demo scripts), no `.env` file and no hard-coded credential found by a pattern search |

## 2. Limits that must be said when demonstrating
Demo data is synthetic. UC-027 is a local deterministic optimizer, not trained AI; a real ETA forecast does not exist. Sign-in over HTTP on localhost: Secure-cookie and HTTPS behaviour was verified only with a local TLS proxy and a pinned certificate, not in a browser. Documents (UC-012) are inserted by SQL; Modules 3 to 5 do not exist (no yard, crane or gate notices); UC-033 re-plan is not built. Browser E2E on this machine fails intermittently (about 1 or 2 suites in 10; causes in `e2e-stability-evidence.md`), so run it on a healthier host before relying on it.

## 3. HTTPS and Secure-cookie limitations
The API serves plain HTTP and expects a TLS-terminating proxy. With `SP_COOKIE_SECURE=true` (the default) the session cookie is `Secure; HttpOnly; SameSite=Lax` (verified over TLS). A browser will not keep or send a Secure cookie over plain `http://`, so the demo must use `SP_COOKIE_SECURE=false` on localhost (documented in the demo commands); never in production (the API refuses it when `NODE_ENV=production`). HSTS, CSP, rate limiting and certificate management belong to the web host and are not implemented here. The server cannot see the scheme (`trust proxy` is off), so it relies on the browser for the Secure rule.

## 4. What prevents full SRS acceptance (prioritised)
| # | Blocker | Type | Needs |
|---|---|---|---|
| 1 | ~~No commit exists~~ **Resolved:** local commit `c8824e9` on `master` (319 files, no secrets; `.gitattributes` keeps SQL on LF so migration checksums survive a Windows checkout). Not pushed; no remote, no tag | handover | the owner decides the remote, tag and backup (README steps in the handover report) |
| 2 | **NFR-SEC-06** data encrypted at rest: verified solution, not enabled | security / deployment | owner decisions in `encryption-at-rest.md` §6; TDE-capable edition; certificate custody |
| 3 | Business decisions: asynchronous ETA design and policy (UC015), optimizer vs AI service (UC027), assumptions Q, M, A, P, N, CH, PF (`remaining-gaps.md` §7) | business | owner |
| 4 | Real AI: ETA forecast, AI berth service, model evaluation (NFR-ACC-04), arrival event for MAE | external | provider, data, labels |
| 5 | UC-030 step 7 notices to yard, cranes, gate (Modules 3 to 5); UC-033; UC-012 documents; UC-034 maintenance | scope | later modules |
| 6 | Production configuration: TLS proxy with HSTS and CSP, `NODE_ENV=production`, rate limiting, secret store, backups with a tested restore, monitoring | deployment | operations |
| 7 | Multi-process operation: refresh hints are in-process (one API process verified) | architecture | shared channel if more than one process |
| 8 | Performance on the target host with real data volume and real browsers; NFR-PER-07 was measured on one machine with about 120 voyages | verification | target environment |
| 9 | Intermittent browser-test failures at sign-in (cause of one recurrence demonstrated, one unknown) | test reliability | healthier host; diagnostics are in place |
| 10 | MFA shown but not enforced; JWT replaced by opaque sessions (deviation) | decision | owner |

## 5. Go / no-go checklist (in order)
1. [x] Demo database healthy and preserved (schema, consistency, accounts): **GO for demo**.
2. [x] A1 fail-closed startup; B1 five-second; B2 50 users; B6 no High finding: done and evidenced.
3. [x] First local commit (blocker 1): done. [ ] Remote/tag/backup of the repository: owner decision, **before any handover**.
4. [ ] Decide ENC-1 and enable TDE on the production database with a certificate backup and a restore test (blocker 2): **before production**.
5. [ ] Owner decisions on the unapproved assumptions and the asynchronous ETA design (blocker 3): **before any UC is marked Completed beyond today's seven**.
6. [ ] Production configuration items (blocker 6) and a performance run on the target host (blocker 8): **before production**.
7. [ ] Real AI components (blocker 4) and Modules 3 to 5 (blocker 5): **before full SRS acceptance** (outside this delivery).
