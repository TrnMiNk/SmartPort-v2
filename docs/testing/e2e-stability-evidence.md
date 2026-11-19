# Evidence: browser E2E stability (2026-11-19)

Scope: test synchronization and diagnostics only. No business behaviour, API, schema or UI code changed. Database: `SmartPortV2_VerifyFinal` (disposable, migrations 0001 to 0008; migration tests on `SmartPortV2_VerifyFinalMig`). `SmartPortV2_DemoFinal` and every other existing database were not touched.

## 1. UC027 "Node is detached from document": root cause found and fixed
- **Reproduction before the fix:** `recommendations.e2e.test.js` run alone, 8 times: failed 4 (runs 2, 5, 7, 8), always at the click on "Lưu và gửi duyệt" (line 143). A further diagnostic series failed on run 2. Roughly 5 failures in 10 runs.
- **Evidence (DOM lifecycle log captured in the failing run):** `planList` was re-drawn at +1036 ms (2 rows), +1295 ms (3 rows) and +1627 ms (4 rows). Each draft save starts a background reload of the plan list (`BP.loadPlans`, which re-draws only when the data changed). The test found the button in the 3-row version, and the reload started by the third save (v3) replaced the table before the click, so the node was detached. The 401 and the favicon 404 in the console are unrelated (the sign-in page's session check; no favicon).
- **Cause:** a race in the test, not in the UI: it waited for the database row (`planOf(v3)`), not for the screen to show it.
- **Fix:** the test waits for the row of the last saved plan (`#planList tr[data-plan=<p3>]`) before it touches the list (condition-based, no sleep, no retry). `S.clickChecked` adds the page diagnostics and the redraw log to any future failure at this click.
- **After the fix:** 10 of 10 runs of the file passed, then 5 of 5 complete suites (below).
- **Residual product risk (not changed here):** a person who clicks a row at the instant the list is re-drawn after a change loses that click. Low severity; the list only re-draws when data changed.

## 2. UC021 "blank sign-in page": not reproduced, cause not proven
- Seen earlier only inside full suite runs (`sign-in form missing ... body=""`). In this session it did not recur: `vessels.e2e.test.js` alone 8 of 8 passed, and 5 complete suites passed with no sign-in failure.
- Reading the code did not give a confirmed cause. Ruled out by reading: the sign-in page is built by `login.js` after `js/*.js` load, so a blank body with `url=login.html` means that script did not run or threw; the static server serves files with no state. Unconfirmed hypotheses (none treated as fact): a script or stylesheet request failing under load (the page also waits on the external Google Fonts stylesheet), or a machine load spike.
- **What was added so the next occurrence is diagnosable, not retried:** every test page now records console errors, uncaught page errors, failed requests and non-API HTTP errors with timestamps; the sign-in failure message prints the page URL, `readyState`, the scripts present, which globals exist (`$`, `SP_AUTH`, `SP_CONFIG`, `ic`), the events and the redraw log. No retry or sleep was added.
- **Status: unresolved (not reproduced). It must not be reported as fixed.**

## 3. Regression runs (sequential, one chain, `SmartPortV2_VerifyFinal`)
| Suite | Result |
|---|---|
| API unit (`npm run test:unit`) | passed 124 of 124 |
| SQL integration (`npm run test:integration`) | passed 192 of 192 |
| Front unit (`npm test`) | passed 55 of 55 |
| Browser E2E complete suite, run 1 | passed 51 of 51 |
| run 2 | passed 51 of 51 |
| run 3 | passed 51 of 51 |
| run 4 | passed 51 of 51 |
| run 5 | passed 51 of 51 |
Before the fix the same complete suite had 50 of 51 in all three audit runs. Five clean runs are encouraging but not proof of stability for a failure that did not reproduce (UC021); the UC027 failure, which reproduced about half the time, did not recur in 15 runs.

## 4. Files changed
`Front/test/e2e/support.js` (diagnostics, DOM redraw log, `clickChecked`), `Front/test/e2e/recommendations.e2e.test.js` (wait for the last saved plan row). Nothing else.

## 8. Update 2026-11-19: review of the sign-in failures and system sampling
Recorded recurrences: (1) blank sign-in page with `net::ERR_NO_BUFFER_SPACE` on `js/icons.js` (diagnosed, host-level); (2) `loginOk` did not complete within 15 s in the paging test (chain B of the B2/B6 slice; no diagnostics existed then; **cause unknown**); (3) a `Node is detached` click in `two-modules.e2e` (queue redrawn by the validation hint between find and click; the click now goes through `clickChecked`, which prints the redraw log). `loginOk` now reports the page message, the API log tail and the page diagnostics if sign-in does not complete. Since those diagnostics exist: 0 sign-in failures in 6 complete suites (3 + 3) plus 4 file-level runs.
Sampling during three complete suites (every 3 s, 60 samples): non-paged pool 905 to 914 MB (flat, no growth), paged pool 662 to 671 MB, free RAM 1.18 to 2.5 GB, handles 166 k to 178 k, TIME_WAIT 165 to 1507, Edge processes 5 to 18 and back to 5. So the suites do not leak and do not grow the kernel pools; the host simply starts with little free memory and a large non-paged pool. No reproducible resource, network or frontend cause was found; no sleep, retry or system change was added; diagnostics are kept. Frontend observation (not changed): the sign-in page needs seven separate scripts and an external font stylesheet, so one failed script request leaves a blank page; bundling or self-hosting would remove that failure mode in production and is a deployment decision.
