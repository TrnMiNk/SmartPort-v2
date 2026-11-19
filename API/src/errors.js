'use strict';

// One error contract for every endpoint (rule 04). Clients get code, message and optional field details only.
// Stack traces, SQL text and internal identifiers never leave the server.

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  validation: (details) => new AppError(400, 'VALIDATION_FAILED', 'Dữ liệu không hợp lệ.', details),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Chưa đăng nhập hoặc phiên đã hết hạn.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này.'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.'),
  // 409: the request is valid but conflicts with current data (duplicate key, stale revision).
  conflict: (message, details) => new AppError(409, 'CONFLICT', message, details),
  // 409: a business rule refuses the operation. `details.rule` names the rule.
  businessRule: (message, details) => new AppError(409, 'BUSINESS_RULE_VIOLATION', message, details),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng.'),
  accountLocked: () => new AppError(423, 'ACCOUNT_LOCKED',
    'Tài khoản đang bị khóa tạm thời. Vui lòng liên hệ Quản trị hệ thống hoặc thử lại sau.'),
  accountInactive: () => new AppError(403, 'ACCOUNT_INACTIVE',
    'Tài khoản đã bị khóa. Vui lòng liên hệ Quản trị hệ thống.'),
};

module.exports = { AppError, errors };
