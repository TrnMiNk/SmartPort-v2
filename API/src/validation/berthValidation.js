'use strict';

// Validation for the berth catalog (UC-024) and the placement check (UC-026). Returns { errors, value }.
// Number limits are the column sizes in the schema (DECIMAL(10,2), DECIMAL(11,8), DECIMAL(10,8)), not business limits.

const { parseId, parsePositiveDecimal, trimmedString, rejectUnknownKeys } = require('./common');
const { parseEta } = require('./voyageValidation');

const DIM_MAX = 99999999.99;
const CRANES_MAX = 1000;
const FIELDS = ['berth_code', 'berth_name', 'berth_type', 'length_m', 'max_depth_m', 'available_cranes', 'allows_dangerous', 'longitude', 'latitude'];
const REQUIRED = ['berth_code', 'berth_type', 'length_m', 'max_depth_m', 'available_cranes', 'allows_dangerous'];

const inRange = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const CHECKS = {
  berth_code: (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(v.trim()) ? v.trim() : null),
  berth_name: (v) => trimmedString(v, 1, 200),
  berth_type: (v) => (v === 'CONTAINER' || v === 'BULK' ? v : null),
  length_m: (v) => parsePositiveDecimal(v, DIM_MAX),
  max_depth_m: (v) => parsePositiveDecimal(v, DIM_MAX),
  available_cranes: (v) => (Number.isInteger(v) && v >= 0 && v <= CRANES_MAX ? v : null),
  allows_dangerous: (v) => (typeof v === 'boolean' ? v : null),
  longitude: (v) => inRange(v, -180, 180),
  latitude: (v) => inRange(v, -90, 90),
};
const MESSAGES = {
  berth_code: 'Mã bến gồm chữ, số, dấu gạch ngang hoặc gạch dưới, tối đa 20 ký tự.',
  berth_name: 'Tên bến tối đa 200 ký tự.',
  berth_type: 'Loại bến phải là CONTAINER hoặc BULK.',
  length_m: 'Chiều dài bến phải lớn hơn 0 (tối đa 2 chữ số thập phân).',
  max_depth_m: 'Độ sâu tối đa phải lớn hơn 0 (tối đa 2 chữ số thập phân).',
  available_cranes: 'Số cẩu bờ khả dụng phải là số nguyên từ 0 đến 1000.',
  allows_dangerous: 'Nhãn cho phép hàng nguy hiểm phải là đúng hoặc sai.',
  longitude: 'Kinh độ phải từ -180 đến 180.',
  latitude: 'Vĩ độ phải từ -90 đến 90.',
};

// mode 'create': every required field must be present. mode 'update': any non-empty subset, plus operational_status,
// an optional reason and confirm_affected_plans (spec 6a).
function validateBerth(body, mode) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], value: {} };
  const errors = [];
  const extra = mode === 'update' ? ['operational_status', 'reason', 'confirm_affected_plans'] : [];
  rejectUnknownKeys(body, [...FIELDS, ...extra], errors);
  const value = {};
  for (const field of FIELDS) {
    if (!(field in body)) { if (mode === 'create' && REQUIRED.includes(field)) errors.push({ field, message: MESSAGES[field] }); continue; }
    const v = body[field];
    if ((field === 'longitude' || field === 'latitude') && v === null) { value[field] = null; continue; }
    const checked = CHECKS[field](v);
    if (checked === null) errors.push({ field, message: MESSAGES[field] }); else value[field] = checked;
  }
  // The map needs both coordinates; either both are given or both are empty (alternative flow 3a).
  if (('longitude' in body) !== ('latitude' in body)) errors.push({ field: 'longitude' in body ? 'latitude' : 'longitude', message: 'Nhập cả kinh độ và vĩ độ, hoặc để trống cả hai.' });
  else if (('longitude' in value) && ((value.longitude === null) !== (value.latitude === null))) errors.push({ field: 'latitude', message: 'Nhập cả kinh độ và vĩ độ, hoặc để trống cả hai.' });
  let confirm = false; let reason = null;
  if (mode === 'update') {
    if ('operational_status' in body) {
      if (body.operational_status === 'IN_SERVICE' || body.operational_status === 'OUT_OF_SERVICE') value.operational_status = body.operational_status;
      else errors.push({ field: 'operational_status', message: 'Trạng thái vận hành phải là IN_SERVICE hoặc OUT_OF_SERVICE.' });
    }
    if ('confirm_affected_plans' in body) { if (typeof body.confirm_affected_plans === 'boolean') confirm = body.confirm_affected_plans; else errors.push({ field: 'confirm_affected_plans', message: 'Giá trị xác nhận không hợp lệ.' }); }
    if ('reason' in body && body.reason !== null) { reason = trimmedString(body.reason, 1, 500); if (reason === null) errors.push({ field: 'reason', message: 'Lý do tối đa 500 ký tự.' }); }
    if (Object.keys(value).length === 0 && errors.length === 0) errors.push({ field: 'body', message: 'Không có thay đổi nào để lưu.' });
  } else if (!('berth_name' in value) && errors.length === 0) {
    value.berth_name = value.berth_code; // the form does not ask for a name; the code is used until one is given
  }
  return { errors, value, confirm, reason };
}

const PLACEMENT_KEYS = ['voyage_id', 'berth_id', 'position_start_m', 'position_end_m', 'planned_start', 'planned_end', 'required_cranes'];

function validatePlacement(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], value: {} };
  const errors = []; const value = {};
  rejectUnknownKeys(body, PLACEMENT_KEYS, errors);
  const need = (field, checked, message) => { if (checked === null || checked === undefined) errors.push({ field, message }); else value[field] = checked; };
  need('voyage_id', parseId(body.voyage_id), 'Chuyến tàu không hợp lệ.');
  need('berth_id', parseId(body.berth_id), 'Bến không hợp lệ.');
  need('position_start_m', inRange(body.position_start_m, 0, DIM_MAX), 'Vị trí bắt đầu phải từ 0 m.');
  need('position_end_m', inRange(body.position_end_m, 0, DIM_MAX), 'Vị trí kết thúc không hợp lệ.');
  need('planned_start', parseEta(body.planned_start), 'Giờ cập dự kiến phải theo ISO 8601 kèm múi giờ.');
  need('planned_end', parseEta(body.planned_end), 'Giờ rời dự kiến phải theo ISO 8601 kèm múi giờ.');
  if (value.position_start_m !== undefined && value.position_end_m !== undefined && !(value.position_end_m > value.position_start_m)) errors.push({ field: 'position_end_m', message: 'Vị trí kết thúc phải lớn hơn vị trí bắt đầu.' });
  if (value.planned_start && value.planned_end && !(value.planned_start < value.planned_end)) errors.push({ field: 'planned_end', message: 'Giờ rời phải sau giờ cập.' });
  if ('required_cranes' in body && body.required_cranes !== null) {
    if (Number.isInteger(body.required_cranes) && body.required_cranes >= 0 && body.required_cranes <= CRANES_MAX) value.required_cranes = body.required_cranes;
    else errors.push({ field: 'required_cranes', message: 'Số cẩu bờ cần dùng phải là số nguyên từ 0 đến 1000.' });
  }
  return { errors, value };
}

module.exports = { validateBerth, validatePlacement };
