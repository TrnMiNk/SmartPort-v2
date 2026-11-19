'use strict';

// Records refused operations. Successful changes write their own audit row inside the same transaction as the change,
// so a rolled-back change leaves no "success" row. A refusal (403 or 409) rolls the transaction back, so it is
// recorded here, outside the transaction, as DENIED or FAILED (rule 04: every state-changing attempt has an outcome).

const audit = require('../repositories/auditRepository');
const { AppError } = require('../errors');

async function audited(db, principal, meta, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && (err.status === 403 || err.status === 409)) {
      try {
        await audit.insert(db, {
          actor: principal.username, action: meta.action, entityType: meta.entityType, entityId: meta.entityId ?? null,
          outcome: err.status === 403 ? 'DENIED' : 'FAILED',
          reason: (err.details && err.details.rule) || err.code,
        });
      } catch (auditError) { /* never hide the original business error behind an audit failure */ }
    }
    throw err;
  }
}

module.exports = { audited };
