'use strict';

// UC-022 / UC-023 request checks. The actual time defaults to the server clock. A time that differs from "now" by more than
// EDIT_TOLERANCE_MS counts as an edited time and needs a reason (alternative flow 2a / 3a); a time in the future is refused.
// Assumption M-1: 5 minutes of tolerance absorbs the delay between opening the form (default "now") and confirming it.

const { parseId, trimmedString, rejectUnknownKeys } = require('./common');

const EDIT_TOLERANCE_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function validateMovement(body, { needsBerth, now = new Date() }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }] };
  const errors = [];
  rejectUnknownKeys(body, needsBerth ? ['berth_id', 'actual_time', 'reason'] : ['actual_time', 'reason'], errors);
  let berthId = null;
  if (needsBerth) {
    berthId = parseId(body.berth_id);
    if (berthId === null) errors.push({ field: 'berth_id', message: 'Cần chọn bến mà tàu thực tế cập vào.' });
  }
  let at = now;
  let edited = false;
  if (body.actual_time !== undefined && body.actual_time !== null) {
    if (typeof body.actual_time !== 'string' || !ISO.test(body.actual_time) || Number.isNaN(Date.parse(body.actual_time))) {
      errors.push({ field: 'actual_time', message: 'Thời gian thực tế phải là thời điểm ISO 8601 có múi giờ.' });
    } else {
      at = new Date(body.actual_time);
      if (at.getTime() > now.getTime() + FUTURE_SKEW_MS) errors.push({ field: 'actual_time', message: 'Thời gian thực tế không được ở tương lai.' });
      edited = Math.abs(at.getTime() - now.getTime()) > EDIT_TOLERANCE_MS;
    }
  }
  let reason = null;
  if (body.reason !== undefined && body.reason !== null) {
    reason = trimmedString(body.reason, 1, 500);
    if (reason === null) errors.push({ field: 'reason', message: 'Lý do phải có 1 đến 500 ký tự.' });
  }
  if (edited && reason === null && !errors.some((e) => e.field === 'reason')) errors.push({ field: 'reason', message: 'Sửa thời gian thực tế bắt buộc có lý do.' });
  return { errors, berthId, at, edited, reason };
}

module.exports = { validateMovement, EDIT_TOLERANCE_MS };
