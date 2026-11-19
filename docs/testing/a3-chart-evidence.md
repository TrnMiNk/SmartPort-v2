# Evidence: A3 berth plan chart, time x position (2026-11-19)

Scope: gap A3 of the final audit (FR-BRT-03; UC-026 4a; UC-027 step 6; UC-028 steps 1, 2, 4 and 2a). No business rule, permission, schema or UC status changed. Databases: `SmartPortV2_VerifyFinal` (disposable, migrations 0001 to 0008) and `SmartPortV2_VerifyFinalMig`. `SmartPortV2_DemoFinal` and all other existing databases were not touched. Suites ran one after the other.

## 1. What the SRS requires (exact lines of `usecases.txt`)
| Source | Text (translated) | Addressed by |
|---|---|---|
| FR-BRT-03 (line 261) | Show the berth plan chart (time axis x position along the berth) and allow viewing, drag and drop, and adjusting the berthing position and time | chart, drag and drop |
| UC-026 4a (2646) | On a violation the system marks it on the chart so the coordinator can adjust (UC-028) | violation marks, ghost block with the server's rules |
| UC-027 step 6 (2686) | The system shows the proposals **and** the berth plan chart (time x position) | proposals drawn as unconfirmed blocks |
| UC-028 steps 1, 2, 4 (2721 to 2724) | Chart shown; the coordinator accepts a proposal **or drags to adjust position/time**; the system rechecks UC-026 and marks valid/violation on the chart | accept = open dialog with the proposal; drag = dialog with dropped values and a UC-026 check |
| UC-028 2a (2727) | Reject all proposals: place manually by drag and drop | tray of unplanned queued vessels |
| UC-028 3a, 5a, acceptance | Violation always warned; override only with a reason, audited; concurrent conflict: reload and choose again | existing dialog and revision paths, tested through the chart |
Drag and drop is therefore **required** (FR-BRT-03, UC-028), not optional. The existing UC-021 Gantt (vessels over time by voyage) is a different view and was not reused: it has no position axis.

## 2. Behaviour
- Panel "Biểu đồ kế hoạch bến" on the vessels page, for roles with berth view (the agent sees no panel; the endpoint answers 403). One berth at a time (selector), 1, 3 or 7 days, previous / today / next. Time on x in UTC+7 labelled without overlap at any width, position 0 to the berth length on y, a "now" line.
- Layers from `GET /berths/:id/chart` (real SQL data): approved plans, pending plans, drafts, completed plans (end at the actual departure), **actual occupancy of a BERTHED vessel** (hatched, from its ATA, open-ended with an arrow when its planned end has passed and no departure is recorded: availability is never inferred from the planned end), and maintenance (whole berth). Rejected and superseded plans are not shown.
- UC-027 proposals: dashed "chưa xác nhận, không giữ chỗ" blocks that can be hidden; no plan exists until a draft is saved.
- Status is not shown by colour alone: border style, hatching and a text label differ, with a legend; tooltips and an info line give ship, voyage, status, stretch, UTC+7 times, source, check and override.
- Drag (mouse, pen or touch, pointer events) of a draft, a proposal, or a tray chip: time snaps to 15 minutes, stretch to 1 m, size kept, the block stays on the berth. The drop opens the **existing** check/save dialog with the dropped values; the server's UC-026 result is drawn on the chart (pass, violation with the rules and reasons, missing data) and shown in the dialog. Nothing is stored by the drop. Saving, override with a reason, audit, revision checks and permissions are the existing paths. Enter on a block opens the same dialog (keyboard path). Escape cancels a drag.
- A background refresh redraws only when the data changed and never while a block is being dragged (it waits for the drop). Open dialogs are untouched.
- States: loading, empty (no berth; berth without plans), error with Retry.
- Backend: read-only `chart` service and endpoint on the shared occupancy rule; the queue payload gained `length_overall_m`. Frontend: `berth-chart.js`, pure geometry in `resources.js`, small CSS block, hooks in `berth-panel.js` (`openCheck(..., values)`).
- Assumptions to approve: CH-1 time on x, position on y; CH-2 snap 15 min / 1 m; CH-3 a vessel dragged from the tray gets its LOA as stretch and a 12 h stay as a UI default (the crane count is never invented: the server answers MISSING_DATA until it is typed).

## 3. Defect found and fixed on the way
The "Check" button of the dialog opened from a UC-027 proposal sent `proposal_id` to the check endpoint, which rejects unknown fields ("Trường không được hỗ trợ"): the button never worked in that dialog (saving did). Fixed in `berth-panel.js`; the chart's proposal drag test would fail without it.

## 4. Tests
| Layer | Test | Result |
|---|---|---|
| Frontend unit | `chart.test.js`: window in UTC+7, scale both ways, clipping and open-ended rect, snap, clamp to the berth, ticks | passed (5 new, 60 total) |
| SQL integration | `berth-chart.http.test.js`: layers and exclusions (rejected, other berth, out of window, cancelled maintenance); BERTHED open-ended / early ATA / departed at ATD; a concurrent update changes the revision; roles (coordinator, manager, yard read; agent 403; anonymous 401); validation (missing, invalid, reversed, over 14 days, unknown berth) | passed (5 new) |
| Browser | `chart.e2e.test.js` (2 tests): real layers incl. actual BERTHED vessel and maintenance, geometry equal to the stored data (within 2.5 px), UTC+7 tooltip and axis, legend; proposals unconfirmed and hideable; drag of a draft to a free place (PASS, nothing stored until Save, revision +1); drag onto an approved vessel (VIOLATION marked, Save refused without a reason, override saved and audited, flags drawn); concurrent edit (stale save refused, the other version stands); proposal drag saved as `LOCAL_OPTIMIZER_ADJUSTED` with decision MODIFIED; tray drag (MISSING_DATA until cranes typed, LOA stretch, 12 h); manager sees the chart without drag/tray and the server refuses his create (403); hint during a drag does not replace the dragged node, refresh applied after the drop; Escape cancels; error then Retry; tablet (820) and phone (390) with no page overflow and no overlapping labels; empty berth message | passed |
Screenshots inspected (real browser, `docs/testing/screenshots/`): `a3-desktop-layers.png`, `a3-desktop-violation-dialog.png`, `a3-desktop-override.png`, `a3-tablet.png`, `a3-phone.png`. Defects seen in them and fixed: time-axis labels overlapped on the phone (tick step now adapts to the width; asserted by the test) and the first desktop shot did not scroll to the chart.

## 5. Regression runs (sequential, `SmartPortV2_VerifyFinal` / `...Mig`)
| Suite | Result |
|---|---|
| API unit | passed 124 of 124 |
| SQL integration (final chain) | passed 201 of 201 (5 new) |
| Frontend unit | passed 60 of 60 |
| Browser E2E complete suite, nine runs in three chains | see below |
| chain 1 | 57 of 58 (new chart test: `Node is either not clickable`, a wait on a dialog button that was present but not yet visible), 58, 58 |
| chain 2 (after the fix: waits are for visible elements) | 58, **57 of 58** (`vessels.e2e` sign-in page blank: see 6), 58 |
| chain 3 (final, nothing changed in between) | **58, 58, 58** |
Also in chain 1 the integration suite failed 3 tests of `migration-0008.test.js`: the old schema rejects a result-less PENDING row with either of two constraints (`CK_vep_status` or `CK_vep_result`) and the test asserted only the first; the assertion now accepts either and the two following failures were cascades. A scratch database was left with a history row for 0008 and an old-shape table by the cascade; I removed that one row from `SmartPortV2_VerifyFinalMig` (my disposable scratch database) and the file then passed.
The three E2E suites after the fix were clean, but one of the two earlier chains had a sign-in failure, so stability is **not** proven (6).

## 6. UC021 blank sign-in page: evidence from one recurrence
The recurrence in chain 2 carried the permanent diagnostics: `requestfailed GET http://localhost:5601/js/icons.js net::ERR_NO_BUFFER_SPACE`, then `pageerror ic is not defined`, `readyState complete`, empty body. So the sign-in page is blank because the browser could not load one script (Windows socket buffer error WSAENOBUFS); `login.js` then fails at its first call and never builds the form. Right after that suite `netstat` showed about 1190 sockets in TIME_WAIT (dynamic range 16384). This is an operating-system or browser resource error on the test machine, not a defect of the page or the static server (the server answered nothing wrong; the request never completed). **Demonstrated for this recurrence only**: the earlier occurrences (including the UC-021 one) had no diagnostics, so they are consistent with this cause but not proven to be it; why the buffers run out (many short-lived contexts, SSE connections, no-store caching) was not isolated. No retry or sleep was added. Status: cause of the observed recurrence demonstrated as environmental; the flake still exists on this machine; **not resolved**.

## 7. Limits
Local deterministic optimizer, no AI. One berth per view; a drop on a berth other than the selected one is not possible (choose the berth first). No resize handles: a time or stretch change that a drag cannot express is typed in the dialog. Keyboard dragging is not provided (Enter opens the dialog). Large queues (hundreds of blocks) and several API processes were not tested (hints are in-process). The chart window is at most 14 days. The default 12 h stay of a tray drop is a UI default, not a rule.
