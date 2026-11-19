> Superseded for the final demo by `final-demo-readiness.md` (database `SmartPortV2_DemoFinal`, migrations 0001 to 0008). The API now refuses a database that lacks any migration.

# Enable UC027 (local recommendations) for a demo, without touching existing databases

Written 2026-11-19. UC027 needs migrations 0006 and 0007. The existing demo and verification databases (`SmartPortV2_DemoRun2`, `Verify4`, `Demo`, ...) do **not** have them and must not be migrated, reset, reseeded or deleted without your explicit authorization. Use a **new** database. Two ways, both verified on 2026-11-19 (see `docs/testing/uc027-hardening-evidence.md`):

- **A. New database with fresh demo data** (recommended; the demo data is rebuilt by the real API).
- **B. Copy of `SmartPortV2_DemoRun2`** (keeps its data; the original is only read by a COPY_ONLY backup).

`scripts/db-admin.js` only ever creates a NEW database: it refuses an existing name, a name outside `SmartPortV2_<letters, digits, underscore>`, and protected names. No credentials are used (Windows authentication) and none are printed.

## A. New database with fresh demo data

```powershell
Set-Location <repo>\API
$db = 'SmartPortV2_Demo027B'            # choose a name that does not exist; the script stops if it does
node scripts/db-admin.js create $db --confirm-new
$env:SP_DB_NAME = $db
npm run migrate                          # expect: applied ... 0006_berth_recommendations.sql, 0007_recommendation_provenance.sql
npm run seed
npm run seed:demo

# demo accounts: type a new throw-away password (12+ characters); it is not shown and not stored
$sec  = Read-Host 'Demo password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:SP_DEMO_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  node scripts/demo-data.js --confirm-disposable
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:SP_DEMO_PASSWORD -ErrorAction SilentlyContinue
}
node scripts/check-consistency.js         # expect: 9 of 9 checks passed
```

## B. Copy of `SmartPortV2_DemoRun2`

```powershell
Set-Location <repo>\API
$copy = 'SmartPortV2_DemoRun2_Copy2'      # a NEW name
node scripts/db-admin.js copy SmartPortV2_DemoRun2 $copy --confirm-copy
$env:SP_DB_NAME = $copy
npm run migrate                           # applies 0006 and 0007 to the COPY only
node scripts/check-consistency.js         # expect: 9 of 9 checks passed
# The copy keeps the original accounts and their (unknown) passwords. Set new ones on the COPY only:
node scripts/reset-demo-passwords.js --check
$sec  = Read-Host 'New demo password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:SP_DEMO_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  node scripts/reset-demo-passwords.js --confirm-demo-reset      # prints ok for each of the six logins
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:SP_DEMO_PASSWORD -ErrorAction SilentlyContinue
}
```
The backup file of the copy stays in the server's default backup folder (the script prints its path). Delete it yourself when it is no longer needed.

## Start and use

```powershell
# API (from API\), with the database you created:
$env:SP_DB_NAME = $db   # or $copy
$env:SP_CORS_ORIGIN = 'http://localhost:5500'; $env:SP_COOKIE_SECURE = 'false'
npm start
# Frontend (second window, from Front\):
npm start                                  # http://localhost:5500  (use localhost, not 127.0.0.1)
```
Sign in as `demo_dieuphoi` (coordinator): Vessels & berths, queue panel, **Đề xuất bến**. Sign in as `demo_quanly` (manager) to approve. Remove the variables afterwards: `Remove-Item Env:SP_DB_NAME, Env:SP_CORS_ORIGIN, Env:SP_COOKIE_SECURE`.

## What to say during the demo
- The banner states it: a **local deterministic optimizer** (policy UC027-OPT-V2), not machine learning; the AI forecast is not available. A proposal never creates or approves a plan.
- Plans made from a proposal are marked "Thuật toán tối ưu cục bộ" (and "đã chỉnh" if edited); "Dịch vụ AI ngoài" is reserved for a real AI provider, which does not exist.
- A berthed vessel keeps its stretch occupied until its actual departure, even if its planned departure has passed: a recommendation never proposes that stretch.
- All policy parameters (P-1 to P-10) are provisional and need business approval.
