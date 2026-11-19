# Evidence: UC021 (schedule), UC022/UC023 (blocked), queue 409 in the browser

Date: 2026-11-18. Database: disposable `SmartPortV2_Verify4`, created empty, migrated (0001, 0002) and seeded for this run. API on port 3000, Front on 5500, Edge through puppeteer-core. Earlier evidence: `uc013-uc015-uc020-evidence.md`.

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 72 of 72 (5 new for the schedule query validation) |
| `cd API && npm run test:integration` | passed: 90 of 90 (7 new in `schedule.http.test.js`; the 83 earlier tests, including UC013, UC015 and UC020, still pass) |
| `cd Front && npm test` | passed: 51 of 51 (3 new: windows, bar geometry, endpoints) |
| `cd Front && npm run test:e2e` | passed: 35 of 35, run twice in a row (new: UC-021, UC-021 5a; the UC-020 test now also covers the 409) |
| UC002 4a | passed in all runs of the suite above (no failure; the diagnostic dump is still in the test) |

## 2. UC021 criteria

| Criterion | Test | Status |
|---|---|---|
| Main flow: list with status, agent, berth, ETA, ATA, ATD | integration "list"; e2e "UC-021" | passed |
| AC-1 filter by berth, agent, status returns the matching rows only | integration "AC-1"; e2e (berth filter gives 1 row) | passed |
| AC-2 Gantt bar equals stored times | integration "AC-2" and "window" (overlap, touching edges, ATA/ATD over plan); e2e bar at 33.33% and 50% of 2026-01-10 in UTC+7 | passed |
| BR-3 berth only from an approved plan | integration "AC-1" (a pending plan gives no berth) | passed |
| Day and week windows (Monday first) | Front unit `scheduleWindow`; e2e week view | passed |
| 4a no match: "Không có dữ liệu" | integration (empty list), e2e (status filter and an empty window) | passed |
| 5a load error with Retry, no partial data | e2e "UC-021 5a" | passed |
| Lifecycle of a voyage opens from a row or bar | e2e "UC-021" | passed |
| Authorization: coordinator, management and warehouse staff may view; agent and technician refused; no session 401; agent does not see the panel | integration "authorization"; e2e | passed |
| Input validation (bad view, status, ids, windows) | unit (5), integration "validation" | passed |

**Limitation.** Berths and approved plans are produced by Module 2 (UC-024, UC-030), which does not exist. The tests insert them into the documented tables. They verify the schedule query and screen against the schema, not Module 2. The mock berth timeline on the vessels page has been replaced by the real schedule. The KPIs and scheduling alerts on that page remain sample data and are labelled so.

## 3. Queue 409 in the browser (UC020 AC-3)

e2e "UC-020": after the coordinator's own move, another session moves a voyage through the API; the next move in the open (stale) view is refused with 409, the banner says the queue was changed by someone else, the queue is reloaded to the new order, and the refused move wrote no `voyage_queue_changes` row. Status: passed. This closes the gap noted in the previous evidence file. UC020 stays **Implemented** (ordering assumptions Q-1..Q-3 unapproved; M2 notification pending).

## 4. UC022 and UC023: not executed

No tests were written because nothing was implemented. Blockers: see section 14 of `UC022.md` and `UC023.md` (no approved berth plan can be created without Module 2; contradictory spec on the state "Đã xếp bến").

## 5. Concurrency and queue consistency review

Reviewed, no code change needed: every queue change (new entry from UC015, move from UC020) takes the single `voyage_queue_state` row lock first, then the voyage rows, with `LOCK_TIMEOUT` 5 s mapped to 503 `QUEUE_BUSY`; moves are guarded by the queue revision. Covered by "simultaneous submissions keep the queue contiguous" and "two coordinators moving at once" (integration) and the browser 409 test above. The schedule is read only and takes no locks that can delay the queue.

## 6. Not verified

- Any real AI provider; the 5 s criterion with a slow provider (analysis in `docs/policies/uc015-uc020-policy-v1.md` §7).
- Schedule behavior with real Module 2 data and with thousands of voyages (only fixtures; Gantt cut at 500 rows by design).
- Browsers other than Edge.
