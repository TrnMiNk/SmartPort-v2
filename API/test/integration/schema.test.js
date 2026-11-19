'use strict';

// Schema integration tests. Run only when SP_TEST_DB names a disposable SmartPort V2 database:
//   SP_TEST_DB=SmartPortV2_Verify1 npm run test:integration
// Each case runs in its own transaction that is rolled back, so no test data remains.
// Without SP_TEST_DB the suite is skipped and reported as "not executed".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig, assertNotProtectedDatabase } = require('../../src/config');
const { createPool } = require('../../src/db/connection');
const { listMigrations, runMigrations } = require('../../src/db/migrate');

const TEST_DB = process.env.SP_TEST_DB;
const skip = TEST_DB ? false : 'SP_TEST_DB not set: schema integration tests not executed';

let ctx;

test.before(async () => {
  if (skip) return;
  assertNotProtectedDatabase(TEST_DB);
  const base = loadConfig({ SP_DB_NAME: TEST_DB });
  const { sql, pool, connect } = createPool(base.db);
  const connected = await connect();
  await runMigrations(connected, sql, listMigrations(path.join(__dirname, '..', '..', 'migrations')));
  ctx = { sql, pool: connected };
}, { timeout: 60000 });

test.after(async () => {
  if (ctx) await ctx.pool.close();
});

// Runs `fn(request)` inside a transaction that is always rolled back.
async function inRolledBackTx(fn) {
  const tx = new ctx.sql.Transaction(ctx.pool);
  await tx.begin();
  try {
    await fn(new ctx.sql.Request(tx));
  } finally {
    await tx.rollback();
  }
}

// Inserts the parent rows needed by voyages and ships. Returns their identities.
async function seedParents(req) {
  const port = await req.query(`INSERT INTO dbo.ports (port_code, port_name) VALUES ('VNSGN_T', N'Cảng thử nghiệm');
    SELECT SCOPE_IDENTITY() AS id;`);
  const agent = await req.query(`INSERT INTO dbo.agents (agent_code, agent_name) VALUES ('AG_T', N'Đại lý thử nghiệm');
    SELECT SCOPE_IDENTITY() AS id;`);
  const type = await req.query(`SELECT TOP 1 id FROM dbo.ship_types WHERE type_code = 'CONTAINER';`);
  return {
    portId: port.recordset[0].id,
    agentId: agent.recordset[0].id,
    shipTypeId: type.recordset[0]?.id ?? (await insertShipType(req)),
  };
}

async function insertShipType(req) {
  const r = await req.query(`INSERT INTO dbo.ship_types (type_code, type_name, cargo_class)
    VALUES ('T_CONT', N'Tàu container thử', 'CONTAINER'); SELECT SCOPE_IDENTITY() AS id;`);
  return r.recordset[0].id;
}

async function insertShip(req, parents, { imo = '9074729', dims = [180, 30, 10, 20000] } = {}) {
  const r = await req.query(`INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id,
      length_overall_m, beam_m, max_draft_m, deadweight_t)
    VALUES ('SHIP_T_${imo}', '${imo}', N'Tàu thử nghiệm', ${parents.shipTypeId},
      ${dims[0]}, ${dims[1]}, ${dims[2]}, ${dims[3]}); SELECT SCOPE_IDENTITY() AS id;`);
  return r.recordset[0].id;
}

async function insertVoyage(req, parents, shipId) {
  const r = await req.query(`INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id,
      declared_eta, declared_teu, cargo_type)
    VALUES (${shipId}, 'V-T1', 'ANNOUNCED', ${parents.agentId}, ${parents.portId},
      '2026-12-01T08:00:00', 100, N'Container'); SELECT SCOPE_IDENTITY() AS id;`);
  return r.recordset[0].id;
}

async function expectRejected(req, sqlText, pattern) {
  await assert.rejects(() => req.query(sqlText), (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

test('valid ship and announced voyage are accepted (positive case)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    const voyageId = await insertVoyage(req, parents, shipId);
    assert.ok(shipId > 0 && voyageId > 0);
  });
});

test('IMO number must be 7 digits (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    await expectRejected(req, `INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id,
      length_overall_m, beam_m, max_draft_m, deadweight_t) VALUES ('X1', 'IMO12AB', N'Sai', ${parents.shipTypeId},
      100, 20, 8, 1000);`, /CK_ships_imo_digits/);
  });
});

test('IMO number is unique (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    await insertShip(req, parents, { imo: '9074729' });
    await expectRejected(req, `INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id,
      length_overall_m, beam_m, max_draft_m, deadweight_t) VALUES ('SHIP_DUP', '9074729', N'Trùng', ${parents.shipTypeId},
      100, 20, 8, 1000);`, /UQ_ships_imo/);
  });
});

test('ship dimensions must be positive (boundary, zero rejected)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    await expectRejected(req, `INSERT INTO dbo.ships (ship_code, imo_number, ship_name, ship_type_id,
      length_overall_m, beam_m, max_draft_m, deadweight_t) VALUES ('SHIP_Z', '1234567', N'Zero', ${parents.shipTypeId},
      0, 20, 8, 1000);`, /CK_ships_dimensions/);
  });
});

test('voyage cannot be BERTHED without ata (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await expectRejected(req, `INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id,
      declared_eta, declared_teu, cargo_type, validation_result, validated_at, validation_policy_version)
      VALUES (${shipId}, 'V-BERTH', 'BERTHED', ${parents.agentId}, ${parents.portId},
      '2026-12-01T08:00:00', 10, N'Container', 'VALID', SYSUTCDATETIME(), 'POLICY-V0');`, /CK_voyages_ata/);
  });
});

test('WAITING_BERTH requires a queue position (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await expectRejected(req, `INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id,
      declared_eta, declared_teu, cargo_type, validation_result, validated_at, validation_policy_version)
      VALUES (${shipId}, 'V-Q', 'WAITING_BERTH', ${parents.agentId}, ${parents.portId},
      '2026-12-01T08:00:00', 10, N'Container', 'VALID', SYSUTCDATETIME(), 'POLICY-V0');`, /CK_voyages_queue_state/);
  });
});

test('one voyage and ship pair cannot be announced twice (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await insertVoyage(req, parents, shipId);
    await expectRejected(req, `INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id,
      declared_eta, declared_teu, cargo_type) VALUES (${shipId}, 'V-T1', 'ANNOUNCED', ${parents.agentId},
      ${parents.portId}, '2026-12-01T08:00:00', 10, N'Container');`, /UQ_voyages_ship_code/);
  });
});

test('a document larger than 10 MB is rejected at the schema level (boundary)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await expectRejected(req, `INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename,
      storage_key, mime_type, file_size_bytes) VALUES (${shipId}, 'REGISTRATION', N'a.pdf', 'k-big', 'application/pdf', 10485761);`,
    /CK_sd_size/);
  });
});

test('a document of exactly 10 MB is accepted (boundary)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await req.query(`INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename,
      storage_key, mime_type, file_size_bytes) VALUES (${shipId}, 'REGISTRATION', N'a.pdf', 'k-edge', 'application/pdf', 10485760);`);
  });
});

test('unsupported document mime type is rejected (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await expectRejected(req, `INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename,
      storage_key, mime_type, file_size_bytes) VALUES (${shipId}, 'REGISTRATION', N'a.exe', 'k-exe', 'application/x-msdownload', 100);`,
    /CK_sd_mime/);
  });
});

test('a voyage-specific document references a voyage (D2)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    const voyageId = await insertVoyage(req, parents, shipId);
    await req.query(`INSERT INTO dbo.ship_documents (ship_id, voyage_id, document_type_code, original_filename,
      storage_key, mime_type, file_size_bytes, valid_from, valid_until)
      VALUES (${shipId}, ${voyageId}, 'CARGO_MANIFEST', N'm.pdf', 'k-voy', 'application/pdf', 1000, '2026-01-01', '2026-12-31');`);
  });
});

test('document validity must end after it starts (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await expectRejected(req, `INSERT INTO dbo.ship_documents (ship_id, document_type_code, original_filename,
      storage_key, mime_type, file_size_bytes, valid_from, valid_until)
      VALUES (${shipId}, 'INSURANCE', N'i.pdf', 'k-val', 'application/pdf', 1000, '2026-06-01', '2026-01-01');`,
    /CK_sd_validity/);
  });
});

test('berth maintenance requires start before end (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const r = await req.query(`INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes)
      VALUES ('B_T', N'Bến thử', 'CONTAINER', 300, 14, 2); SELECT SCOPE_IDENTITY() AS id;`);
    await expectRejected(req, `INSERT INTO dbo.berth_maintenance (berth_id, starts_at, ends_at, reason, created_by)
      VALUES (${r.recordset[0].id}, '2026-12-02', '2026-12-01', N'Sửa', N'tester');`, /CK_bm_period/);
  });
});

test('a plan cannot be PENDING_APPROVAL unless constraints passed (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    const voyageId = await insertVoyage(req, parents, shipId);
    const b = await req.query(`INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes)
      VALUES ('B_P', N'Bến P', 'CONTAINER', 300, 14, 2); SELECT SCOPE_IDENTITY() AS id;`);
    await expectRejected(req, `INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source, position_start_m,
      position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version, constraint_check_json)
      VALUES (${voyageId}, ${b.recordset[0].id}, 'PENDING_APPROVAL', 'MANUAL', 0, 100, '2026-12-01', '2026-12-02', 1, 15,
      'PLAN-V0', N'{"passed": false}');`, /CK_bp_reviewed/);
  });
});

test('only one open (pending or approved) plan per voyage (negative)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    const voyageId = await insertVoyage(req, parents, shipId);
    const b = await req.query(`INSERT INTO dbo.berths (berth_code, berth_name, berth_type, length_m, max_depth_m, available_cranes)
      VALUES ('B_O', N'Bến O', 'CONTAINER', 300, 14, 2); SELECT SCOPE_IDENTITY() AS id;`);
    const insertPlan = (berthId, start) => `INSERT INTO dbo.berth_plans (voyage_id, berth_id, plan_status, source,
      position_start_m, position_end_m, planned_start, planned_end, required_cranes, buffer_m, policy_version,
      constraint_check_json) VALUES (${voyageId}, ${berthId}, 'PENDING_APPROVAL', 'MANUAL', 0, 100,
      '${start}', '2026-12-31', 1, 15, 'PLAN-V0', N'{"passed": true}');`;
    // First open plan is accepted; the second open plan for the same voyage must fail on the filtered unique index.
    await req.query(insertPlan(b.recordset[0].id, '2026-12-01'));
    await expectRejected(req, insertPlan(b.recordset[0].id, '2026-12-05'), /UX_bp_open_plan_per_voyage/);
  });
});

test('voyage queue position must be positive (boundary, zero rejected)', { skip }, async () => {
  await inRolledBackTx(async (req) => {
    const parents = await seedParents(req);
    const shipId = await insertShip(req, parents);
    await expectRejected(req, `INSERT INTO dbo.voyages (ship_id, voyage_code, status, agent_id, origin_port_id,
      declared_eta, declared_teu, cargo_type, queue_position) VALUES (${shipId}, 'V-QZ', 'ANNOUNCED', ${parents.agentId},
      ${parents.portId}, '2026-12-01T08:00:00', 10, N'Container', 0);`, /CK_voyages_queue/);
  });
});
