'use strict';

// Berth queue ordering (FR-VES-07, UC-015 step 4, UC-020): "theo ETA dự báo và độ ưu tiên (tàu tuyến chính, hàng
// lạnh/nguy hiểm)". Pure and deterministic. Documented: the two keys, and that main-line and reefer/hazard vessels are the
// priority examples. NOT documented (engineering assumptions Q-1 to Q-3 in docs/policies/uc015-uc020-policy-v1.md):
//   Q-1 priority outranks ETA; Q-2 MAIN_LINE and REEFER_OR_HAZARD share one tier, since the specification ranks neither
//   above the other; Q-3 ties are broken by queue entry time, then voyage id, so equal inputs always give one order.

const TIER = { MAIN_LINE: 1, REEFER_OR_HAZARD: 1, STANDARD: 2 };

function compare(a, b) {
  const tier = (TIER[a.priority_class] ?? 2) - (TIER[b.priority_class] ?? 2);
  if (tier !== 0) return tier;
  const eta = new Date(a.effective_eta).getTime() - new Date(b.effective_eta).getTime();
  if (eta !== 0) return eta;
  const queued = new Date(a.queued_at).getTime() - new Date(b.queued_at).getTime();
  if (queued !== 0) return queued;
  return a.id - b.id;
}

// 0-based index at which `candidate` enters an existing queue: before the first entry it outranks, else at the end.
// The scan starts at the front, so the result is a function of the current queue only.
function insertionIndex(entries, candidate) {
  const i = entries.findIndex((entry) => compare(candidate, entry) < 0);
  return i === -1 ? entries.length : i;
}

module.exports = { TIER, compare, insertionIndex };
