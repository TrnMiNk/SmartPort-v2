'use strict';

// Data access for berth recommendations (UC-027): the facts a run is based on, and the stored requests, outcomes, proposals and decisions. SQL only.

const occupancy = require('./occupancy');

const num = (v) => (v === null || v === undefined ? null : Number(v));

// The waiting queue with the facts the engine needs. Effective ETA is the declared ETA unless a valid AI forecast exists (same rule as UC-020).
async function queueFacts(db, voyageIds) {
  const req = db.pool.request();
  const filter = voyageIds ? `AND v.id IN (${voyageIds.map((id, i) => { req.input(`v${i}`, db.sql.Int, id); return `@v${i}`; }).join(', ')})` : '';
  const r = await req.query(
    `SELECT v.id AS voyage_id, v.voyage_code, v.queue_position, v.priority_class, s.ship_name, v.declared_teu, v.cargo_hazard,
            s.length_overall_m AS loa, s.max_draft_m AS draft, t.cargo_class,
            CASE WHEN p.ai_status = 'AVAILABLE' THEN p.predicted_eta ELSE v.declared_eta END AS effective_eta,
            CASE WHEN p.ai_status = 'AVAILABLE' THEN 'AI' ELSE 'DECLARED' END AS eta_source
     FROM dbo.voyages v JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.ship_types t ON t.id = s.ship_type_id
     LEFT JOIN dbo.voyage_eta_predictions p ON p.id = v.latest_eta_prediction_id
     WHERE v.status = 'WAITING_BERTH' ${filter} ORDER BY v.queue_position`);
  return r.recordset.map((x) => ({ ...x, loa: num(x.loa), draft: num(x.draft), declared_teu: num(x.declared_teu), queue_position: num(x.queue_position),
    effective_eta: new Date(x.effective_eta).toISOString() }));
}

async function activeBerths(db) {
  const r = await db.pool.request().query(
    `SELECT id AS berth_id, berth_code, berth_type, length_m, max_depth_m, available_cranes, allows_dangerous, operational_status
     FROM dbo.berths WHERE is_active = 1 ORDER BY id`);
  return r.recordset.map((b) => ({ ...b, length_m: num(b.length_m), max_depth_m: num(b.max_depth_m), allows_dangerous: !!b.allows_dangerous }));
}

// Reservations that still matter at `asOf`: pending, approved and completed plans (a completed plan ends at the actual departure), as UC-026 sees them for a draft.
async function reservations(db, asOf) {
  const r = await db.pool.request().input('asOf', db.sql.DateTime2(3), asOf).input('now', db.sql.DateTime2(3), asOf).query(
    `SELECT * FROM (SELECT bp.id, bp.berth_id, ${occupancy.FROM} AS [from], ${occupancy.TO} AS [to], bp.position_start_m, bp.position_end_m, v.voyage_code
       FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id
       WHERE bp.plan_status IN ('PENDING_APPROVAL', 'APPROVED', 'COMPLETED') AND bp.position_end_m IS NOT NULL) x
     WHERE x.[to] > @asOf ORDER BY x.berth_id, x.[from], x.id`);
  return r.recordset.map((x) => ({ berth_id: x.berth_id, from: new Date(x.from).toISOString(), to: new Date(x.to).toISOString(),
    position_start_m: num(x.position_start_m), position_end_m: num(x.position_end_m), voyage_code: x.voyage_code }));
}

async function maintenance(db, asOf) {
  const r = await db.pool.request().input('asOf', db.sql.DateTime2(3), asOf).query(
    `SELECT berth_id, starts_at AS [from], ends_at AS [to] FROM dbo.berth_maintenance WHERE status = 'ACTIVE' AND ends_at > @asOf ORDER BY berth_id, starts_at, id`);
  return r.recordset.map((x) => ({ berth_id: x.berth_id, from: new Date(x.from).toISOString(), to: new Date(x.to).toISOString() }));
}

async function insertInference(db, v) {
  const r = await db.pool.request()
    .input('u', db.sql.BigInt, v.userId).input('model', db.sql.NVarChar(40), v.modelVersion).input('status', db.sql.VarChar(20), v.status)
    .input('fail', db.sql.NVarChar(200), v.failureReason ?? null).input('req', db.sql.NVarChar(db.sql.MAX), v.requestJson).input('res', db.sql.NVarChar(db.sql.MAX), v.responseJson)
    .input('hash', db.sql.Char(64), v.snapshotHash).input('ms', db.sql.Int, v.durationMs)
    .query(`INSERT INTO dbo.berth_plan_inferences (requested_by_user_id, model_version, ai_status, failure_reason, request_json, engine_kind, snapshot_hash, response_json, duration_ms, completed_at)
            OUTPUT inserted.id VALUES (@u, @model, @status, @fail, @req, 'LOCAL_OPTIMIZER', @hash, @res, @ms, SYSUTCDATETIME())`);
  return num(r.recordset[0].id);
}

async function insertVessel(db, inferenceId, v) {
  await db.pool.request().input('i', db.sql.BigInt, inferenceId).input('v', db.sql.Int, v.voyage_id).input('q', db.sql.Int, v.queue_position ?? null)
    .input('eta', db.sql.DateTime2(3), new Date(v.effective_eta)).input('src', db.sql.VarChar(10), v.eta_source).input('o', db.sql.VarChar(16), v.outcome)
    .input('c', db.sql.Int, v.candidates_considered).input('r', db.sql.Int, v.candidates_rejected).input('reasons', db.sql.NVarChar(db.sql.MAX), JSON.stringify(v.reasons))
    .query(`INSERT INTO dbo.berth_plan_inference_vessels (inference_id, voyage_id, queue_position, effective_eta, eta_source, outcome, candidates_considered, candidates_rejected, reasons_json)
            VALUES (@i, @v, @q, @eta, @src, @o, @c, @r, @reasons)`);
}

async function insertProposal(db, inferenceId, voyageId, p) {
  const r = await db.pool.request().input('i', db.sql.BigInt, inferenceId).input('v', db.sql.Int, voyageId).input('b', db.sql.Int, p.berth_id).input('rank', db.sql.Int, p.rank)
    .input('ps', db.sql.Decimal(10, 2), p.position_start_m).input('pe', db.sql.Decimal(10, 2), p.position_end_m)
    .input('from', db.sql.DateTime2(3), new Date(p.planned_start)).input('to', db.sql.DateTime2(3), new Date(p.planned_end))
    .input('wait', db.sql.Decimal(10, 2), p.expected_wait_h).input('score', db.sql.Decimal(9, 6), p.score)
    .input('check', db.sql.NVarChar(db.sql.MAX), JSON.stringify(p.check)).input('why', db.sql.NVarChar(db.sql.MAX), JSON.stringify(p.explanation_json))
    .query(`INSERT INTO dbo.berth_plan_proposals (inference_id, voyage_id, berth_id, rank_no, position_start_m, position_end_m, planned_start, planned_end, expected_wait_h, score, constraint_check_json, explanation_json)
            OUTPUT inserted.id VALUES (@i, @v, @b, @rank, @ps, @pe, @from, @to, @wait, @score, @check, @why)`);
  return num(r.recordset[0].id);
}

async function findInference(db, id) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query(
    `SELECT i.id, i.requested_by_user_id, u.username AS requested_by, i.requested_at, i.model_version, i.ai_status, i.failure_reason, i.engine_kind, i.snapshot_hash, i.duration_ms,
            i.completed_at, i.request_json, i.response_json
     FROM dbo.berth_plan_inferences i LEFT JOIN dbo.auth_users u ON u.user_id = i.requested_by_user_id WHERE i.id = @id`);
  return r.recordset[0] ? { ...r.recordset[0], id: num(r.recordset[0].id) } : null;
}

async function vesselsOf(db, id) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query(
    `SELECT iv.voyage_id, v.voyage_code, iv.queue_position, iv.effective_eta, iv.eta_source, iv.outcome, iv.candidates_considered, iv.candidates_rejected, iv.reasons_json
     FROM dbo.berth_plan_inference_vessels iv JOIN dbo.voyages v ON v.id = iv.voyage_id WHERE iv.inference_id = @id ORDER BY iv.queue_position, iv.voyage_id`);
  return r.recordset;
}

async function proposalsOf(db, id) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query(
    `SELECT p.id, p.voyage_id, p.berth_id, b.berth_code, p.rank_no, p.position_start_m, p.position_end_m, p.planned_start, p.planned_end, p.expected_wait_h, p.score, p.constraint_check_json, p.explanation_json
     FROM dbo.berth_plan_proposals p JOIN dbo.berths b ON b.id = p.berth_id WHERE p.inference_id = @id ORDER BY p.voyage_id, p.rank_no`);
  return r.recordset.map((p) => ({ ...p, id: num(p.id), position_start_m: num(p.position_start_m), position_end_m: num(p.position_end_m), expected_wait_h: num(p.expected_wait_h), score: num(p.score) }));
}

async function decisionsOf(db, id) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query(
    `SELECT d.id, d.voyage_id, d.proposal_id, d.plan_id, d.decision, d.reason, d.decided_at, u.username AS decided_by
     FROM dbo.berth_plan_decisions d LEFT JOIN dbo.auth_users u ON u.user_id = d.decided_by_user_id WHERE d.inference_id = @id ORDER BY d.id`);
  return r.recordset.map((d) => ({ ...d, id: num(d.id), proposal_id: num(d.proposal_id), plan_id: num(d.plan_id) }));
}

// A proposal with the request it belongs to, for turning it into a draft plan.
async function findProposal(db, id) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query(
    `SELECT p.id, p.inference_id, p.voyage_id, p.berth_id, p.rank_no, p.position_start_m, p.position_end_m, p.planned_start, p.planned_end, p.explanation_json, i.engine_kind
     FROM dbo.berth_plan_proposals p JOIN dbo.berth_plan_inferences i ON i.id = p.inference_id WHERE p.id = @id`);
  const p = r.recordset[0];
  return p ? { ...p, id: num(p.id), inference_id: num(p.inference_id), position_start_m: num(p.position_start_m), position_end_m: num(p.position_end_m) } : null;
}

async function insertDecision(db, d) {
  await db.pool.request().input('i', db.sql.BigInt, d.inferenceId).input('v', db.sql.Int, d.voyageId).input('p', db.sql.BigInt, d.proposalId ?? null).input('pl', db.sql.BigInt, d.planId ?? null)
    .input('d', db.sql.VarChar(10), d.decision).input('r', db.sql.NVarChar(500), d.reason ?? null).input('u', db.sql.BigInt, d.userId)
    .query(`INSERT INTO dbo.berth_plan_decisions (inference_id, voyage_id, proposal_id, plan_id, decision, reason, decided_by_user_id) VALUES (@i, @v, @p, @pl, @d, @r, @u)`);
}

// An accepted plan that the coordinator later edits becomes MODIFIED (and the plan's source AI_ADJUSTED); editing it back makes it ACCEPTED again.
async function reclassify(db, planId, source, decision) {
  await db.pool.request().input('pl', db.sql.BigInt, planId).input('s', db.sql.VarChar(30), source).input('d', db.sql.VarChar(10), decision).query(
    `UPDATE dbo.berth_plans SET source = @s WHERE id = @pl;
     UPDATE dbo.berth_plan_decisions SET decision = @d WHERE plan_id = @pl;`);
}

module.exports = { queueFacts, activeBerths, reservations, maintenance, insertInference, insertVessel, insertProposal, findInference, vesselsOf, proposalsOf, decisionsOf,
  findProposal, insertDecision, reclassify };
