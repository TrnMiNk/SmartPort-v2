'use strict';

// Berth catalog (UC-024): list, read, create, update. Authorization is checked before this layer (M2_BERTHS: `view` to
// read, `edit` to change). Every change writes its audit row (old and new values) in the same transaction; a refusal
// is recorded as FAILED by `audited`. Changing the length or depth of a berth that has open plans needs an explicit
// confirmation (spec 6a); the response of the first attempt lists the affected plans.

const berths = require('../repositories/berthsRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const { errors } = require('../errors');
const { validateBerth } = require('../validation/berthValidation');
const { parsePaging } = require('../validation/common');
const events = require('../realtime/m2Events');

const duplicate = () => errors.conflict('Mã bến đã tồn tại.', { field: 'berth_code', message: 'Mã bến đã tồn tại.' });
const stale = (current) => errors.conflict('Thông tin bến vừa được người khác thay đổi. Vui lòng tải lại.', { current_revision: current });
const isDuplicateKey = (err) => err && (err.number === 2627 || err.number === 2601);

async function create(db, principal, body) {
  const { errors: bad, value } = validateBerth(body, 'create');
  if (bad.length) throw errors.validation(bad);
  let saved;
  try {
    saved = await audited(db, principal, { action: 'BERTH_CREATE', entityType: 'BERTH' }, () => withTransaction(db, async (tx) => {
      if (await berths.findByCode(tx, value.berth_code)) throw duplicate();
      const id = await berths.insert(tx, value);
      const berth = await berths.findById(tx, id);
      await audit.insert(tx, { actor: principal.username, action: 'BERTH_CREATE', entityType: 'BERTH', entityId: id, outcome: 'SUCCESS', newJson: JSON.stringify(berth) });
      return berth;
    }));
  } catch (err) {
    if (isDuplicateKey(err)) throw duplicate(); // two creations of the same code at once: the unique constraint decides
    throw err;
  }
  events.publish('BERTHS_CHANGED', { berth_id: saved.id });
  return saved;
}

async function update(db, principal, id, body, revision) {
  const { errors: bad, value, confirm, reason } = validateBerth(body, 'update');
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của bến.' });
  if (bad.length) throw errors.validation(bad);
  let saved;
  try {
    saved = await audited(db, principal, { action: 'BERTH_UPDATE', entityType: 'BERTH', entityId: id }, () => withTransaction(db, async (tx) => {
      const old = await berths.findById(tx, id, { lock: true });
      if (!old || !old.is_active) throw errors.notFound();
      if (old.revision !== revision) throw stale(old.revision);
      if (value.berth_code && value.berth_code !== old.berth_code) {
        const other = await berths.findByCode(tx, value.berth_code);
        if (other && other.id !== id) throw duplicate();
      }
      const sizeChanged = ['length_m', 'max_depth_m'].some((k) => k in value && Number(value[k]) !== Number(old[k]));
      let confirmedPlans = 0;
      if (sizeChanged) {
        const plans = await berths.openPlans(tx, id);
        if (plans.length && !confirm) {
          throw errors.businessRule('Bến đang có kế hoạch cập bến. Thay đổi kích thước có thể ảnh hưởng các kế hoạch này; cần xác nhận để tiếp tục.',
            { rule: 'BERTH_HAS_PLANS', requires_confirmation: true, plans: plans.map((p) => ({ id: p.id, voyage_code: p.voyage_code, plan_status: p.plan_status, planned_start: p.planned_start, planned_end: p.planned_end })) });
        }
        confirmedPlans = plans.length;
      }
      if (!(await berths.update(tx, id, revision, value))) throw stale(null);
      const updated = await berths.findById(tx, id);
      const note = confirmedPlans ? `Đã xác nhận ảnh hưởng ${confirmedPlans} kế hoạch.${reason ? ' ' + reason : ''}` : reason;
      await audit.insert(tx, { actor: principal.username, action: 'BERTH_UPDATE', entityType: 'BERTH', entityId: id, outcome: 'SUCCESS',
        reason: note ? note.slice(0, 500) : null, oldJson: JSON.stringify(old), newJson: JSON.stringify(updated) });
      return updated;
    }));
  } catch (err) {
    if (isDuplicateKey(err)) throw duplicate();
    throw err;
  }
  events.publish('BERTHS_CHANGED', { berth_id: id });
  return saved;
}

async function get(db, id) {
  const berth = await berths.findById(db, id);
  if (!berth || !berth.is_active) throw errors.notFound();
  return berth;
}

async function list(db, query) {
  const bad = [];
  const { page, size } = parsePaging(query, bad);
  if (bad.length) throw errors.validation(bad);
  const { items, total } = await berths.list(db, { offset: page * size, size });
  return { items, total, page, size };
}

module.exports = { create, update, get, list };
