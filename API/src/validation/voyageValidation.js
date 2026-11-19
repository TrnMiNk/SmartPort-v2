'use strict';

// Validation for arrival notices (UC-013). ETA must be ISO 8601 with an explicit offset (UTC or +hh:mm) so a
// notice never depends on the server's time zone (spec: ISO 8601, stored UTC, shown UTC+7).

const { MAX_INT, parseId, trimmedString, rejectUnknownKeys } = require('./common');

const FIELDS = ['ship_id', 'voyage_code', 'agent_id', 'origin_port_id', 'declared_eta', 'declared_teu',
  'cargo_type', 'service_request', 'priority_class'];
const REQUIRED = ['ship_id', 'voyage_code', 'agent_id', 'origin_port_id', 'declared_eta', 'declared_teu', 'cargo_type'];
const PRIORITY = ['STANDARD', 'MAIN_LINE', 'REEFER_OR_HAZARD'];
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;

// JavaScript's Date silently rolls impossible dates forward (2026-02-30 becomes 2026-03-02), so the calendar fields
// are checked against a UTC date built from the same numbers before the value is accepted.
function parseEta(value) {
  if (typeof value !== 'string') return null;
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const real = probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
    && probe.getUTCHours() === h && probe.getUTCMinutes() === mi && probe.getUTCSeconds() === s;
  if (!real || (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59))) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateNotice(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], value: {} };
  }
  rejectUnknownKeys(body, FIELDS, errors);
  const value = {};
  const need = (field, ok, message) => {
    if (!(field in body)) { if (REQUIRED.includes(field)) errors.push({ field, message }); return; }
    if (ok === null || ok === undefined) errors.push({ field, message }); else value[field] = ok;
  };
  need('ship_id', parseId(body.ship_id), 'Vui lòng chọn tàu.');
  need('voyage_code', typeof body.voyage_code === 'string' && /^[A-Za-z0-9._/-]{1,50}$/.test(body.voyage_code.trim())
    ? body.voyage_code.trim() : null, 'Mã chuyến gồm 1–50 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang hoặc gạch chéo.');
  need('agent_id', parseId(body.agent_id), 'Vui lòng chọn đại lý.');
  need('origin_port_id', parseId(body.origin_port_id), 'Vui lòng chọn cảng đi.');
  need('declared_eta', parseEta(body.declared_eta), 'ETA khai báo phải theo ISO 8601 kèm múi giờ (ví dụ 2026-12-01T08:00:00Z).');
  need('declared_teu', Number.isInteger(body.declared_teu) && body.declared_teu >= 0 && body.declared_teu <= MAX_INT
    ? body.declared_teu : null, 'Số TEU phải là số nguyên không âm.');
  need('cargo_type', trimmedString(body.cargo_type, 1, 100), 'Loại hàng là bắt buộc, tối đa 100 ký tự.');
  if ('service_request' in body) {
    if (body.service_request === null) value.service_request = null;
    else need('service_request', trimmedString(body.service_request, 1, 1000), 'Yêu cầu dịch vụ tối đa 1000 ký tự.');
  }
  if ('priority_class' in body) {
    need('priority_class', PRIORITY.includes(body.priority_class) ? body.priority_class : null,
      'Mức ưu tiên phải là STANDARD, MAIN_LINE hoặc REEFER_OR_HAZARD.');
  }
  return { errors, value };
}

module.exports = { validateNotice, parseEta, PRIORITY };
