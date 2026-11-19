'use strict';

// UC-015 automatic voyage validation. No human confirmation step. Flow (docs/policies/uc015-uc020-policy-v1.md):
//   1. read the voyage, the effective policy and the facts; evaluate the rules (pure, deterministic)
//   2. if VALID, ask the AI adapter for an ETA forecast OUTSIDE any database transaction (timeout from system parameters)
//   3. one transaction: lock the voyage and the queue, re-read and re-evaluate, then store the result, the status history,
//      the queue position, the run record and the audit row together
// Infrastructure failures (policy unavailable, queue busy, database errors) are errors; they are never turned into
// REJECTED or MISSING_DOCUMENTS, and the notice stays ANNOUNCED. A retry on a voyage that is already decided returns the
// stored result and changes nothing.

const crypto = require('node:crypto');
const repo = require('../repositories/validationRepository');
const queue = require('../repositories/queueRepository');
const voyagesRepo = require('../repositories/voyagesRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { evaluate, parsePolicy } = require('../policy/validationPolicy');
const { insertionIndex } = require('../policy/queueOrder');
const { AppError } = require('../errors');

const ELIGIBLE = ['ANNOUNCED', 'MISSING_DOCUMENTS'];
const { present: presentPrediction, AI_LABEL } = require('./etaPredictionService');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const policyUnavailable = (why) => new AppError(503, 'POLICY_UNAVAILABLE',
  'Chưa có chính sách kiểm tra hợp lệ đang hiệu lực. Thông báo được giữ ở trạng thái ANNOUNCED.', { rule: 'POLICY_UNAVAILABLE', why });

// Fail closed (UC015 BR-4): no policy, a corrupt policy or an unusable configuration never produces a VALID result.
async function loadPolicy(db) {
  const row = await repo.effectivePolicy(db);
  if (!row) throw policyUnavailable('NONE_EFFECTIVE');
  if (sha256(row.config_json) !== String(row.checksum).toLowerCase()) throw policyUnavailable('CHECKSUM_MISMATCH');
  try { parsePolicy(row.config_json); } catch (e) { throw policyUnavailable('INVALID_CONFIG'); }
  return { version: row.version, config: row.config_json, checksum: sha256(row.config_json) };
}

async function buildSnapshot(db, v, policy) {
  return {
    voyage: { id: v.id, voyage_code: v.voyage_code, status: v.status, declared_eta: v.declared_eta ? new Date(v.declared_eta).toISOString() : null,
      declared_teu: v.declared_teu, cargo_type: v.cargo_type, origin_port_id: v.origin_port_id, agent_id: v.agent_id, priority_class: v.priority_class },
    ship: { id: v.ship_id, imo_number: v.imo_number ? String(v.imo_number).trim() : null, is_active: Boolean(v.ship_active) },
    restrictions: await repo.restrictionsFor(db, v.ship_id),
    documents: await repo.documentsFor(db, v.ship_id, v.id),
    policy: { version: policy.version, checksum: policy.checksum },
  };
}


function summary(r) {
  return { state: 'COMPLETED', replayed: Boolean(r.replayed), outcome: r.outcome, reason_code: r.reasonCode ?? null,
    reason_codes: r.reasonCodes ?? [], reason: r.reason ?? null, policy_version: r.policyVersion ?? null, run_id: r.runId ?? null,
    queue_position: r.queuePosition ?? null, ai: r.ai ?? null, duration_ms: r.durationMs ?? null };
}

// The stored result of an earlier run (replay): the latest prediction of the voyage, in the same shape as a fresh result.
async function replayAi(db, v) {
  const rows = await repo.predictionsForVoyage(db, v.id);
  return rows.length ? presentPrediction(rows[rows.length - 1], rows.length) : null;
}

async function replaySummary(db, v) {
  const run = await repo.latestRun(db, v.id);
  return summary({ replayed: true, outcome: v.validation_result ?? (run && run.outcome) ?? null, reasonCode: run && run.reason_code,
    reason: run && run.reason, policyVersion: run && run.policy_version, runId: run && run.id,
    queuePosition: v.queue_position, ai: await replayAi(db, v) });
}

const queueBusy = () => new AppError(503, 'QUEUE_BUSY', 'Hàng đợi đang được cập nhật. Vui lòng thử lại.');

async function runForVoyage(db, { etaAdapter, etaWorker }, voyageId, { actor, trigger }) {
  const started = Date.now();
  const first = await repo.loadVoyage(db, voyageId);
  if (!first) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.');
  if (!ELIGIBLE.includes(first.status)) return replaySummary(db, first);

  const policy = await loadPolicy(db);
  const early = evaluate(policy.config, await buildSnapshot(db, first, policy));

  // Asynchronous ETA (V2): the provider is NOT called here. A valid notice is queued on its declared ETA at once. When a provider is configured a PENDING
  // prediction row is stored in the same transaction (a durable job for jobs/etaWorker.js); without a provider the answer is already known: UNAVAILABLE / NOT_CONFIGURED.
  const providerConfigured = Boolean(etaAdapter && etaAdapter.configured);
  void early;

  try {
    const outcome = await withTransaction(db, async (tx) => {
      await tx.pool.request().batch('SET LOCK_TIMEOUT 5000');
      try {
        // Global lock order: the queue state row first, then voyage rows. Taking them in the other order lets two
        // validations wait for each other (one holds the queue and needs another's voyage row, and the reverse).
        await queue.lockState(tx);
        const v = await repo.loadVoyage(tx, voyageId, { lock: true });
        if (!ELIGIBLE.includes(v.status)) return replaySummary(tx, v); // another request decided it first
        const snapshot = await buildSnapshot(tx, v, policy);
        const result = evaluate(policy.config, snapshot); // re-read and re-evaluate under the lock
        const now = new Date();
        let predictionId = null; let queuePosition = null; let aiOut = null;

        if (result.outcome === 'VALID') {
          const declared = new Date(v.declared_eta);
          const inputJson = JSON.stringify({ voyage_code: first.voyage_code, imo_number: String(first.imo_number).trim(), origin_port_code: first.port_code, declared_eta: declared.toISOString() });
          const stored = { voyageId: v.id, declaredEta: declared, status: providerConfigured ? 'PENDING' : 'UNAVAILABLE', predictedEta: null, deviationH: null, confidence: null, modelVersion: null,
            failureReason: providerConfigured ? null : 'NOT_CONFIGURED', inputHash: sha256(inputJson), inputJson, finished: !providerConfigured };
          predictionId = await repo.insertPrediction(tx, stored);
          const current = await queue.entries(tx);
          const effectiveEta = declared;                       // the declared ETA until a valid forecast arrives
          queuePosition = insertionIndex(current, { id: v.id, priority_class: v.priority_class, effective_eta: effectiveEta, queued_at: now }) + 1;
          await queue.shiftDown(tx, queuePosition);
          await repo.updateVoyage(tx, v.id, { status: 'WAITING_BERTH', validation_result: 'VALID', validation_reason: null, validated_at: now,
            validation_policy_version: policy.version, queue_position: queuePosition, queued_at: now, latest_eta_prediction_id: predictionId });
          await voyagesRepo.insertHistory(tx, { voyageId: v.id, fromStatus: v.status, toStatus: 'VALIDATED', actor });
          await voyagesRepo.insertHistory(tx, { voyageId: v.id, fromStatus: 'VALIDATED', toStatus: 'WAITING_BERTH', actor });
          await queue.bump(tx);
          aiOut = presentPrediction({ id: predictionId, ai_status: stored.status, declared_eta: declared, predicted_eta: null, eta_deviation_h: null,
            eta_confidence: null, model_version: null, failure_reason: stored.failureReason, input_hash: stored.inputHash, requested_at: now, completed_at: stored.finished ? now : null,
            queue_effect: stored.finished ? 'UNCHANGED' : null, attempts: 0 },
            (await repo.predictionsForVoyage(tx, v.id)).length);
        } else {
          await repo.updateVoyage(tx, v.id, { status: result.outcome, validation_result: result.outcome, validation_reason: result.reason,
            validated_at: now, validation_policy_version: policy.version });
          if (v.status !== result.outcome) {
            await voyagesRepo.insertHistory(tx, { voyageId: v.id, fromStatus: v.status, toStatus: result.outcome, reason: result.reasonCode, actor });
          }
        }

        const durationMs = Date.now() - started;
        const runId = await repo.insertRun(tx, { voyageId: v.id, policyVersion: policy.version, trigger, actor, outcome: result.outcome,
          reasonCode: result.reasonCode, reason: result.reason, snapshotJson: JSON.stringify(snapshot),
          rulesJson: JSON.stringify({ engine: result.engine, rules: result.rules }), aiStatus: aiOut ? aiOut.status : null,
          predictionId, queuePosition, durationMs });
        const out = summary({ outcome: result.outcome, reasonCode: result.reasonCode, reasonCodes: result.reasonCodes, reason: result.reason,
          policyVersion: policy.version, runId, queuePosition, ai: aiOut, durationMs });
        await audit.insert(tx, { actor, action: 'VOYAGE_VALIDATE', entityType: 'VOYAGE', entityId: v.id, outcome: 'SUCCESS',
          reason: result.reasonCode, newJson: JSON.stringify({ run_id: runId, policy_version: policy.version, outcome: result.outcome,
            reason_codes: result.reasonCodes, queue_position: queuePosition, ai_status: aiOut ? aiOut.status : null }) });
        await repo.notifyRole(tx, 'DIEU_PHOI_VIEN', { title: `Chuyến ${v.voyage_code}: ${result.outcome}`,
          body: result.outcome === 'VALID' ? `Đã vào hàng đợi chờ cập bến, vị trí ${queuePosition}.` : result.reason, entityType: 'VOYAGE', entityId: v.id });
        return out;
      } finally {
        try { await tx.pool.request().batch('SET LOCK_TIMEOUT -1'); } catch (e) { /* the transaction may already be aborted */ }
      }
    });
    if (outcome.ai && outcome.ai.status === 'PENDING' && etaWorker) etaWorker.kick();   // after the commit, without waiting
    return outcome;
  } catch (err) {
    if (err && /Lock request time out/i.test(err.message || '')) throw queueBusy();
    throw err;
  }
}

module.exports = { runForVoyage, loadPolicy, buildSnapshot, AI_LABEL };
