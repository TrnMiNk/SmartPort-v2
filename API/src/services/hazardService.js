'use strict';

// Verified cargo hazard of a voyage (UC-026 BR-03). Only a coordinator with edit rights on M1 records it, with a basis
// (for example the cargo manifest number); an agent's declaration or a request value is never used as evidence.
// Assumption UC-026 A-4: the arrival notice has no structured field, so this verification is the source of the fact.

const voyagesRepo = require('../repositories/voyagesRepository');
const plans = require('../repositories/berthPlansRepository');
const audit = require('../repositories/auditRepository');
const { withTransaction } = require('../db/transaction');
const { audited } = require('./auditing');
const { errors } = require('../errors');
const { validateHazard } = require('../validation/planValidation');

async function verify(db, principal, voyageId, body) {
  const { errors: bad, cargoHazard, basis } = validateHazard(body);
  if (bad.length) throw errors.validation(bad);
  return audited(db, principal, { action: 'CARGO_HAZARD_VERIFY', entityType: 'VOYAGE', entityId: voyageId }, () => withTransaction(db, async (tx) => {
    const voyage = await plans.lockVoyage(tx, voyageId);
    if (!voyage) throw errors.notFound();
    if (voyage.status === 'DEPARTED') throw errors.businessRule('Chuyến đã rời cảng, không thay đổi xác minh hàng hóa.', { rule: 'VOYAGE_DEPARTED' });
    const old = await voyagesRepo.findById(tx, voyageId);
    await voyagesRepo.setCargoHazard(tx, voyageId, { hazard: cargoHazard, basis, userId: principal.userId });
    const updated = await voyagesRepo.findById(tx, voyageId);
    await audit.insert(tx, { actor: principal.username, action: 'CARGO_HAZARD_VERIFY', entityType: 'VOYAGE', entityId: voyageId, outcome: 'SUCCESS', reason: basis,
      oldJson: JSON.stringify({ cargo_hazard: old.cargo_hazard }), newJson: JSON.stringify({ cargo_hazard: updated.cargo_hazard }) });
    return updated;
  }));
}

module.exports = { verify };
