'use strict';

// Boundary validation for drafts (UC-013 3a) and queue moves (UC-020). A draft may be incomplete, so only its shape and
// sizes are checked here; the full notice rules run when it is submitted.

const { trimmedString, rejectUnknownKeys } = require('./common');

const DRAFT_KEYS = ['ship_id', 'voyage_code', 'agent_id', 'origin_port_id', 'declared_eta', 'declared_teu', 'cargo_type', 'service_request', 'priority_class'];
const MAX_DRAFT_BYTES = 4096;

function validateDraft(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], value: {} };
  const errors = [];
  rejectUnknownKeys(body, DRAFT_KEYS, errors);
  const value = {};
  for (const key of DRAFT_KEYS) {
    if (!(key in body)) continue;
    const v = body[key];
    const ok = v === null || (typeof v === 'string' && v.length <= 1000) || (typeof v === 'number' && Number.isFinite(v));
    if (!ok) errors.push({ field: key, message: 'Giá trị không hợp lệ.' });
    else if (v !== null && v !== '') value[key] = v; // empty values are not stored
  }
  if (errors.length === 0 && Object.keys(value).length === 0) errors.push({ field: 'body', message: 'Bản nháp trống. Hãy nhập ít nhất một trường.' });
  if (errors.length === 0 && Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_DRAFT_BYTES) errors.push({ field: 'body', message: 'Bản nháp quá lớn.' });
  return { errors, value };
}

function validateMove(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }] };
  const errors = [];
  rejectUnknownKeys(body, ['to_position', 'reason'], errors);
  if (!Number.isInteger(body.to_position) || body.to_position < 1 || body.to_position > 100000) {
    errors.push({ field: 'to_position', message: 'Vị trí mới phải là số nguyên từ 1.' });
  }
  const reason = trimmedString(body.reason, 1, 500);
  if (reason === null) errors.push({ field: 'reason', message: 'Bắt buộc nhập lý do khi đổi thứ tự (tối đa 500 ký tự).' });
  return { errors, toPosition: body.to_position, reason };
}

module.exports = { validateDraft, validateMove, DRAFT_KEYS };
