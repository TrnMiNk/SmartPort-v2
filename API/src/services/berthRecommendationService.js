'use strict';

// UC-027, local berth recommendation (policy UC027-OPT-V1). The engine is policy/berthOptimizer.js; this service gathers one consistent snapshot of the
// queue, berths, reservations and maintenance, runs the engine with UC-026 as the authority for every candidate, stores the request, the answer, each
// vessel's outcome and every proposal shown (FR-BRT-12), and records the coordinator's final choice. It never creates or approves a plan: acceptance is
// UC-028 (a draft made from a proposal is checked again by UC-026 when saved, submitted and approved).
// Concurrency: generating reads without locks; the answer is advisory and is valid for the snapshot it carries. Anything that changed meanwhile is
// caught by the UC-026 recheck when a plan is saved.

const crypto = require('node:crypto');
const rec = require('../repositories/recommendationsRepository');
const validation = require('../repositories/validationRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const placement = require('./placementService');
const { recommend, metrics, POLICY } = require('../policy/berthOptimizer');
const { validateGenerate, validateIgnore } = require('../validation/recommendationValidation');
const { MAX_VESSELS } = require('../ai/berthAdapter');
const { AppError, errors } = require('../errors');

const ENGINE = Object.freeze({ kind: 'LOCAL_OPTIMIZER', version: POLICY.version, is_machine_learning: false, predictive_ai: 'UNAVAILABLE',
  note: 'Thuật toán tối ưu cục bộ, tất định, dùng luật UC-026. Không phải mô hình học máy; dự báo AI chưa có.' });

// Canonical JSON (sorted keys) so the same snapshot always hashes the same.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

async function bufferMetres(db) {
  const raw = await validation.parameter(db, 'BERTH_SAFETY_BUFFER_M');
  const value = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new AppError(503, 'PARAMETER_UNAVAILABLE', 'Thiếu tham số khoảng đệm an toàn (BERTH_SAFETY_BUFFER_M).');
  return value;
}

// The origin of a request. Historical rows with EXTERNAL_PROVIDER are shown as EXTERNAL_AI. A local algorithm is never reported as an AI model.
const engineOf = (kind) => (kind === 'LOCAL_OPTIMIZER' ? ENGINE : { kind: 'EXTERNAL_AI', is_machine_learning: null, predictive_ai: 'PROVIDER', note: 'Dịch vụ AI ngoài đã được cấu hình.' });
// The plan source that records where a plan came from: LOCAL_OPTIMIZER(_ADJUSTED) for the local algorithm, AI(_ADJUSTED) only for an external AI provider.
const sourceFor = (engineKind, same) => (engineKind === 'LOCAL_OPTIMIZER' ? (same ? 'LOCAL_OPTIMIZER' : 'LOCAL_OPTIMIZER_ADJUSTED') : (same ? 'AI' : 'AI_ADJUSTED'));

const present = (inference, vessels, proposals, decisions) => {
  const byVoyage = new Map();
  for (const p of proposals) {
    const why = JSON.parse(p.explanation_json || '{}');
    byVoyage.set(p.voyage_id, [...(byVoyage.get(p.voyage_id) || []), { proposal_id: p.id, rank: p.rank_no, berth_id: p.berth_id, berth_code: p.berth_code, position_start_m: p.position_start_m, position_end_m: p.position_end_m,
      planned_start: new Date(p.planned_start).toISOString(), planned_end: new Date(p.planned_end).toISOString(), expected_wait_h: p.expected_wait_h, score: p.score, required_cranes: why.required_cranes ?? null,
      duration_h: why.duration_h ?? null, cost: why.cost ?? null, breakdown: why.breakdown ?? null, reasons: why.reasons || [], uc026: JSON.parse(p.constraint_check_json) }]);
  }
  return {
    id: inference.id, engine: engineOf(inference.engine_kind), policy_version: inference.model_version, status: inference.ai_status === 'AVAILABLE' ? 'RECOMMENDED' : 'NO_FEASIBLE_PLACEMENT',
    as_of: JSON.parse(inference.request_json).as_of, requested_by: inference.requested_by, requested_at: inference.requested_at, duration_ms: inference.duration_ms, snapshot_hash: inference.snapshot_hash,
    vessels: vessels.map((v) => ({ voyage_id: v.voyage_id, voyage_code: v.voyage_code, queue_position: v.queue_position, effective_eta: new Date(v.effective_eta).toISOString(), eta_source: v.eta_source, outcome: v.outcome,
      candidates_considered: v.candidates_considered, candidates_rejected_by_uc026: v.candidates_rejected, reasons: JSON.parse(v.reasons_json), proposals: byVoyage.get(v.voyage_id) || [],
      decision: decisions.filter((d) => d.voyage_id === v.voyage_id).map((d) => ({ decision: d.decision, plan_id: d.plan_id, proposal_id: d.proposal_id, reason: d.reason, decided_by: d.decided_by, decided_at: d.decided_at })) })),
    summary: { vessels: vessels.length, recommended: vessels.filter((v) => v.outcome === 'RECOMMENDED').length, unschedulable: vessels.filter((v) => v.outcome === 'UNSCHEDULABLE').length,
      proposals: proposals.length, rejected_by_uc026: vessels.reduce((s, v) => s + v.candidates_rejected, 0) },
  };
};

async function load(db, id) {
  const inference = await rec.findInference(db, id);
  if (!inference) throw errors.notFound();
  return present(inference, await rec.vesselsOf(db, id), await rec.proposalsOf(db, id), await rec.decisionsOf(db, id));
}

async function generate(db, principal, body) {
  const { errors: bad, voyageIds } = validateGenerate(body);
  if (bad.length) throw errors.validation(bad);   // more than 20 vessels is refused here, before any work (UC-027 exception)
  const started = Date.now();
  const asOf = new Date(Math.floor(started / 1000) * 1000);
  let vessels = await rec.queueFacts(db, voyageIds);
  if (voyageIds) {
    const missing = voyageIds.filter((id) => !vessels.some((v) => v.voyage_id === id));
    if (missing.length) throw errors.validation([{ field: 'voyage_ids', message: `Chuyến không có trong hàng đợi chờ cập bến: ${missing.join(', ')}.` }]);
  } else vessels = vessels.slice(0, MAX_VESSELS);
  if (!vessels.length) throw errors.businessRule('Hàng đợi chờ cập bến đang trống.', { rule: 'QUEUE_EMPTY' });
  const snapshot = { as_of: asOf.toISOString(), buffer_m: await bufferMetres(db), policy: POLICY, vessels, berths: await rec.activeBerths(db),
    busy: await rec.reservations(db, asOf), maintenance: await rec.maintenance(db, asOf) };
  const hash = crypto.createHash('sha256').update(canonical(snapshot)).digest('hex');
  // UC-026 is the authority: every candidate is checked against the stored reservations; only a PASS is shown.
  const verify = (v, c) => placement.evaluateForPlan(db, { voyage_id: v.voyage_id, berth_id: c.berth_id, position_start_m: c.position_start_m, position_end_m: c.position_end_m,
    planned_start: new Date(c.planned_start), planned_end: new Date(c.planned_end), required_cranes: c.required_cranes });
  const result = await recommend(snapshot, { verify });
  const durationMs = Date.now() - started;
  const anyPlaced = result.vessels.some((v) => v.outcome === 'RECOMMENDED');
  const id = await audited(db, principal, { action: 'BERTH_RECOMMEND', entityType: 'BERTH_RECOMMENDATION' }, () => withTransaction(db, async (tx) => {
    const inferenceId = await rec.insertInference(tx, { userId: principal.userId, modelVersion: POLICY.version, status: anyPlaced ? 'AVAILABLE' : 'UNAVAILABLE', failureReason: anyPlaced ? null : 'NO_FEASIBLE_PLACEMENT',
      requestJson: JSON.stringify(snapshot), responseJson: JSON.stringify(result), snapshotHash: hash, durationMs });
    for (const r of result.vessels) {
      const v = vessels.find((x) => x.voyage_id === r.voyage_id);
      await rec.insertVessel(tx, inferenceId, { ...r, queue_position: v.queue_position, effective_eta: v.effective_eta, eta_source: v.eta_source });
      for (const p of r.proposals) {
        await rec.insertProposal(tx, inferenceId, r.voyage_id, { ...p, check: p.check, explanation_json: { required_cranes: p.required_cranes, duration_h: p.duration_h, cost: p.cost, breakdown: p.breakdown, reasons: p.explanation } });
      }
    }
    const summary = metrics(result);
    await audit.insert(tx, { actor: principal.username, action: 'BERTH_RECOMMEND', entityType: 'BERTH_RECOMMENDATION', entityId: inferenceId, outcome: 'SUCCESS',
      reason: anyPlaced ? null : 'NO_FEASIBLE_PLACEMENT', newJson: JSON.stringify({ engine_kind: 'LOCAL_OPTIMIZER', policy_version: POLICY.version, snapshot_hash: hash, duration_ms: durationMs, vessels: summary.vessels, placed: summary.placed, unschedulable: summary.unschedulable }) });
    return inferenceId;
  }));
  return load(db, id);
}

async function get(db, id) { return load(db, id); }

async function ignore(db, principal, id, body) {
  const { errors: bad, voyageId, reason } = validateIgnore(body);
  if (bad.length) throw errors.validation(bad);
  const inference = await rec.findInference(db, id);
  if (!inference) throw errors.notFound();
  if (!(await rec.vesselsOf(db, id)).some((v) => v.voyage_id === voyageId)) throw errors.validation([{ field: 'voyage_id', message: 'Chuyến này không thuộc yêu cầu đề xuất.' }]);
  try {
    await audited(db, principal, { action: 'BERTH_RECOMMEND_IGNORE', entityType: 'BERTH_RECOMMENDATION', entityId: id }, () => withTransaction(db, async (tx) => {
      await rec.insertDecision(tx, { inferenceId: id, voyageId, decision: 'IGNORED', reason, userId: principal.userId });
      await audit.insert(tx, { actor: principal.username, action: 'BERTH_RECOMMEND_IGNORE', entityType: 'BERTH_RECOMMENDATION', entityId: id, outcome: 'SUCCESS', reason,
        newJson: JSON.stringify({ voyage_id: voyageId }) });
    }));
  } catch (err) {
    if (err && (err.number === 2601 || err.number === 2627)) throw errors.businessRule('Đề xuất cho chuyến này đã được ghi nhận là bỏ qua.', { rule: 'ALREADY_IGNORED' });
    throw err;
  }
  return load(db, id);
}

// ---- used by berthPlanService when a draft is made from, or edited after, a proposal
const sameAsProposal = (p, value) => {
  const why = JSON.parse(p.explanation_json || '{}');
  return p.berth_id === value.berth_id && Number(p.position_start_m) === Number(value.position_start_m) && Number(p.position_end_m) === Number(value.position_end_m)
    && new Date(p.planned_start).getTime() === new Date(value.planned_start).getTime() && new Date(p.planned_end).getTime() === new Date(value.planned_end).getTime()
    && (why.required_cranes ?? null) === (value.required_cranes ?? null);
};

async function linkForDraft(tx, proposalId, value) {
  const p = await rec.findProposal(tx, proposalId);
  if (!p) throw errors.validation([{ field: 'proposal_id', message: 'Đề xuất không tồn tại.' }]);
  if (p.voyage_id !== value.voyage_id) throw errors.validation([{ field: 'proposal_id', message: 'Đề xuất này không dành cho chuyến đã chọn.' }]);
  const same = sameAsProposal(p, value);
  return { proposal: p, source: sourceFor(p.engine_kind, same), decision: same ? 'ACCEPTED' : 'MODIFIED' };
}

async function recordDraftDecision(tx, principal, planId, link) {
  await rec.insertDecision(tx, { inferenceId: link.proposal.inference_id, voyageId: link.proposal.voyage_id, proposalId: link.proposal.id, planId, decision: link.decision, userId: principal.userId });
}

async function reclassifyAfterEdit(tx, plan, value) {
  if (!plan.proposal_id) return;
  const p = await rec.findProposal(tx, plan.proposal_id);
  const same = sameAsProposal(p, value);
  const source = sourceFor(p.engine_kind, same);
  if (source !== plan.source) await rec.reclassify(tx, plan.id, source, same ? 'ACCEPTED' : 'MODIFIED');
}

module.exports = { generate, get, ignore, linkForDraft, recordDraftDecision, reclassifyAfterEdit, ENGINE, canonical };
