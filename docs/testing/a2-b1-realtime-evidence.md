# Evidence: A2 realtime refresh and B1 five-second acceptance (2026-11-19)

Scope: refresh hints for validation and queue changes (A2) and measurement of the SRS five-second criteria (B1). No business rule, schema or permission changed. Database: `SmartPortV2_VerifyFinal` (disposable, migrations 0001 to 0008; migration tests on `SmartPortV2_VerifyFinalMig`). `SmartPortV2_DemoFinal` and every other existing database were not touched. All suites ran one after the other.

## 1. A2: root cause and change
- **Gap (from the audit):** the berth channel (`/api/v1/realtime/m2/events`) published hints only for plans, berths and ETA forecasts. A validated or rejected notice and a manual queue move published nothing, so a second coordinator saw them only after the 30 s timer or a reload. The notice list was also never refreshed by a hint (`loadNotices` had no silent mode).
- **Backend:** `voyageService.withValidation` publishes `VOYAGE_VALIDATED {voyage_id}` after every validation (queued, missing documents, rejected, or a run that could not complete, since the notice itself changed). `queueService.move` publishes `QUEUE_MOVED {voyage_id}` after the commit; a refused move publishes nothing. The existing `ETA_UPDATED` (asynchronous forecast and reorder) and `PLAN_APPROVED` (voyage leaves the queue) already covered the other cases; the browser tests below measure the second one.
- **Payload and access:** a hint holds the type and a voyage id only. It is sent on the existing berth channel, which still requires the berth-view permission (agents get 403, anonymous clients 401). The content-free notification channel is unchanged and does not carry these hints, so an agent or yard account receives nothing from them. No notification model or permission changed.
- **Frontend:** `berth-panel.js` reads the hint type: `VOYAGE_VALIDATED` and `QUEUE_MOVED` reload only the notices, the queue and the schedule (`refreshQueueViews`); other hints keep the old full refresh, which now also reloads the notices. `loadNotices({silent})` redraws only when the data changed (the queue and schedule already did).
- **Not changed:** the manual-order rules, the ETA worker, the notification list.

## 2. B1: the SRS criteria and how each was measured
SRS five-second criteria (`SmartPort/runtime-verification/final-acceptance/usecases.txt`): API notice appears in the system (UC-013); a valid vessel appears in the queue (UC-015); berth state on the UI after a change (UC-025); after approval all parties are notified (UC-030); the coordinator receives the rejection reason (UC-031). Plan submission to the manager (UC-029 AC-2) has no number in the SRS; it is measured against the same 5000 ms.
Method (`Front/test/e2e/latency.e2e.test.js`): separate signed-in Edge sessions (two coordinators, a manager, two agents of different agents). The initiator's UI click is time zero (the queue move uses the browser session's API call). The receiving page records when its DOM first shows the update (a MutationObserver inside the page) and when each refresh hint arrived. Each iteration prints its own line and fails above 5000 ms; the threshold was not changed. Columns: `api` is click to response (request, validation and SQL persistence, not separable further without server instrumentation); `hint` is response to the first hint received (clamped at 0: the hint often reached the browser before Node saw the response); `render` is hint to DOM change.

## 3. B1 results (3 complete suite runs, 5 iterations per workflow and run, individual lines in the test output)
| Workflow (receiver) | Measurements | Min ms | Max ms | Max API ms |
|---|---|---|---|---|
| Notice submitted, valid: appears in another coordinator's queue | 15 | 77 | 144 | 117 |
| same: appears in the other coordinator's notice list | 15 | 77 | 144 | 117 |
| Notice with missing documents appears in the other coordinator's list | 6 | 71 | 105 | 81 |
| Manual queue move seen in another coordinator's queue | 15 | 28 | 59 | 35 |
| Plan submitted: manager's notice | 15 | 81 | 149 | 80 |
| Approval: coordinator's notice | 15 | 84 | 143 | 69 |
| Approval: voyage leaves the other coordinator's queue | 15 | 70 | 131 | 69 |
| Approval: berth shows "Đã đặt trước" | 15 | 60 | 101 | 69 |
| Approval: the voyage's agent's notice | 15 | 82 | 132 | 69 |
| Berthing: berth "Đang sử dụng" in the manager's and the other coordinator's browser | 30 | 45 | 87 | 48 |
| Departure: berth "Trống" in the same two browsers | 30 | 44 | 70 | 45 |
| Rejection: coordinator's notice with the reason | 15 | 56 | 169 | 93 |
Total: 201 measurements, **all under 5000 ms, slowest 169 ms** (per-run maxima 131, 137 and 169 ms). Isolation checks inside the same test: another agent's notification list and open page never contain the approved voyage; the agent gets 403 on the plan list.

## 4. A2 tests
| Test | Result |
|---|---|
| Integration: valid notice sends one `VOYAGE_VALIDATED` hint with only type and voyage id, within 5 s, ids strictly increasing, one hint per action | passed |
| Integration: missing documents also sends it; agent and yard notification channels receive nothing | passed |
| Integration: queue move sends `QUEUE_MOVED` after commit; a stale (refused) move sends nothing | passed |
| Integration: berth channel 403 for the agent, 401 anonymous | passed |
| Browser: while a coordinator types a notice, another user's hint refreshes the queue behind the dialog; the open form keeps its values and stays open; an unchanged queue is not re-drawn | passed |

## 5. Regression and a changed test premise
UC-020 browser test (6a, stale queue) failed twice in the first chain after the change (`Node is detached`, `vessels.e2e.test.js:570`): its premise was that another user's move leaves this page stale. Since A2 the page refreshes itself, so the click raced with the redraw. This is the intended behaviour. The test now produces the stale view the way it occurs for real, by closing that page's refresh channel (a hint is not proof of delivery) before the other move; the 409 path is still exercised. 4 of 4 runs of the file passed afterwards.

## 6. Runs (sequential, final chain)
| Suite | Result |
|---|---|
| API unit | passed 124 of 124 |
| SQL integration | passed 196 of 196 (4 new) |
| Front unit | passed 55 of 55 |
| Browser E2E complete suite, run 1 | passed 56 of 56 |
| run 2 | passed 56 of 56 |
| run 3 | passed 56 of 56 |
An earlier chain with the same code but before the UC-020 test fix had 56 of 56 once and 55 of 56 twice (the UC-020 test above). No `sign-in form missing` (UC021) failure occurred in any run; its cause is still unproven.

## 7. Limits (not verified)
- One API process and one machine, idle, a local database. No load (SRS 50 users at 3 s is a separate gap B2) and no network latency. The numbers show the design is far below the limit, not what happens under load.
- Hints are in-process (`m2Events.js`): with several API processes a client is told only when its own process produced the event; the others see the change at the next reload or timer. Not implemented, not tested. Reconnect reload and the loss of a hint are covered by the UC-025 and UC-020 tests.
- The measured DOM time excludes the final paint. The asynchronous-ETA reorder is covered functionally (eta browser test) but was not timed here. An agent's open list of own notices is not refreshed by a validation hint (agents have no berth channel); they see their own result in the submit dialog.
- Yard, crane and gate recipients of the approval notice belong to Modules 3 to 5 and cannot be measured.

## 8. Count verification (2026-11-19, requested after review)
A report said the table in section 3 sums to 171 while the summary said 201. Recomputed from the original logs of the final chain (`e2e_1.log` to `e2e_3.log`): every run prints 67 `B1 <workflow> #n <receiver>` lines and a summary line "67 measurements", so 3 x 67 = **201**. Per workflow and run: notice-to-queue 5 + 5 (queue and notice list), notice-missing-documents 2, queue-move 5, plan-submit 5, plan-approval 20 (4 receivers), berthing 10, departure 10, rejection 5 = 67. The rows of the section 3 table add up to 15 + 15 + 6 + 15 + 15 + 15 + 15 + 15 + 15 + 30 + 30 + 15 = **201** as well. The number 171 could not be reproduced from the logs or the table; it equals 201 minus one of the two 30-measurement rows (berthing or departure), which suggests one of those rows was left out of that sum. No measurement was added or removed; 201 stands.
