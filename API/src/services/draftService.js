'use strict';

// Drafts of arrival notices (UC-013 alternative flow 3a). A draft is private to its owner and is not an official notice:
// it is not validated and never reaches UC-015 until it is submitted. States: OPEN -> SUBMITTED or DISCARDED (final).
// Submitting reuses the notice creation path, so the draft is marked SUBMITTED in the same transaction that creates the
// notice, and a repeated submission returns the existing notice instead of creating a second one.

const drafts = require('../repositories/draftsRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const voyageService = require('./voyageService');
const { errors } = require('../errors');
const { validateDraft } = require('../validation/flowValidation');

const view = (d) => ({ id: d.id, payload: d.payload, status: d.status, submitted_voyage_id: d.submitted_voyage_id, revision: d.revision, updated_at: d.updated_at });
const ownedBy = (d, principal) => d && String(d.owner_user_id) === String(principal.userId);
const stale = (current) => errors.conflict('Bản nháp vừa được thay đổi ở nơi khác. Vui lòng tải lại.', { current_revision: current });
const notOpen = () => errors.businessRule('Bản nháp không còn ở trạng thái mở.', { rule: 'DRAFT_NOT_OPEN' });

async function create(db, principal, body) {
  const { errors: bad, value } = validateDraft(body);
  if (bad.length) throw errors.validation(bad);
  return withTransaction(db, async (tx) => {
    const id = await drafts.insert(tx, principal.userId, value);
    await audit.insert(tx, { actor: principal.username, action: 'DRAFT_CREATE', entityType: 'VOYAGE_DRAFT', entityId: id, outcome: 'SUCCESS' });
    return view(await drafts.findById(tx, id));
  });
}

async function list(db, principal) {
  return { items: (await drafts.listOpen(db, principal.userId)).map(view) };
}

async function get(db, principal, id) {
  const d = await drafts.findById(db, id);
  if (!ownedBy(d, principal)) throw errors.notFound(); // someone else's draft is not disclosed
  return view(d);
}

async function update(db, principal, id, body, revision) {
  const { errors: bad, value } = validateDraft(body);
  if (revision === null) bad.push({ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của bản nháp.' });
  if (bad.length) throw errors.validation(bad);
  return audited(db, principal, { action: 'DRAFT_UPDATE', entityType: 'VOYAGE_DRAFT', entityId: id }, () => withTransaction(db, async (tx) => {
    const d = await drafts.findById(tx, id, { lock: true });
    if (!ownedBy(d, principal)) throw errors.notFound();
    if (d.status !== 'OPEN') throw notOpen();
    if (d.revision !== revision) throw stale(d.revision);
    if (!(await drafts.updatePayload(tx, id, revision, value))) throw stale(null);
    await audit.insert(tx, { actor: principal.username, action: 'DRAFT_UPDATE', entityType: 'VOYAGE_DRAFT', entityId: id, outcome: 'SUCCESS' });
    return view(await drafts.findById(tx, id));
  }));
}

async function discard(db, principal, id, revision) {
  if (revision === null) throw errors.validation([{ field: 'If-Match', message: 'Thiếu phiên bản (If-Match) của bản nháp.' }]);
  return audited(db, principal, { action: 'DRAFT_DISCARD', entityType: 'VOYAGE_DRAFT', entityId: id }, () => withTransaction(db, async (tx) => {
    const d = await drafts.findById(tx, id, { lock: true });
    if (!ownedBy(d, principal)) throw errors.notFound();
    if (d.status !== 'OPEN') throw notOpen();
    if (d.revision !== revision) throw stale(d.revision);
    await drafts.discard(tx, id, revision);
    await audit.insert(tx, { actor: principal.username, action: 'DRAFT_DISCARD', entityType: 'VOYAGE_DRAFT', entityId: id, outcome: 'SUCCESS' });
    return view(await drafts.findById(tx, id));
  }));
}

// Submit: validates as a full notice (400 with field errors if incomplete), creates it, then runs UC-015.
async function submit(db, deps, principal, id) {
  const d = await drafts.findById(db, id);
  if (!ownedBy(d, principal)) throw errors.notFound();
  if (d.status === 'DISCARDED') throw notOpen();
  const body = { ...d.payload };
  return voyageService.submitNotice(db, deps, principal, body, { draft: { id } });
}

module.exports = { create, list, get, update, discard, submit };
