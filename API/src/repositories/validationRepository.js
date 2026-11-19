'use strict';

// Data access for UC-015: policy, the facts a decision is based on, runs, ETA predictions and voyage state. SQL only.

const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

async function effectivePolicy(db) {
  const r = await db.pool.request().query(`SELECT TOP 1 version, config_json, checksum FROM dbo.validation_policies
    WHERE effective_from <= SYSUTCDATETIME() AND (effective_until IS NULL OR effective_until > SYSUTCDATETIME())
    ORDER BY effective_from DESC, version DESC`);
  return r.recordset[0] ?? null;
}

async function parameter(db, key) {
  const r = await db.pool.request().input('k', db.sql.VarChar(100), key)
    .query('SELECT param_value FROM dbo.system_parameters WHERE param_key = @k');
  return r.recordset[0] ? r.recordset[0].param_value : null;
}

async function loadVoyage(db, id, { lock = false } = {}) {
  const r = await db.pool.request().input('id', db.sql.Int, id).query(`
    SELECT v.id, v.ship_id, v.voyage_code, v.status, v.agent_id, v.origin_port_id, v.declared_eta, v.declared_teu,
      v.cargo_type, v.priority_class, v.revision, v.queue_position, v.validation_result, v.latest_eta_prediction_id,
      s.imo_number, s.is_active AS ship_active, p.port_code
    FROM dbo.voyages v ${lock ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
    JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.ports p ON p.id = v.origin_port_id WHERE v.id = @id`);
  const row = r.recordset[0];
  return row ? { ...row, revision: Number(row.revision) } : null;
}

async function documentsFor(db, shipId, voyageId) {
  const r = await db.pool.request().input('s', db.sql.Int, shipId).input('v', db.sql.Int, voyageId).query(`
    SELECT id, document_type_code, voyage_id, review_status, valid_from, valid_until FROM dbo.ship_documents
    WHERE ship_id = @s AND (voyage_id IS NULL OR voyage_id = @v) ORDER BY id`);
  return r.recordset.map((d) => ({ ...d, valid_from: day(d.valid_from), valid_until: day(d.valid_until) }));
}

async function restrictionsFor(db, shipId) {
  const r = await db.pool.request().input('s', db.sql.Int, shipId).query(`
    SELECT restriction_type, reason, valid_from, valid_until FROM dbo.vessel_restrictions WHERE ship_id = @s AND is_active = 1 ORDER BY id`);
  return r.recordset.map((x) => ({ ...x, valid_from: day(x.valid_from), valid_until: day(x.valid_until) }));
}

async function insertPrediction(db, p) {
  const r = await db.pool.request()
    .input('voyageId', db.sql.Int, p.voyageId).input('declared', db.sql.DateTime2(3), p.declaredEta)
    .input('status', db.sql.VarChar(20), p.status).input('predicted', db.sql.DateTime2(3), p.predictedEta ?? null)
    .input('dev', db.sql.Decimal(9, 3), p.deviationH ?? null).input('conf', db.sql.Decimal(5, 4), p.confidence ?? null)
    .input('model', db.sql.NVarChar(40), p.modelVersion ?? null).input('fail', db.sql.NVarChar(200), p.failureReason ?? null)
    .input('hash', db.sql.Char(64), p.inputHash).input('json', db.sql.NVarChar(db.sql.MAX), p.inputJson).input('finished', db.sql.Bit, p.finished ? 1 : 0)
    .query(`INSERT INTO dbo.voyage_eta_predictions (voyage_id, declared_eta, ai_status, predicted_eta, eta_deviation_h,
              eta_confidence, model_version, failure_reason, input_hash, input_json, completed_at, queue_effect)
            OUTPUT inserted.id VALUES (@voyageId, @declared, @status, @predicted, @dev, @conf, @model, @fail, @hash, @json,
              CASE WHEN @finished = 1 THEN SYSUTCDATETIME() END, CASE WHEN @finished = 1 THEN 'UNCHANGED' END)`);
  return r.recordset[0].id;
}

async function insertRun(db, run) {
  const r = await db.pool.request()
    .input('voyageId', db.sql.Int, run.voyageId).input('policy', db.sql.VarChar(40), run.policyVersion)
    .input('trigger', db.sql.VarChar(20), run.trigger).input('actor', db.sql.NVarChar(100), run.actor)
    .input('outcome', db.sql.VarChar(20), run.outcome).input('code', db.sql.VarChar(60), run.reasonCode)
    .input('reason', db.sql.NVarChar(1000), run.reason).input('snapshot', db.sql.NVarChar(db.sql.MAX), run.snapshotJson)
    .input('rules', db.sql.NVarChar(db.sql.MAX), run.rulesJson).input('ai', db.sql.VarChar(20), run.aiStatus)
    .input('pred', db.sql.BigInt, run.predictionId).input('pos', db.sql.Int, run.queuePosition).input('ms', db.sql.Int, run.durationMs)
    .query(`INSERT INTO dbo.voyage_validation_runs (voyage_id, policy_version, trigger_source, actor, outcome, reason_code,
              reason, input_snapshot, rule_results, ai_status, prediction_id, queue_position, duration_ms)
            OUTPUT inserted.id VALUES (@voyageId, @policy, @trigger, @actor, @outcome, @code, @reason, @snapshot, @rules,
              @ai, @pred, @pos, @ms)`);
  return Number(r.recordset[0].id);
}

const VOYAGE_COLUMNS = {
  status: (s) => s.VarChar(20), validation_result: (s) => s.VarChar(20), validation_reason: (s) => s.NVarChar(1000),
  validated_at: (s) => s.DateTime2(3), validation_policy_version: (s) => s.VarChar(40), queue_position: (s) => s.Int,
  queued_at: (s) => s.DateTime2(3), latest_eta_prediction_id: (s) => s.BigInt,
};

async function updateVoyage(db, id, fields) {
  const req = db.pool.request().input('id', db.sql.Int, id);
  const sets = Object.entries(fields).map(([column, value]) => {
    if (!VOYAGE_COLUMNS[column]) throw new Error(`column not updatable: ${column}`); // allow-list
    req.input(column, VOYAGE_COLUMNS[column](db.sql), value);
    return `${column} = @${column}`;
  });
  await req.query(`UPDATE dbo.voyages SET ${sets.join(', ')}, revision = revision + 1, updated_at = SYSUTCDATETIME() WHERE id = @id`);
}

async function latestRun(db, voyageId) {
  const r = await db.pool.request().input('id', db.sql.Int, voyageId).query(`
    SELECT TOP 1 id, policy_version, trigger_source, actor, outcome, reason_code, reason, rule_results, ai_status,
      queue_position, duration_ms, created_at FROM dbo.voyage_validation_runs WHERE voyage_id = @id ORDER BY id DESC`);
  const row = r.recordset[0];
  return row ? { ...row, id: Number(row.id) } : null;
}

// All predictions of a voyage, oldest first (append-only). UC-016 history and the latest result.
async function predictionsForVoyage(db, voyageId) {
  const r = await db.pool.request().input('id', db.sql.Int, voyageId).query(
    `SELECT id, voyage_id, declared_eta, ai_status, predicted_eta, eta_deviation_h, eta_confidence, model_version, failure_reason, input_hash, requested_at,
            completed_at, attempts, queue_effect
     FROM dbo.voyage_eta_predictions WHERE voyage_id = @id ORDER BY id`);
  return r.recordset;
}

async function notifyRole(db, roleCode, { title, body, entityType, entityId }) {
  await db.pool.request().input('role', db.sql.VarChar(40), roleCode).input('title', db.sql.NVarChar(200), title)
    .input('body', db.sql.NVarChar(1000), body).input('type', db.sql.VarChar(40), entityType).input('eid', db.sql.BigInt, entityId)
    .query(`INSERT INTO dbo.notifications (recipient_role_code, title, body, entity_type, entity_id) VALUES (@role, @title, @body, @type, @eid)`);
}

module.exports = { effectivePolicy, parameter, loadVoyage, documentsFor, restrictionsFor, insertPrediction, predictionsForVoyage, insertRun, updateVoyage, latestRun, notifyRole };
