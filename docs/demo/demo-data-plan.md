# Demo data plan (modules 1 and 2)

Status: written 2026-11-19. The script was run once on a new disposable database (`SmartPortV2_DemoRun2`) and checked with `check-consistency.js` (9 of 9 checks passed).

## 1. Safety rules

- The demo data goes into a **new, empty, migrated** database. `API/scripts/demo-data.js` refuses to run when the database already has berths, voyages or `demo_*` accounts, when `--confirm-disposable` is missing, when `SP_DEMO_PASSWORD` (12 or more characters) is missing, or when the database name is protected.
- Nothing is seeded automatically. Nothing is reset, deleted or overwritten. Existing databases (`SmartPortV2_Demo`, `Verify1` to `Verify4`, `Mig`, `Test`, `Rollback1`) are not touched.
- No password is stored in a file or printed. You choose `SP_DEMO_PASSWORD` for the run; all demo accounts share it. Use a throw-away value and do not reuse a real password.
- All demo records carry the prefix `DEMO` (ships), `DM` (voyage codes), `D0x` (berths), `demo_*` (accounts). Ports and agents come from `npm run seed:demo` (fictional).
- A failed run can leave partial data. Use a new database for the next attempt instead of cleaning the old one.

## 2. What is real and what is a fixture

Everything is created through the real API in-process, so history, audit rows and notifications are genuine:

| Item | How it is created |
|---|---|
| Berths | `POST /berths` |
| Ships | `POST /ships` |
| Ship documents (registration, insurance) | **SQL fixture** (no document-upload use case exists in this delivery). One ship gets none, to show `MISSING_DOCUMENTS` |
| Notices and automatic validation | `POST /voyages` (UC-013, UC-015); the AI forecast is "unavailable" (no provider) |
| Cargo hazard verification | `PUT /voyages/:id/cargo-hazard` |
| Plans, submit, approve, reject | `POST /berth-plans`, `/submit`, `/approve`, `/reject` (approval by a different account) |
| Berthing and departure (with edited times and a reason, because the past cannot be waited for) | `POST /voyages/:id/berthing`, `/departure` |

## 3. Data volume and states

| Entity | Count | Notes |
|---|---|---|
| Berths | 8 | 6 container (300 to 450 m), 2 bulk; one allows dangerous goods |
| Ships | 24 | 20 container, 4 bulk |
| Voyages | 24 | 2 `DEPARTED`, 2 `BERTHED`, 3 `BERTH_ASSIGNED`, 16 `WAITING_BERTH`, 1 `MISSING_DOCUMENTS` |
| Plans | 11 | 2 `COMPLETED`, 5 `APPROVED`, 2 `PENDING_APPROVAL`, 1 `REJECTED` (with reason), 1 `DRAFT` |
| Queue | 16 | 2 `MAIN_LINE`, the rest `STANDARD`; 4 of the queued voyages already have a plan in progress |
| Audit rows | about 144 | written by the real flow |

Times are relative to the moment the script runs (past, now and future), so the Gantt shows history, current berthing and planned arrivals.

## 4. Accounts

| Username | Role | Use in the demo |
|---|---|---|
| `demo_dieuphoi` | Điều phối viên | register notices, make plans, confirm berthing and departure |
| `demo_dieuphoi2` | Điều phối viên | second coordinator (conflict demos) |
| `demo_quanly` | Ban quản lý | approve or reject plans |
| `demo_quanly2` | Ban quản lý | second approver (concurrent decisions) |
| `demo_khobai` | Nhân viên kho bãi | role refusal demo (read-only on berths) |
| `demo_daily` | Đại lý hàng hải | agent: sees only its own vessels, no berth screens |

## 5. Run

```
# 1. create a NEW database (name of your choice, e.g. SmartPortV2_DemoRun3) in SQL Server, then from API/:
SP_DB_NAME=<new db> npm run migrate
SP_DB_NAME=<new db> npm run seed
SP_DB_NAME=<new db> npm run seed:demo
SP_DB_NAME=<new db> SP_DEMO_PASSWORD=<your throw-away password> node scripts/demo-data.js --confirm-disposable
SP_DB_NAME=<new db> node scripts/check-consistency.js          # read-only, expect 9 of 9 ok
```

## 6. Known limits

- Ship documents are fixtures; the AI forecast is unavailable; no real vessel traffic data exists.
- The sample KPI block on the vessels page is **not** produced by this data; it stays labelled as sample data.
- Re-running on the same database is refused by design.
