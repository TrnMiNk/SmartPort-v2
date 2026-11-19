'use strict';

// UC-027 local berth recommendation engine, policy UC027-OPT-V2 (V1 stays available to replay stored snapshots). A LOCAL, DETERMINISTIC optimizer: no machine learning, no model, no
// prediction and no confidence. Its score is a utility computed from the cost below, not a probability. It is decision support: it never
// creates or approves a plan.
//
// Pure: the same snapshot gives the same result (no clock, no randomness, no database). The caller passes the facts valid at `as_of`.
// Every candidate it proposes is meant to be checked again by UC-026 (`verify`), which is the authority: a candidate that does not
// PASS there is dropped and counted, never shown as valid (UC-027 BR-1). Missing information is never treated as a passing constraint.
//
// Algorithm (provisional policy, see docs/use-cases/UC027.md section 16 for every parameter and why it needs approval):
//  1. Vessels are handled in queue order (priority, then effective ETA, then entry time: UC-020). Each vessel is considered once.
//  2. For every in-service berth that fits the vessel (type, LOA, draft, hazard, cranes) find the EARLIEST slot: start no earlier than
//     max(effective ETA, as_of) rounded up to the grid, and then the lowest position on the quay such that the vessel does not overlap or
//     come closer than the safety buffer to another reservation, and does not meet a maintenance window. Candidate starts are the earliest
//     start and the end of each reservation or maintenance interval of that berth (a standard event-point search).
//  3. Candidates are ranked by cost = wait_h + 0.25 * duration_h + 0.1 * unused_length + 0.05 * unused_cranes + 0.1 * (an ordinary cargo on a
//     dangerous-goods berth). Waiting dominates; the fit terms only separate near-equal starts. Ties: earlier start, then lower berth id, then lower position. Up to 3 verified candidates are kept per vessel.
//  4. The best verified candidate of a vessel is held as a tentative reservation while later vessels are placed, so the rank-1 placements
//     of one run do not collide with each other. Alternatives (rank 2 and 3) are only checked against real reservations and the held rank 1s.
//  V2 (this version) chooses the rank-1 placement with a bounded beam search over the queue: it keeps the best 8 partial plans (by total waiting, then
//  total cost) and for every vessel only considers the berths and positions that give it its EARLIEST feasible start in that partial plan. So no vessel
//  is ever delayed to help a vessel behind it (queue priority is kept); the search only decides WHICH berth and position, looking ahead at the vessels
//  that follow. The search is bounded by a counter (not by time), so the result stays reproducible. V1 (beam width 1) is the plain greedy choice.

const BASE = {
  handlingTeuPerCraneHour: 25,   // P-1
  fixedHours: 4,                  // P-2 berthing, unberthing and paperwork per call
  maxCranesPerVessel: 3,          // P-3
  gridMinutes: 15,                // P-4
  horizonDays: 14,                // P-5
  maxProposals: 3,                // UC-027: 1 to 3 ranked placements
  // P-6: waiting time comes first (SRS FR-BRT-05 lists it first); the fit terms add at most 0.25 h together (one grid step), so they only break near-ties.
  weights: Object.freeze({ wait: 1.0, duration: 0.25, unusedLength: 0.1, unusedCranes: 0.05, keepDangerousBerth: 0.1 }),
};
const V1 = Object.freeze({ ...BASE, version: 'UC027-OPT-V1', beamWidth: 1 });
// P-10: beam width 8, 4 alternatives per step, work cap 2000 candidate searches (a counter, never a clock). Chosen from measurements (docs/testing/uc027-hardening-evidence.md).
const V2 = Object.freeze({ ...BASE, version: 'UC027-OPT-V2', beamWidth: 8, candidatesPerStep: 4, maxExpansions: 2000 });
const POLICIES = Object.freeze({ [V1.version]: V1, [V2.version]: V2 });
const POLICY = V2;

const HOUR = 3600000;
const toMs = (v) => new Date(v).getTime();
const iso = (ms) => new Date(ms).toISOString();
const cm = (m) => Math.round(Number(m) * 100);
const m2 = (c) => c / 100;
const round = (x, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

// Facts about the vessel that must exist before any berth can be judged. Absence is reported, never assumed fine.
function missingFacts(v) {
  const m = [];
  if (!isNum(v.loa) || Number(v.loa) <= 0) m.push({ code: 'LOA', text: 'Thiếu chiều dài LOA của tàu.' });
  if (!isNum(v.draft) || Number(v.draft) <= 0) m.push({ code: 'DRAFT', text: 'Thiếu mớn nước tối đa của tàu.' });
  if (!v.cargo_class) m.push({ code: 'CARGO_CLASS', text: 'Loại tàu chưa xác định loại hàng.' });
  if (!isNum(v.declared_teu) || Number(v.declared_teu) <= 0) m.push({ code: 'TEU', text: 'Thiếu sản lượng TEU khai báo (không ước lượng được thời gian xử lý).' });
  if (!isNum(v.effective_eta) && !v.effective_eta) m.push({ code: 'ETA', text: 'Thiếu ETA hiệu lực.' });
  return m;
}

// Why a berth cannot take the vessel at all (independent of time), or null.
function berthRejection(v, b, policy) {
  if (b.operational_status !== 'IN_SERVICE') return { code: 'BERTH_IN_SERVICE', text: `Bến ${b.berth_code} đang ngừng hoạt động.` };
  if (v.cargo_class !== b.berth_type) return { code: 'BERTH_TYPE', text: `Loại bến ${b.berth_type} không phù hợp loại hàng ${v.cargo_class}.` };
  if (cm(v.loa) > cm(b.length_m)) return { code: 'LOA_FIT', text: `LOA ${v.loa} m dài hơn bến ${b.berth_code} (${b.length_m} m).` };
  if (cm(v.draft) > cm(b.max_depth_m)) return { code: 'DRAFT_FIT', text: `Mớn nước ${v.draft} m lớn hơn độ sâu bến ${b.berth_code} (${b.max_depth_m} m).` };
  if (!b.allows_dangerous) {
    if (v.cargo_hazard === 'DANGEROUS') return { code: 'DANGEROUS_GOODS', text: `Hàng nguy hiểm không được xếp vào bến ${b.berth_code} (không có nhãn cho phép).` };
    if (v.cargo_hazard !== 'NONE') return { code: 'DANGEROUS_GOODS_MISSING', text: `Chưa có xác minh hàng nguy hiểm nên chưa được xếp vào bến ${b.berth_code} (không có nhãn cho phép).` };
  }
  if (!(Number(b.available_cranes) > 0)) return { code: 'CRANES', text: `Bến ${b.berth_code} không có cẩu bờ khả dụng.` };
  void policy;
  return null;
}

// Earliest start >= t0 and lowest position where [start, start + dur] fits on berth `b`. Returns null when none within the horizon.
function findSlot({ lenCm, durMs, t0, bufferCm, berth, busy, maintenance, horizonMs }) {
  const lengthCm = cm(berth.length_m);
  const starts = new Set([t0]);
  for (const x of [...busy, ...maintenance]) { const end = toMs(x.to); if (end > t0) starts.add(end); }
  for (const start of [...starts].sort((a, b) => a - b)) {
    if (start > t0 + horizonMs) break;
    const end = start + durMs;
    if (maintenance.some((x) => toMs(x.from) < end && toMs(x.to) > start)) continue;
    const near = busy.filter((x) => toMs(x.from) < end && toMs(x.to) > start);
    const positions = [0, ...near.map((x) => cm(x.position_end_m) + bufferCm)].sort((a, b) => a - b);
    for (const p of positions) {
      if (p + lenCm > lengthCm) continue;
      const clear = near.every((x) => Math.max(p - cm(x.position_end_m), cm(x.position_start_m) - (p + lenCm)) >= bufferCm);
      if (clear) return { start, end, positionCm: p };
    }
  }
  return null;
}

function costOf(v, b, slot, cranes, durationH, policy) {
  const w = policy.weights;
  const waitH = Math.max(0, (slot.start - toMs(v.effective_eta)) / HOUR);
  const lenCm = Math.ceil(Number(v.loa) * 100);
  const unusedLength = (cm(b.length_m) - lenCm) / cm(b.length_m);
  const unusedCranes = (Number(b.available_cranes) - cranes) / Number(b.available_cranes);
  const keep = b.allows_dangerous && v.cargo_hazard === 'NONE' ? 1 : 0;
  const parts = { wait_h: round(waitH, 4), duration_h: durationH, unused_length: round(unusedLength, 4), unused_cranes: round(unusedCranes, 4), ordinary_cargo_on_dangerous_berth: keep };
  const cost = w.wait * waitH + w.duration * durationH + w.unusedLength * unusedLength + w.unusedCranes * unusedCranes + w.keepDangerousBerth * keep;
  return { cost: round(cost), score: round(1 / (1 + cost)), waitH: round(waitH, 2), parts };
}

// Candidates for one vessel: one per fitting berth (its earliest slot), plus the berths that cannot take the vessel and why.
function candidatesFor(v, berths, busy, maintenance, asOf, bufferM, policy) {
  const bufferCm = cm(bufferM);
  const grid = policy.gridMinutes * 60000;
  const t0 = Math.ceil(Math.max(toMs(v.effective_eta), toMs(asOf)) / grid) * grid;
  const lenCm = Math.ceil(Number(v.loa) * 100);
  const candidates = []; const excluded = [];
  for (const b of berths) {
    const why = berthRejection(v, b, policy);
    if (why) { excluded.push({ berth_id: b.berth_id, berth_code: b.berth_code, ...why }); continue; }
    const cranes = Math.min(Number(b.available_cranes), policy.maxCranesPerVessel);
    const durationH = Math.ceil(Number(v.declared_teu) / (cranes * policy.handlingTeuPerCraneHour)) + policy.fixedHours;
    const slot = findSlot({ lenCm, durMs: durationH * HOUR, t0, bufferCm, berth: b,
      busy: busy.filter((x) => x.berth_id === b.berth_id), maintenance: maintenance.filter((x) => x.berth_id === b.berth_id), horizonMs: policy.horizonDays * 24 * HOUR });
    if (!slot) { excluded.push({ berth_id: b.berth_id, berth_code: b.berth_code, code: 'NO_SLOT', text: `Bến ${b.berth_code} không có khoảng trống trong ${policy.horizonDays} ngày tới.` }); continue; }
    const c = costOf(v, b, slot, cranes, durationH, policy);
    candidates.push({ berth_id: b.berth_id, berth_code: b.berth_code, position_start_m: m2(slot.positionCm), position_end_m: m2(slot.positionCm + lenCm),
      planned_start: iso(slot.start), planned_end: iso(slot.end), required_cranes: cranes, expected_wait_h: c.waitH, duration_h: durationH, cost: c.cost, score: c.score, breakdown: c.parts });
  }
  candidates.sort((a, b) => a.cost - b.cost || toMs(a.planned_start) - toMs(b.planned_start) || a.berth_id - b.berth_id || a.position_start_m - b.position_start_m);
  return { candidates, excluded };
}

function explain(v, c, rank) {
  return [
    { code: 'RANK', text: `Hạng ${rank} theo chi phí ${c.cost} (điểm tiện ích ${c.score}; không phải xác suất hay độ tin cậy).` },
    { code: 'WAIT', text: `Bắt đầu ${c.planned_start}, chờ ${c.expected_wait_h} giờ sau ETA hiệu lực (${v.eta_source === 'AI' ? 'dự báo' : 'khai báo'}).` },
    { code: 'FIT', text: `Đoạn bến ${c.position_start_m} đến ${c.position_end_m} m trên bến ${c.berth_code}; LOA ${v.loa} m, mớn nước ${v.draft} m.` },
    { code: 'HANDLING', text: `Dùng ${c.required_cranes} cẩu, thời gian xử lý ước tính ${c.duration_h} giờ (TEU khai báo ${v.declared_teu}; giả định chính sách ${POLICY.handlingTeuPerCraneHour} TEU mỗi cẩu mỗi giờ cộng ${POLICY.fixedHours} giờ cố định).` },
  ];
}

// Bounded beam search over the vessel sequence (queue order is never changed). Returns voyage_id -> the chosen placement. Pure and deterministic.
// A partial plan is ranked by total waiting (an unscheduled vessel counts as the whole horizon), then total cost, then a fixed key.
function planWithBeam(snapshot, policy) {
  const penalty = policy.horizonDays * 24;
  let states = [{ busy: snapshot.busy.map((x) => ({ ...x })), wait: 0, cost: 0, picks: [] }];
  let searches = 0;
  for (const v of snapshot.vessels) {
    if (missingFacts(v).length) { states = states.map((st) => ({ ...st, picks: [...st.picks, null] })); continue; }
    const next = [];
    for (const st of states) {
      const { candidates } = candidatesFor(v, snapshot.berths, st.busy, snapshot.maintenance || [], snapshot.as_of, snapshot.buffer_m, policy);
      searches += 1;
      if (!candidates.length) { next.push({ busy: st.busy, wait: st.wait + penalty, cost: st.cost, picks: [...st.picks, null] }); continue; }
      const earliest = Math.min(...candidates.map((c) => toMs(c.planned_start)));       // only the earliest feasible start: nobody is delayed for a later vessel
      const pool = candidates.filter((c) => toMs(c.planned_start) === earliest).slice(0, policy.candidatesPerStep);
      for (const c of pool) {
        next.push({ busy: [...st.busy, { berth_id: c.berth_id, from: c.planned_start, to: c.planned_end, position_start_m: c.position_start_m, position_end_m: c.position_end_m }],
          wait: st.wait + c.expected_wait_h, cost: st.cost + c.cost, picks: [...st.picks, { berth_id: c.berth_id, planned_start: c.planned_start }] });
      }
    }
    const key = (st) => st.picks.map((x) => (x ? `${x.berth_id}@${x.planned_start}` : '-')).join('|');
    next.sort((a, b) => a.wait - b.wait || a.cost - b.cost || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    states = next.slice(0, searches > policy.maxExpansions ? 1 : policy.beamWidth);
  }
  return new Map(snapshot.vessels.map((v, i) => [v.voyage_id, states[0].picks[i]]));
}

// `verify(vessel, candidate)` is the UC-026 check; without it candidates are returned UNVERIFIED (unit tests and the baseline only).
// `selection`: 'OPTIMIZED' (the policy) or 'FIRST_FIT' (evaluation baseline: earliest start, then berth code order; never offered to users).
async function recommend(snapshot, { verify = null, selection = 'OPTIMIZED', policy: given = null } = {}) {
  // A stored snapshot names its policy version, so an old request replays with the rules it was made with.
  const policy = given || POLICIES[snapshot.policy && snapshot.policy.version] || POLICY;
  const plan = selection === 'OPTIMIZED' && policy.beamWidth > 1 ? planWithBeam(snapshot, policy) : null;
  const berths = snapshot.berths.map((b) => ({ ...b }));
  const busy = snapshot.busy.map((x) => ({ ...x }));
  const maintenance = snapshot.maintenance || [];
  const out = [];
  for (const v of snapshot.vessels) {
    const missing = missingFacts(v);
    if (missing.length) {
      out.push({ voyage_id: v.voyage_id, voyage_code: v.voyage_code, outcome: 'UNSCHEDULABLE', proposals: [], candidates_considered: 0, candidates_rejected: 0,
        reasons: missing.map((m) => ({ code: 'MISSING_DATA', text: m.text })) });
      continue;
    }
    const { candidates, excluded } = candidatesFor(v, berths, busy, maintenance, snapshot.as_of, snapshot.buffer_m, policy);
    const preferred = plan && plan.get(v.voyage_id);
    if (preferred) candidates.sort((a, b) => (a.berth_id === preferred.berth_id && a.planned_start === preferred.planned_start ? 0 : 1) - (b.berth_id === preferred.berth_id && b.planned_start === preferred.planned_start ? 0 : 1));   // stable: the rest keeps the cost order
    if (selection === 'FIRST_FIT') candidates.sort((a, b) => toMs(a.planned_start) - toMs(b.planned_start) || a.berth_code.localeCompare(b.berth_code) || a.position_start_m - b.position_start_m);
    const proposals = []; const failed = [];
    for (const c of candidates) {
      if (proposals.length >= policy.maxProposals) break;
      if (!verify) { proposals.push({ ...c, check: null }); continue; }
      let r;
      try { r = await verify(v, c); } catch (e) { r = { outcome: 'ERROR', rules: [{ id: 'STATE', outcome: 'ERROR', reason: 'Trạng thái chuyến hoặc bến đã thay đổi khi kiểm tra.' }] }; }
      if (r.outcome === 'PASS') proposals.push({ ...c, check: r });
      else failed.push({ berth_id: c.berth_id, berth_code: c.berth_code, outcome: r.outcome, reasons: (r.rules || []).filter((x) => x.outcome !== 'PASS').map((x) => ({ code: x.id, text: x.reason })) });
    }
    proposals.forEach((p, i) => { p.rank = i + 1; p.explanation = explain(v, p, i + 1); });
    const entry = { voyage_id: v.voyage_id, voyage_code: v.voyage_code, outcome: proposals.length ? 'RECOMMENDED' : 'UNSCHEDULABLE', proposals,
      candidates_considered: candidates.length, candidates_rejected: failed.length,
      reasons: proposals.length ? [] : [...excluded.map((x) => ({ code: x.code, text: x.text })), ...failed.flatMap((f) => f.reasons.map((r) => ({ code: r.code, text: `Bến ${f.berth_code}: ${r.text}` })))] };
    if (!proposals.length && !entry.reasons.length) entry.reasons.push({ code: 'NO_BERTH', text: 'Không có bến nào trong danh mục.' });
    out.push(entry);
    if (proposals[0]) busy.push({ berth_id: proposals[0].berth_id, from: proposals[0].planned_start, to: proposals[0].planned_end, position_start_m: proposals[0].position_start_m,
      position_end_m: proposals[0].position_end_m, voyage_code: v.voyage_code, tentative: true });
  }
  void berths;
  return { policy_version: policy.version, as_of: snapshot.as_of, selection, vessels: out };
}

// Evaluation metrics of one result (used for the baseline comparison and the report). Waiting hours are for rank 1 only.
function metrics(result) {
  const placed = result.vessels.filter((x) => x.proposals[0]);
  const waits = placed.map((x) => x.proposals[0].expected_wait_h);
  const hours = placed.reduce((s, x) => s + x.proposals[0].duration_h, 0);
  const starts = placed.map((x) => toMs(x.proposals[0].planned_start)); const ends = placed.map((x) => toMs(x.proposals[0].planned_end));
  return { vessels: result.vessels.length, placed: placed.length, unschedulable: result.vessels.length - placed.length,
    mean_wait_h: waits.length ? round(waits.reduce((a, b) => a + b, 0) / waits.length, 2) : null, max_wait_h: waits.length ? Math.max(...waits) : null,
    mean_unused_length: placed.length ? round(placed.reduce((t, x) => t + x.proposals[0].breakdown.unused_length, 0) / placed.length, 4) : null,
    mean_unused_cranes: placed.length ? round(placed.reduce((t, x) => t + x.proposals[0].breakdown.unused_cranes, 0) / placed.length, 4) : null,
    occupied_berth_hours: hours, makespan_h: placed.length ? round((Math.max(...ends) - Math.min(...starts)) / HOUR, 2) : null };
}

module.exports = { recommend, metrics, candidatesFor, findSlot, planWithBeam, POLICY, POLICIES, missingFacts };
