'use strict';

// Maps every thrown error to the single response contract. Unknown errors become a generic 500 with no
// details. Server-side logs record the error name and code only, never SQL text or stack traces sent to clients.

const { AppError, errors } = require('../errors');

function notFoundHandler(req, res, next) {
  next(errors.notFound());
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    return sendError(res, err.status, err.code, err.message, err.details);
  }

  // Safety net for a race that slips past the service checks: SQL Server's unique constraints still hold, and the
  // violation is reported as a conflict instead of a server error. Only the constraint name is read, never sent on.
  const message = err && typeof err.message === 'string' ? err.message : '';
  if (/UQ_ships_imo|UQ_ships_code/.test(message)) {
    return sendError(res, 409, 'CONFLICT', 'Số IMO đã tồn tại.', { field: 'imo_number', message: 'Số IMO đã tồn tại.' });
  }
  if (/UQ_voyages_ship_code/.test(message)) {
    return sendError(res, 409, 'CONFLICT', 'Thông báo cho tàu và chuyến này đã tồn tại.', { rule: 'DUPLICATE_NOTICE' });
  }

  // Malformed JSON or oversized body from express.json().
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    return sendError(res, status, 'VALIDATION_FAILED', 'Yêu cầu không đúng định dạng JSON hoặc quá lớn.');
  }

  // The SQL Server error number (for example 1205 = deadlock victim) helps operations; the message may contain SQL, so it is not logged.
  const sqlNumber = err && (err.number || (err.originalError && err.originalError.info && err.originalError.info.number));
  process.stderr.write(`unhandled error: ${err && err.name} ${err && err.code ? err.code : ''}${sqlNumber ? ' sql=' + sqlNumber : ''}\n`);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Đã xảy ra lỗi. Vui lòng thử lại sau.');
}

function sendError(res, status, code, message, details) {
  const body = { success: false, error: { code, message } };
  if (details) body.error.details = details;
  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
