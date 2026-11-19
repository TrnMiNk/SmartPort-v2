'use strict';

// Data access for the durable ETA prediction jobs (migration 0008). A PENDING row of dbo.voyage_eta_predictions IS the job. SQL only; the decisions are in
// jobs/etaWorker.js. Time is the database clock throughout, so two processes never disagree about when a lease ended.

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Claims up to `n` pending jobs whose lease is free or expired, in one statement. UPDLOCK + READPAST make concurrent workers skip rows another worker is
// claiming, so a row is claimed by exactly one of them. Each claim gets its own token and a lease; `attempts` counts the claims.
async function claim(db, n, leaseMs) {
  const r = await db.pool.request().input('n', db.sql.Int, n).input('lease', db.sql.Int, leaseMs).query(
    `WITH c AS (SELECT TOP (@n) * FROM dbo.voyage_eta_predictions WITH (UPDLOCK, READPAST, ROWLOCK)
                WHERE ai_status = 'PENDING' AND (claimed_until IS NULL OR claimed_until < SYSUTCDATETIME()) ORDER BY id)
     UPDATE c SET claim_token = NEWID(), claimed_until = DATEADD(MILLISECOND, @lease, SYSUTCDATETIME()), attempts = attempts + 1
     OUTPUT inserted.id, inserted.voyage_id, inserted.declared_eta, inserted.input_json, inserted.claim_token, inserted.attempts`);
  return r.recordset.map((x) => ({ id: num(x.id), voyage_id: x.voyage_id, declared_eta: x.declared_eta, input_json: x.input_json, claim_token: String(x.claim_token), attempts: x.attempts }));
}

// Stores the answer only if the claim is still the current one and the row is still pending. Zero rows means a stale or duplicate result: it is ignored.
async function complete(db, p) {
  const r = await db.pool.request().input('id', db.sql.BigInt, p.id).input('token', db.sql.UniqueIdentifier, p.token)
    .input('status', db.sql.VarChar(20), p.status).input('predicted', db.sql.DateTime2(3), p.predictedEta ?? null).input('dev', db.sql.Decimal(9, 3), p.deviationH ?? null)
    .input('conf', db.sql.Decimal(5, 4), p.confidence ?? null).input('model', db.sql.NVarChar(40), p.modelVersion ?? null).input('fail', db.sql.NVarChar(200), p.failureReason ?? null)
    .query(`UPDATE dbo.voyage_eta_predictions SET ai_status = @status, predicted_eta = @predicted, eta_deviation_h = @dev, eta_confidence = @conf, model_version = @model,
              failure_reason = @fail, completed_at = SYSUTCDATETIME(), claim_token = NULL, claimed_until = NULL
            WHERE id = @id AND claim_token = @token AND ai_status = 'PENDING'`);
  return r.rowsAffected[0] === 1;
}

async function setEffect(db, id, effect) {
  await db.pool.request().input('id', db.sql.BigInt, id).input('e', db.sql.VarChar(30), effect).query('UPDATE dbo.voyage_eta_predictions SET queue_effect = @e WHERE id = @id');
}

// True when a person moved this voyage in the queue (UC-020). The system's own moves are recorded with an actor that starts with "system:".
async function movedByPerson(db, voyageId) {
  const r = await db.pool.request().input('v', db.sql.Int, voyageId).query(
    "SELECT TOP 1 1 AS x FROM dbo.voyage_queue_changes WHERE voyage_id = @v AND change_type = 'MOVE' AND actor NOT LIKE N'system:%'");
  return r.recordset.length > 0;
}

async function pendingCount(db) {
  const r = await db.pool.request().query("SELECT COUNT(*) AS n FROM dbo.voyage_eta_predictions WHERE ai_status = 'PENDING'");
  return r.recordset[0].n;
}

module.exports = { claim, complete, setEffect, movedByPerson, pendingCount };
