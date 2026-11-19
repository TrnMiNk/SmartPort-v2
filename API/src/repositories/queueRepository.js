'use strict';

// Data access for the berth queue (UC-020). Queue changes are serialized by locking the single voyage_queue_state row;
// its revision is the concurrency token shown to clients.

async function lockState(db) {
  const r = await db.pool.request().query('SELECT revision FROM dbo.voyage_queue_state WITH (UPDLOCK, HOLDLOCK) WHERE id = 1');
  return Number(r.recordset[0].revision);
}

async function readState(db) {
  const r = await db.pool.request().query('SELECT revision FROM dbo.voyage_queue_state WHERE id = 1');
  return Number(r.recordset[0].revision);
}

async function bump(db) {
  await db.pool.request().query('UPDATE dbo.voyage_queue_state SET revision = revision + 1 WHERE id = 1');
}

// Effective ETA is the AI forecast when one was available, otherwise the declared ETA (UC-015 3a).
const SELECT = `SELECT v.id, v.queue_position, v.queued_at, v.priority_class, v.voyage_code, v.declared_eta,
    CASE WHEN p.ai_status = 'AVAILABLE' THEN p.predicted_eta ELSE v.declared_eta END AS effective_eta,
    CASE WHEN p.ai_status = 'AVAILABLE' THEN 'AI' ELSE 'DECLARED' END AS eta_source, p.ai_status AS eta_status,
    s.ship_name, s.imo_number, s.length_overall_m, a.agent_name
  FROM dbo.voyages v JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.agents a ON a.id = v.agent_id
  LEFT JOIN dbo.voyage_eta_predictions p ON p.id = v.latest_eta_prediction_id
  WHERE v.status = 'WAITING_BERTH' ORDER BY v.queue_position`;

async function entries(db) {
  const r = await db.pool.request().query(SELECT);
  return r.recordset;
}

// Opens a gap: every queued voyage at or after `position` moves down by one.
async function shiftDown(db, position) {
  await db.pool.request().input('p', db.sql.Int, position)
    .query(`UPDATE dbo.voyages SET queue_position = queue_position + 1, revision = revision + 1
            WHERE status = 'WAITING_BERTH' AND queue_position >= @p`);
}

// Moves one voyage from `from` to `to` in a single statement; the others between them shift by one.
async function move(db, id, from, to) {
  await db.pool.request().input('id', db.sql.Int, id).input('from', db.sql.Int, from).input('to', db.sql.Int, to)
    .query(`UPDATE dbo.voyages SET revision = revision + 1, queue_position = CASE
              WHEN id = @id THEN @to
              WHEN @to < @from AND queue_position >= @to AND queue_position < @from THEN queue_position + 1
              WHEN @to > @from AND queue_position > @from AND queue_position <= @to THEN queue_position - 1
              ELSE queue_position END
            WHERE status = 'WAITING_BERTH' AND queue_position IS NOT NULL
              AND (id = @id OR (@to < @from AND queue_position >= @to AND queue_position < @from)
                            OR (@to > @from AND queue_position > @from AND queue_position <= @to))`);
}

async function insertChange(db, { voyageId, from, to, reason, actor }) {
  await db.pool.request().input('v', db.sql.Int, voyageId).input('from', db.sql.Int, from).input('to', db.sql.Int, to)
    .input('reason', db.sql.NVarChar(500), reason).input('actor', db.sql.NVarChar(100), actor)
    .query(`INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, reason, actor) VALUES (@v, @from, @to, @reason, @actor)`);
}

// A voyage leaves the queue (its berth plan was approved): everyone behind it moves up by one so positions stay 1..n without gaps.
async function closeGap(db, position) {
  await db.pool.request().input('p', db.sql.Int, position)
    .query(`UPDATE dbo.voyages SET queue_position = queue_position - 1, revision = revision + 1
            WHERE status = 'WAITING_BERTH' AND queue_position > @p`);
}

// History of a voyage that left the queue (the row of the voyage itself keeps queued_at).
async function insertLeft(db, { voyageId, from, reason, actor }) {
  await db.pool.request().input('v', db.sql.Int, voyageId).input('from', db.sql.Int, from).input('reason', db.sql.NVarChar(500), reason).input('actor', db.sql.NVarChar(100), actor)
    .query(`INSERT INTO dbo.voyage_queue_changes (voyage_id, from_position, to_position, change_type, reason, actor) VALUES (@v, @from, NULL, 'LEFT_QUEUE', @reason, @actor)`);
}

module.exports = { lockState, readState, bump, entries, shiftDown, move, insertChange, closeGap, insertLeft };
