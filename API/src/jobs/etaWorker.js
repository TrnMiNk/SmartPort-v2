'use strict';

// The ETA prediction worker (UC-015 step 3 and UC-016, asynchronous V2 design). The validation request queues a valid notice on its declared ETA and stores a PENDING
// prediction row; this worker claims pending rows, asks the provider (at most 10 s), stores the answer and, when a valid forecast arrives, moves the voyage to
// the place the queue rules give its new effective ETA.
//
// Reliability (the supported configuration):
//  - The job is a database row, so a pending request survives a restart. A claim is a lease (token + expiry on the database clock): a worker that dies leaves the
//    row pending and another claim takes it after the lease; a result that arrives from an expired claim is recognised by its token and ignored (stale).
//  - Claiming uses UPDLOCK + READPAST, so several workers or processes never run the same job at the same time. Duplicate results change nothing.
//  - A job claimed more than `maxAttempts` times without finishing is closed as UNAVAILABLE / ABANDONED. A provider failure, timeout or malformed answer is
//    UNAVAILABLE with the reason; no forecast is ever invented.
//  - Limit: the refresh hint to open screens is in-process (an API process only tells its own clients); other processes' clients refresh on their timers.
//
// Queue effect, under the queue lock (global lock order: queue state, then the voyage row, as in validation and UC-020):
//  - the voyage must still be WAITING_BERTH; a voyage that left the queue (plan approved, berthed, departed) is never touched (NOT_APPLIED_LEFT_QUEUE);
//  - the prediction must still be the voyage's latest (NOT_APPLIED_SUPERSEDED otherwise);
//  - a voyage that a person moved by hand is left where the person put it (KEPT_MANUAL_POSITION);
//  - otherwise the voyage takes the position the order rules of UC-020 give its new effective ETA (priority first, then ETA, then entry time): the others keep
//    their relative order, positions stay 1..n, and the move is recorded in the queue history (actor "system:eta") and in the audit log.
// Berth plans are not read or changed here: a voyage with an approved plan is no longer in the queue, so it is never reached.

const etaRepo = require('../repositories/etaJobsRepository');
const validation = require('../repositories/validationRepository');
const queue = require('../repositories/queueRepository');
const audit = require('../repositories/auditRepository');
const { insertionIndex } = require('../policy/queueOrder');
const { withTransaction } = require('../db/transaction');
const events = require('../realtime/m2Events');

const MAX_TIMEOUT_MS = 10000;   // NFR-PER-06 / UC-016 2a: the provider is never waited for longer than 10 s
const defaultLog = (line) => process.stderr.write(JSON.stringify(line) + '\n');

function createEtaWorker({ db, etaAdapter, intervalMs = 1000, concurrency = 4, maxAttempts = 3, leaseExtraMs = 15000, leaseMs = null, log = defaultLog } = {}) {
  const inflight = new Set();
  let timer = null; let pumping = false; let again = false; let stopped = false;

  async function timeoutMs() {
    const configured = Number(await validation.parameter(db, 'AI_TIMEOUT_MS')) || MAX_TIMEOUT_MS;
    return Math.min(configured, MAX_TIMEOUT_MS);
  }

  // Applies a finished answer. Returns { stored, effect } ; stored is false for a stale or duplicate result.
  async function finish(job, ai) {
    const declared = new Date(job.declared_eta);
    const available = ai.status === 'AVAILABLE';
    const result = await withTransaction(db, async (tx) => {
      await tx.pool.request().batch('SET LOCK_TIMEOUT 5000');
      try {
        await queue.lockState(tx);
        const stored = await etaRepo.complete(tx, { id: job.id, token: job.claim_token, status: ai.status,
          predictedEta: available ? ai.predictedEta : null, deviationH: available ? Math.round(((ai.predictedEta - declared) / 36e5) * 1000) / 1000 : null,
          confidence: available ? ai.confidence : null, modelVersion: available ? ai.modelVersion : null, failureReason: available ? null : String(ai.reason).slice(0, 200) });
        if (!stored) return { stored: false, effect: null };
        const voyage = await validation.loadVoyage(tx, job.voyage_id, { lock: true });
        let effect = 'UNCHANGED'; let before = null; let after = null;
        if (available) {
          if (!voyage || voyage.status !== 'WAITING_BERTH') effect = 'NOT_APPLIED_LEFT_QUEUE';
          else if (Number(voyage.latest_eta_prediction_id) !== job.id) effect = 'NOT_APPLIED_SUPERSEDED';
          else if (await etaRepo.movedByPerson(tx, job.voyage_id)) effect = 'KEPT_MANUAL_POSITION';
          else {
            const entries = await queue.entries(tx);            // the prediction is stored, so the effective ETA of this voyage is already the forecast
            const me = entries.find((e) => e.id === job.voyage_id);
            if (me) {
              const target = insertionIndex(entries.filter((e) => e.id !== me.id), me) + 1;
              before = me.queue_position; after = target;
              if (target !== me.queue_position) {
                await queue.move(tx, me.id, me.queue_position, target);
                await queue.insertChange(tx, { voyageId: me.id, from: me.queue_position, to: target, reason: 'Dự báo ETA được áp dụng (ETA hiệu lực thay đổi)', actor: 'system:eta' });
                await queue.bump(tx);
                effect = 'REORDERED';
              }
            }
          }
        }
        await etaRepo.setEffect(tx, job.id, effect);
        await audit.insert(tx, { actor: 'system:eta', action: 'VOYAGE_ETA_PREDICTION', entityType: 'VOYAGE', entityId: job.voyage_id, outcome: 'SUCCESS',
          reason: available ? effect : String(ai.reason).slice(0, 200),
          newJson: JSON.stringify({ prediction_id: job.id, status: ai.status, effect, attempts: job.attempts, declared_eta: declared.toISOString(),
            predicted_eta: available ? ai.predictedEta.toISOString() : null, position_before: before, position_after: after }) });
        if (effect === 'REORDERED' && voyage) {
          await validation.notifyRole(tx, 'DIEU_PHOI_VIEN', { title: `Chuyến ${voyage.voyage_code}: dự báo ETA đổi thứ tự hàng đợi`,
            body: `Vị trí hàng đợi ${before} → ${after} theo ETA dự báo ${ai.predictedEta.toISOString()}.`, entityType: 'VOYAGE', entityId: voyage.id });
        }
        return { stored: true, effect };
      } finally {
        try { await tx.pool.request().batch('SET LOCK_TIMEOUT -1'); } catch (e) { /* the transaction may already be aborted */ }
      }
    });
    if (result.stored) events.publish('ETA_UPDATED', { voyage_id: job.voyage_id });   // open screens re-read the queue and the voyage
    return result;
  }

  async function process(job) {
    let ai;
    if (job.attempts > maxAttempts) ai = { status: 'UNAVAILABLE', reason: 'ABANDONED' };
    else {
      try { ai = await etaAdapter.predict(JSON.parse(job.input_json), { timeoutMs: await timeoutMs() }); }
      catch (e) { ai = { status: 'UNAVAILABLE', reason: 'UNREACHABLE' }; }   // the adapter does not throw; this keeps a bug from leaving the job pending
    }
    try { return await finish(job, ai); }
    catch (e) { log({ event: 'eta_job_error', job_id: job.id, error: e && e.name, sql: e && e.number }); return { stored: false, effect: null, error: true }; }   // the lease expires and the job is retried
  }

  async function claim(n) {
    const lease = leaseMs ?? ((await timeoutMs()) + leaseExtraMs);   // leaseMs is for tests only
    return etaRepo.claim(db, n, lease);
  }

  // Test and operator entry: claim what is free now (up to the concurrency limit) and wait for those jobs.
  async function runOnce() {
    const jobs = await claim(concurrency);
    const results = await Promise.all(jobs.map((j) => process(j)));
    return results.length;
  }

  async function pump() {
    const free = concurrency - inflight.size;
    if (free <= 0 || stopped) return;
    for (const job of await claim(free)) {
      const p = process(job).finally(() => { inflight.delete(p); kick(); });
      inflight.add(p);
    }
  }

  function kick() {
    if (stopped) return;
    if (pumping) { again = true; return; }
    pumping = true;
    (async () => { try { do { again = false; await pump(); } while (again); } finally { pumping = false; } })().catch((e) => log({ event: 'eta_worker_error', error: e && e.name }));
  }

  return {
    runOnce, kick, process, claim,
    start() { stopped = false; timer = setInterval(kick, intervalMs); timer.unref(); kick(); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = null; await Promise.allSettled([...inflight]); },
    pendingCount: () => etaRepo.pendingCount(db),
  };
}

module.exports = { createEtaWorker, MAX_TIMEOUT_MS };
