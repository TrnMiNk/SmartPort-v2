'use strict';

// Data access for voyages (arrival notices) and their status history. SQL only.

const SELECT = `SELECT v.id, v.ship_id, s.ship_name, s.imo_number, v.voyage_code, v.status, v.agent_id, a.agent_name,
  v.origin_port_id, p.port_name AS origin_port_name, v.declared_eta, v.declared_teu, v.cargo_type, v.service_request,
  v.priority_class, v.announced_at, v.revision, v.created_at, v.validation_result, v.validation_reason, v.validation_policy_version, v.queue_position,
  v.cargo_hazard, v.cargo_hazard_basis, v.cargo_hazard_verified_at
  FROM dbo.voyages v JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.agents a ON a.id = v.agent_id
  JOIN dbo.ports p ON p.id = v.origin_port_id`;

// BIGINT revision comes back as a string from SQL Server; expose it as a number (see shipsRepository).
const shape = (row) => (row ? { ...row, revision: Number(row.revision) } : null);

async function findById(db, id) {
  const r = await db.pool.request().input('id', db.sql.Int, id).query(`${SELECT} WHERE v.id = @id`);
  return shape(r.recordset[0]);
}

async function findByShipAndCode(db, shipId, code) {
  const r = await db.pool.request().input('shipId', db.sql.Int, shipId).input('code', db.sql.VarChar(50), code)
    .query('SELECT id FROM dbo.voyages WITH (UPDLOCK, HOLDLOCK) WHERE ship_id = @shipId AND voyage_code = @code');
  return r.recordset[0] ?? null;
}

async function insert(db, v, announcedByUserId) {
  const r = await db.pool.request()
    .input('shipId', db.sql.Int, v.ship_id)
    .input('code', db.sql.VarChar(50), v.voyage_code)
    .input('agentId', db.sql.Int, v.agent_id)
    .input('portId', db.sql.Int, v.origin_port_id)
    .input('eta', db.sql.DateTime2(3), v.declared_eta)
    .input('teu', db.sql.Int, v.declared_teu)
    .input('cargo', db.sql.NVarChar(100), v.cargo_type)
    .input('service', db.sql.NVarChar(1000), v.service_request ?? null)
    .input('priority', db.sql.VarChar(20), v.priority_class)
    .input('userId', db.sql.BigInt, announcedByUserId)
    .query(`INSERT INTO dbo.voyages (ship_id, voyage_code, agent_id, origin_port_id, declared_eta, declared_teu,
              cargo_type, service_request, priority_class, announced_by_user_id)
            OUTPUT inserted.id
            VALUES (@shipId, @code, @agentId, @portId, @eta, @teu, @cargo, @service, @priority, @userId)`);
  return r.recordset[0].id;
}

async function insertHistory(db, { voyageId, fromStatus, toStatus, reason, actor }) {
  await db.pool.request()
    .input('voyageId', db.sql.Int, voyageId)
    .input('from', db.sql.VarChar(20), fromStatus ?? null)
    .input('to', db.sql.VarChar(20), toStatus)
    .input('reason', db.sql.NVarChar(500), reason ?? null)
    .input('actor', db.sql.NVarChar(100), actor)
    .query(`INSERT INTO dbo.voyage_status_history (voyage_id, from_status, to_status, reason, actor)
            VALUES (@voyageId, @from, @to, @reason, @actor)`);
}

async function historyFor(db, voyageId) {
  const r = await db.pool.request().input('id', db.sql.Int, voyageId)
    .query(`SELECT from_status, to_status, reason, actor, changed_at FROM dbo.voyage_status_history
            WHERE voyage_id = @id ORDER BY id`);
  return r.recordset;
}

// agentIds: null means no restriction; an array limits results to those agents' voyages.
async function list(db, { status, shipId, agentIds, offset, size }) {
  const where = [];
  const bind = (req) => {
    if (status) req.input('status', db.sql.VarChar(20), status);
    if (shipId) req.input('shipId', db.sql.Int, shipId);
    (agentIds || []).forEach((a, i) => req.input(`a${i}`, db.sql.Int, a));
    return req;
  };
  if (status) where.push('v.status = @status');
  if (shipId) where.push('v.ship_id = @shipId');
  if (agentIds) where.push(agentIds.length ? `v.agent_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})` : '1 = 0');
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = await bind(db.pool.request()).query(`SELECT COUNT(*) AS n FROM dbo.voyages v ${clause}`);
  const rows = await bind(db.pool.request()).input('offset', db.sql.Int, offset).input('size', db.sql.Int, size)
    .query(`${SELECT} ${clause} ORDER BY v.id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  return { items: rows.recordset.map(shape), total: total.recordset[0].n };
}

async function setCargoHazard(db, id, { hazard, basis, userId }) {
  await db.pool.request().input('id', db.sql.Int, id).input('h', db.sql.VarChar(12), hazard).input('b', db.sql.NVarChar(500), basis).input('u', db.sql.BigInt, userId)
    .query(`UPDATE dbo.voyages SET cargo_hazard = @h, cargo_hazard_basis = @b, cargo_hazard_verified_by_user_id = @u, cargo_hazard_verified_at = SYSUTCDATETIME(),
            revision = revision + 1, updated_at = SYSUTCDATETIME() WHERE id = @id`);
}

// UC-022 / UC-023. Row lock first; the guarded UPDATEs below only succeed for the status and revision the caller saw.
async function lockForMovement(db, id) {
  const r = await db.pool.request().input('id', db.sql.Int, id).query(
    `SELECT v.id, v.voyage_code, v.status, v.revision, v.agent_id, v.ata, v.atd
     FROM dbo.voyages v WITH (UPDLOCK, HOLDLOCK) WHERE v.id = @id`);
  return shape(r.recordset[0]);
}

async function markBerthed(db, id, revision, ata) {
  const r = await db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision).input('ata', db.sql.DateTime2(3), ata)
    .query(`UPDATE dbo.voyages SET status = 'BERTHED', ata = @ata, revision = revision + 1, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND revision = @rev AND status = 'BERTH_ASSIGNED'`);
  return r.rowsAffected[0] === 1;
}

async function markDeparted(db, id, revision, atd) {
  const r = await db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision).input('atd', db.sql.DateTime2(3), atd)
    .query(`UPDATE dbo.voyages SET status = 'DEPARTED', atd = @atd, revision = revision + 1, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND revision = @rev AND status = 'BERTHED'`);
  return r.rowsAffected[0] === 1;
}

module.exports = { lockForMovement, markBerthed, markDeparted, setCargoHazard, findById, findByShipAndCode, insert, insertHistory, historyFor, list };
