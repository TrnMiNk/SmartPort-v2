# ETA terminology and the arrival event (UC-013, UC-015, UC-016, UC-017, UC-018, UC-022)

Date: 2026-11-19. Authority: the SRS (`SmartPort/runtime-verification/final-acceptance/usecases.txt`, read only). Where the SRS is silent the gap is recorded here; nothing was decided silently.

## 1. What each term means

| Term | Meaning in the SRS | Where it lives in V2 | Source (SRS) |
|---|---|---|---|
| **Declared ETA** ("ETA khai báo") | The arrival time the agent or coordinator enters in the arrival notice | `voyages.declared_eta`; the value at the time of each request is kept in `voyage_eta_predictions.declared_eta` | UC-013 step 3; FR-VES-02 |
| **Predicted ETA** ("ETA dự báo") | The time an AI service returns for the voyage, "dựa trên dữ liệu lịch sử, tốc độ tàu và thời tiết" | `voyage_eta_predictions.predicted_eta` (only when a provider really answered) | UC-016 step 2; FR-VES-05 |
| **Deviation** ("độ lệch") | Predicted ETA minus declared ETA, in hours | `voyage_eta_predictions.eta_deviation_h` | UC-016 step 3 and business rule |
| **Confidence** ("độ tin cậy") | Returned by the AI service. **The SRS never defines what it measures** (not a probability, not a tolerance band) | `voyage_eta_predictions.eta_confidence` (0 to 1 as reported) | UC-016 step 2 |
| **Effective ETA** | The ETA the queue uses: the predicted ETA when a forecast exists, otherwise the declared ETA | computed in the queue query (UC-020) | UC-015 step 4, 3a |
| **ETA thực tế** in FR-VES-05 and UC-016 ("dự báo ETA thực tế") | Read as "a realistic forecast of the ETA", i.e. the predicted ETA. It is **not** defined as an event that happened | , | FR-VES-05; UC-016 description |
| **ATA** | "Thời gian cập bến thực tế": the **berthing** time recorded by the coordinator when the vessel is berthed | `voyages.ata` (UC-022) | UC-022 |
| **Actual arrival at port** | **Not defined anywhere in the SRS.** No use case records the moment a vessel reaches the port limits, the anchorage or the pilot station | does not exist in V2 | , |

## 2. The ambiguity and what is NOT done about it

1. **ATA is the berthing time, not the arrival at port.** UC-022 records the ATA when the vessel is berthed (the vessel may wait at anchor for a berth first), and UC-025 and the billing text (FR for ATA to ATD) use ATA as berth occupancy time. Berthing time = arrival + waiting for a berth, so using it as the "actual arrival" would teach a model that congestion is lateness. **V2 therefore does not use the berth ATA as a ground-truth arrival label, anywhere.**
2. **What NFR-ACC-04 compares against is not stated.** "MAE of the ETA forecast lower than the deviation of the declared ETA" needs an actual time to measure both against. The SRS does not say which event. UC-017 (deviation alert, default threshold 6 h) compares predicted with declared ETA, not with any actual time.
3. **UC-018 (update ETA, keep the history of ETA changes) is not built**, so there is only one declared ETA per voyage and no ETA change history; a second prediction can only come from a later UC-018 or from an explicit request that no use case defines.

## 3. Proposal (needs approval, not implemented)

Add a separate, explicit event: **actual arrival at port** (for example `voyages.actual_port_arrival_at` with who recorded it, a source and a defined boundary such as "pilot boarding" or "entry to the port limits"), recorded by the coordinator or imported from AIS, with its own use case or an extension of UC-022. Until it exists and is approved: no training or accuracy measurement of any ETA model may use the berth ATA, and the MAE criterion stays blocked. The proposal changes the SRS vocabulary and the data model, so it is a business decision, not a code decision.

## 4. Confidence: how it is shown now

The value is shown exactly as the provider reported it (0 to 1, not converted to a percentage) with the statement "do nhà cung cấp báo; ý nghĩa chưa được định nghĩa" and a longer explanation in the tooltip and in the API field `confidence_meaning`. It is never shown when no real forecast exists. If the business later defines it (for example "probability that the error is within X hours"), the definition and a calibration test must come first.

## 5. Time convention

All stored times are UTC (ISO 8601). Every time shown on the vessels page (declared ETA, predicted ETA, request time, history, queue, schedule) is converted to **UTC+7** by the same function (`SP_RES_UTIL.formatUtc7`), as the SRS requires ("ISO 8601 UTC, hiển thị UTC+7").
