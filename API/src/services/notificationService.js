'use strict';

// Reading notifications (UC-029 AC-2 and later). Any signed-in user may read what is addressed to them or to one of their roles;
// there is no other access. Assumption N-1: a notification addressed to a role has one read mark, shared by everyone with the role.

const repo = require('../repositories/notificationsRepository');
const audit = require('../repositories/auditRepository');
const { errors } = require('../errors');
const { parsePaging, parseId } = require('../validation/common');

async function list(db, principal, query) {
  const bad = [];
  const { page, size } = parsePaging(query, bad);
  if (query.unread !== undefined && !['true', 'false'].includes(query.unread)) bad.push({ field: 'unread', message: 'unread phải là true hoặc false.' });
  if (bad.length) throw errors.validation(bad);
  const { items, total, unread } = await repo.list(db, principal.userId, { unreadOnly: query.unread === 'true', offset: page * size, size });
  return { items, total, unread, page, size };
}

async function markRead(db, principal, rawId) {
  const id = parseId(rawId);
  if (id === null) throw errors.notFound();
  const n = await repo.findVisible(db, principal.userId, id);
  if (!n) throw errors.notFound();            // not addressed to this user: its existence is not disclosed
  if (await repo.markRead(db, id)) {
    await audit.insert(db, { actor: principal.username, action: 'NOTIFICATION_READ', entityType: 'NOTIFICATION', entityId: id, outcome: 'SUCCESS' });
  }
  return repo.findVisible(db, principal.userId, id);
}

module.exports = { list, markRead };
