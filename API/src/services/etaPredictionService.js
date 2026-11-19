'use strict';

// UC-016 display and history of ETA predictions. A prediction is an append-only row of dbo.voyage_eta_predictions written by UC-015 step 3; nothing here
// predicts anything. When no real provider answered, the row says UNAVAILABLE with the reason, and this module shows that label and no invented value.
//
// Terms (docs/architecture/eta-semantics.md): declared ETA = what the agent declared; predicted ETA = what a provider returned for the declared voyage;
// deviation = predicted minus declared, in hours (UC-016 step 3). None of them is the actual arrival at port, and the berthing time (ATA, UC-022) is not either.
// Confidence is shown exactly as the provider reported it, with the statement that the SRS does not define its meaning.

const repo = require('../repositories/validationRepository');
const voyages = require('../repositories/voyagesRepository');
const { errors } = require('../errors');
const { can } = require('../security/permissions');

const AI_LABEL = 'chưa có dự báo AI';
const PENDING_LABEL = 'đang chờ dự báo AI';
const CONFIDENCE_MEANING = 'Giá trị từ 0 đến 1 do nhà cung cấp dự báo báo cáo. Đặc tả chưa định nghĩa ý nghĩa của nó nên không được hiểu là xác suất đã hiệu chuẩn.';
const iso = (v) => (v ? new Date(v).toISOString() : null);

// `sequence` is the order of the prediction among those of its voyage (1 is the first); null when it is not known (a result built before the history is read).
function present(row, sequence = null) {
  const available = row.ai_status === 'AVAILABLE';
  const pending = row.ai_status === 'PENDING';
  return {
    id: row.id === undefined || row.id === null ? null : Number(row.id), sequence,
    requested_at: iso(row.requested_at), declared_eta: iso(row.declared_eta),
    status: row.ai_status, label: available ? null : pending ? PENDING_LABEL : AI_LABEL,
    predicted_eta: available ? iso(row.predicted_eta) : null,
    deviation_h: available && row.eta_deviation_h !== null && row.eta_deviation_h !== undefined ? Number(row.eta_deviation_h) : null,
    confidence: available && row.eta_confidence !== null && row.eta_confidence !== undefined ? Number(row.eta_confidence) : null,
    confidence_meaning: available ? CONFIDENCE_MEANING : null,
    model_version: available ? row.model_version : null,
    reason: available || pending ? null : row.failure_reason,
    source: available ? { kind: 'EXTERNAL_AI', model_version: row.model_version } : pending ? { kind: 'PENDING' } : { kind: 'NONE', reason: row.failure_reason },
    completed_at: iso(row.completed_at), attempts: row.attempts === undefined || row.attempts === null ? null : Number(row.attempts), queue_effect: row.queue_effect ?? null,
    input_hash: row.input_hash ?? null,
  };
}

const readScope = (principal) => (can(principal.roles, 'M1_VESSELS', 'view') ? null : principal.agentIds);

async function ensureReadable(db, principal, voyageId) {
  const voyage = await voyages.findById(db, voyageId);
  const scope = readScope(principal);
  if (!voyage || (scope && !scope.includes(voyage.agent_id))) throw errors.notFound();
  return voyage;
}

// UC-016 5a: all predictions of the voyage, newest first, each with its order number.
async function history(db, principal, voyageId) {
  await ensureReadable(db, principal, voyageId);
  const rows = await repo.predictionsForVoyage(db, voyageId);
  const items = rows.map((r, i) => present(r, i + 1)).reverse();
  return { voyage_id: voyageId, total: items.length, items };
}

async function latestFor(db, voyageId) {
  const rows = await repo.predictionsForVoyage(db, voyageId);
  return rows.length ? present(rows[rows.length - 1], rows.length) : null;
}

module.exports = { present, history, latestFor, AI_LABEL, PENDING_LABEL, CONFIDENCE_MEANING };
