'use strict';

// Data access for vessel profiles. SQL only; decisions live in shipService.

const SELECT = `SELECT s.id, s.ship_code, s.imo_number, s.ship_name, s.flag_state, s.ship_type_id, t.type_name AS ship_type_name,
  s.operator_agent_id, a.agent_name AS operator_agent_name, s.length_overall_m, s.beam_m, s.max_draft_m, s.deadweight_t,
  s.is_active, s.revision, s.created_at, s.updated_at`;

const FROM = (lock) => `FROM dbo.ships s ${lock ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
  JOIN dbo.ship_types t ON t.id = s.ship_type_id LEFT JOIN dbo.agents a ON a.id = s.operator_agent_id`;

// Parameter types per updatable column. Sizes match the schema.
const COLUMN_TYPES = {
  imo_number: (sql) => sql.Char(7),
  ship_name: (sql) => sql.NVarChar(200),
  flag_state: (sql) => sql.NVarChar(100),
  ship_type_id: (sql) => sql.Int,
  operator_agent_id: (sql) => sql.Int,
  length_overall_m: (sql) => sql.Decimal(10, 2),
  beam_m: (sql) => sql.Decimal(10, 2),
  max_draft_m: (sql) => sql.Decimal(10, 2),
  deadweight_t: (sql) => sql.Decimal(12, 2),
};

const escapeLike = (text) => text.replace(/[\\%_[]/g, (c) => '\\' + c);

// SQL Server returns BIGINT as a string (to avoid precision loss). Revisions are small counters, so they are exposed
// as numbers, as the API contract says; without this, revision comparisons would never match.
const shape = (row) => (row ? { ...row, revision: Number(row.revision) } : null);

async function findById(db, id, { lock = false } = {}) {
  const r = await db.pool.request().input('id', db.sql.Int, id).query(`${SELECT} ${FROM(lock)} WHERE s.id = @id`);
  return shape(r.recordset[0]);
}

async function findByImo(db, imo) {
  const r = await db.pool.request().input('imo', db.sql.Char(7), imo)
    .query('SELECT id FROM dbo.ships WITH (UPDLOCK, HOLDLOCK) WHERE imo_number = @imo');
  return r.recordset[0] ?? null;
}

async function insert(db, v, actorCode) {
  const r = await db.pool.request()
    .input('code', db.sql.VarChar(50), actorCode)
    .input('imo', db.sql.Char(7), v.imo_number)
    .input('name', db.sql.NVarChar(200), v.ship_name)
    .input('flag', db.sql.NVarChar(100), v.flag_state ?? null)
    .input('typeId', db.sql.Int, v.ship_type_id)
    .input('agentId', db.sql.Int, v.operator_agent_id ?? null)
    .input('loa', db.sql.Decimal(10, 2), v.length_overall_m)
    .input('beam', db.sql.Decimal(10, 2), v.beam_m)
    .input('draft', db.sql.Decimal(10, 2), v.max_draft_m)
    .input('dwt', db.sql.Decimal(12, 2), v.deadweight_t)
    .query(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, flag_state, ship_type_id, operator_agent_id,
              length_overall_m, beam_m, max_draft_m, deadweight_t)
            OUTPUT inserted.id
            VALUES (@code, @imo, @name, @flag, @typeId, @agentId, @loa, @beam, @draft, @dwt)`);
  return r.recordset[0].id;
}

// Optimistic update: succeeds only if the stored revision still equals `revision`. Returns true if a row changed.
async function update(db, id, revision, fields) {
  const req = db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision);
  const sets = [];
  for (const [column, value] of Object.entries(fields)) {
    if (!COLUMN_TYPES[column]) throw new Error(`column not updatable: ${column}`); // allow-list, never user text
    req.input(column, COLUMN_TYPES[column](db.sql), value);
    sets.push(`${column} = @${column}`);
  }
  const r = await req.query(`UPDATE dbo.ships SET ${sets.join(', ')}, revision = revision + 1, updated_at = SYSUTCDATETIME()
                             WHERE id = @id AND revision = @rev`);
  return r.rowsAffected[0] === 1;
}

async function setInactive(db, id, revision) {
  const r = await db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision)
    .query(`UPDATE dbo.ships SET is_active = 0, revision = revision + 1, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND revision = @rev AND is_active = 1`);
  return r.rowsAffected[0] === 1;
}

// agentIds: null means no restriction; an array limits results to vessels operated by those agents.
async function list(db, { search, includeInactive, agentIds, offset, size }) {
  const where = [];
  const bind = (req) => {
    if (search) {
      req.input('imoLike', db.sql.VarChar(100), escapeLike(search) + '%');
      req.input('nameLike', db.sql.NVarChar(300), '%' + escapeLike(search) + '%');
    }
    (agentIds || []).forEach((a, i) => req.input(`a${i}`, db.sql.Int, a));
    return req;
  };
  if (search) where.push("(s.imo_number LIKE @imoLike ESCAPE '\\' OR s.ship_name LIKE @nameLike ESCAPE '\\')");
  if (!includeInactive) where.push('s.is_active = 1');
  if (agentIds) where.push(agentIds.length ? `s.operator_agent_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})` : '1 = 0');
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = await bind(db.pool.request()).query(`SELECT COUNT(*) AS n ${FROM(false)} ${clause}`);
  const rows = await bind(db.pool.request())
    .input('offset', db.sql.Int, offset).input('size', db.sql.Int, size)
    .query(`${SELECT} ${FROM(false)} ${clause} ORDER BY s.ship_name, s.id OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  return { items: rows.recordset.map(shape), total: total.recordset[0].n };
}

// A voyage is unfinished unless it has departed or was rejected (UC011 assumption A-2).
async function findUnfinishedVoyages(db, shipId) {
  const r = await db.pool.request().input('id', db.sql.Int, shipId)
    .query(`SELECT TOP 5 id, voyage_code, status FROM dbo.voyages WHERE ship_id = @id AND status NOT IN ('DEPARTED', 'REJECTED')`);
  return r.recordset;
}

module.exports = { findById, findByImo, insert, update, setInactive, list, findUnfinishedVoyages };
