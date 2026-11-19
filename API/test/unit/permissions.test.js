'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MATRIX, DERIVED, permissionsFor, can } = require('../../src/security/permissions');
const { requirePermission } = require('../../src/http/auth');

const ROLES = ['BAN_QUAN_LY', 'DIEU_PHOI_VIEN', 'NHAN_VIEN_KHO_BAI', 'KY_THUAT_VIEN', 'QUAN_TRI_HE_THONG'];

// Expected values are copied from the SRS matrix (section 2.2). X = view, T = edit, D = approve.
const SRS = {
  M1_VESSELS: { BAN_QUAN_LY: ['approve', 'view'], DIEU_PHOI_VIEN: ['edit', 'notice', 'view'], NHAN_VIEN_KHO_BAI: ['view'], KY_THUAT_VIEN: [], QUAN_TRI_HE_THONG: ['view'] },
  M2_BERTHS: { BAN_QUAN_LY: ['approve', 'view'], DIEU_PHOI_VIEN: ['edit', 'view'], NHAN_VIEN_KHO_BAI: ['view'], KY_THUAT_VIEN: [], QUAN_TRI_HE_THONG: ['view'] },
  M3_CARGO: { BAN_QUAN_LY: ['view'], DIEU_PHOI_VIEN: ['edit', 'view'], NHAN_VIEN_KHO_BAI: ['edit', 'view'], KY_THUAT_VIEN: [], QUAN_TRI_HE_THONG: ['view'] },
  M4_YARD: { BAN_QUAN_LY: ['view'], DIEU_PHOI_VIEN: ['edit', 'view'], NHAN_VIEN_KHO_BAI: ['edit', 'view'], KY_THUAT_VIEN: [], QUAN_TRI_HE_THONG: ['view'] },
  M5_BILLING: { BAN_QUAN_LY: ['approve', 'view'], DIEU_PHOI_VIEN: ['view'], NHAN_VIEN_KHO_BAI: ['edit', 'view'], KY_THUAT_VIEN: [], QUAN_TRI_HE_THONG: ['view'] },
  M6_IOT: { BAN_QUAN_LY: ['view'], DIEU_PHOI_VIEN: ['view'], NHAN_VIEN_KHO_BAI: [], KY_THUAT_VIEN: ['edit', 'view'], QUAN_TRI_HE_THONG: ['edit', 'view'] },
  M7_MONITORING: { BAN_QUAN_LY: ['view'], DIEU_PHOI_VIEN: ['view'], NHAN_VIEN_KHO_BAI: ['view'], KY_THUAT_VIEN: ['view'], QUAN_TRI_HE_THONG: ['view'] },
  M8_REPORTS: { BAN_QUAN_LY: ['view'], DIEU_PHOI_VIEN: ['view'], NHAN_VIEN_KHO_BAI: ['view'], KY_THUAT_VIEN: ['view'], QUAN_TRI_HE_THONG: ['view'] },
  ADMIN: { BAN_QUAN_LY: [], DIEU_PHOI_VIEN: [], NHAN_VIEN_KHO_BAI: [], KY_THUAT_VIEN: [], QUAN_TRI_HE_THONG: ['edit', 'view'] },
};

test('the matrix equals the SRS permission matrix for every internal role and feature', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), Object.keys(SRS).sort());
  for (const [feature, expected] of Object.entries(SRS)) {
    for (const role of ROLES) {
      const derived = ((DERIVED[feature] || {})[role]) || [];
      const fromMatrix = (permissionsFor([role])[feature] ?? []).filter((x) => !derived.includes(x));
      assert.deepEqual(fromMatrix, expected[role], `${feature} / ${role}`);
    }
  }
});

test('grants that come from a use case and not from the SRS matrix are exactly these', () => {
  assert.deepEqual(DERIVED, { M2_BERTHS: { DIEU_PHOI_VIEN: ['override'] } });
  assert.deepEqual(permissionsFor(['DIEU_PHOI_VIEN']).M2_BERTHS, ['edit', 'override', 'view']);
  assert.deepEqual(permissionsFor(['BAN_QUAN_LY']).M2_BERTHS, ['approve', 'view']);
});

test('the external shipping agent only has what UC-013 gives it (own records, arrival notices)', () => {
  const p = permissionsFor(['DAI_LY_HANG_HAI']);
  assert.deepEqual(p, { M1_VESSELS: ['notice', 'view_own'] });
  assert.equal(can(['DAI_LY_HANG_HAI'], 'M1_VESSELS', 'edit'), false);
  assert.equal(can(['DAI_LY_HANG_HAI'], 'M2_BERTHS', 'view'), false);
});

test('unknown roles, no roles and missing arguments are denied (default deny)', () => {
  assert.deepEqual(permissionsFor(['NOT_A_ROLE']), {});
  assert.deepEqual(permissionsFor([]), {});
  assert.deepEqual(permissionsFor(undefined), {});
  assert.equal(can(['QUAN_TRI_HE_THONG'], 'UNKNOWN_FEATURE', 'view'), false);
  assert.equal(can(['QUAN_TRI_HE_THONG'], 'ADMIN'), false, 'no action listed means deny');
});

test('several roles combine their permissions', () => {
  const p = permissionsFor(['KY_THUAT_VIEN', 'DIEU_PHOI_VIEN']);
  assert.deepEqual(p.M1_VESSELS, ['edit', 'notice', 'view']);
  assert.deepEqual(p.M6_IOT, ['edit', 'view']);
});

test('requirePermission: allows a granted action, denies others, and audits the denial', async () => {
  const audited = [];
  const db = {
    sql: { NVarChar: () => 0, VarChar: () => 0, MAX: 0 },
    pool: { request: () => { const r = { input() { return r; }, async query() { audited.push(true); } }; return r; } },
  };
  const run = (roles, action, auditAction) => new Promise((resolve) => {
    requirePermission({ db }, 'M1_VESSELS', [action], auditAction)({ principal: { username: 'u', roles } }, {}, (err) => resolve(err ? err.code : 'ok'));
  });
  assert.equal(await run(['DIEU_PHOI_VIEN'], 'edit'), 'ok');
  assert.equal(await run(['NHAN_VIEN_KHO_BAI'], 'edit', 'SHIP_CREATE'), 'FORBIDDEN');
  assert.equal(audited.length, 1, 'denied attempts are written to the audit log');
  assert.equal(await run(['KY_THUAT_VIEN'], 'view'), 'FORBIDDEN');
  assert.equal(audited.length, 1, 'no audit write when no audit action is named');
  const noPrincipal = await new Promise((resolve) => requirePermission({ db }, 'M1_VESSELS', ['view'])({}, {}, (e) => resolve(e.code)));
  assert.equal(noPrincipal, 'UNAUTHENTICATED');
});
