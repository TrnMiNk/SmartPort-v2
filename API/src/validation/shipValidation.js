'use strict';

// Validation for vessel profiles (UC-010, UC-011). Returns { errors, value }; `value` holds normalized fields.
// Limits for numbers are the column sizes in the schema (DECIMAL(10,2) and DECIMAL(12,2)), not business limits.

const { parseId, parsePositiveDecimal, trimmedString, rejectUnknownKeys } = require('./common');

const FIELDS = ['imo_number', 'ship_name', 'flag_state', 'ship_type_id', 'operator_agent_id',
  'length_overall_m', 'beam_m', 'max_draft_m', 'deadweight_t'];
const REQUIRED = ['imo_number', 'ship_name', 'ship_type_id', 'length_overall_m', 'beam_m', 'max_draft_m', 'deadweight_t'];
const DIM_MAX = 99999999.99;
const DWT_MAX = 9999999999.99;

const CHECKS = {
  imo_number: (v) => (typeof v === 'string' && /^[0-9]{7}$/.test(v) ? v : null),
  ship_name: (v) => trimmedString(v, 1, 200),
  flag_state: (v) => (v === null ? null : trimmedString(v, 1, 100)),
  ship_type_id: parseId,
  operator_agent_id: (v) => (v === null ? null : parseId(v)),
  length_overall_m: (v) => parsePositiveDecimal(v, DIM_MAX),
  beam_m: (v) => parsePositiveDecimal(v, DIM_MAX),
  max_draft_m: (v) => parsePositiveDecimal(v, DIM_MAX),
  deadweight_t: (v) => parsePositiveDecimal(v, DWT_MAX),
};

const MESSAGES = {
  imo_number: 'Số IMO phải gồm đúng 7 chữ số.',
  ship_name: 'Tên tàu là bắt buộc, tối đa 200 ký tự.',
  flag_state: 'Cờ tàu tối đa 100 ký tự.',
  ship_type_id: 'Loại tàu không hợp lệ.',
  operator_agent_id: 'Hãng tàu/đại lý không hợp lệ.',
  length_overall_m: 'Chiều dài LOA phải lớn hơn 0 (tối đa 2 chữ số thập phân).',
  beam_m: 'Chiều rộng phải lớn hơn 0 (tối đa 2 chữ số thập phân).',
  max_draft_m: 'Mớn nước tối đa phải lớn hơn 0 (tối đa 2 chữ số thập phân).',
  deadweight_t: 'Tổng trọng tải phải lớn hơn 0 (tối đa 2 chữ số thập phân).',
};

// mode 'create': every required field must be present. mode 'update': any non-empty subset is accepted.
function validateShip(body, mode) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], value: {} };
  }
  rejectUnknownKeys(body, mode === 'update' ? [...FIELDS, 'reason'] : FIELDS, errors);
  const value = {};
  for (const field of FIELDS) {
    if (!(field in body)) {
      if (mode === 'create' && REQUIRED.includes(field)) errors.push({ field, message: MESSAGES[field] });
      continue;
    }
    const checked = CHECKS[field](body[field]);
    if (checked === null && !(body[field] === null && (field === 'flag_state' || field === 'operator_agent_id'))) {
      errors.push({ field, message: MESSAGES[field] });
    } else {
      value[field] = checked;
    }
  }
  if (mode === 'update') {
    if (Object.keys(value).length === 0 && errors.length === 0) errors.push({ field: 'body', message: 'Không có thay đổi nào để lưu.' });
    if ('reason' in body && body.reason !== null && trimmedString(body.reason, 1, 500) === null) {
      errors.push({ field: 'reason', message: 'Lý do tối đa 500 ký tự.' });
    }
  }
  return { errors, value };
}

function validateDeactivate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], reason: null };
  }
  const errors = [];
  rejectUnknownKeys(body, ['reason'], errors);
  const reason = trimmedString(body.reason, 1, 500);
  if (reason === null) errors.push({ field: 'reason', message: 'Vui lòng nhập lý do vô hiệu hóa (tối đa 500 ký tự).' });
  return { errors, reason };
}

module.exports = { validateShip, validateDeactivate, FIELDS };
