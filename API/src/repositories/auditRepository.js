'use strict';

// Append-only writes to dbo.audit_events (rule 04: actor, action, target, timestamp, outcome).

async function insert(db, event) {
  await db.pool.request()
    .input('actor', db.sql.NVarChar(100), event.actor)
    .input('action', db.sql.VarChar(60), event.action)
    .input('entityType', db.sql.VarChar(40), event.entityType)
    .input('entityId', db.sql.NVarChar(64), event.entityId == null ? null : String(event.entityId))
    .input('outcome', db.sql.VarChar(20), event.outcome)
    .input('reason', db.sql.NVarChar(500), event.reason ?? null)
    .input('oldJson', db.sql.NVarChar(db.sql.MAX), event.oldJson ?? null)
    .input('newJson', db.sql.NVarChar(db.sql.MAX), event.newJson ?? null)
    .query(`INSERT INTO dbo.audit_events (actor, action, entity_type, entity_id, outcome, reason, old_json, new_json)
            VALUES (@actor, @action, @entityType, @entityId, @outcome, @reason, @oldJson, @newJson)`);
}

// Successful changes of one entity, oldest first (used for the vessel change history, UC-011).
async function listSuccessful(db, entityType, entityId) {
  const r = await db.pool.request()
    .input('t', db.sql.VarChar(40), entityType)
    .input('e', db.sql.NVarChar(64), String(entityId))
    .query(`SELECT id, actor, action, reason, old_json, new_json, occurred_at FROM dbo.audit_events
            WHERE entity_type = @t AND entity_id = @e AND outcome = 'SUCCESS' ORDER BY id`);
  return r.recordset;
}

module.exports = { insert, listSuccessful };
