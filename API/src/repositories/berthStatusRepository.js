'use strict';

// Read-only queries for berth state (UC-025) and for the placement check (UC-026). SQL only.

const occupancy = require('./occupancy');

const BERTH_COLUMNS = `b.id, b.berth_code, b.berth_name, b.berth_type, b.length_m, b.max_depth_m, b.available_cranes, b.allows_dangerous,
  b.longitude, b.latitude, b.operational_status, b.revision`;

// One row per active berth with the facts valid at @now: the maintenance interval containing now, the approved plan holding
// the berth now (or whose voyage is still berthed after the plan end), and the next approved plan.
async function snapshot(db, now, berthId = null) {
  const r = await db.pool.request().input('now', db.sql.DateTime2(3), now).input('berthId', db.sql.Int, berthId).query(`
    SELECT ${BERTH_COLUMNS},
      m.id AS m_id, m.starts_at AS m_starts_at, m.ends_at AS m_ends_at, m.reason AS m_reason,
      c.plan_id AS c_plan_id, c.voyage_id AS c_voyage_id, c.voyage_code AS c_voyage_code, c.voyage_status AS c_voyage_status,
      c.ship_name AS c_ship_name, c.planned_start AS c_start, c.planned_end AS c_end, c.ata AS c_ata,
      n.plan_id AS n_plan_id, n.voyage_code AS n_voyage_code, n.ship_name AS n_ship_name, n.planned_start AS n_start, n.planned_end AS n_end
    FROM dbo.berths b
    OUTER APPLY (SELECT TOP 1 id, starts_at, ends_at, reason FROM dbo.berth_maintenance
                 WHERE berth_id = b.id AND status = 'ACTIVE' AND starts_at <= @now AND ends_at > @now ORDER BY ends_at DESC) m
    OUTER APPLY (SELECT TOP 1 bp.id AS plan_id, v.id AS voyage_id, v.voyage_code, v.status AS voyage_status, s.ship_name, bp.planned_start, bp.planned_end, v.ata
                 FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id JOIN dbo.ships s ON s.id = v.ship_id
                 WHERE bp.berth_id = b.id AND bp.plan_status = 'APPROVED' AND (bp.planned_start <= @now OR v.status = 'BERTHED')
                   AND (bp.planned_end > @now OR v.status = 'BERTHED') ORDER BY bp.planned_start DESC, bp.id DESC) c
    OUTER APPLY (SELECT TOP 1 bp.id AS plan_id, v.voyage_code, s.ship_name, bp.planned_start, bp.planned_end
                 FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id JOIN dbo.ships s ON s.id = v.ship_id
                 WHERE bp.berth_id = b.id AND bp.plan_status = 'APPROVED' AND bp.planned_start > @now ORDER BY bp.planned_start, bp.id) n
    WHERE b.is_active = 1 AND (@berthId IS NULL OR b.id = @berthId) ORDER BY b.berth_code`);
  return r.recordset;
}

async function upcomingPlans(db, berthId, now) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('now', db.sql.DateTime2(3), now).query(
    `SELECT TOP 10 bp.id, bp.plan_status, bp.planned_start, bp.planned_end, bp.position_start_m, bp.position_end_m, v.voyage_code, s.ship_name
     FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id JOIN dbo.ships s ON s.id = v.ship_id
     WHERE bp.berth_id = @b AND bp.plan_status IN ('APPROVED', 'PENDING_APPROVAL') AND bp.planned_end > @now
     ORDER BY bp.planned_start, bp.id`);
  return r.recordset;
}

async function upcomingMaintenance(db, berthId, now) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('now', db.sql.DateTime2(3), now).query(
    `SELECT TOP 10 id, starts_at, ends_at, reason FROM dbo.berth_maintenance
     WHERE berth_id = @b AND status = 'ACTIVE' AND ends_at > @now ORDER BY starts_at, id`);
  return r.recordset;
}

// Chart layers for one berth in [from, to] (FR-BRT-03). A plan's physical occupancy uses the shared definition (occupancy.js): a BERTHED vessel keeps its
// stretch until its actual departure, so `occupies_to` is NULL (open-ended) when the planned end has passed and no departure is recorded.
// Rejected, cancelled and superseded plans are not part of the chart.
async function chartPlans(db, berthId, from, to, now) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('from', db.sql.DateTime2(3), from).input('to', db.sql.DateTime2(3), to).input('now', db.sql.DateTime2(3), now).query(
    `SELECT bp.id AS plan_id, bp.voyage_id, v.voyage_code, s.ship_name, v.status AS voyage_status, v.ata, v.atd, bp.plan_status, bp.source, bp.proposal_id,
       bp.position_start_m, bp.position_end_m, bp.planned_start, bp.planned_end, bp.required_cranes, bp.revision,
       JSON_VALUE(bp.constraint_check_json, '$.passed') AS check_passed, bp.override_reason,
       ${occupancy.FROM} AS occupies_from, CASE WHEN (${occupancy.TO}) = ${occupancy.OPEN_END} THEN NULL ELSE ${occupancy.TO} END AS occupies_to
     FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id JOIN dbo.ships s ON s.id = v.ship_id
     WHERE bp.berth_id = @b AND bp.plan_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED')
       AND (${occupancy.FROM}) < @to AND (${occupancy.TO}) > @from
     ORDER BY bp.planned_start, bp.id`);
  return r.recordset;
}

async function chartMaintenance(db, berthId, from, to) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('from', db.sql.DateTime2(3), from).input('to', db.sql.DateTime2(3), to).query(
    `SELECT id, starts_at, ends_at, reason FROM dbo.berth_maintenance WHERE berth_id = @b AND status = 'ACTIVE' AND starts_at < @to AND ends_at > @from ORDER BY starts_at, id`);
  return r.recordset;
}

// Facts for the placement check (UC-026).
async function voyageFacts(db, voyageId) {
  const r = await db.pool.request().input('id', db.sql.Int, voyageId).query(
    `SELECT v.id, v.voyage_code, v.status, v.priority_class, s.length_overall_m AS loa, s.max_draft_m AS draft, t.cargo_class, v.cargo_hazard
     FROM dbo.voyages v JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.ship_types t ON t.id = s.ship_type_id WHERE v.id = @id`);
  return r.recordset[0] ?? null;
}

// Plans on the berth that share time with the proposed interval. The voyage's own plans are ignored.
// `statuses` are the plan states that hold the berth against this placement: pending, approved and completed plans for a save or a
// submission (UC-028/029), approved and completed ones only at approval (UC-030: a plan that is merely waiting for a decision is not a reservation).
async function neighbors(db, berthId, voyageId, from, to, statuses = ['PENDING_APPROVAL', 'APPROVED', 'COMPLETED'], now = new Date()) {
  const list = statuses.map((s) => `'${s.replace(/[^A-Z_]/g, '')}'`).join(', '); // constant states, never user text
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('v', db.sql.Int, voyageId)
    .input('from', db.sql.DateTime2(3), from).input('to', db.sql.DateTime2(3), to).input('now', db.sql.DateTime2(3), now).query(
      `SELECT * FROM (SELECT bp.id AS plan_id, v.voyage_code, bp.position_start_m, bp.position_end_m, ${occupancy.FROM} AS planned_start, ${occupancy.TO} AS planned_end
         FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id
         WHERE bp.berth_id = @b AND bp.voyage_id <> @v AND bp.plan_status IN (${list})) x
       WHERE x.planned_start < @to AND x.planned_end > @from`);  // a completed plan frees the berth at the actual departure
  return r.recordset;
}

async function maintenanceOverlapping(db, berthId, from, to) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('from', db.sql.DateTime2(3), from).input('to', db.sql.DateTime2(3), to).query(
    `SELECT id, starts_at, ends_at, reason FROM dbo.berth_maintenance WHERE berth_id = @b AND status = 'ACTIVE' AND starts_at < @to AND ends_at > @from`);
  return r.recordset;
}

module.exports = { snapshot, upcomingPlans, upcomingMaintenance, chartPlans, chartMaintenance, voyageFacts, neighbors, maintenanceOverlapping };
