'use strict';

// Data access for arrival notice drafts (UC-013 alternative flow 3a). A draft belongs to one user. SQL only.

const shape = (row) => (row ? { ...row, revision: Number(row.revision), payload: JSON.parse(row.payload) } : null);
const COLUMNS = 'id, owner_user_id, payload, status, submitted_voyage_id, revision, created_at, updated_at';

async function insert(db, ownerUserId, payload) {
  const r = await db.pool.request().input('o', db.sql.BigInt, ownerUserId).input('p', db.sql.NVarChar(db.sql.MAX), JSON.stringify(payload))
    .query('INSERT INTO dbo.voyage_drafts (owner_user_id, payload) OUTPUT inserted.id VALUES (@o, @p)');
  return r.recordset[0].id;
}

async function findById(db, id, { lock = false } = {}) {
  const r = await db.pool.request().input('id', db.sql.Int, id)
    .query(`SELECT ${COLUMNS} FROM dbo.voyage_drafts ${lock ? 'WITH (UPDLOCK, HOLDLOCK)' : ''} WHERE id = @id`);
  return shape(r.recordset[0]);
}

async function listOpen(db, ownerUserId) {
  const r = await db.pool.request().input('o', db.sql.BigInt, ownerUserId)
    .query(`SELECT ${COLUMNS} FROM dbo.voyage_drafts WHERE owner_user_id = @o AND status = 'OPEN' ORDER BY updated_at DESC, id DESC`);
  return r.recordset.map(shape);
}

// Optimistic update of an OPEN draft. Returns true when a row changed.
async function updatePayload(db, id, revision, payload) {
  const r = await db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision)
    .input('p', db.sql.NVarChar(db.sql.MAX), JSON.stringify(payload))
    .query(`UPDATE dbo.voyage_drafts SET payload = @p, revision = revision + 1, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND revision = @rev AND status = 'OPEN'`);
  return r.rowsAffected[0] === 1;
}

async function markSubmitted(db, id, voyageId) {
  await db.pool.request().input('id', db.sql.Int, id).input('v', db.sql.Int, voyageId)
    .query(`UPDATE dbo.voyage_drafts SET status = 'SUBMITTED', submitted_voyage_id = @v, revision = revision + 1, updated_at = SYSUTCDATETIME() WHERE id = @id`);
}

async function discard(db, id, revision) {
  const r = await db.pool.request().input('id', db.sql.Int, id).input('rev', db.sql.BigInt, revision)
    .query(`UPDATE dbo.voyage_drafts SET status = 'DISCARDED', revision = revision + 1, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND revision = @rev AND status = 'OPEN'`);
  return r.rowsAffected[0] === 1;
}

module.exports = { insert, findById, listOpen, updatePayload, markSubmitted, discard };
