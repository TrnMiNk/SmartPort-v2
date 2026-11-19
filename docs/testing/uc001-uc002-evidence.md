# UC001 and UC002 — Evidence (login, logout, session)

Date: 2026-11-18. Scope: Front/ and API/ integration for UC-001 and UC-002 only. Environment: Windows 11, Node 24.14.0, SQL Server 16 (local), disposable database `SmartPortV2_Verify2`, headless Microsoft Edge (first browser found) driven by `puppeteer-core` 25.18.1. Status legend (rule 07): passed, failed, not executed, unavailable.

## 1. Commands and results

| Suite | Command | Result |
|---|---|---|
| API unit | `cd API && npm run test:unit` | **passed** 17 of 17 |
| API integration (real SQL Server) | `cd API && SP_DB_NAME=SmartPortV2_Verify2 SP_TEST_DB=SmartPortV2_Verify2 npm run test:integration` | **passed** 28 of 28 (16 schema, 12 HTTP auth) |
| Front unit (API client, auth module, static server) | `cd Front && npm test` | **passed** 34 of 34 |
| Browser end-to-end (real browser, real API, real SQL Server) | `cd Front && SP_E2E_DB=SmartPortV2_Verify2 npm run test:e2e` | **passed** 11 of 11 |

SQL Server audit evidence after the run (`dbo.audit_events`, cumulative over two e2e runs): `LOGIN SUCCESS` 13, `LOGIN FAILED WRONG_PASSWORD` 10, `LOGIN FAILED LOCKED_AFTER_FAILURES` 2, `LOGIN FAILED UNKNOWN_USER` 2, `LOGIN DENIED ACCOUNT_LOCKED` 2, `LOGOUT SUCCESS` 3. After cleanup: 0 test users, 0 sessions left.

## 2. UC001 acceptance criteria

| Criterion | Test (file: name) | Status |
|---|---|---|
| AC-1 A user with the correct role sees only the permitted menu | None. The dashboard shows the user's real role, but the menu is not filtered. No function-to-role matrix exists (UC-005 admin screen is out of scope), so there is nothing to filter against | **not executed** (open, needs the permission matrix) |
| AC-2 Account locked after exactly five consecutive failures | `auth.http.test.js`: the fifth consecutive failure locks the account; `auth.e2e.test.js`: five wrong passwords lock the account in the UI | **passed** |
| AC-3 Wrong credentials and unknown users get the same message | `auth.http.test.js`: wrong password and unknown user return the same generic message; `auth.e2e.test.js`: wrong password shows the API message | **passed** |
| AC-4 Passwords are never stored, logged or returned in clear text | `security.test.js`: fresh salt, no plaintext; `auth.http.test.js`: no `password_hash` in the response; `auth.e2e.test.js`: successful login (cookie HttpOnly; password and cookie value absent from page, storage and DOM); `auth.test.js`: failed login stores no password | **passed** |

Flows covered: main success (e2e login, `auth.http` login), wrong credentials (4a), locked account (4b and 4c), inactive account (`auth.http`: a deactivated account cannot log in), validation (e2e empty form sends no request; `auth.test.js` boundaries 3 and 100 characters), server unreachable (`auth.test.js`; e2e for the session check), protected page without a session (e2e).
Authorization denial: not applicable (public endpoint).

## 3. UC002 acceptance criteria

| Criterion | Test | Status |
|---|---|---|
| AC-1 After logout the old token is refused | `auth.http.test.js`: after logout the old token is rejected; `auth.e2e.test.js`: logout revokes the session on the server (replay of the captured cookie returns 401) | **passed** |
| AC-2 A forged token is refused | `auth.http.test.js`: a forged session token is rejected | **passed** |
| AC-3 Session expires after inactivity (30 minutes, sliding) | `auth.http.test.js`: an idle session past its expiry is refused; an accepted request extends the idle expiry (about 30 minutes ahead); `auth.e2e.test.js`: a session revoked on the server redirects to login with the expiry notice | **passed**. Limit: expiry was simulated by changing stored timestamps; a real 30-minute wait was not run |
| AC-4 After logout the user returns to the login page | `auth.e2e.test.js`: logout revokes the session and blocks protected pages afterwards; regression: Sign out stays reachable on a narrow screen | **passed** |

Other flows: failed logout keeps the page and session and shows a message (e2e, `auth.test.js`); logout when already signed out (`auth.test.js`); blocked browser storage (`auth.test.js`); expired session shows the notice (e2e).

## 4. Defects found and fixed

| Defect | Found by | Fix | Regression evidence |
|---|---|---|---|
| "Sign out" and user block hidden on screens of 860 px or less (no way to sign out on tablets or phones) | e2e logout tests failed with "Node is not clickable" at the default 800 px viewport | `css/app.css`: compact user block kept visible in the narrow layout | e2e: Sign out stays reachable at 390 px. **Failure before the fix was observed at 800 px; the 390 px test was written after the fix and was not run against the old CSS** |
| A request path with `%00` crashed the static server (`ERR_INVALID_ARG_VALUE`, uncaught) | Hung test run; reproduced with a probe | `scripts/serve.js` rejects NUL with 400 | `serve.test.js`: raw `/x%00.js` returns 400 and the server keeps serving. Crash reproduced before the fix |
| Static server served `package.json` and `README.md` | Unit test | Only allow-listed extensions are served | `serve.test.js` |
| API bound to all network interfaces | Review | `SP_HOST` defaults to `127.0.0.1` | `config.test.js` |

## 5. Not executed, unavailable or open

| Item | Status | Reason |
|---|---|---|
| UC001 AC-1 role-filtered menu | **not executed** | No permission matrix (UC-005) |
| Real 30-minute idle wait | **not executed** | Simulated by timestamps |
| Firefox, Safari, mobile devices | **not executed** | Only headless Edge on desktop plus one 390 px viewport |
| HTTPS and `Secure` cookie behavior | **not executed** | Tests run on HTTP with `SP_COOKIE_SECURE=false` |
| Accessibility audit, keyboard-only walkthrough | **not executed** | No tool run |
| Spec UC-002 step 2 (confirm sign-out when a form has unsaved data) | not applicable now | No dashboard form with editable data exists yet |
| MFA | not implemented | The design text on the login page mentions MFA. It is design copy only; nothing enforces it |
