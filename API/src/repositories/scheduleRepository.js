'use strict';

// Read-only schedule query for UC-021. A voyage's berth and planned interval come from its latest APPROVED or COMPLETED
// berth plan (BR-3); the bar uses the actual times when they exist (assumption A-1). SQL only.

const FROM = `FROM dbo.voyages v JOIN dbo.ships s ON s.id = v.ship_id JOIN dbo.agents a ON a.id = v.agent_id
  OUTER APPLY (SELECT TOP 1 bp.id, bp.berth_id, b.berth_code, b.berth_name, bp.planned_start, bp.planned_end
               FROM dbo.berth_plans bp JOIN dbo.berths b ON b.id = bp.berth_id
               WHERE bp.voyage_id = v.id AND bp.plan_status IN ('APPROVED', 'COMPLETED') ORDER BY bp.id DESC) p
  CROSS APPLY (SELECT COALESCE(v.ata, p.planned_start) AS start_at,
                      CASE WHEN COALESCE(v.ata, p.planned_start) IS NULL THEN NULL ELSE COALESCE(v.atd, p.planned_end) END AS end_at) t`;

// Rows whose interval overlaps [from, to); voyages with no interval are placed by their declared ETA.
const WINDOW = `((t.start_at IS NOT NULL AND t.start_at < @to AND (t.end_at IS NULL OR t.end_at > @from))
   OR (t.start_at IS NULL AND v.declared_eta >= @from AND v.declared_eta < @to))`;

async function query(db, { status, agentId, berthId, from, to, offset, limit }) {
  const where = [];
  const bind = (req) => {
    if (status) req.input('status', db.sql.VarChar(20), status);
    if (agentId) req.input('agentId', db.sql.Int, agentId);
    if (berthId) req.input('berthId', db.sql.Int, berthId);
    if (from) req.input('from', db.sql.DateTime2(3), from).input('to', db.sql.DateTime2(3), to);
    return req;
  };
  if (status) where.push('v.status = @status');
  if (agentId) where.push('v.agent_id = @agentId');
  if (berthId) where.push('p.berth_id = @berthId');
  if (from) where.push(WINDOW);
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = await bind(db.pool.request()).query(`SELECT COUNT(*) AS n ${FROM} ${clause}`);
  const rows = await bind(db.pool.request()).input('offset', db.sql.Int, offset).input('limit', db.sql.Int, limit).query(
    `SELECT v.id, v.voyage_code, v.status, v.priority_class, s.ship_name, s.imo_number, v.agent_id, a.agent_name,
            v.declared_eta, v.ata, v.atd, p.berth_id, p.berth_code, p.berth_name, p.planned_start, p.planned_end,
            t.start_at, t.end_at, CASE WHEN v.ata IS NOT NULL THEN 'ACTUAL' WHEN p.id IS NOT NULL THEN 'PLAN' ELSE NULL END AS bar_source
     ${FROM} ${clause} ORDER BY COALESCE(t.start_at, v.declared_eta), v.id OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);
  return { items: rows.recordset, total: total.recordset[0].n };
}

module.exports = { query };
