'use strict';

// Berth queue (UC-020). Lists voyages in WAITING_BERTH in stored order and lets a coordinator move one with a reason.
// Order on entry is decided by src/policy/queueOrder.js (UC-015). Changes are serialized by the queue state row; the
// client sends the queue revision it saw (If-Match) and a stale view is refused so it can reload (UC-020 6a).

const queue = require('../repositories/queueRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const { AppError, errors } = require('../errors');
const { validateMove } = require('../validation/flowValidation');
const events = require('../realtime/m2Events');

const present = (e) => ({ voyage_id: e.id, position: e.queue_position, voyage_code: e.voyage_code, ship_name: e.ship_name, imo_number: e.imo_number, length_overall_m: e.length_overall_m == null ? null : Number(e.length_overall_m),
  agent_name: e.agent_name, priority_class: e.priority_class, declared_eta: e.declared_eta, effective_eta: e.effective_eta,
  eta_source: e.eta_source, eta_status: e.eta_status ?? null, queued_at: e.queued_at });

async function list(db) {
  const revision = await queue.readState(db);
  return { revision, items: (await queue.entries(db)).map(present) };
}

async function move(db, principal, voyageId, body, revision) {
  const { errors: bad, toPosition, reason } = validateMove(body);
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản hàng đợi (If-Match).' });
  if (bad.length) throw errors.validation(bad);

  try {
    const moved = await audited(db, principal, { action: 'QUEUE_MOVE', entityType: 'VOYAGE', entityId: voyageId }, () => withTransaction(db, async (tx) => {
      await tx.pool.request().batch('SET LOCK_TIMEOUT 5000');
      try {
        const current = await queue.lockState(tx);
        if (current !== revision) throw errors.conflict('Hàng đợi vừa được người khác thay đổi. Vui lòng tải lại.', { rule: 'QUEUE_CHANGED', current_revision: current });
        const entries = await queue.entries(tx);
        const entry = entries.find((e) => e.id === voyageId);
        if (!entry) throw errors.businessRule('Chuyến này không nằm trong hàng đợi chờ cập bến.', { rule: 'NOT_IN_QUEUE' });
        if (toPosition > entries.length) {
          throw errors.validation([{ field: 'to_position', message: `Vị trí mới tối đa là ${entries.length}.` }]);
        }
        if (toPosition === entry.queue_position) {
          throw errors.validation([{ field: 'to_position', message: 'Vị trí mới trùng vị trí hiện tại.' }]);
        }
        await queue.move(tx, voyageId, entry.queue_position, toPosition);
        await queue.insertChange(tx, { voyageId, from: entry.queue_position, to: toPosition, reason, actor: principal.username });
        await queue.bump(tx);
        await audit.insert(tx, { actor: principal.username, action: 'QUEUE_MOVE', entityType: 'VOYAGE', entityId: voyageId, outcome: 'SUCCESS', reason,
          oldJson: JSON.stringify({ position: entry.queue_position }), newJson: JSON.stringify({ position: toPosition }) });
        return list(tx);
      } finally {
        try { await tx.pool.request().batch('SET LOCK_TIMEOUT -1'); } catch (e) { /* the transaction may already be aborted */ }
      }
    }));
    events.publish('QUEUE_MOVED', { voyage_id: voyageId });   // after commit: other open queues re-read
    return moved;
  } catch (err) {
    if (err && /Lock request time out/i.test(err.message || '')) throw new AppError(503, 'QUEUE_BUSY', 'Hàng đợi đang được cập nhật. Vui lòng thử lại.');
    throw err;
  }
}

module.exports = { list, move };
