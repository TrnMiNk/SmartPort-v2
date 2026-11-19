'use strict';

// Validation for berth plans (UC-028 manual drafts, UC-029 submission) and for the cargo hazard verification (UC-026 BR-03).

const { parseId, trimmedString, rejectUnknownKeys } = require('./common');
const { validatePlacement } = require('./berthValidation');

// Body of a draft: the placement of UC-026, an optional override reason and an optional proposal_id (UC-027: a draft made from a recommendation).
// The source is never taken from the client: it is MANUAL, or AI / AI_ADJUSTED when a proposal is given (the service compares the plan with the proposal).
function validatePlanBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], value: {} };
  const { source, override_reason: overrideReason, proposal_id: proposalRaw, ...placementBody } = body;
  const { errors, value } = validatePlacement(placementBody);
  let proposalId = null;
  if (proposalRaw !== undefined && proposalRaw !== null) {
    proposalId = parseId(proposalRaw);
    if (proposalId === null) errors.push({ field: 'proposal_id', message: 'Mã đề xuất không hợp lệ.' });
    if (source !== undefined) errors.push({ field: 'source', message: 'Không gửi source cùng proposal_id: nguồn do hệ thống xác định.' });
  } else if (source !== undefined && source !== 'MANUAL') errors.push({ field: 'source', message: 'Chỉ hỗ trợ source = MANUAL; kế hoạch từ đề xuất dùng proposal_id.' });
  let reason = null;
  if (overrideReason !== undefined && overrideReason !== null) {
    reason = trimmedString(overrideReason, 1, 500);
    if (reason === null) errors.push({ field: 'override_reason', message: 'Lý do ghi đè từ 1 đến 500 ký tự.' });
  }
  return { errors, value, overrideReason: reason, proposalId };
}

function validateSubmit(body) {
  if (body === undefined || body === null) return { errors: [], overrideReason: null };
  if (typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], overrideReason: null };
  const errors = [];
  rejectUnknownKeys(body, ['override_reason'], errors);
  let reason = null;
  if (body.override_reason !== undefined && body.override_reason !== null) {
    reason = trimmedString(body.override_reason, 1, 500);
    if (reason === null) errors.push({ field: 'override_reason', message: 'Lý do ghi đè từ 1 đến 500 ký tự.' });
  }
  return { errors, overrideReason: reason };
}

function validateReject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }], reason: null };
  const errors = [];
  rejectUnknownKeys(body, ['reason'], errors);
  const reason = trimmedString(body.reason, 1, 500);
  if (reason === null) errors.push({ field: 'reason', message: 'Từ chối bắt buộc có lý do (1 đến 500 ký tự).' });
  return { errors, reason };
}

function validateHazard(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }] };
  const errors = [];
  rejectUnknownKeys(body, ['cargo_hazard', 'basis'], errors);
  if (body.cargo_hazard !== 'NONE' && body.cargo_hazard !== 'DANGEROUS') errors.push({ field: 'cargo_hazard', message: 'Phải là NONE (không có hàng nguy hiểm) hoặc DANGEROUS.' });
  const basis = trimmedString(body.basis, 1, 500);
  if (basis === null) errors.push({ field: 'basis', message: 'Bắt buộc nêu căn cứ xác minh (ví dụ số danh mục hàng hóa), tối đa 500 ký tự.' });
  return { errors, cargoHazard: body.cargo_hazard, basis };
}

module.exports = { validateReject, validatePlanBody, validateSubmit, validateHazard, parseId };
