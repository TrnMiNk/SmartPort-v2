'use strict';

// In-app notifications (decision D6). A row is addressed to one user or to a role; a user sees the rows addressed to them and to any
// of their roles. SQL only.

const VISIBLE = '(n.recipient_user_id = @uid OR n.recipient_role_code IN (SELECT r.role_code FROM dbo.auth_user_roles ur JOIN dbo.auth_roles r ON r.role_id = ur.role_id WHERE ur.user_id = @uid))';

const shape = (r) => ({ id: Number(r.id), title: r.title, body: r.body, entity_type: r.entity_type, entity_id: r.entity_id == null ? null : Number(r.entity_id),
  created_at: r.created_at, read_at: r.read_at, for_role: r.recipient_role_code });

async function list(db, userId, { unreadOnly, offset, size }) {
  const where = `${VISIBLE}${unreadOnly ? ' AND n.read_at IS NULL' : ''}`;
  const req = () => db.pool.request().input('uid', db.sql.BigInt, userId);
  const total = await req().query(`SELECT COUNT(*) AS n FROM dbo.notifications n WHERE ${where}`);
  const unread = await req().query(`SELECT COUNT(*) AS n FROM dbo.notifications n WHERE ${VISIBLE} AND n.read_at IS NULL`);
  const rows = await req().input('offset', db.sql.Int, offset).input('size', db.sql.Int, size)
    .query(`SELECT n.id, n.title, n.body, n.entity_type, n.entity_id, n.created_at, n.read_at, n.recipient_role_code FROM dbo.notifications n
            WHERE ${where} ORDER BY n.id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
  return { items: rows.recordset.map(shape), total: total.recordset[0].n, unread: unread.recordset[0].n };
}

async function findVisible(db, userId, id) {
  const r = await db.pool.request().input('uid', db.sql.BigInt, userId).input('id', db.sql.BigInt, id)
    .query(`SELECT n.id, n.title, n.body, n.entity_type, n.entity_id, n.created_at, n.read_at, n.recipient_role_code FROM dbo.notifications n WHERE n.id = @id AND ${VISIBLE}`);
  return r.recordset[0] ? shape(r.recordset[0]) : null;
}

async function markRead(db, id) {
  const r = await db.pool.request().input('id', db.sql.BigInt, id).query('UPDATE dbo.notifications SET read_at = SYSUTCDATETIME() WHERE id = @id AND read_at IS NULL');
  return r.rowsAffected[0] === 1;
}

async function insertForUser(db, userId, { title, body, entityType, entityId }) {
  await db.pool.request().input('u', db.sql.BigInt, userId).input('t', db.sql.NVarChar(200), title).input('b', db.sql.NVarChar(1000), body)
    .input('et', db.sql.VarChar(40), entityType).input('ei', db.sql.BigInt, entityId)
    .query('INSERT INTO dbo.notifications (recipient_user_id, title, body, entity_type, entity_id) VALUES (@u, @t, @b, @et, @ei)');
}

// Users who act for an agent (the voyage's agent is told when its plan is approved).
async function agentUserIds(db, agentId) {
  const r = await db.pool.request().input('a', db.sql.Int, agentId).query('SELECT user_id FROM dbo.auth_user_agents WHERE agent_id = @a');
  return r.recordset.map((x) => Number(x.user_id));
}

module.exports = { list, findVisible, markRead, insertForUser, agentUserIds };
