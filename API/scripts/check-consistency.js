'use strict';

// Read-only consistency report for the voyage and berth-plan lifecycles (modules 1 and 2). It changes nothing.
//   SP_DB_NAME=<db> node scripts/check-consistency.js
// Each check lists the offending rows; exit code 1 when any check fails.

const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/connection');

const CHECKS = [
  ['voyage status equals the last history row', `SELECT v.id, v.voyage_code, v.status, h.to_status FROM dbo.voyages v CROSS APPLY (SELECT TOP 1 to_status FROM dbo.voyage_status_history WHERE voyage_id = v.id ORDER BY id DESC) h WHERE h.to_status <> v.status`],
  ['queue positions are exactly 1..n for WAITING_BERTH voyages', `SELECT v.id, v.queue_position, ROW_NUMBER() OVER (ORDER BY v.queue_position) AS expected FROM dbo.voyages v WHERE v.status = 'WAITING_BERTH' AND 1 = 1 ORDER BY v.queue_position OFFSET 0 ROWS`, (rows) => rows.filter((r) => Number(r.queue_position) !== Number(r.expected))],
  ['only WAITING_BERTH voyages have a queue position', `SELECT id, status, queue_position FROM dbo.voyages WHERE status <> 'WAITING_BERTH' AND queue_position IS NOT NULL`],
  ['a BERTH_ASSIGNED or BERTHED voyage has exactly one APPROVED plan', `SELECT v.id, v.status, COUNT(bp.id) AS approved FROM dbo.voyages v LEFT JOIN dbo.berth_plans bp ON bp.voyage_id = v.id AND bp.plan_status = 'APPROVED' WHERE v.status IN ('BERTH_ASSIGNED', 'BERTHED') GROUP BY v.id, v.status HAVING COUNT(bp.id) <> 1`],
  ['a DEPARTED voyage has no APPROVED plan and a COMPLETED one', `SELECT v.id FROM dbo.voyages v WHERE v.status = 'DEPARTED' AND (EXISTS (SELECT 1 FROM dbo.berth_plans WHERE voyage_id = v.id AND plan_status = 'APPROVED') OR NOT EXISTS (SELECT 1 FROM dbo.berth_plans WHERE voyage_id = v.id AND plan_status = 'COMPLETED'))`],
  ['an APPROVED plan belongs to a BERTH_ASSIGNED or BERTHED voyage', `SELECT bp.id, v.status FROM dbo.berth_plans bp JOIN dbo.voyages v ON v.id = bp.voyage_id WHERE bp.plan_status = 'APPROVED' AND v.status NOT IN ('BERTH_ASSIGNED', 'BERTHED')`],
  ['ATA set exactly from BERTHED on, ATD only when DEPARTED', `SELECT id, status, ata, atd FROM dbo.voyages WHERE (status IN ('BERTHED', 'DEPARTED') AND ata IS NULL) OR (status NOT IN ('BERTHED', 'DEPARTED') AND ata IS NOT NULL) OR (status = 'DEPARTED' AND atd IS NULL) OR (status <> 'DEPARTED' AND atd IS NOT NULL)`],
  ['no two vessels berthed on overlapping stretches of one berth', `SELECT a.berth_id, a.voyage_id AS voyage_a, b.voyage_id AS voyage_b FROM dbo.berth_plans a JOIN dbo.voyages va ON va.id = a.voyage_id AND va.status = 'BERTHED' JOIN dbo.berth_plans b ON b.berth_id = a.berth_id AND b.id > a.id JOIN dbo.voyages vb ON vb.id = b.voyage_id AND vb.status = 'BERTHED' WHERE a.plan_status = 'APPROVED' AND b.plan_status = 'APPROVED' AND a.position_start_m < b.position_end_m AND b.position_start_m < a.position_end_m`],
  ['every state change has an audit row (approve, reject, berthing, departure)', `SELECT 'APPROVE' AS kind, bp.id FROM dbo.berth_plans bp WHERE bp.approved_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.audit_events WHERE action = 'BERTH_PLAN_APPROVE' AND outcome = 'SUCCESS' AND entity_id = CAST(bp.id AS NVARCHAR(50)))
    UNION ALL SELECT 'REJECT', bp.id FROM dbo.berth_plans bp WHERE bp.plan_status = 'REJECTED' AND NOT EXISTS (SELECT 1 FROM dbo.audit_events WHERE action = 'BERTH_PLAN_REJECT' AND outcome = 'SUCCESS' AND entity_id = CAST(bp.id AS NVARCHAR(50)))
    UNION ALL SELECT 'BERTHING', v.id FROM dbo.voyages v WHERE v.status IN ('BERTHED', 'DEPARTED') AND NOT EXISTS (SELECT 1 FROM dbo.audit_events WHERE action = 'VOYAGE_BERTHING' AND outcome = 'SUCCESS' AND entity_id = CAST(v.id AS NVARCHAR(50)))
    UNION ALL SELECT 'DEPARTURE', v.id FROM dbo.voyages v WHERE v.status = 'DEPARTED' AND NOT EXISTS (SELECT 1 FROM dbo.audit_events WHERE action = 'VOYAGE_DEPARTURE' AND outcome = 'SUCCESS' AND entity_id = CAST(v.id AS NVARCHAR(50)))`],
];

async function main() {
  const config = loadConfig();
  const { sql, connect } = createPool(config.db);
  const pool = await connect();
  let failed = 0;
  for (const [name, text, post] of CHECKS) {
    let rows = (await pool.request().query(text)).recordset;
    if (post) rows = post(rows);
    if (rows.length) failed += 1;
    process.stdout.write(`${rows.length ? 'FAIL' : 'ok  '} ${name}${rows.length ? ` (${rows.length} rows, first: ${JSON.stringify(rows[0])})` : ''}\n`);
  }
  const total = (await pool.request().query('SELECT COUNT(*) AS n FROM dbo.voyages')).recordset[0].n;
  process.stdout.write(`${CHECKS.length - failed} of ${CHECKS.length} checks passed on ${config.db.database} (${total} voyages)\n`);
  await pool.close(); void sql;
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { process.stderr.write(`check failed: ${err.message}\n`); process.exitCode = 1; });
