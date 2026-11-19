'use strict';

// UC-025: the display state of a berth at one instant, derived from plans, maintenance and the berth's operational
// status (docs/database/schema.md section 4). Nothing is stored, so the state cannot drift from the plans (BR-2).
//
// Order: OUT_OF_SERVICE (BR-3: regardless of plans; shown as a fifth label, assumption A-3) > MAINTENANCE >
// IN_USE > RESERVED > AVAILABLE.
//  - IN_USE: an approved plan holds the berth now and its voyage is BERTHED.
//  - RESERVED: an approved plan starts later, or holds the berth now while its voyage has not berthed yet (the
//    vessel is late but the berth stays reserved for it, assumption A-4).
// The caller passes only facts valid at `now`: the maintenance interval containing now, the approved plan holding the
// berth now (or whose voyage is still berthed after the plan end, assumption A-5), and the next approved plan.

const STATES = ['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'RESERVED', 'OUT_OF_SERVICE'];

function deriveState({ operationalStatus, maintenance, currentPlan, nextPlan }) {
  if (operationalStatus === 'OUT_OF_SERVICE') return 'OUT_OF_SERVICE';
  if (maintenance) return 'MAINTENANCE';
  if (currentPlan && currentPlan.voyage_status === 'BERTHED') return 'IN_USE';
  if (currentPlan || nextPlan) return 'RESERVED';
  return 'AVAILABLE';
}

module.exports = { deriveState, STATES };
