'use strict';

// UC-026: check one proposed berth placement against the technical and business rules. Pure: the service gathers the
// facts, this module decides. Nothing is stored. Each rule gives PASS, VIOLATION (with the reason) or MISSING_DATA
// (spec 6a: not enough data to evaluate, so the plan must not be saved). Equal facts always give equal results.
// The evaluation only says what is true. Whether a violation may be overridden, and by whom, is decided elsewhere (UC-028/029);
// `overridable: false` marks the violations for which no exception mechanism exists (an out-of-service berth).
//
// Position is a metre offset along the quay; a vessel occupies [position_start_m, position_end_m] (assumption A-1).
// Two placements that share time and whose stretches intersect break BR-01; if they do not intersect but the gap is
// smaller than the safety buffer they break BR-02. A gap exactly equal to the buffer passes.

const RULES_VERSION = 'UC026-RULES-V2';

const num = (v) => (v === null || v === undefined ? null : Number(v));
const cm = (v) => Math.round(v * 100); // compare metres at the 2-decimal precision of the schema
const fmt = (v) => String(Math.round(v * 100) / 100);
const when = (d) => new Date(d).toISOString();
const pass = (id) => ({ id, outcome: 'PASS', reason: null });
const violation = (id, reason, details, overridable = true) => ({ id, outcome: 'VIOLATION', reason, overridable, ...(details ? { details } : {}) });
const missing = (id, reason) => ({ id, outcome: 'MISSING_DATA', reason });

function evaluate(facts) {
  const { ship, berth, placement: p } = facts;
  const start = num(p.position_start_m); const end = num(p.position_end_m);
  const from = new Date(p.planned_start).getTime(); const to = new Date(p.planned_end).getTime();
  const bufferM = num(facts.buffer_m);
  const results = [];

  // A berth that is out of service takes no new plan. No exception mechanism is documented, so this cannot be overridden.
  if (berth.operational_status === 'OUT_OF_SERVICE') results.push(violation('BERTH_IN_SERVICE', 'Bến đang ngừng hoạt động nên không nhận kế hoạch mới.', undefined, false));
  else results.push(pass('BERTH_IN_SERVICE'));

  // LOA <= berth stretch, and the stretch lies inside the berth.
  const loa = num(ship.loa);
  if (loa === null) results.push(missing('LOA_FIT', 'Thiếu dữ liệu: tàu chưa có chiều dài LOA.'));
  else if (cm(loa) > cm(end - start)) results.push(violation('LOA_FIT', `LOA ${fmt(loa)} m lớn hơn đoạn bến được bố trí ${fmt(end - start)} m.`));
  else if (cm(end) > cm(num(berth.length_m))) results.push(violation('LOA_FIT', `Đoạn bến kết thúc tại ${fmt(end)} m, vượt chiều dài bến ${fmt(num(berth.length_m))} m.`));
  else results.push(pass('LOA_FIT'));

  const draft = num(ship.draft);
  if (draft === null) results.push(missing('DRAFT_FIT', 'Thiếu dữ liệu: tàu chưa có mớn nước tối đa.'));
  else if (cm(draft) > cm(num(berth.max_depth_m))) results.push(violation('DRAFT_FIT', `Mớn nước ${fmt(draft)} m lớn hơn độ sâu bến ${fmt(num(berth.max_depth_m))} m.`));
  else results.push(pass('DRAFT_FIT'));

  if (!ship.cargo_class) results.push(missing('BERTH_TYPE', 'Thiếu dữ liệu: loại tàu chưa xác định loại hàng.'));
  else if (ship.cargo_class !== berth.berth_type) results.push(violation('BERTH_TYPE', `Loại bến ${berth.berth_type} không phù hợp loại hàng ${ship.cargo_class}.`));
  else results.push(pass('BERTH_TYPE'));

  const cranes = num(p.required_cranes);
  if (cranes === null) results.push(missing('CRANES', 'Thiếu dữ liệu: chưa nhập số cẩu bờ cần dùng.'));
  else if (cranes > Number(berth.available_cranes)) results.push(violation('CRANES', `Cần ${cranes} cẩu bờ nhưng bến chỉ có ${berth.available_cranes} cẩu khả dụng.`));
  else results.push(pass('CRANES'));

  // BR-01 and BR-02 against plans that share time with this placement.
  const overlaps = []; const tooClose = [];
  for (const n of facts.neighbors || []) {
    const ns = num(n.position_start_m); const ne = num(n.position_end_m);
    const sharesTime = new Date(n.planned_start).getTime() < to && new Date(n.planned_end).getTime() > from;
    if (!sharesTime || ns === null || ne === null) continue;
    if (cm(start) < cm(ne) && cm(ns) < cm(end)) overlaps.push(n);
    else if (cm(Math.max(start - ne, ns - end)) < cm(bufferM)) tooClose.push({ n, gap: Math.max(start - ne, ns - end) });
  }
  results.push(overlaps.length
    ? violation('OVERLAP', `Chồng lấn đoạn bến và thời gian với chuyến ${overlaps.map((n) => n.voyage_code).join(', ')}.`, { voyages: overlaps.map((n) => n.voyage_code) })
    : pass('OVERLAP'));
  results.push(tooClose.length
    ? violation('SAFETY_BUFFER', `Khoảng cách tới ${tooClose.map((x) => `${x.n.voyage_code} (${fmt(x.gap)} m)`).join(', ')} nhỏ hơn khoảng đệm an toàn ${fmt(bufferM)} m.`, { buffer_m: bufferM })
    : pass('SAFETY_BUFFER'));

  // BR-03. Only a berth without the label needs the fact. It comes from the voyage's verified cargo hazard
  // (verified by a coordinator, with a basis); a value typed in a request is not evidence, and the priority class is not cargo data.
  if (berth.allows_dangerous) results.push(pass('DANGEROUS_GOODS'));
  else if (facts.cargo_hazard === 'DANGEROUS') results.push(violation('DANGEROUS_GOODS', 'Hàng nguy hiểm chỉ được xếp vào bến có nhãn cho phép hàng nguy hiểm.'));
  else if (facts.cargo_hazard === 'NONE') results.push(pass('DANGEROUS_GOODS'));
  else results.push(missing('DANGEROUS_GOODS', 'Thiếu dữ liệu: chưa có xác minh hàng nguy hiểm cho chuyến này nên chưa đánh giá được bến không có nhãn cho phép.'));

  const blocking = (facts.maintenance || []).filter((m) => new Date(m.starts_at).getTime() < to && new Date(m.ends_at).getTime() > from);
  results.push(blocking.length
    ? violation('MAINTENANCE', `Bến đang bảo trì trong thời gian bố trí (${blocking.map((m) => `${when(m.starts_at)} đến ${when(m.ends_at)}`).join('; ')}).`, { intervals: blocking.map((m) => m.id) })
    : pass('MAINTENANCE'));

  // Missing data wins over a violation: with data missing the plan cannot be saved at all (spec 6a), and the stored outcome
  // VIOLATION therefore always means "every rule could be evaluated", which the plan table relies on for overrides.
  const outcome = results.some((r) => r.outcome === 'MISSING_DATA') ? 'MISSING_DATA' : results.some((r) => r.outcome === 'VIOLATION') ? 'VIOLATION' : 'PASS';
  // `passed` is the flag that the plan table's constraint reads from the stored check result (CK_bp_reviewed).
  const violations = results.filter((r) => r.outcome === 'VIOLATION');
  return { rules_version: RULES_VERSION, outcome, passed: outcome === 'PASS', buffer_m: bufferM,
    overridable: outcome === 'VIOLATION' && violations.every((r) => r.overridable !== false), rules: results };
}

module.exports = { evaluate, RULES_VERSION };
