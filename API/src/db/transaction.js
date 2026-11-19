'use strict';

// Runs `fn` inside one SQL Server transaction. `fn` receives a db facade with the same shape as the pool-based one
// ({ sql, pool.request() }), so repositories work unchanged inside and outside a transaction. Any error rolls back.

async function withTransaction(db, fn) {
  const tx = new db.sql.Transaction(db.pool);
  await tx.begin();
  const txDb = { sql: db.sql, pool: { request: () => new db.sql.Request(tx) } };
  try {
    const result = await fn(txDb);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (rollbackError) { /* the transaction may already be aborted */ }
    throw err;
  }
}

module.exports = { withTransaction };
