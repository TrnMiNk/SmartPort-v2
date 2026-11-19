'use strict';

// UC-026: check a proposed berth placement. The check reads and stores nothing. `evaluateForPlan` takes a database or a
// transaction handle so that UC-028/029 can run the same check again inside the transaction that saves a plan, after it
// has locked the berth row, so two concurrent plans cannot both pass (assumption A-2).

const berths = require('../repositories/berthsRepository');
const status = require('../repositories/berthStatusRepository');
const validation = require('../repositories/validationRepository');
const { evaluate } = require('../policy/placementRules');
const { validatePlacement } = require('../validation/berthValidation');
const { AppError, errors } = require('../errors');

async function bufferMetres(db) {
  const raw = await validation.parameter(db, 'BERTH_SAFETY_BUFFER_M');
  const value = raw === null ? NaN : Number(raw);
  // Fail closed: the buffer comes from the parameters (AC-3), never from a constant in the code.
  if (!Number.isFinite(value) || value < 0) throw new AppError(503, 'PARAMETER_UNAVAILABLE', 'Thiếu tham số khoảng đệm an toàn (BERTH_SAFETY_BUFFER_M).');
  return value;
}

async function evaluateForPlan(db, input, { neighborStatuses } = {}) {
  const berth = await berths.findById(db, input.berth_id);
  if (!berth || !berth.is_active) throw errors.validation([{ field: 'berth_id', message: 'Bến không tồn tại hoặc đã ngừng sử dụng.' }]);
  const voyage = await status.voyageFacts(db, input.voyage_id);
  if (!voyage) throw errors.validation([{ field: 'voyage_id', message: 'Chuyến tàu không tồn tại.' }]);
  if (voyage.status !== 'WAITING_BERTH') {
    throw errors.businessRule('Chỉ kiểm tra được chuyến tàu đang chờ cập bến trong hàng đợi.', { rule: 'VOYAGE_NOT_IN_QUEUE', status: voyage.status });
  }
  // One query at a time: inside a transaction the connection serves a single request at once (EREQINPROG otherwise).
  const buffer = await bufferMetres(db);
  const neighbors = await status.neighbors(db, berth.id, voyage.id, input.planned_start, input.planned_end, neighborStatuses);
  const maintenance = await status.maintenanceOverlapping(db, berth.id, input.planned_start, input.planned_end);
  const result = evaluate({
    ship: { loa: voyage.loa, draft: voyage.draft, cargo_class: voyage.cargo_class }, berth,
    placement: input, buffer_m: buffer, neighbors, maintenance, cargo_hazard: voyage.cargo_hazard, // verified by a coordinator, never from the request
  });
  return { voyage_id: voyage.id, voyage_status: voyage.status, voyage_code: voyage.voyage_code, berth_id: berth.id, berth_code: berth.berth_code, ...result };
}

async function check(db, body) {
  const { errors: bad, value } = validatePlacement(body);
  if (bad.length) throw errors.validation(bad);
  return evaluateForPlan(db, value);
}

module.exports = { check, evaluateForPlan };
