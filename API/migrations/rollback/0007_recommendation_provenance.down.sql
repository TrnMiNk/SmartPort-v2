-- Rollback for 0007_recommendation_provenance.sql. Run only with explicit authorization (rule 05); not run by the migration runner.
-- It REFUSES to run (THROW, nothing changed) when the old schema could not express the data: any plan with source LOCAL_OPTIMIZER or
-- LOCAL_OPTIMIZER_ADJUSTED (relabelling them AI would present a local algorithm as an AI model again) and any request with engine_kind EXTERNAL_AI.
-- After a rollback, delete the 0007 row from dbo.schema_migrations so the runner can re-apply it.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM dbo.berth_plans WHERE source IN ('LOCAL_OPTIMIZER', 'LOCAL_OPTIMIZER_ADJUSTED'))
    THROW 50071, 'Rollback 0007 blocked: plans with source LOCAL_OPTIMIZER or LOCAL_OPTIMIZER_ADJUSTED exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.berth_plan_inferences WHERE engine_kind = 'EXTERNAL_AI')
    THROW 50072, 'Rollback 0007 blocked: recommendation requests with engine_kind EXTERNAL_AI exist.', 1;

ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT CK_bpi_engine;
EXEC(N'ALTER TABLE dbo.berth_plan_inferences ADD CONSTRAINT CK_bpi_engine CHECK (engine_kind IN (''LOCAL_OPTIMIZER'', ''EXTERNAL_PROVIDER''))');

ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_source_proposal;
ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_source;
ALTER TABLE dbo.berth_plans ALTER COLUMN source VARCHAR(20) NOT NULL;
EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_source CHECK (source IN (''MANUAL'', ''AI'', ''AI_ADJUSTED''))');
EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_source_proposal CHECK (
    (source = ''MANUAL'' AND proposal_id IS NULL) OR (source IN (''AI'', ''AI_ADJUSTED'') AND proposal_id IS NOT NULL))');

COMMIT TRANSACTION;
