'use strict';

// Role-to-feature permissions. Source: SRS section 2.2 "Ma trận phân quyền tổng quát" (docs/use-cases/UC005.md §3).
//   X = view, T = create/edit, D = approve. "–" means no entry (default deny).
// Features follow the SRS modules: M1 vessels and schedule, M2 berths, M3 cargo, M4 yard and gate, M5 billing,
// M6 IoT and maintenance, M7 POC/TOC and GIS, M8 reports, ADMIN user management and configuration.
//
// Not in the matrix (assumptions, see UC005 A-5 to A-7):
//  - DAI_LY_HANG_HAI is an external actor, not one of the five internal groups. Its only rights come from
//    UC-013 and UC-012: announce arrivals and attach documents for its own agent. Action 'view_own' limits reads
//    to records of its linked agents.
//  - 'notice' (create an arrival notice, UC-013) is granted to the coordinator because UC-013 names the coordinator
//    as a primary actor, in addition to the agent.
//  - "giới hạn" and "phạm vi bộ phận" scopes for M7 and M8 are not defined, so they are plain 'view' here.

const MATRIX = {
  M1_VESSELS: {
    BAN_QUAN_LY: ['view', 'approve'],
    DIEU_PHOI_VIEN: ['view', 'edit', 'notice'],
    NHAN_VIEN_KHO_BAI: ['view'],
    QUAN_TRI_HE_THONG: ['view'],
    DAI_LY_HANG_HAI: ['view_own', 'notice'],
  },
  M2_BERTHS: {
    BAN_QUAN_LY: ['view', 'approve'],
    DIEU_PHOI_VIEN: ['view', 'edit'],
    NHAN_VIEN_KHO_BAI: ['view'],
    QUAN_TRI_HE_THONG: ['view'],
  },
  M3_CARGO: {
    BAN_QUAN_LY: ['view'],
    DIEU_PHOI_VIEN: ['view', 'edit'],
    NHAN_VIEN_KHO_BAI: ['view', 'edit'],
    QUAN_TRI_HE_THONG: ['view'],
  },
  M4_YARD: {
    BAN_QUAN_LY: ['view'],
    DIEU_PHOI_VIEN: ['view', 'edit'],
    NHAN_VIEN_KHO_BAI: ['view', 'edit'],
    QUAN_TRI_HE_THONG: ['view'],
  },
  M5_BILLING: {
    BAN_QUAN_LY: ['view', 'approve'],
    DIEU_PHOI_VIEN: ['view'],
    NHAN_VIEN_KHO_BAI: ['view', 'edit'],
    QUAN_TRI_HE_THONG: ['view'],
  },
  M6_IOT: {
    BAN_QUAN_LY: ['view'],
    DIEU_PHOI_VIEN: ['view'],
    KY_THUAT_VIEN: ['view', 'edit'],
    QUAN_TRI_HE_THONG: ['view', 'edit'],
  },
  M7_MONITORING: {
    BAN_QUAN_LY: ['view'],
    DIEU_PHOI_VIEN: ['view'],
    NHAN_VIEN_KHO_BAI: ['view'],
    KY_THUAT_VIEN: ['view'],
    QUAN_TRI_HE_THONG: ['view'],
  },
  M8_REPORTS: {
    BAN_QUAN_LY: ['view'],
    DIEU_PHOI_VIEN: ['view'],
    NHAN_VIEN_KHO_BAI: ['view'],
    KY_THUAT_VIEN: ['view'],
    QUAN_TRI_HE_THONG: ['view'],
  },
  ADMIN: {
    QUAN_TRI_HE_THONG: ['view', 'edit'],
  },
};

// Grants that come from a use case, not from the SRS matrix (kept apart so the matrix stays exactly the SRS table).
//  - M2_BERTHS 'override': accept a berth placement that breaks a rule, with a reason (UC-028 3a). The coordinator is the only actor of UC-028.
const DERIVED = { M2_BERTHS: { DIEU_PHOI_VIEN: ['override'] } };

// Union of the actions granted by all of the user's roles, per feature. Unknown roles grant nothing.
function permissionsFor(roles) {
  const result = {};
  for (const [feature, byRole] of Object.entries(MATRIX)) {
    const actions = new Set();
    for (const role of roles || []) {
      for (const action of byRole[role] || []) actions.add(action);
      for (const action of (DERIVED[feature] || {})[role] || []) actions.add(action);
    }
    if (actions.size > 0) result[feature] = [...actions].sort();
  }
  return result;
}

// True if the roles grant at least one of the actions on the feature. No actions listed means deny.
function can(roles, feature, ...actions) {
  const granted = permissionsFor(roles)[feature] || [];
  return actions.length > 0 && actions.some((a) => granted.includes(a));
}

module.exports = { MATRIX, DERIVED, permissionsFor, can };
