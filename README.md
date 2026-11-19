# SmartPort V2

Rebuild of SmartPort, Modules 1 (vessel arrival/departure) and 2 (berth scheduling). Node 24 + Express 5 over SQL Server (`API/`), static HTML/CSS/JS front end with no build step (`Front/`), requirements, evidence and decisions in `docs/`.

**Status:** ready for a **demonstration**. Not ready for production and not fully SRS-accepted (see "Limitations" and `docs/release/release-readiness.md`). The original SmartPort projects were used only as read-only references.

**Quick start with the shared demo database:** restore `SmartPortV2_DemoFinal.bak` (see `README-DB.md`, shipped separately with the `.bak`), then follow sections 1, 4 and 5 below. Starting from an empty database: sections 1 to 4.

## Requirements

| Item | Needed |
|---|---|
| Node.js | 20 or later (developed on 24) |
| SQL Server | 2019 or later (a `.bak` made on SQL Server 2022 restores only on 2022 or newer). Any instance reachable from your PC (`localhost`, `localhostSQLEXPRESS`, ...): set `SP_DB_SERVER`. **Windows (trusted) authentication only**: your Windows account needs a login on that instance (SQL logins are not supported by this code) |
| ODBC driver | Microsoft ODBC Driver 18 for SQL Server (`msnodesqlv8`; needs a Windows host) |
| Browser | Edge or Chrome. Browser tests use `puppeteer-core` with the installed Edge |

No secret is stored anywhere in the repository. The database login is the Windows account running the API; demo passwords are typed by you.

## 0. Configuration

The API reads environment variables only (no `.env` loader); `API/.env.example` lists them with placeholders. Main ones: `SP_DB_NAME` (required), `SP_DB_SERVER` (default `localhost`), `SP_ODBC_DRIVER`, `SP_DB_ENCRYPT` (set `false` if the connection fails with a certificate error on a local instance), `SP_CORS_ORIGIN`, `SP_COOKIE_SECURE`. Full table: `API/README.md`. `scripts/db-admin.js` also honours `SP_DB_SERVER` and `SP_ODBC_DRIVER`.

## 1. Install

```powershell
Set-Location <repo>\API;   npm install
Set-Location <repo>\Front; npm install      # only needed for the browser tests (puppeteer-core)
```

## 2. Create a database (fresh set-up)

Use a **new, dedicated** database whose name starts with `SmartPortV2_`. The tools refuse legacy and system names and never drop or overwrite an existing database.

```powershell
Set-Location <repo>\API
node scripts/db-admin.js create SmartPortV2_MyDemo --confirm-new     # refuses if the name already exists
$env:SP_DB_NAME = 'SmartPortV2_MyDemo'
npm run migrate        # applies 0001..0008 in order, checksum-checked (stops on a changed or unknown migration)
npm run seed           # reference data (idempotent)
npm run seed:demo      # fictional ports and agents, so the forms have options
```

Migrations are in `API/migrations/0001_baseline.sql` to `0008_eta_prediction_jobs.sql`; rollback scripts are in `API/migrations/rollback/` (never run automatically). The API refuses to start if the database lacks a migration, has a different checksum, or is newer than the code.

## 3. Demo accounts and data (you choose the password)

The six demo accounts and the demo data are created through the real API. The password is read from a hidden prompt into an environment variable for one command and removed afterwards; it is never written to a file or printed.

```powershell
$env:SP_DB_NAME = 'SmartPortV2_MyDemo'
$sec  = Read-Host 'Demo password (12+ characters, throw-away)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:SP_DEMO_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  node scripts/demo-data.js --confirm-disposable      # stops if the database already has berths, voyages or demo accounts
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:SP_DEMO_PASSWORD -ErrorAction SilentlyContinue
}
node scripts/check-consistency.js                      # read-only; expect "9 of 9 checks passed"
```

| Account | Role |
|---|---|
| `demo_dieuphoi`, `demo_dieuphoi2` | Coordinator |
| `demo_quanly`, `demo_quanly2` | Manager (approves or rejects plans) |
| `demo_khobai` | Yard (read-only on berths) |
| `demo_daily` | Shipping agent (sees only its own vessels) |

To change the six passwords later: `node scripts/reset-demo-passwords.js --check`, then `--confirm-demo-reset` with `SP_DEMO_PASSWORD` set the same way (touches only those six accounts). Any other user: `"<password>" | node scripts/create-user.js --username <u> --name "<display name>" --roles <ROLE>` (password from stdin, never from an argument).

## 4. Start the API and the front end

```powershell
# Window 1: API
Set-Location <repo>\API
$env:SP_DB_NAME = 'SmartPortV2_MyDemo'
$env:SP_CORS_ORIGIN = 'http://localhost:5500'
$env:SP_COOKIE_SECURE = 'false'        # local plain HTTP only; the API refuses this when NODE_ENV=production
npm start                              # "SmartPort API listening on 127.0.0.1:3000"

# Window 2: front end
Set-Location <repo>\Front
npm start                              # http://localhost:5500  (use "localhost", not 127.0.0.1)
```

Open `http://localhost:5500/`, sign in, open **Vessels & berths**. Other environment variables: `API/README.md`.

## 5. Demo workflow (Modules 1 and 2)

Full click-by-click script (about 10 minutes, two browser windows, one coordinator and one manager): `docs/demo/two-modules-demo.md`. In short: arrival notice → automatic validation (UC-015, policy `UC015-POLICY-V1`) → queue → berth check (UC-026) → local proposal or manual plan (UC-027/UC-025) → submit → manager approves or rejects → berthing → departure, plus the time × position berth chart with drag and drop. Notifications arrive without reloading. Roles are checked in `docs/demo/two-modules-demo.md` section 2.

## 6. Tests

```powershell
Set-Location <repo>\API
npm run test:unit                                                   # no database
$env:SP_DB_NAME = 'SmartPortV2_Verify'; $env:SP_TEST_DB = 'SmartPortV2_Verify'
npm run test:integration                                            # DISPOSABLE database only (creates and removes rows)
Set-Location <repo>\Front
npm test                                                            # unit
npm run test:e2e                                                    # browser (needs Edge and a disposable database, see docs/testing/b2-b6-evidence.md)
```

Never run integration or browser tests against a demo database. Evidence and last results: `docs/testing/`.

## 7. Limitations (say them when demonstrating)

- **ETA forecast:** there is no AI provider, trained model or AIS feed. The notice shows "chưa có dự báo AI"; a labelled mock provider can demonstrate the asynchronous flow. The asynchronous ETA design is a V2 decision not yet business-approved.
- **UC-027 berth proposals** come from a **local deterministic optimizer** (`UC027-OPT-V2`), not trained AI.
- **Synthetic data** only. Documents (UC-012) are inserted by SQL; Modules 3 to 5 (yard, crane, gate notices), UC-033 re-plan and billing are not built.
- **Browser E2E is intermittently unstable on the development machine** (low free RAM, socket buffer exhaustion; about 1 or 2 suites in 10; causes in `docs/testing/e2e-stability-evidence.md`). Last runs: 59 of 59 in three consecutive runs.
- **Production security:** the API serves HTTP and expects a TLS-terminating proxy with HSTS and CSP; rate limiting belongs to the proxy; MFA is shown but not enforced; sessions are opaque HttpOnly cookies instead of JWT (deviation); **encryption at rest (NFR-SEC-06) is verified with TDE on a disposable database but not enabled** (`docs/architecture/encryption-at-rest.md`); refresh hints work inside one API process only. Use `SP_COOKIE_SECURE=false` only on localhost.
- UC statuses are unchanged by this delivery; only seven UCs are Completed (`docs/traceability.md`).

## 8. Repository map

Some documents under `docs/` mention internal project-instruction files (`CLAUDE.md`, `.claude/`). They are not part of this repository and nothing in the code depends on them.


```
API/        backend (src/, migrations/, seeds/, scripts/, test/)
Front/      static front end (js/, css/, scripts/serve.js, test/)
docs/       requirements, use cases, traceability, architecture, API/DB contracts, evidence (testing/), demo/, release/
```
