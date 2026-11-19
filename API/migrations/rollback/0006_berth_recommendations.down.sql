-- Rollback for 0006_berth_recommendations.sql. Run only with explicit authorization (rule 05); not run by the migration runner.
-- It REFUSES to run (THROW, nothing changed) when it would lose information: any recommendation request, per-vessel outcome, proposal or
-- human decision, and any berth plan that came from a proposal (source AI or AI_ADJUSTED). Export or resolve those rows first.
-- After a rollback, delete the 0006 row from dbo.schema_migrations so the runner can re-apply it.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM dbo.berth_plans WHERE source <> 'MANUAL')
    THROW 50061, 'Rollback 0006 blocked: berth plans made from proposals exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.berth_plan_decisions)
    THROW 50062, 'Rollback 0006 blocked: human decisions on recommendations exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.berth_plan_inference_vessels)
    THROW 50063, 'Rollback 0006 blocked: per-vessel recommendation outcomes exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.berth_plan_proposals)
    THROW 50064, 'Rollback 0006 blocked: stored proposals exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.berth_plan_inferences)
    THROW 50065, 'Rollback 0006 blocked: stored recommendation requests exist.', 1;

DROP INDEX UX_bpd_ignore ON dbo.berth_plan_decisions;
DROP INDEX UX_bpd_plan ON dbo.berth_plan_decisions;
DROP TABLE dbo.berth_plan_decisions;

ALTER TABLE dbo.berth_plan_proposals DROP CONSTRAINT UQ_bpp_rank_vessel;
ALTER TABLE dbo.berth_plan_proposals ADD CONSTRAINT UQ_bpp_rank UNIQUE (inference_id, rank_no);
ALTER TABLE dbo.berth_plan_proposals DROP CONSTRAINT CK_bpp_explanation;
ALTER TABLE dbo.berth_plan_proposals DROP CONSTRAINT CK_bpp_end;
ALTER TABLE dbo.berth_plan_proposals DROP COLUMN explanation_json, position_end_m;

DROP TABLE dbo.berth_plan_inference_vessels;

ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT CK_bpi_hash;
ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT CK_bpi_duration;
ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT CK_bpi_response_json;
ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT CK_bpi_engine;
ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT DF_bpi_engine;
ALTER TABLE dbo.berth_plan_inferences DROP COLUMN completed_at, duration_ms, response_json, snapshot_hash, engine_kind;

COMMIT TRANSACTION;
