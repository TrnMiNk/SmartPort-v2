'use strict';

// Small boundary-validation helpers shared by request validators. Each returns a value or null/undefined on failure;
// the callers turn failures into { field, message } entries (rule 04: validate every external input).

const MAX_INT = 2147483647;

function parseId(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 && raw <= MAX_INT ? raw : null;
  if (typeof raw === 'string' && /^[0-9]{1,10}$/.test(raw)) {
    const n = Number(raw);
    return n > 0 && n <= MAX_INT ? n : null;
  }
  return null;
}

// Positive decimal with at most two fraction digits and an upper bound set by the column size.
function parsePositiveDecimal(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) return null;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 ? Math.round(value * 100) / 100 : null;
}

function trimmedString(value, min, max) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length >= min && t.length <= max ? t : null;
}

// Pagination: page is zero-based. Defaults page 0, size 20; size is limited to 100.
function parsePaging(query, errors) {
  const page = query.page === undefined ? 0 : (/^[0-9]{1,6}$/.test(String(query.page)) ? Number(query.page) : null);
  const size = query.size === undefined ? 20 : (/^[0-9]{1,3}$/.test(String(query.size)) ? Number(query.size) : null);
  if (page === null) errors.push({ field: 'page', message: 'Trang phải là số nguyên không âm.' });
  if (size === null || size < 1 || size > 100) errors.push({ field: 'size', message: 'Kích thước trang phải từ 1 đến 100.' });
  return { page, size };
}

// Revision from an If-Match header: "5" or 5. Returns null when missing or malformed.
function parseIfMatch(header) {
  if (typeof header !== 'string') return null;
  const m = header.trim().match(/^(?:W\/)?"?([0-9]{1,18})"?$/);
  return m ? Number(m[1]) : null;
}

function rejectUnknownKeys(body, allowed, errors) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ field: key, message: 'Trường không được hỗ trợ.' });
  }
}

module.exports = { MAX_INT, parseId, parsePositiveDecimal, trimmedString, parsePaging, parseIfMatch, rejectUnknownKeys };
