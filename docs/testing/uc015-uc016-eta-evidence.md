# Evidence: UC015 and UC016 ETA readiness and acceptance hardening

Date: 2026-11-19. **No real AI provider, no AIS data, no actual-arrival labels and no ETA model exist; none was built, trained or simulated.** Every forecast in this file comes from a clearly labelled local MOCK (a stand-in function or a small HTTP server written for the test, returning the declared ETA plus a fixed offset). Mocks prove how the system stores, computes and shows an answer; they say nothing about the quality of any real model. Database: my disposable `SmartPortV2_UC027` (migrated to 0007). `DemoRun2` and `Verify4` were not touched; no migration was added (the existing columns were enough). Legacy repositories untouched. The suites ran one after the other (one chain, waiting for each step).

## 1. Commands and results

| Command | Result |
|---|---|
| `cd API && npm run test:unit` | passed: 113 of 113 |
| `cd API && npm run test:integration` (`SP_DB_NAME` and `SP_TEST_DB` = UC027 database, `SP_MIGRATION_TEST_DB` = Mig) | passed: 173 of 173 (6 new UC-016 and UC-015 tests in `flow.http.test.js`; UC013, UC015, UC020, UC021 and all Module 1 and 2 tests included) |
| `cd Front && npm test` | passed: 55 of 55 (1 new) |
| `cd Front && npm run test:e2e` (`SP_E2E_DB` = UC027 database) | passed: 51 of 51 in 3 consecutive runs (2 new in `eta.e2e.test.js`) |

## 2. Criteria and tests

| Criterion | Test | Provider | Status |
|---|---|---|---|
| No provider: the history, the voyage detail and the validation result show UNAVAILABLE, the label "chưa có dự báo AI", the reason, and null predicted ETA, deviation, confidence and model; nothing invented | integration "UC-016 no provider"; integration "UC-015 valid notice" | none (the real state) | passed |
| Four values shown together: declared ETA, predicted ETA, deviation (predicted minus declared, hours; +12 h in the test), confidence as reported, with the statement that its meaning is undefined; source and order number | integration "UC-016 MOCK provider answer"; browser (result dialog, lifecycle dialog, queue tag) | MOCK | passed (display and computation only) |
| A replay of an already valid voyage shows the stored forecast and adds no prediction | integration | MOCK | passed (this was a defect: the replay lost the forecast) |
| History: append-only, newest first with order numbers, earlier rows unchanged; the database refuses an impossible confidence and an AVAILABLE row without a forecast | integration "UC-016 history" (rows 2 and 3 are fixtures: no use case issues a second prediction until UC-018 exists) | fixtures | passed |
| History access: coordinator, view roles and the voyage's own agent read; another agent 404; unknown and malformed ids 404; no session 401; no M1 permission 403 | integration | , | passed |
| Failure reasons in the history for timeout, malformed answer, unreachable and HTTP error; the voyage continues with the declared ETA and the queue uses it | integration (timeout reduced to 150 ms for the test) and the earlier UC-015 test | MOCK | passed |
| Queue ordering without a forecast and with an earlier forecast | integration (UC-020 tests, unchanged) | MOCK for the forecast | passed |
| Browser, provider answers: values in UTC+7 (declared 08:00 and predicted 10:00 as typed and computed), deviation "+2 giờ", confidence with its note, model name, queue shows the forecast tag, lifecycle dialog and history | browser `eta.e2e` | MOCK HTTP server | passed |
| Browser, provider answers 503: "chưa có dự báo AI" with the reason, no predicted time, deviation and confidence "—", voyage queued by the declared ETA (tag "declared"), history keeps the attempt | browser `eta.e2e` | MOCK HTTP server returning 503 | passed |
| UC-015 AC-1 (5 s) with the AI unavailable | integration, browser (0.08 to 0.24 s earlier measured) | none | passed |
| UC-015 AC-1 with a slow provider | integration "KNOWN CONFLICT" | MOCK answering after 5.5 s | **conflict measured**: the submission took 5.53 and 5.54 s in two runs, although the provider answered inside the 10 s timeout |
| A real AI forecast (UC-015 step 3, UC-016 AC-3), the MAE criterion (NFR-ACC-04) | none | none | **not executed: blocked** |

## 3. Defects found and fixed

| Defect | Fix |
|---|---|
| The validation result and its replay carried only the status and the predicted time: no declared ETA, deviation, model or timestamp, and a replay showed no forecast | One presentation function (`etaPredictionService.present`) used by the fresh result, the replay, the history and the voyage detail |
| No way to read the prediction history (UC-016 5a) and no display of the four values on the vessels page | `GET /voyages/:id/eta-predictions`, `eta` on the voyage detail, and the screens |
| The old test compared the whole `ai` object, so any added field would break it | Replaced by explicit field checks |

## 4. Terminology and the arrival event

See `docs/architecture/eta-semantics.md`. The SRS defines declared ETA, predicted ETA, deviation (predicted minus declared, hours) and effective ETA; it does **not** define confidence, nor an "actual arrival at port" event. The ATA of UC-022 is the berthing time and is not used as an arrival label anywhere. A separate arrival event is proposed (needs approval); until then NFR-ACC-04 cannot be measured.

## 5. Not verified, blockers

- A real provider's behaviour (accuracy, real 10 s timeout, load), any real forecast, model quality, AIS and weather sources, an actual-arrival event and labels, history of ETA changes (UC-018 not built), UC-017 deviation alerts.
- The conflict between UC-015 AC-1 (5 s) and 3a (10 s) is unresolved; options are in UC015 section 16.2.
- Several API processes; browsers other than Edge; `DemoRun2` and `Verify4` do not have migrations 0006 and 0007 (this slice needs none).
