'use strict';

// Business rules for vessel profiles: UC-010 (create), UC-011 (search, update, deactivate).
// Authorization is checked before this layer (permission middleware); agent scope for reads is applied here.

const ships = require('../repositories/shipsRepository');
const catalog = require('../repositories/catalogRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const { errors } = require('../errors');
const { can } = require('../security/permissions');
const { validateShip, validateDeactivate } = require('../validation/shipValidation');
const { parsePaging, trimmedString } = require('../validation/common');

// null = may see every vessel; an array = only vessels operated by these agents (external shipping agents).
const readScope = (principal) => (can(principal.roles, 'M1_VESSELS', 'view') ? null : principal.agentIds);

// Reference checks, reported as field errors so the form can point at the field.
async function checkReferences(tx, value) {
  const problems = [];
  if (value.ship_type_id !== undefined && !(await catalog.activeShipTypeExists(tx, value.ship_type_id))) {
    problems.push({ field: 'ship_type_id', message: 'Loại tàu không tồn tại hoặc đã bị vô hiệu hóa.' });
  }
  if (value.operator_agent_id != null && !(await catalog.activeAgentExists(tx, value.operator_agent_id))) {
    problems.push({ field: 'operator_agent_id', message: 'Hãng tàu/đại lý không tồn tại hoặc đã bị vô hiệu hóa.' });
  }
  if (problems.length) throw errors.validation(problems);
}

const duplicateImo = () => errors.conflict('Số IMO đã tồn tại.', { field: 'imo_number', message: 'Số IMO đã tồn tại.' });
const staleRevision = (current) => errors.conflict('Hồ sơ tàu vừa được người khác thay đổi. Vui lòng tải lại.', { current_revision: current });

async function create(db, principal, body) {
  const { errors: bad, value } = validateShip(body, 'create');
  if (bad.length) throw errors.validation(bad);
  return audited(db, principal, { action: 'SHIP_CREATE', entityType: 'SHIP' }, () => withTransaction(db, async (tx) => {
    await checkReferences(tx, value);
    if (await ships.findByImo(tx, value.imo_number)) throw duplicateImo();
    const id = await ships.insert(tx, value, `IMO${value.imo_number}`); // ship_code is derived from the unique IMO
    const ship = await ships.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'SHIP_CREATE', entityType: 'SHIP', entityId: id,
      outcome: 'SUCCESS', newJson: JSON.stringify(ship) });
    return ship;
  }));
}

async function update(db, principal, id, body, revision) {
  const { errors: bad, value } = validateShip(body, 'update');
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của hồ sơ tàu.' });
  if (bad.length) throw errors.validation(bad);
  const reason = body.reason ? trimmedString(body.reason, 1, 500) : null;
  return audited(db, principal, { action: 'SHIP_UPDATE', entityType: 'SHIP', entityId: id }, () => withTransaction(db, async (tx) => {
    const old = await ships.findById(tx, id, { lock: true });
    if (!old) throw errors.notFound();
    if (old.revision !== revision) throw staleRevision(old.revision);
    await checkReferences(tx, value);
    if (value.imo_number && value.imo_number !== old.imo_number) {
      const other = await ships.findByImo(tx, value.imo_number);
      if (other && other.id !== id) throw duplicateImo();
    }
    if (!(await ships.update(tx, id, revision, value))) throw staleRevision(null);
    const updated = await ships.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'SHIP_UPDATE', entityType: 'SHIP', entityId: id,
      outcome: 'SUCCESS', reason, oldJson: JSON.stringify(old), newJson: JSON.stringify(updated) });
    return updated;
  }));
}

async function deactivate(db, principal, id, body, revision) {
  const { errors: bad, reason } = validateDeactivate(body);
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của hồ sơ tàu.' });
  if (bad.length) throw errors.validation(bad);
  return audited(db, principal, { action: 'SHIP_DEACTIVATE', entityType: 'SHIP', entityId: id }, () => withTransaction(db, async (tx) => {
    const old = await ships.findById(tx, id, { lock: true });
    if (!old) throw errors.notFound();
    if (old.revision !== revision) throw staleRevision(old.revision);
    if (!old.is_active) throw errors.businessRule('Tàu đã bị vô hiệu hóa.', { rule: 'SHIP_ALREADY_INACTIVE' });
    const open = await ships.findUnfinishedVoyages(tx, id);
    if (open.length) {
      throw errors.businessRule('Không thể vô hiệu hóa tàu đang có chuyến chưa kết thúc. Hãy chờ chuyến kết thúc.',
        { rule: 'SHIP_HAS_UNFINISHED_VOYAGE', voyages: open.map((v) => ({ id: v.id, voyage_code: v.voyage_code, status: v.status })) });
    }
    if (!(await ships.setInactive(tx, id, revision))) throw staleRevision(null);
    const updated = await ships.findById(tx, id);
    await audit.insert(tx, { actor: principal.username, action: 'SHIP_DEACTIVATE', entityType: 'SHIP', entityId: id,
      outcome: 'SUCCESS', reason, oldJson: JSON.stringify(old), newJson: JSON.stringify(updated) });
    return updated;
  }));
}

async function get(db, principal, id) {
  const ship = await ships.findById(db, id);
  const scope = readScope(principal);
  // An agent outside the vessel's operator gets "not found", so existence is not disclosed.
  if (!ship || (scope && !scope.includes(ship.operator_agent_id))) throw errors.notFound();
  return ship;
}

async function list(db, principal, query) {
  const bad = [];
  const { page, size } = parsePaging(query, bad);
  const search = query.search === undefined ? null : trimmedString(String(query.search), 1, 100);
  if (query.search !== undefined && search === null) bad.push({ field: 'search', message: 'Từ khóa tìm kiếm tối đa 100 ký tự.' });
  if (query.includeInactive !== undefined && !['true', 'false'].includes(query.includeInactive)) {
    bad.push({ field: 'includeInactive', message: 'includeInactive phải là true hoặc false.' });
  }
  if (bad.length) throw errors.validation(bad);
  const { items, total } = await ships.list(db, {
    search, includeInactive: query.includeInactive === 'true', agentIds: readScope(principal), offset: page * size, size,
  });
  return { items, total, page, size };
}

// Fields shown in the history, with the key that carries the readable value for reference columns.
const HISTORY_FIELDS = [
  ['imo_number', 'imo_number'], ['ship_name', 'ship_name'], ['flag_state', 'flag_state'],
  ['ship_type', 'ship_type_name'], ['operator_agent', 'operator_agent_name'],
  ['length_overall_m', 'length_overall_m'], ['beam_m', 'beam_m'], ['max_draft_m', 'max_draft_m'],
  ['deadweight_t', 'deadweight_t'], ['is_active', 'is_active'],
];

// Old and new values of every field that changed between two stored snapshots (pure; unit-tested).
function diffShip(oldJson, newJson) {
  if (!oldJson || !newJson) return [];
  const before = JSON.parse(oldJson); const after = JSON.parse(newJson);
  return HISTORY_FIELDS
    .filter(([, key]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
    .map(([field, key]) => ({ field, old: before[key] ?? null, new: after[key] ?? null }));
}

// UC-011 AC-1: every change to a vessel profile is listed with who, when, why, and the old and new values.
async function history(db, principal, id) {
  await get(db, principal, id); // applies the same visibility rules as reading the vessel (404 outside an agent's scope)
  const rows = await audit.listSuccessful(db, 'SHIP', id);
  return {
    items: rows.map((r) => ({
      at: r.occurred_at, actor: r.actor, action: r.action, reason: r.reason,
      changes: r.action === 'SHIP_CREATE' ? [] : diffShip(r.old_json, r.new_json),
    })),
  };
}

module.exports = { create, update, deactivate, get, list, history, diffShip };
