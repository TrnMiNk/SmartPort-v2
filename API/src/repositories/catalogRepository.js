'use strict';

// Read access to the reference catalogs used by the M1 forms (UC-006, read-only here). Inactive entries are excluded.

async function shipTypes(db) {
  const r = await db.pool.request().query(
    'SELECT id, type_code AS code, type_name AS name, cargo_class FROM dbo.ship_types WHERE is_active = 1 ORDER BY type_name');
  return r.recordset;
}

async function ports(db) {
  const r = await db.pool.request().query(
    'SELECT id, port_code AS code, port_name AS name FROM dbo.ports WHERE is_active = 1 ORDER BY port_name');
  return r.recordset;
}

// Berths are owned by Module 2 (UC-024); this read-only list only feeds the schedule filter.
async function berths(db) {
  const r = await db.pool.request().query('SELECT id, berth_code AS code, berth_name AS name FROM dbo.berths WHERE is_active = 1 ORDER BY berth_code');
  return r.recordset;
}

// agentIds: null means all agents; an array limits the list to those agents.
async function agents(db, agentIds) {
  const req = db.pool.request();
  (agentIds || []).forEach((a, i) => req.input(`a${i}`, db.sql.Int, a));
  const filter = agentIds ? (agentIds.length ? `AND id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})` : 'AND 1 = 0') : '';
  const r = await req.query(`SELECT id, agent_code AS code, agent_name AS name FROM dbo.agents WHERE is_active = 1 ${filter} ORDER BY agent_name`);
  return r.recordset;
}

const exists = (table) => async (db, id) => {
  const r = await db.pool.request().input('id', db.sql.Int, id).query(`SELECT id FROM dbo.${table} WHERE id = @id AND is_active = 1`);
  return r.recordset.length > 0;
};

module.exports = {
  shipTypes, ports, agents, berths,
  activeShipTypeExists: exists('ship_types'),
  activeAgentExists: exists('agents'),
  activePortExists: exists('ports'),
};
