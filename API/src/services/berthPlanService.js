'use strict';

// Manual berth plans: save and edit a draft (UC-028), submit it for approval (UC-029) and approve it (UC-030). Rejection is UC-031 (not built).
//
// What this module guarantees
//  - Every save and every submission runs the placement check (UC-026) again, inside the transaction that holds the berth lock,
//    so two plans for the same berth cannot both pass against each other.
//  - The check result is stored as it is (`passed` stays false when a rule failed). A rule violation is accepted only through
//    an override: a reason, the `override` permission, and a violation that can be overridden. Missing data and an out-of-service
//    berth can never be overridden. The override (who, when, why, which rules) is stored beside the result and audited.
//  - Drafts and submissions do not change the voyage or the queue.
// Lock order: queue state (only when the queue changes, i.e. approval), berth rows by id, then the voyage row, then the plan row. A lock wait longer than 5 s becomes 503 BERTH_BUSY.

const plans = require('../repositories/berthPlansRepository');
const berths = require('../repositories/berthsRepository');
const audit = require('../repositories/auditRepository');
const validation = require('../repositories/validationRepository');
const queue = require('../repositories/queueRepository');
const notifications = require('../repositories/notificationsRepository');
const voyagesRepo = require('../repositories/voyagesRepository');
const events = require('../realtime/m2Events');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const placement = require('./placementService');
const { AppError, errors } = require('../errors');
const { can } = require('../security/permissions');
const { validatePlanBody, validateSubmit, validateReject } = require('../validation/planValidation');
const recommendations = require('./berthRecommendationService');
const { parsePaging, parseId } = require('../validation/common');

const stale = (current) => errors.conflict('Kế hoạch vừa được người khác thay đổi. Vui lòng tải lại.', { current_revision: current });
const summary = (r) => ({ outcome: r.outcome, passed: r.passed, overridable: r.overridable, rules: r.rules.filter((x) => x.outcome !== 'PASS').map((x) => ({ id: x.id, outcome: x.outcome, reason: x.reason, overridable: x.overridable })) });

async function inLocks(db, fn) {
  try {
    return await withTransaction(db, async (tx) => {
      await tx.pool.request().batch('SET LOCK_TIMEOUT 5000');
      try { return await fn(tx); } finally { try { await tx.pool.request().batch('SET LOCK_TIMEOUT -1'); } catch (e) { /* the transaction may already be aborted */ } }
    });
  } catch (err) {
    if (err && /Lock request time out/i.test(err.message || '')) throw new AppError(503, 'BERTH_BUSY', 'Bến đang được cập nhật. Vui lòng thử lại.');
    if (err && (err.number === 2601 || err.number === 2627)) {
      if (/UX_bp_draft_per_voyage/.test(err.message)) throw errors.businessRule('Chuyến này đã có kế hoạch nháp. Hãy sửa kế hoạch nháp đó.', { rule: 'DRAFT_EXISTS' });
      if (/UX_bp_open_plan_per_voyage/.test(err.message)) throw errors.businessRule('Chuyến này đã có kế hoạch đang chờ duyệt hoặc đã duyệt.', { rule: 'VOYAGE_HAS_OPEN_PLAN' });
    }
    throw err;
  }
}

async function lockBerths(tx, ids) {
  const found = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const berth = await berths.findById(tx, id, { lock: true });
    if (!berth || !berth.is_active) throw errors.validation([{ field: 'berth_id', message: 'Bến không tồn tại hoặc đã ngừng sử dụng.' }]);
    found.push(berth);
  }
  return found;
}

// Decides whether a check result may be saved. Returns the override to store, or null when the check passed.
function decide(principal, result, reason) {
  if (result.outcome === 'PASS') return null;
  if (result.outcome === 'MISSING_DATA') {
    throw errors.businessRule('Thiếu dữ liệu để kiểm tra ràng buộc nên không thể lưu kế hoạch.', { rule: 'INSUFFICIENT_DATA', check: summary(result) });
  }
  if (!reason) {
    throw errors.businessRule('Kế hoạch vi phạm ràng buộc. Chỉ được tiếp tục khi ghi đè kèm lý do.', { rule: 'CONSTRAINT_VIOLATION', requires_override: true, check: summary(result) });
  }
  if (!result.overridable) {
    throw errors.businessRule('Có vi phạm không thể ghi đè (bến ngừng hoạt động). Hãy chọn bến khác.', { rule: 'NOT_OVERRIDABLE', check: summary(result) });
  }
  if (!can(principal.roles, 'M2_BERTHS', 'override')) throw errors.forbidden();
  return { reason, by: principal.userId, at: new Date(), rules: result.rules.filter((x) => x.outcome === 'VIOLATION').map((x) => x.id) };
}

const toRow = (value, result, override) => ({ ...value, buffer_m: result.buffer_m, policy_version: result.rules_version, check: result, override });
const eligible = async (tx, voyageId) => {
  const voyage = await plans.lockVoyage(tx, voyageId);
  if (!voyage) throw errors.validation([{ field: 'voyage_id', message: 'Chuyến tàu không tồn tại.' }]);
  if (voyage.status !== 'WAITING_BERTH') throw errors.businessRule('Chỉ lập kế hoạch cho chuyến đang chờ cập bến trong hàng đợi.', { rule: 'VOYAGE_NOT_IN_QUEUE', status: voyage.status });
  return voyage;
};

async function writeOverrideAudit(tx, principal, action, planId, override, result) {
  if (!override) return;
  await audit.insert(tx, { actor: principal.username, action, entityType: 'BERTH_PLAN', entityId: planId, outcome: 'SUCCESS', reason: override.reason,
    newJson: JSON.stringify({ overridden_rules: override.rules, check_outcome: result.outcome, policy_version: result.rules_version, violations: summary(result).rules }) });
}

async function createDraft(db, principal, body) {
  const { errors: bad, value, overrideReason, proposalId } = validatePlanBody(body);
  if (bad.length) throw errors.validation(bad);
  return audited(db, principal, { action: 'BERTH_PLAN_CREATE', entityType: 'BERTH_PLAN' }, () => inLocks(db, async (tx) => {
    await lockBerths(tx, [value.berth_id]);
    await eligible(tx, value.voyage_id);
    const open = await plans.openPlansForVoyage(tx, value.voyage_id);
    if (open.length) {
      const draft = open.find((p) => p.plan_status === 'DRAFT');
      throw errors.businessRule(draft ? 'Chuyến này đã có kế hoạch nháp. Hãy sửa kế hoạch nháp đó.' : 'Chuyến này đã có kế hoạch đang chờ duyệt hoặc đã duyệt.',
        { rule: draft ? 'DRAFT_EXISTS' : 'VOYAGE_HAS_OPEN_PLAN', plan_id: open[0].id });
    }
    const result = await placement.evaluateForPlan(tx, value);
    const override = decide(principal, result, overrideReason);
    const link = proposalId ? await recommendations.linkForDraft(tx, proposalId, value) : null;   // UC-027: a draft made from a proposal; UC-026 above has just checked it again
    const id = await plans.insertDraft(tx, { ...toRow(value, result, override), voyage_id: value.voyage_id, source: link ? link.source : 'MANUAL', proposal_id: link ? link.proposal.id : null }, principal.userId);
    if (link) await recommendations.recordDraftDecision(tx, principal, id, link);
    await plans.insertHistory(tx, { planId: id, from: null, to: 'DRAFT', actor: principal.username });
    const saved = await plans.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'BERTH_PLAN_CREATE', entityType: 'BERTH_PLAN', entityId: id, outcome: 'SUCCESS', newJson: JSON.stringify(saved) });
    await writeOverrideAudit(tx, principal, 'BERTH_PLAN_OVERRIDE', id, override, result);
    return saved;
  }));
}

async function updateDraft(db, principal, id, body, revision) {
  const { errors: bad, value, overrideReason } = validatePlanBody(body);
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của kế hoạch.' });
  if (bad.length) throw errors.validation(bad);
  return audited(db, principal, { action: 'BERTH_PLAN_UPDATE', entityType: 'BERTH_PLAN', entityId: id }, () => inLocks(db, async (tx) => {
    const peek = await plans.findById(tx, id);
    if (!peek) throw errors.notFound();
    await lockBerths(tx, [peek.berth_id, value.berth_id]);
    const old = await plans.findById(tx, id, { lock: true });
    if (!old) throw errors.notFound();
    if (old.plan_status !== 'DRAFT') throw errors.businessRule('Chỉ sửa được kế hoạch nháp.', { rule: 'NOT_DRAFT', plan_status: old.plan_status });
    if (old.revision !== revision) throw stale(old.revision);
    if (old.voyage_id !== value.voyage_id) throw errors.validation([{ field: 'voyage_id', message: 'Không đổi được chuyến của kế hoạch.' }]);
    await eligible(tx, old.voyage_id);
    const result = await placement.evaluateForPlan(tx, value);
    const override = decide(principal, result, overrideReason);
    if (!(await plans.updateDraft(tx, id, revision, toRow(value, result, override)))) throw stale(null);
    await recommendations.reclassifyAfterEdit(tx, old, value);   // a plan from a proposal becomes AI_ADJUSTED (decision MODIFIED) when edited, and back when edited to match
    const saved = await plans.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'BERTH_PLAN_UPDATE', entityType: 'BERTH_PLAN', entityId: id, outcome: 'SUCCESS', oldJson: JSON.stringify(old), newJson: JSON.stringify(saved) });
    await writeOverrideAudit(tx, principal, 'BERTH_PLAN_OVERRIDE', id, override, result);
    return saved;
  }));
}

async function submit(db, principal, id, body, revision) {
  const { errors: bad, overrideReason } = validateSubmit(body);
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của kế hoạch.' });
  if (bad.length) throw errors.validation(bad);
  const submitted = await audited(db, principal, { action: 'BERTH_PLAN_SUBMIT', entityType: 'BERTH_PLAN', entityId: id }, () => inLocks(db, async (tx) => {
    const peek = await plans.findById(tx, id);
    if (!peek) throw errors.notFound();
    const [berth] = await lockBerths(tx, [peek.berth_id]);
    const old = await plans.findById(tx, id, { lock: true });
    if (old.plan_status !== 'DRAFT') throw errors.businessRule('Chỉ gửi duyệt được kế hoạch nháp.', { rule: 'NOT_DRAFT', plan_status: old.plan_status });
    if (old.revision !== revision) throw stale(old.revision);
    const voyage = await eligible(tx, old.voyage_id);
    const others = (await plans.openPlansForVoyage(tx, old.voyage_id)).filter((p) => p.id !== id);
    if (others.length) throw errors.businessRule('Chuyến này đã có kế hoạch khác đang chờ duyệt hoặc đã duyệt.', { rule: 'VOYAGE_HAS_OPEN_PLAN', plan_id: others[0].id });
    const input = { voyage_id: old.voyage_id, berth_id: berth.id, position_start_m: Number(old.position_start_m), position_end_m: Number(old.position_end_m),
      planned_start: new Date(old.planned_start), planned_end: new Date(old.planned_end), required_cranes: old.required_cranes };
    const result = await placement.evaluateForPlan(tx, input);   // the check is repeated now: data may have changed since the draft
    const override = decide(principal, result, overrideReason || old.override_reason);
    if (!(await plans.markSubmitted(tx, id, revision, toRow(input, result, override), principal.userId))) throw stale(null);
    await plans.insertHistory(tx, { planId: id, from: 'DRAFT', to: 'PENDING_APPROVAL', reason: override ? override.reason : null, actor: principal.username });
    const saved = await plans.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'BERTH_PLAN_SUBMIT', entityType: 'BERTH_PLAN', entityId: id, outcome: 'SUCCESS',
      reason: override ? override.reason : null, oldJson: JSON.stringify(old), newJson: JSON.stringify(saved) });
    await writeOverrideAudit(tx, principal, 'BERTH_PLAN_OVERRIDE', id, override, result);
    await validation.notifyRole(tx, 'BAN_QUAN_LY', { title: 'Kế hoạch cập bến chờ phê duyệt',
      body: `Chuyến ${voyage.voyage_code} tại bến ${berth.berth_code}${override ? ' (có ghi đè ràng buộc)' : ''} đang chờ phê duyệt.`, entityType: 'BERTH_PLAN', entityId: id });
    return saved;
  }));
  events.publish('PLAN_SUBMITTED', { plan_id: id }); // open screens of the port manager reload their notices and plan list
  return submitted;
}


// UC-030. Approval is the only way a plan becomes APPROVED, and it is decided on facts read now, never on the stored result:
//  - the approver holds `approve` (route), is not the submitter (F-4; the database refuses it too), and saw the current revision;
//  - the placement check is run again inside the transaction that holds the queue, berth and voyage locks. Only a plan whose check passes
//    NOW is approved (F-1b): an override lets a plan reach review but never makes a failed rule acceptable. Only APPROVED and COMPLETED plans count
//    as reservations here, so a plan that is merely waiting for its own decision cannot block another one;
//  - in the same transaction the voyage becomes BERTH_ASSIGNED (C-1), leaves the queue, the queue closes the gap and records the exit.
// Rule failures answer 409 and tell the submitter (spec 6a); the plan stays PENDING_APPROVAL.
async function approve(db, principal, id, body, revision) {
  const bad = [];
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) bad.push({ field: 'confirm', message: 'Cần xác nhận phê duyệt (confirm: true).' });
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của kế hoạch.' });
  if (bad.length) throw errors.validation(bad);
  const approverId = Number(principal.userId);
  const seen = {};
  let done;
  try {
    done = await audited(db, principal, { action: 'BERTH_PLAN_APPROVE', entityType: 'BERTH_PLAN', entityId: id }, () => inLocks(db, async (tx) => {
      await queue.lockState(tx);
      const peek = await plans.findById(tx, id);
      if (!peek) throw errors.notFound();
      const [berth] = await lockBerths(tx, [peek.berth_id]);
      const old = await plans.findById(tx, id, { lock: true });
      seen.submitter = old.submitted_by_user_id; seen.voyageId = old.voyage_id; seen.berthCode = berth.berth_code;
      if (old.plan_status !== 'PENDING_APPROVAL') throw errors.businessRule('Kế hoạch không còn ở trạng thái chờ phê duyệt.', { rule: 'NOT_PENDING', plan_status: old.plan_status });
      if (old.revision !== revision) throw stale(old.revision);
      if (old.submitted_by_user_id === approverId) throw errors.businessRule('Người gửi kế hoạch không được tự phê duyệt kế hoạch của mình.', { rule: 'SELF_APPROVAL' });
      const voyage = await eligible(tx, old.voyage_id);
      seen.voyageCode = voyage.voyage_code;
      const input = { voyage_id: old.voyage_id, berth_id: berth.id, position_start_m: Number(old.position_start_m), position_end_m: Number(old.position_end_m),
        planned_start: new Date(old.planned_start), planned_end: new Date(old.planned_end), required_cranes: old.required_cranes };
      const result = await placement.evaluateForPlan(tx, input, { neighborStatuses: ['APPROVED', 'COMPLETED'] });
      if (result.outcome !== 'PASS') {
        seen.blocked = summary(result);
        throw errors.businessRule('Kế hoạch không còn thỏa các ràng buộc tại thời điểm duyệt nên không thể phê duyệt. Cần lập lại hoặc từ chối kế hoạch.',
          { rule: 'CONSTRAINT_VIOLATION_AT_APPROVAL', check: summary(result), had_override: !!old.override_reason });
      }
      if (!(await plans.markApproved(tx, id, revision, result, approverId))) throw stale(null);
      const oldPosition = await plans.assignVoyage(tx, old.voyage_id);
      if (oldPosition === null) throw errors.businessRule('Chuyến không còn trong hàng đợi chờ cập bến.', { rule: 'VOYAGE_NOT_IN_QUEUE' });
      const reason = `Kế hoạch bến #${id} (bến ${berth.berth_code}) đã được phê duyệt`;
      await voyagesRepo.insertHistory(tx, { voyageId: old.voyage_id, fromStatus: 'WAITING_BERTH', toStatus: 'BERTH_ASSIGNED', reason, actor: principal.username });
      await queue.closeGap(tx, oldPosition);
      await queue.insertLeft(tx, { voyageId: old.voyage_id, from: oldPosition, reason, actor: principal.username });
      await queue.bump(tx);
      await plans.insertHistory(tx, { planId: id, from: 'PENDING_APPROVAL', to: 'APPROVED', reason: old.override_reason ? 'Có ghi đè khi gửi duyệt; kiểm tra lại tại thời điểm duyệt: đạt' : null, actor: principal.username });
      const saved = await plans.findById(tx, id);
      await audit.insert(tx, { actor: principal.username, action: 'BERTH_PLAN_APPROVE', entityType: 'BERTH_PLAN', entityId: id, outcome: 'SUCCESS', reason,
        oldJson: JSON.stringify(old),
        newJson: JSON.stringify({ plan: saved, decision: { policy_version: result.rules_version, outcome: result.outcome, had_override: !!old.override_reason, previous_check_passed: old.check.passed },
          voyage: { id: old.voyage_id, from: 'WAITING_BERTH', to: 'BERTH_ASSIGNED', left_queue_position: oldPosition } }) });
      const local = (d) => new Date(new Date(d).getTime() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
      const when = `${local(old.planned_start)} – ${local(old.planned_end)} (UTC+7)`;
      await notifications.insertForUser(tx, old.submitted_by_user_id, { title: 'Kế hoạch cập bến đã được phê duyệt', body: `Chuyến ${voyage.voyage_code} đã được xếp bến ${berth.berth_code} (${when}).`, entityType: 'BERTH_PLAN', entityId: id });
      const agent = (await tx.pool.request().input('v', tx.sql.Int, old.voyage_id).query('SELECT agent_id FROM dbo.voyages WHERE id = @v')).recordset[0].agent_id;
      for (const userId of await notifications.agentUserIds(tx, agent)) {
        await notifications.insertForUser(tx, userId, { title: 'Chuyến tàu đã được xếp bến', body: `Chuyến ${voyage.voyage_code} được xếp bến ${berth.berth_code} (${when}).`, entityType: 'BERTH_PLAN', entityId: id });
      }
      return { ...saved, voyage: { id: old.voyage_id, status: 'BERTH_ASSIGNED', queue_position: null, left_queue_position: oldPosition } };
    }));
  } catch (err) {
    // 6a: the submitter is told why the plan cannot be approved. The refusal rolled the transaction back, so this is a separate write.
    if (err && err.details && err.details.rule === 'CONSTRAINT_VIOLATION_AT_APPROVAL' && seen.submitter) {
      try {
        await notifications.insertForUser(db, seen.submitter, { title: 'Không thể phê duyệt kế hoạch cập bến',
          body: `Chuyến ${seen.voyageCode} (bến ${seen.berthCode}): ${seen.blocked.rules.map((r) => r.reason).join(' ')}`.slice(0, 1000), entityType: 'BERTH_PLAN', entityId: id });
        events.publish('NOTIFICATION', { plan_id: id });
      } catch (e) { /* never hide the business refusal behind a notification failure */ }
    }
    throw err;
  }
  events.publish('PLAN_APPROVED', { plan_id: id, berth_id: done.berth_id, voyage_id: done.voyage_id });
  return done;
}

// UC-031. Port management rejects a plan that waits for a decision, with a reason. A pending plan reserves nothing, so the berth, the voyage and
// the queue are not touched. A rejected plan stays as history and is not edited or resubmitted (UC-031 A-1): the coordinator, who is told the
// reason, makes a new draft. Only a PENDING_APPROVAL plan can be rejected; an approved or completed plan cannot.
async function reject(db, principal, id, body, revision) {
  const { errors: bad, reason } = validateReject(body);
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của kế hoạch.' });
  if (bad.length) throw errors.validation(bad);
  const done = await audited(db, principal, { action: 'BERTH_PLAN_REJECT', entityType: 'BERTH_PLAN', entityId: id }, () => inLocks(db, async (tx) => {
    const peek = await plans.findById(tx, id);
    if (!peek) throw errors.notFound();
    const [berth] = await lockBerths(tx, [peek.berth_id]);
    const old = await plans.findById(tx, id, { lock: true });
    if (old.plan_status !== 'PENDING_APPROVAL') throw errors.businessRule('Kế hoạch không còn ở trạng thái chờ phê duyệt.', { rule: 'NOT_PENDING', plan_status: old.plan_status });
    if (old.revision !== revision) throw stale(old.revision);
    if (!(await plans.markRejected(tx, id, revision, reason))) throw stale(null);
    await plans.insertHistory(tx, { planId: id, from: 'PENDING_APPROVAL', to: 'REJECTED', reason, actor: principal.username });
    const saved = await plans.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'BERTH_PLAN_REJECT', entityType: 'BERTH_PLAN', entityId: id, outcome: 'SUCCESS', reason,
      oldJson: JSON.stringify(old), newJson: JSON.stringify({ plan: saved, previous_status: 'PENDING_APPROVAL', new_status: 'REJECTED', rejected_by: principal.username }) });
    await notifications.insertForUser(tx, old.submitted_by_user_id, { title: 'Kế hoạch cập bến bị từ chối',
      body: `Chuyến ${old.voyage_code} (bến ${berth.berth_code}) bị từ chối: ${reason}`.slice(0, 1000), entityType: 'BERTH_PLAN', entityId: id });
    return saved;
  }));
  events.publish('PLAN_REJECTED', { plan_id: id, berth_id: done.berth_id, voyage_id: done.voyage_id });
  return done;
}

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'COMPLETED'];
async function list(db, query) {
  const bad = [];
  const { page, size } = parsePaging(query, bad);
  if (query.status !== undefined && !STATUSES.includes(query.status)) bad.push({ field: 'status', message: 'Trạng thái kế hoạch không hợp lệ.' });
  const voyageId = query.voyage_id === undefined ? null : parseId(query.voyage_id);
  if (query.voyage_id !== undefined && voyageId === null) bad.push({ field: 'voyage_id', message: 'Mã chuyến không hợp lệ.' });
  if (bad.length) throw errors.validation(bad);
  const { items, total } = await plans.list(db, { status: query.status, voyageId, offset: page * size, size });
  return { items, total, page, size };
}

async function get(db, id) {
  const plan = await plans.findById(db, id);
  if (!plan) throw errors.notFound();
  return { ...plan, history: await plans.history(db, id) };
}

module.exports = { createDraft, updateDraft, submit, approve, reject, list, get };
