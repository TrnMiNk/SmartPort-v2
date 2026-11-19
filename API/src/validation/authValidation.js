'use strict';

// Boundary validation for auth requests. Returns a list of field errors; empty means valid.

const USERNAME = /^[A-Za-z0-9._-]{3,100}$/;

function validateLogin(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [{ field: 'body', message: 'Yêu cầu phải là đối tượng JSON.' }];
  }
  if (typeof body.username !== 'string' || !USERNAME.test(body.username)) {
    errors.push({ field: 'username', message: 'Tên đăng nhập gồm 3–100 ký tự chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.' });
  }
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256) {
    errors.push({ field: 'password', message: 'Mật khẩu không hợp lệ.' });
  }
  return errors;
}

module.exports = { validateLogin };
