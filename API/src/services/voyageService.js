'use strict';

// Business rules for arrival notices (UC-013) and the hand-off to automatic validation (UC-015).
// Saving a notice and validating it are two steps with separate transactions: the notice is kept (ANNOUNCED) even if
// validation fails for an infrastructure reason, and validation can be retried safely (UC015 P1 behavior).

const voyages = require('../repositories/voyagesRepository');
const ships = require('../repositories/shipsRepository');
const catalog = require('../repositories/catalogRepository');
const drafts = require('../repositories/draftsRepository');
const validationRepo = require('../repositories/validationRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const { runForVoyage, AI_LABEL } = require('./validationService');
const etaPredictions = require('./etaPredictionService');
const { errors } = require('../errors');
const { can } = require('../security/permissions');
const { validateNotice } = require('../validation/voyageValidation');
const { parsePaging, parseId } = require('../validation/common');
const events = require('../realtime/m2Events');

const STATUSES = ['ANNOUNCED', 'MISSING_DOCUMENTS', 'REJECTED', 'VALIDATED', 'WAITING_BERTH', 'BERTH_ASSIGNED', 'BERTHED', 'DEPARTED'];

// null = all voyages; an array = only voyages of these agents (external shipping agents).
const readScope = (principal) => (can(principal.roles, 'M1_VESSELS', 'view') ? null : principal.agentIds);

// An agent-only user (no coordinator rights) is restricted to its own agents and cannot set the priority class.
const isRestricted = (principal) => !can(principal.roles, 'M1_VESSELS', 'edit');

// Thrown inside the transaction when the draft was already submitted; the caller answers with the existing voyage.
class AlreadySubmitted extends Error {
  constructor(voyageId) { super('draft already submitted'); this.voyageId = voyageId; }
}

async function createNotice(db, principal, body, { draft = null } = {}) {
  const { errors: bad, value } = validateNotice(body);
  const restricted = isRestricted(principal);
  if (restricted && value.priority_class && value.priority_class !== 'STANDARD') {
    bad.push({ field: 'priority_class', message: 'Chỉ điều phối viên được đặt mức ưu tiên khác STANDARD.' });
  }
  if (bad.length) throw errors.validation(bad);
  value.priority_class = value.priority_class || 'STANDARD';

  return audited(db, principal, { action: 'VOYAGE_CREATE', entityType: 'VOYAGE' }, () => withTransaction(db, async (tx) => {
    if (draft) { // the draft row is locked, so two submissions of one draft cannot both create a notice
      const d = await drafts.findById(tx, draft.id, { lock: true });
      if (!d || String(d.owner_user_id) !== String(principal.userId)) throw errors.notFound();
      if (d.status === 'SUBMITTED') throw new AlreadySubmitted(d.submitted_voyage_id);
      if (d.status !== 'OPEN') throw errors.businessRule('Bản nháp đã bị hủy.', { rule: 'DRAFT_DISCARDED' });
    }
    // Lock the vessel row so concurrent notices for the same vessel are serialized (duplicate check below is then safe).
    const ship = await ships.findById(tx, value.ship_id, { lock: true });
    if (!ship) {
      throw errors.businessRule('Tàu chưa có hồ sơ. Vui lòng tạo hồ sơ tàu trước khi gửi thông báo.', { rule: 'SHIP_NOT_FOUND', field: 'ship_id' });
    }
    if (!ship.is_active) {
      throw errors.businessRule('Tàu đã bị vô hiệu hóa, không thể tạo thông báo tàu đến.', { rule: 'SHIP_INACTIVE', field: 'ship_id' });
    }
    if (restricted) {
      const own = principal.agentIds;
      if (!own.includes(value.agent_id) || !own.includes(ship.operator_agent_id)) throw errors.forbidden();
    }
    const refs = [];
    if (!(await catalog.activeAgentExists(tx, value.agent_id))) refs.push({ field: 'agent_id', message: 'Đại lý không tồn tại hoặc đã bị vô hiệu hóa.' });
    if (!(await catalog.activePortExists(tx, value.origin_port_id))) refs.push({ field: 'origin_port_id', message: 'Cảng đi không tồn tại hoặc đã bị vô hiệu hóa.' });
    if (refs.length) throw errors.validation(refs);

    const existing = await voyages.findByShipAndCode(tx, value.ship_id, value.voyage_code);
    if (existing) {
      throw errors.conflict('Thông báo cho tàu và chuyến này đã tồn tại.', { rule: 'DUPLICATE_NOTICE', existing_voyage_id: existing.id });
    }

    const id = await voyages.insert(tx, value, principal.userId);
    await voyages.insertHistory(tx, { voyageId: id, fromStatus: null, toStatus: 'ANNOUNCED', actor: principal.username });
    if (draft) await drafts.markSubmitted(tx, draft.id, id);
    const voyage = await voyages.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'VOYAGE_CREATE', entityType: 'VOYAGE', entityId: id,
      outcome: 'SUCCESS', newJson: JSON.stringify(voyage) });
    return voyage;
  }));
}

// Runs UC-015 for a saved notice and returns the notice with the outcome. An infrastructure failure does not undo
// the notice: it is returned as ANNOUNCED with `validation.state = NOT_RUN` and the error code, and can be retried.
async function withValidation(db, deps, principal, voyageId, trigger) {
  let validation;
  try {
    validation = await runForVoyage(db, deps, voyageId, { actor: principal.username, trigger });
  } catch (err) {
    validation = { state: 'NOT_RUN', code: err.status ? err.code : 'INTERNAL_ERROR',
      message: err.status ? err.message : 'Đã xảy ra lỗi khi kiểm tra tự động. Có thể thử lại.' };
    if (!err.status) process.stderr.write(`validation error: ${err.name} ${err.code || ''}\n`);
  }
  // The notice exists and its outcome changed (queued, missing documents or rejected): open coordinator screens re-read the notices and the queue.
  // The hint carries only the type and the voyage id; the data itself is read through the authorized API.
  events.publish('VOYAGE_VALIDATED', { voyage_id: voyageId });
  return { ...(await voyages.findById(db, voyageId)), validation };
}

// Creates the notice, then validates it automatically. `created` is false when a draft had already been submitted.
async function submitNotice(db, deps, principal, body, opts = {}) {
  try {
    const voyage = await createNotice(db, principal, body, opts);
    return { created: true, voyage: await withValidation(db, deps, principal, voyage.id, 'SUBMIT') };
  } catch (err) {
    if (err instanceof AlreadySubmitted) return { created: false, voyage: await withValidation(db, deps, principal, err.voyageId, 'SUBMIT') };
    throw err;
  }
}

// Safe retry of the automatic validation for a notice that is ANNOUNCED or MISSING_DOCUMENTS (for example after the
// agent supplied the missing documents). Any other status returns the stored result without changing anything.
async function revalidate(db, deps, principal, id) {
  const voyage = await voyages.findById(db, id);
  const scope = readScope(principal);
  if (!voyage || (scope && !scope.includes(voyage.agent_id))) throw errors.notFound();
  return withValidation(db, deps, principal, id, 'REVALIDATE');
}

async function get(db, principal, id) {
  const voyage = await voyages.findById(db, id);
  const scope = readScope(principal);
  if (!voyage || (scope && !scope.includes(voyage.agent_id))) throw errors.notFound();
  const run = await validationRepo.latestRun(db, id);
  const last = run && { run_id: run.id, outcome: run.outcome, reason_code: run.reason_code, reason: run.reason, policy_version: run.policy_version,
    ai_status: run.ai_status, ai_label: run.ai_status === 'UNAVAILABLE' ? AI_LABEL : null, rules: JSON.parse(run.rule_results).rules, at: run.created_at };
  return { ...voyage, history: await voyages.historyFor(db, id), last_validation: last, eta: await etaPredictions.latestFor(db, id) };
}

async function list(db, principal, query) {
  const bad = [];
  const { page, size } = parsePaging(query, bad);
  if (query.status !== undefined && !STATUSES.includes(query.status)) bad.push({ field: 'status', message: 'Trạng thái không hợp lệ.' });
  const shipId = query.ship_id === undefined ? null : parseId(query.ship_id);
  if (query.ship_id !== undefined && shipId === null) bad.push({ field: 'ship_id', message: 'Mã tàu không hợp lệ.' });
  if (bad.length) throw errors.validation(bad);
  const { items, total } = await voyages.list(db, { status: query.status, shipId, agentIds: readScope(principal), offset: page * size, size });
  return { items, total, page, size };
}

module.exports = { createNotice, submitNotice, revalidate, withValidation, get, list, AlreadySubmitted };
