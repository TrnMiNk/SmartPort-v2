'use strict';

// Read-only reference lists for the M1 forms (UC-006, minimal). Agents see only their own agents.

const catalog = require('../repositories/catalogRepository');
const { can } = require('../security/permissions');

const agentScope = (principal) => (can(principal.roles, 'M1_VESSELS', 'view') ? null : principal.agentIds);

module.exports = {
  shipTypes: (db) => catalog.shipTypes(db),
  ports: (db) => catalog.ports(db),
  berths: (db) => catalog.berths(db),
  agents: (db, principal) => catalog.agents(db, agentScope(principal)),
};
