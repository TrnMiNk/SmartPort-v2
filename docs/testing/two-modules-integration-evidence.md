# Evidence: integration review of modules 1 and 2, UI/UX pass, demo preparation

Date: 2026-11-19. Verification databases: disposable `SmartPortV2_Verify4` (API integration, browser e2e), `SmartPortV2_Mig` (migration tests), and a **new** `SmartPortV2_DemoRun2` (demo-sized data, screenshots). `SmartPortV2_DemoRun1` is a partial first attempt of the demo script (it failed on a business rule, see 5) and was left as it is. No migration was added. Legacy repositories were not touched. No existing database was reset or seeded.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 90 of 90 |
| `cd API && npm run test:integration` (with `SP_MIGRATION_TEST_DB`) | passed: 146 of 146 (last run, after cleaning the leftovers described in 5) |
| `cd Front && npm test` | passed: 53 of 53 |
| `cd Front && npm run test:e2e` | passed: 47 of 47 in 3 consecutive full runs (2 new tests in `two-modules.e2e.test.js`) |
| `SP_DB_NAME=SmartPortV2_DemoRun2 node API/scripts/check-consistency.js` | passed: 9 of 9 checks on 24 voyages made by the real flow |

## 2. Full business workflow in a real browser (`two-modules.e2e.test.js`)

| Step | Where verified | Status |
|---|---|---|
| Sign in as the coordinator and as a different port manager | browser, two contexts | passed |
| Register a notice through the form; automatic validation in the same request: `WAITING_BERTH`, run row `VALID` with policy `UC015-POLICY-V1` | UI + SQL | passed |
| AI: the result says "chưa có dự báo AI"; the run records `ai_status = UNAVAILABLE`. **AI is not counted as executed.** | UI + SQL | passed (AI criteria remain unverified) |
| Queue membership shown; hazard verification; placement check `PASS`; draft; submit | UI | passed |
| Manager gets the notification without reloading; reviews; approves; the plan becomes `APPROVED`, the voyage `BERTH_ASSIGNED`, leaves the queue; coordinator's page follows; berth "Đã đặt trước" | UI + SQL | passed |
| Schedule shows the voyage with its berth; berthing with default ATA; berth "Đang sử dụng" on both pages; departure; berth "Trống"; plan `COMPLETED` | UI + SQL | passed |
| History: six transitions with actor; audit rows for submit, approve, berthing, departure | SQL | passed |
| Rejection workflow: empty reason refused, then rejected with a reason; coordinator is told (reason in the notice); voyage stays `WAITING_BERTH` and queued; berth stays free; a new draft is accepted; audit `SUCCESS` for the rejection | UI + SQL | passed |
| Roles: coordinator cannot approve or reject (403, audited); warehouse staff cannot approve or confirm berthing; the agent cannot read plans or confirm departure; no button for them | UI + API | passed |

## 3. Latency measured in the browser (milliseconds, from the click to the visible result; local machine, one API process)

| Flow | Run 1 | Run 2 | Run 3 | Limit in the specification |
|---|---|---|---|---|
| Notice submit to validation result | 168 | 175 | 149 | 5 s |
| Plan submit to the manager's notice on an open page | 139 | 133 | 147 | 5 s |
| Approval to the coordinator's notice | 70 | 49 | 54 | 5 s |
| Rejection to the coordinator's notice | 126 | **2016** | 118 | 5 s |

The 2016 ms value is an unexplained outlier (about 17 times the usual); it is still inside 5 s. It was not retried away and its cause is unknown (not investigated further: one sample). Pages without the live channel (agents) refresh every 30 s, so the 5 s limit is **not** met for them and was not measured.

## 4. UI/UX review (screenshots at 1440, 820 and 390 px; page: Vessels & berths)

Method: the real pages against the demo-sized database, one screenshot per panel, plus the berthing dialog with a validation error. No horizontal page overflow at any size (scroll width equals client width). Impeccable is **not installed** in this environment, so it was not used. Accessibility was reviewed by inspection only (no automated audit was run).

| Issue found | Fix |
|---|---|
| Notification panel: text touched the left edge, the list grew without limit (32 rows made the panel 1342 px tall), the mark-as-read button wrapped to four lines on mobile | Padding, list capped at 420 px with scrolling, no-wrap buttons, and a line "Đang hiển thị 20 thông báo mới nhất trong 32 chưa đọc" |
| Approval notices showed raw ISO timestamps (`2026-11-19T09:18:31.117Z`) | Server text now shows `YYYY-MM-DD HH:mm (UTC+7)` |
| Section titles mixed Vietnamese-only and English-only | Registry, queue and notices titles now use "Tiếng Việt · English" like the other panels |
| A page of seven long panels with no way to jump | Sticky jump bar with anchors to each section (scrolls horizontally on phones) |
| Tables clipped on phones with no hint that they scroll | Edge shadows on scrolling tables, sticky first column, and the least important column hidden on phones for the schedule and plan tables |
| Sample KPIs, alerts and strip looked like live data; its single label was above the KPIs only; placeholder buttons "Resolve conflicts" and "Export plan" did nothing | Everything sample is inside one dashed block labelled "DỮ LIỆU MẪU · SAMPLE DATA"; the buttons are disabled with "Chưa triển khai"; live arrival notices moved out of that block |
| Template chrome that looked real: workspace "Port of Rotterdam", "All systems operational", a frozen clock "08:42 UTC+2", "Alerts (3)", a search box that does nothing | Workspace marked "dữ liệu mẫu", status shown as "System status (sample)", a **real** clock in UTC+7, Alerts disabled without a fake count, search disabled |
| Dialogs | Reviewed: berthing and lifecycle dialogs fit at 390 px, errors appear under the field, focus moves to the first field. No change needed |

Preserved: colour system, table layout, Gantt, status pills, dialog structure. Other pages (overview, cargo, yard, services, equipment, GIS) were not changed, except that the shared sidebar and top bar labels above apply to every page.

## 5. Stability review

- **Intermittent e2e failures** (UC-021 5a, UC-010 duplicate IMO): not seen in the 3 full runs of this task (6 together with the previous task). Cause still unproven; diagnostics are kept; no retries added.
- **New observation:** while building `two-modules.e2e.test.js`, one SQL read (`COUNT(*)` on `audit_events`) timed out four times in a row (15 s, then 30 s timeouts) and then passed on the next runs without any code change to that query. Not reproduced since. The test now dumps blocking sessions if it happens again. Cause unknown; a lock wait caused by a leftover session is a hypothesis only (no leftover session was found afterwards).
- **Test pollution found (my mistake, test-side):** the shared queue is global, and several earlier tests assume it holds nothing else. Failed runs of my `voyage-movement` tests left WAITING_BERTH rows (cleanup had failed on a foreign key), which made five unrelated integration tests fail with "positions 1..n". I removed exactly those leftovers (three known test suffixes, in one transaction) and the 146 tests passed. Lesson: after a failed run, clean its fixtures before rerunning. This is a limitation of the shared-database test design, not a product defect.
- **Assumption M-1** (UC-022 and UC-023): the 5-minute tolerance for "edited time" and the 1-minute future skew are my choices, not approved business rules. Alternatives: no tolerance (every typed time needs a reason), or ask the user explicitly with a checkbox "Tôi đã sửa giờ". Needs the owner's decision. The other assumptions (M-2 to M-5, N-1, A-2, A-5) also remain unapproved.
- **Status transitions:** `check-consistency.js` checks, on 24 voyages created by the real flow: status equals the last history row; queue positions are 1..n; only waiting voyages have positions; assigned or berthed voyages have exactly one approved plan; departed voyages have a completed plan; approved plans match voyage states; ATA/ATD set exactly when expected; no two vessels berthed on overlapping stretches; an audit row exists for every approval, rejection, berthing and departure. All passed.
- **Demo-sized data:** 8 berths, 24 ships, 24 voyages, 11 plans, about 144 audit rows. The pages, queue, schedule and notification list render and respond normally (screenshots above). Larger volumes were not tested.
- First demo-script attempt failed because the plan stretch was shorter than the vessel and the berth type did not match: the placement rules refused it correctly. The script now sizes each stretch from the ship and picks the berth type by ship type.

## 6. Remaining sample or simulated information

| Where | What | State |
|---|---|---|
| Vessels page, bottom block | KPI cards, scheduling alerts, status strip, footer "Sources: AIS … NLRTM / SHIFT A / UTC+2" | Fixed sample, labelled, buttons disabled |
| Sidebar and top bar (all pages) | Workspace "Port of Rotterdam", "System status (sample)", disabled search and Alerts | Marked or disabled |
| Other pages (overview, port operation, cargo, yard, services, equipment, GIS) | Template content | Out of scope, not reviewed in this task; not labelled |
| Ship documents | Inserted by SQL in tests and demo | No upload use case |
| AI forecast and proposals | Unavailable | Not simulated |

## 7. Outstanding acceptance criteria (accurate classification kept)

- UC-015: **Implemented**; the AI forecast part cannot be verified (no provider).
- UC-020: **Implemented** (ordering assumptions Q-1 to Q-3 unapproved).
- UC-025, UC-026, UC-028, UC-030: **Implemented** (UC-030 AC-1 only for the parties in scope).
- UC-021, UC-029 (manual path), UC-022, UC-023, UC-031: **Completed**.
- UC-027: **blocked** (no AI provider). UC-033: **not built**.

## 8. Not verified

- 5 s delivery for users without the live channel; several API processes; browsers other than Edge; an automated accessibility audit; data volumes above the demo size; the intermittent failures' causes.
