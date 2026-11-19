'use strict';

// UC-025: berth state at query time. Read only; the state is derived by policy/berthState.js from plans and maintenance,
// so no screen or request can set it (BR-2).

const status = require('../repositories/berthStatusRepository');
const { deriveState } = require('../policy/berthState');
const { errors } = require('../errors');
const { parseEta } = require('../validation/voyageValidation');

const MAX_CHART_HOURS = 14 * 24;

function present(row, now) {
  const maintenance = row.m_id ? { id: row.m_id, starts_at: row.m_starts_at, ends_at: row.m_ends_at, reason: row.m_reason } : null;
  const currentPlan = row.c_plan_id ? { plan_id: row.c_plan_id, voyage_id: row.c_voyage_id, voyage_code: row.c_voyage_code, voyage_status: row.c_voyage_status,
    ship_name: row.c_ship_name, planned_start: row.c_start, planned_end: row.c_end, ata: row.c_ata } : null;
  const nextPlan = row.n_plan_id ? { plan_id: row.n_plan_id, voyage_code: row.n_voyage_code, ship_name: row.n_ship_name, planned_start: row.n_start, planned_end: row.n_end } : null;
  return {
    id: row.id, berth_code: row.berth_code, berth_name: row.berth_name, berth_type: row.berth_type, length_m: row.length_m, max_depth_m: row.max_depth_m,
    available_cranes: row.available_cranes, allows_dangerous: !!row.allows_dangerous, longitude: row.longitude, latitude: row.latitude,
    operational_status: row.operational_status, revision: Number(row.revision),
    state: deriveState({ operationalStatus: row.operational_status, maintenance, currentPlan, nextPlan }),
    maintenance, current_plan: currentPlan, next_plan: nextPlan, as_of: now,
  };
}

async function snapshot(db, now = new Date()) {
  const rows = await status.snapshot(db, now);
  return { as_of: now, items: rows.map((r) => present(r, now)) };
}

// Selected berth: vessel now, upcoming plans and maintenance (main flow step 6).
async function detail(db, id, now = new Date()) {
  const rows = await status.snapshot(db, now, id);
  if (!rows.length) throw errors.notFound();
  const [plans, maintenance] = await Promise.all([status.upcomingPlans(db, id, now), status.upcomingMaintenance(db, id, now)]);
  return { ...present(rows[0], now), upcoming_plans: plans, upcoming_maintenance: maintenance };
}

// FR-BRT-03: the layers of the time x position chart for one berth. Read only: it decides nothing (UC-026 stays the only judge of a placement).
// A proposal of UC-027 is not stored as a plan until a coordinator saves it, so it never appears here as a reservation.
async function chart(db, id, query, now = new Date()) {
  const bad = [];
  const from = query.from === undefined ? null : parseEta(query.from); const to = query.to === undefined ? null : parseEta(query.to);
  if (!from) bad.push({ field: 'from', message: 'Thời điểm bắt đầu không hợp lệ (ISO 8601 có múi giờ).' });
  if (!to) bad.push({ field: 'to', message: 'Thời điểm kết thúc không hợp lệ (ISO 8601 có múi giờ).' });
  if (from && to && !(to > from)) bad.push({ field: 'to', message: 'Thời điểm kết thúc phải sau thời điểm bắt đầu.' });
  if (from && to && to > from && (to - from) / 3600e3 > MAX_CHART_HOURS) bad.push({ field: 'to', message: `Khoảng xem tối đa ${MAX_CHART_HOURS / 24} ngày.` });
  if (bad.length) throw errors.validation(bad);
  const rows = await status.snapshot(db, now, id);
  if (!rows.length) throw errors.notFound();
  const b = rows[0];
  const [plans, maintenance] = await Promise.all([status.chartPlans(db, id, from, to, now), status.chartMaintenance(db, id, from, to)]);
  return {
    berth: { id: b.id, berth_code: b.berth_code, berth_name: b.berth_name, berth_type: b.berth_type, length_m: Number(b.length_m), operational_status: b.operational_status, revision: Number(b.revision) },
    from, to, as_of: now,
    plans: plans.map((p) => ({ plan_id: Number(p.plan_id), voyage_id: p.voyage_id, voyage_code: p.voyage_code, ship_name: p.ship_name, voyage_status: p.voyage_status, plan_status: p.plan_status,
      source: p.source, from_proposal: p.proposal_id != null, position_start_m: Number(p.position_start_m), position_end_m: Number(p.position_end_m), planned_start: p.planned_start, planned_end: p.planned_end,
      required_cranes: p.required_cranes, revision: Number(p.revision), check_passed: p.check_passed === 'true', has_override: !!p.override_reason, ata: p.ata, atd: p.atd,
      occupies_from: p.occupies_from, occupies_to: p.occupies_to, physically_berthed: p.voyage_status === 'BERTHED' })),
    maintenance: maintenance.map((m) => ({ id: Number(m.id), starts_at: m.starts_at, ends_at: m.ends_at, reason: m.reason })),
  };
}

module.exports = { snapshot, detail, present, chart };
