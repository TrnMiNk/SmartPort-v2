'use strict';

// Data access for berth plans (UC-028, UC-029). SQL only; decisions live in berthPlanService.

const SELECT = `SELECT bp.id, bp.voyage_id, v.voyage_code, s.ship_name, bp.berth_id, b.berth_code, bp.plan_status, bp.source, bp.proposal_id,
  bp.position_start_m, bp.position_end_m, bp.planned_start, bp.planned_end, bp.required_cranes, bp.buffer_m, bp.policy_version,
  bp.constraint_check_json, bp.override_reason, bp.override_by_user_id, bp.override_at, bp.override_rules, bp.rejection_reason,
  bp.created_by_user_id, bp.created_at, bp.submitted_by_user_id, su.display_name AS submitted_by_name, bp.submitted_at, bp.approved_by_user_id, au.display_name AS approved_by_name, bp.approved_at, bp.revision`;
const FROM = (lock) => `FROM dbo.berth_plans bp ${lock ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
  JOIN dbo.voyages v ON v.id = bp.voyage_id JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.berths b ON b.id = bp.berth_id
  LEFT JOIN dbo.auth_users su ON su.user_id = bp.submitted_by_user_id LEFT JOIN dbo.auth_users au ON au.user_id = bp.approved_by_user_id`;

// BIGINT columns arrive as strings; ids and revisions are small counters, so they are exposed as numbers (see shipsRepository).
const num = (v) => (v === null || v === undefined ? null : Number(v));
function shape(row) {
  if (!row) return null;
  return { ...row, id: num(row.id), revision: num(row.revision), created_by_user_id: num(row.created_by_user_id), submitted_by_user_id: num(row.submitted_by_user_id),
    approved_by_user_id: num(row.approved_by_user_id), override_by_user_id: num(row.override_by_user_id),
    check: JSON.parse(row.constraint_check_json), override_rules: row.override_rules ? JSON.parse(row.override_rules) : null, constraint_check_json: undefined };
}

async function findById(db, id, { lock = false } = {}) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query(`${SELECT} ${FROM(lock)} WHERE bp.id = @id`);
  return shape(r.recordset[0]);
}

// Serializes everything that decides on one voyage. Lock order in this module: berth(s) by id, then voyage, then plan.
async function lockVoyage(db, id) {
  const r = await db.pool.request().input('id', db.sql.Int, id).query('SELECT id, voyage_code, status FROM dbo.voyages WITH (UPDLOCK, HOLDLOCK) WHERE id = @id');
  return r.recordset[0] ?? null;
}

async function openPlansForVoyage(db, voyageId) {
  const r = await db.pool.request().input('v', db.sql.Int, voyageId)
    .query(`SELECT id, plan_status FROM dbo.berth_plans WHERE voyage_id = @v AND plan_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED')`);
  return r.recordset.map((p) => ({ id: num(p.id), plan_status: p.plan_status }));
}

function bindPlacement(req, sql, v) {
  return req.input('berthId', sql.Int, v.berth_id).input('ps', sql.Decimal(10, 2), v.position_start_m).input('pe', sql.Decimal(10, 2), v.position_end_m)
    .input('from', sql.DateTime2(3), v.planned_start).input('to', sql.DateTime2(3), v.planned_end).input('cranes', sql.Int, v.required_cranes ?? null)
    .input('buffer', sql.Decimal(10, 2), v.buffer_m).input('policy', sql.VarChar(40), v.policy_version).input('check', sql.NVarChar(sql.MAX), JSON.stringify(v.check))
    .input('ovReason', sql.NVarChar(500), v.override ? v.override.reason : null).input('ovBy', sql.BigInt, v.override ? v.override.by : null)
    .input('ovAt', sql.DateTime2(3), v.override ? v.override.at : null).input('ovRules', sql.NVarChar(400), v.override ? JSON.stringify(v.override.rules) : null);
}

async function insertDraft(db, v, userId) {
  const req = bindPlacement(db.pool.request(), db.sql, v).input('voyageId', db.sql.Int, v.voyage_id).input('u', db.sql.BigInt, userId)
    .input('source', db.sql.VarChar(30), v.source || 'MANUAL').input('proposalId', db.sql.BigInt, v.proposal_id ?? null);
  const r = await req.query(`INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m, position_end_m, planned_start, planned_end,
      required_cranes, buffer_m, policy_version, constraint_check_json, override_reason, override_by_user_id, override_at, override_rules, created_by_user_id, proposal_id)
    OUTPUT inserted.id VALUES (@voyageId, @berthId, 'DRAFT', @source, @ps, @pe, @from, @to, @cranes, @buffer, @policy, @check, @ovReason, @ovBy, @ovAt, @ovRules, @u, @proposalId)`);
  return num(r.recordset[0].id);
}

// Optimistic update of a DRAFT: succeeds only if the revision still matches and the plan is still a draft.
async function updateDraft(db, id, revision, v) {
  const req = bindPlacement(db.pool.request(), db.sql, v).input('id', db.sql.BigInt, id).input('rev', db.sql.BigInt, revision);
  const r = await req.query(`UPDATE dbo.berth_plans SET berth_id = @berthId, position_start_m = @ps, position_end_m = @pe, planned_start = @from, planned_end = @to,
      required_cranes = @cranes, buffer_m = @buffer, policy_version = @policy, constraint_check_json = @check, override_reason = @ovReason,
      override_by_user_id = @ovBy, override_at = @ovAt, override_rules = @ovRules, revision = revision + 1
    WHERE id = @id AND revision = @rev AND plan_status = 'DRAFT'`);
  return r.rowsAffected[0] === 1;
}

async function markSubmitted(db, id, revision, v, userId) {
  const req = bindPlacement(db.pool.request(), db.sql, v).input('id', db.sql.BigInt, id).input('rev', db.sql.BigInt, revision).input('u', db.sql.BigInt, userId);
  const r = await req.query(`UPDATE dbo.berth_plans SET plan_status = 'PENDING_APPROVAL', submitted_by_user_id = @u, submitted_at = SYSUTCDATETIME(),
      berth_id = @berthId, position_start_m = @ps, position_end_m = @pe, planned_start = @from, planned_end = @to, required_cranes = @cranes, buffer_m = @buffer,
      policy_version = @policy, constraint_check_json = @check, override_reason = @ovReason, override_by_user_id = @ovBy, override_at = @ovAt, override_rules = @ovRules,
      revision = revision + 1
    WHERE id = @id AND revision = @rev AND plan_status = 'DRAFT'`);
  return r.rowsAffected[0] === 1;
}

// Approval (UC-030): only a pending plan with the revision the approver saw can be approved. The check result stored is the one made now.
async function markApproved(db, id, revision, check, userId) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).input('rev', db.sql.BigInt, revision).input('u', db.sql.BigInt, userId)
    .input('check', db.sql.NVarChar(db.sql.MAX), JSON.stringify(check))
    .query(`UPDATE dbo.berth_plans SET plan_status = 'APPROVED', approved_by_user_id = @u, approved_at = SYSUTCDATETIME(), constraint_check_json = @check, revision = revision + 1
            WHERE id = @id AND revision = @rev AND plan_status = 'PENDING_APPROVAL'`);
  return r.rowsAffected[0] === 1;
}

// The voyage of an approved plan: WAITING_BERTH -> BERTH_ASSIGNED and no queue position. Returns the position it had.
async function assignVoyage(db, voyageId) {
  const r = await db.pool.request().input('id', db.sql.Int, voyageId)
    .query(`UPDATE dbo.voyages SET status = 'BERTH_ASSIGNED', queue_position = NULL, revision = revision + 1, updated_at = SYSUTCDATETIME()
            OUTPUT deleted.queue_position AS old_position WHERE id = @id AND status = 'WAITING_BERTH'`);
  return r.recordset[0] ? Number(r.recordset[0].old_position) : null;
}

// Rejection (UC-031): only a pending plan with the revision the decider saw. The reason is required by CK_bp_reject_reason.
async function markRejected(db, id, revision, reason) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).input('rev', db.sql.BigInt, revision).input('r', db.sql.NVarChar(500), reason)
    .query("UPDATE dbo.berth_plans SET plan_status = 'REJECTED', rejection_reason = @r, revision = revision + 1 WHERE id = @id AND revision = @rev AND plan_status = 'PENDING_APPROVAL'");
  return r.rowsAffected[0] === 1;
}

async function insertHistory(db, { planId, from, to, reason, actor }) {
  await db.pool.request().input('p', db.sql.BigInt, planId).input('f', db.sql.VarChar(20), from ?? null).input('t', db.sql.VarChar(20), to)
    .input('r', db.sql.NVarChar(500), reason ?? null).input('a', db.sql.NVarChar(100), actor)
    .query('INSERT INTO dbo.berth_plan_status_history (plan_id, from_status, to_status, reason, actor) VALUES (@p, @f, @t, @r, @a)');
}

async function history(db, planId) {
  const r = await db.pool.request().input('p', db.sql.BigInt, planId)
    .query('SELECT from_status, to_status, reason, actor, changed_at FROM dbo.berth_plan_status_history WHERE plan_id = @p ORDER BY id');
  return r.recordset;
}

async function list(db, { status, voyageId, offset, size }) {
  const where = [];
  const bind = (req) => { if (status) req.input('st', db.sql.VarChar(20), status); if (voyageId) req.input('v', db.sql.Int, voyageId); return req; };
  if (status) where.push('bp.plan_status = @st');
  if (voyageId) where.push('bp.voyage_id = @v');
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = await bind(db.pool.request()).query(`SELECT COUNT(*) AS n ${FROM(false)} ${clause}`);
  const rows = await bind(db.pool.request()).input('offset', db.sql.Int, offset).input('size', db.sql.Int, size)
    .query(`${SELECT} ${FROM(false)} ${clause} ORDER BY bp.id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  return { items: rows.recordset.map(shape), total: total.recordset[0].n };
}

// The approved plan of a voyage (at most one open plan per voyage: UX_bp_open_plan_per_voyage), locked.
async function approvedForVoyage(db, voyageId) {
  const r = await db.pool.request().input('v', db.sql.Int, voyageId).query(
    "SELECT id, berth_id, position_start_m, position_end_m, planned_start, planned_end, revision FROM dbo.berth_plans WITH (UPDLOCK, HOLDLOCK) WHERE voyage_id = @v AND plan_status = 'APPROVED'");
  return r.recordset[0] ?? null;
}

// Another vessel already berthed on the same stretch of the berth (positions overlap).
async function berthedOverlapping(db, berthId, voyageId, startM, endM) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).input('v', db.sql.Int, voyageId)
    .input('s', db.sql.Decimal(10, 2), startM).input('e', db.sql.Decimal(10, 2), endM).query(
      `SELECT TOP 1 v.voyage_code FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id
       WHERE bp.berth_id = @b AND bp.plan_status = 'APPROVED' AND v.status = 'BERTHED' AND v.id <> @v
         AND bp.position_start_m < @e AND COALESCE(bp.position_end_m, bp.position_start_m + 1) > @s`);
  return r.recordset[0] ?? null;
}

// Departure ends the plan: APPROVED -> COMPLETED (the plan row is kept as history).
async function markCompleted(db, id, revision) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).input('rev', db.sql.BigInt, revision)
    .query("UPDATE dbo.berth_plans SET plan_status = 'COMPLETED', revision = revision + 1 WHERE id = @id AND revision = @rev AND plan_status = 'APPROVED'");
  return r.rowsAffected[0] === 1;
}

module.exports = { approvedForVoyage, berthedOverlapping, markCompleted, markRejected, markApproved, assignVoyage, findById, lockVoyage, openPlansForVoyage, insertDraft, updateDraft, markSubmitted, insertHistory, history, list };
