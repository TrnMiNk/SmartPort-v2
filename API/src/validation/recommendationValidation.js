'use strict';

// Request checks for UC-027 berth recommendations.

const { parseId, trimmedString, rejectUnknownKeys } = require('./common');
const { MAX_VESSELS } = require('../ai/berthAdapter');

// Body of a request: optional list of at most 20 distinct waiting voyages. Without a list the first 20 of the queue are used.
function validateGenerate(body) {
  if (body === undefined || body === null) return { errors: [], voyageIds: null };
  if (typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], voyageIds: null };
  const errors = [];
  rejectUnknownKeys(body, ['voyage_ids'], errors);
  let ids = null;
  if (body.voyage_ids !== undefined && body.voyage_ids !== null) {
    if (!Array.isArray(body.voyage_ids) || body.voyage_ids.length < 1) errors.push({ field: 'voyage_ids', message: 'Cần chọn ít nhất một tàu trong hàng đợi.' });
    else if (body.voyage_ids.length > MAX_VESSELS) errors.push({ field: 'voyage_ids', message: `Chỉ được chọn tối đa ${MAX_VESSELS} tàu.` });
    else {
      ids = body.voyage_ids.map(parseId);
      if (ids.some((x) => x === null)) errors.push({ field: 'voyage_ids', message: 'Mã chuyến không hợp lệ.' });
      else if (new Set(ids).size !== ids.length) errors.push({ field: 'voyage_ids', message: 'Có tàu bị chọn nhiều lần.' });
    }
  }
  return { errors, voyageIds: errors.length ? null : ids };
}

function validateIgnore(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }] };
  const errors = [];
  rejectUnknownKeys(body, ['voyage_id', 'reason'], errors);
  const voyageId = parseId(body.voyage_id);
  if (voyageId === null) errors.push({ field: 'voyage_id', message: 'Mã chuyến không hợp lệ.' });
  let reason = null;
  if (body.reason !== undefined && body.reason !== null) {
    reason = trimmedString(body.reason, 1, 500);
    if (reason === null) errors.push({ field: 'reason', message: 'Lý do từ 1 đến 500 ký tự.' });
  }
  return { errors, voyageId, reason };
}

module.exports = { validateGenerate, validateIgnore };
