'use strict';

// Data access for the berth catalog (UC-024). SQL only; decisions live in berthService.

const SELECT = `SELECT b.id, b.berth_code, b.berth_name, b.berth_type, b.length_m, b.max_depth_m, b.available_cranes, b.allows_dangerous,
  b.longitude, b.latitude, b.operational_status, b.is_active, b.revision, b.created_at, b.updated_at`;
const FROM = (lock) => `FROM dbo.berths b ${lock ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}`;

const COLUMN_TYPES = {
  berth_code: (sql) => sql.VarChar(20),
  berth_name: (sql) => sql.NVarChar(200),
  berth_type: (sql) => sql.VarChar(20),
  length_m: (sql) => sql.Decimal(10, 2),
  max_depth_m: (sql) => sql.Decimal(10, 2),
  available_cranes: (sql) => sql.Int,
  allows_dangerous: (sql) => sql.Bit,
  longitude: (sql) => sql.Decimal(11, 8),
  latitude: (sql) => sql.Decimal(10, 8),
  operational_status: (sql) => sql.VarChar(20),
};

// BIGINT revision arrives as a string; expose a number (see shipsRepository). DECIMAL columns arrive as numbers.
const shape = (row) => (row ? { ...row, revision: Number(row.revision), allows_dangerous: !!row.allows_dangerous, is_active: !!row.is_active } : null);

async function findById(db, id, { lock = false } = {}) {
  const r = await db.pool.request().input('id', db.sql.Int, id).query(`${SELECT} ${FROM(lock)} WHERE b.id = @id`);
  return shape(r.recordset[0]);
}

async function findByCode(db, code) {
  const r = await db.pool.request().input('c', db.sql.VarChar(20), code)
    .query('SELECT id FROM dbo.berths WITH (UPDLOCK, HOLDLOCK) WHERE berth_code = @c');
  return r.recordset[0] ?? null;
}

async function insert(db, v) {
  const req = db.pool.request();
  const cols = []; const vals = [];
  for (const [column, value] of Object.entries({ ...v })) {
    if (!COLUMN_TYPES[column]) throw new Error(`column not insertable: ${column}`); // allow-list, never user text
    req.input(column, COLUMN_TYPES[column](db.sql), value ?? null);
    cols.push(column); vals.push('@' + column);
  }
  const r = await req.query(`INSERT INTO dbo.berths (${cols.join(', ')}) OUTPUT inserted.id VALUES (${vals.join(', ')})`);
  return r.recordset[0].id;
}

// Optimistic update: succeeds only if the stored revision still equals `revision`.
async function update(db, id, revision, fields) {
  const req = db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision);
  const sets = [];
  for (const [column, value] of Object.entries(fields)) {
    if (!COLUMN_TYPES[column]) throw new Error(`column not updatable: ${column}`);
    req.input(column, COLUMN_TYPES[column](db.sql), value);
    sets.push(`${column} = @${column}`);
  }
  const r = await req.query(`UPDATE dbo.berths SET ${sets.join(', ')}, revision = revision + 1, updated_at = SYSUTCDATETIME()
                             WHERE id = @id AND revision = @rev`);
  return r.rowsAffected[0] === 1;
}

async function list(db, { offset, size }) {
  const total = await db.pool.request().query('SELECT COUNT(*) AS n FROM dbo.berths WHERE is_active = 1');
  const rows = await db.pool.request().input('offset', db.sql.Int, offset).input('size', db.sql.Int, size)
    .query(`${SELECT} ${FROM(false)} WHERE b.is_active = 1 ORDER BY b.berth_code OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  return { items: rows.recordset.map(shape), total: total.recordset[0].n };
}

// Plans that a change of length or depth can affect: not yet decided or approved (spec 6a).
async function openPlans(db, berthId) {
  const r = await db.pool.request().input('b', db.sql.Int, berthId).query(
    `SELECT bp.id, bp.plan_status, bp.planned_start, bp.planned_end, v.voyage_code FROM dbo.berth_plans bp
     JOIN dbo.voyages v ON v.id = bp.voyage_id
     WHERE bp.berth_id = @b AND bp.plan_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED') ORDER BY bp.planned_start, bp.id`);
  return r.recordset;
}

module.exports = { findById, findByCode, insert, update, list, openPlans };
