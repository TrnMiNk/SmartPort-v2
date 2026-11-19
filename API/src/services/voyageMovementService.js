'use strict';

// UC-022 (confirm berthing) and UC-023 (confirm departure). Both change one voyage and, for departure, its approved plan, inside one
// transaction. Lock order follows the berth plan module: berth row, voyage row, plan row. The voyage revision (If-Match) guards
// stale screens; the guarded UPDATEs (status + revision) make a duplicate or concurrent confirmation fail with 409 and change nothing.
// Berth occupancy is never stored (UC-025 BR-2): berthing sets the voyage BERTHED, which makes the approved plan "in use"; departure
// completes the plan, which frees the berth from the actual departure time.

const voyagesRepo = require('../repositories/voyagesRepository');
const plans = require('../repositories/berthPlansRepository');
const berths = require('../repositories/berthsRepository');
const audit = require('../repositories/auditRepository');
const events = require('../realtime/m2Events');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const { AppError, errors } = require('../errors');
const { validateMovement } = require('../validation/movementValidation');

const stale = (current) => errors.conflict('Chuyến tàu vừa được người khác thay đổi. Vui lòng tải lại.', { current_revision: current });

async function inTx(db, fn) {
  try {
    return await withTransaction(db, async (tx) => {
      await tx.pool.request().batch('SET LOCK_TIMEOUT 5000');
      try { return await fn(tx); } finally { try { await tx.pool.request().batch('SET LOCK_TIMEOUT -1'); } catch (e) { /* aborted transaction */ } }
    });
  } catch (err) {
    if (err && /Lock request time out/i.test(err.message || '')) throw new AppError(503, 'BERTH_BUSY', 'Bến đang được cập nhật. Vui lòng thử lại.');
    throw err;
  }
}

// Locks the berth of the voyage's approved plan first (lock order), then the voyage row.
async function lockInOrder(tx, id) {
  const peek = await plans.approvedForVoyage(tx, id);
  if (peek) await berths.findById(tx, peek.berth_id, { lock: true });
  return voyagesRepo.lockForMovement(tx, id);
}

async function confirmBerthing(db, principal, id, body, revision) {
  const v = validateMovement(body, { needsBerth: true });
  const bad = [...v.errors];
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của chuyến.' });
  if (bad.length) throw errors.validation(bad);
  const out = await audited(db, principal, { action: 'VOYAGE_BERTHING', entityType: 'VOYAGE', entityId: id }, () => inTx(db, async (tx) => {
    const voyage = await lockInOrder(tx, id);
    if (!voyage) throw errors.notFound();
    if (voyage.status !== 'BERTH_ASSIGNED') throw errors.businessRule('Chỉ chuyến đã được xếp bến (BERTH_ASSIGNED) mới xác nhận cập bến được.', { rule: 'NOT_BERTH_ASSIGNED', voyage_status: voyage.status });
    if (voyage.revision !== revision) throw stale(voyage.revision);
    const plan = await plans.approvedForVoyage(tx, id);
    if (!plan) throw errors.businessRule('Chuyến chưa có kế hoạch bến được phê duyệt.', { rule: 'NO_APPROVED_PLAN' });
    if (plan.berth_id !== v.berthId) {
      throw errors.businessRule('Tàu cập bến khác với bến trong kế hoạch được phê duyệt. Hãy báo Ban quản lý lập lại kế hoạch (UC-033, chưa triển khai).', { rule: 'WRONG_BERTH', planned_berth_id: plan.berth_id });
    }
    const busy = await plans.berthedOverlapping(tx, plan.berth_id, id, plan.position_start_m, plan.position_end_m);
    if (busy) throw errors.businessRule(`Vị trí cập bến đang có tàu khác (${busy.voyage_code}) chưa rời bến.`, { rule: 'BERTH_OCCUPIED', occupied_by: busy.voyage_code });
    if (!(await voyagesRepo.markBerthed(tx, id, revision, v.at))) throw stale(null);
    const reason = v.reason ? `Xác nhận cập bến, sửa giờ thực tế: ${v.reason}` : 'Xác nhận cập bến';
    await voyagesRepo.insertHistory(tx, { voyageId: id, fromStatus: 'BERTH_ASSIGNED', toStatus: 'BERTHED', reason, actor: principal.username });
    await audit.insert(tx, { actor: principal.username, action: 'VOYAGE_BERTHING', entityType: 'VOYAGE', entityId: id, outcome: 'SUCCESS', reason,
      oldJson: JSON.stringify({ status: 'BERTH_ASSIGNED', revision: voyage.revision }),
      newJson: JSON.stringify({ status: 'BERTHED', ata: v.at.toISOString(), ata_edited: v.edited, plan_id: Number(plan.id), berth_id: plan.berth_id }) });
    return { id, voyage_code: voyage.voyage_code, status: 'BERTHED', ata: v.at, atd: null, revision: voyage.revision + 1, plan_id: Number(plan.id), berth_id: plan.berth_id, ata_edited: v.edited };
  }));
  events.publish('BERTHS_CHANGED', { berth_id: out.berth_id, voyage_id: id });
  return out;
}

async function confirmDeparture(db, principal, id, body, revision) {
  const v = validateMovement(body, { needsBerth: false });
  const bad = [...v.errors];
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của chuyến.' });
  if (bad.length) throw errors.validation(bad);
  const out = await audited(db, principal, { action: 'VOYAGE_DEPARTURE', entityType: 'VOYAGE', entityId: id }, () => inTx(db, async (tx) => {
    const voyage = await lockInOrder(tx, id);
    if (!voyage) throw errors.notFound();
    if (voyage.status !== 'BERTHED') throw errors.businessRule('Chỉ chuyến đang cập bến (BERTHED) mới xác nhận rời bến được.', { rule: 'NOT_BERTHED', voyage_status: voyage.status });
    if (voyage.revision !== revision) throw stale(voyage.revision);
    if (!voyage.ata || v.at.getTime() < new Date(voyage.ata).getTime()) {
      throw errors.businessRule('Giờ rời bến không được trước giờ cập bến.', { rule: 'ATD_BEFORE_ATA', ata: voyage.ata });
    }
    const plan = await plans.approvedForVoyage(tx, id);
    if (!plan) throw errors.businessRule('Không tìm thấy kế hoạch bến đang áp dụng của chuyến.', { rule: 'NO_APPROVED_PLAN' });
    if (!(await voyagesRepo.markDeparted(tx, id, revision, v.at))) throw stale(null);
    if (!(await plans.markCompleted(tx, Number(plan.id), Number(plan.revision)))) throw stale(null);
    await plans.insertHistory(tx, { planId: Number(plan.id), from: 'APPROVED', to: 'COMPLETED', reason: 'Tàu đã rời bến', actor: principal.username });
    const reason = v.reason ? `Xác nhận rời bến, sửa giờ thực tế: ${v.reason}` : 'Xác nhận rời bến';
    await voyagesRepo.insertHistory(tx, { voyageId: id, fromStatus: 'BERTHED', toStatus: 'DEPARTED', reason, actor: principal.username });
    await audit.insert(tx, { actor: principal.username, action: 'VOYAGE_DEPARTURE', entityType: 'VOYAGE', entityId: id, outcome: 'SUCCESS', reason,
      oldJson: JSON.stringify({ status: 'BERTHED', revision: voyage.revision, ata: voyage.ata }),
      newJson: JSON.stringify({ status: 'DEPARTED', atd: v.at.toISOString(), atd_edited: v.edited, plan_id: Number(plan.id), plan_status: 'COMPLETED', berth_id: plan.berth_id }) });
    return { id, voyage_code: voyage.voyage_code, status: 'DEPARTED', ata: voyage.ata, atd: v.at, revision: voyage.revision + 1, plan_id: Number(plan.id), berth_id: plan.berth_id, atd_edited: v.edited };
  }));
  events.publish('BERTHS_CHANGED', { berth_id: out.berth_id, voyage_id: id });
  return out;
}

module.exports = { confirmBerthing, confirmDeparture };
