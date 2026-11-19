'use strict';

// One definition of when a berth plan occupies its stretch, shared by UC-026 (placement check) and UC-027 (recommendations), so the two can never disagree.
// It follows the occupancy rules already decided for UC-022 and UC-025 (A-5):
//  - a plan occupies [planned_start, planned_end]; a vessel that berthed EARLY (ATA before the planned start) occupies from its ATA;
//  - a COMPLETED plan ends at the actual departure (ATD);
//  - a vessel that is BERTHED occupies its stretch until it actually departs: when its planned end has already passed and no departure is recorded,
//    the occupancy has no known end, so it is open-ended and nothing may be placed on that stretch from now on.
// Queries using these fragments need `v` (voyages), `bp` (berth_plans) and a bound @now (DateTime2).

const OPEN_END = `CAST('9999-12-31T00:00:00' AS DATETIME2(3))`;
const FROM = `CASE WHEN v.status = 'BERTHED' AND v.ata IS NOT NULL AND v.ata < bp.planned_start THEN v.ata ELSE bp.planned_start END`;
const TO = `CASE WHEN bp.plan_status = 'COMPLETED' THEN COALESCE(v.atd, bp.planned_end)
                  WHEN v.status = 'BERTHED' AND bp.planned_end <= @now THEN ${OPEN_END}
                  ELSE bp.planned_end END`;

module.exports = { FROM, TO, OPEN_END };
