-- 0007_recommendation_provenance.sql
-- UC-027 provenance. Migration 0006 stored plans made from a LOCAL optimizer proposal with source AI / AI_ADJUSTED, which labels a deterministic algorithm as
-- "AI". This migration separates the origins of a plan:
--   MANUAL                    made by the coordinator
--   LOCAL_OPTIMIZER           equals a proposal of the local deterministic optimizer
--   LOCAL_OPTIMIZER_ADJUSTED  from such a proposal, then changed by the coordinator
--   AI, AI_ADJUSTED           reserved for an actual external AI provider (none exists); the values are unchanged so old rows and consumers keep working
-- and the origin of a recommendation request (berth_plan_inferences.engine_kind) gains EXTERNAL_AI (the old value EXTERNAL_PROVIDER stays valid for rows that
-- predate 0006 and is shown as EXTERNAL_AI).
-- Data: plans that came from a LOCAL_OPTIMIZER request and carry AI / AI_ADJUSTED are relabelled, and one audit row records how many. No other row changes.
-- berth_plans.source is widened from VARCHAR(20) to VARCHAR(30) (the new value is 24 characters). Widening cannot lose data.
-- Rollback: rollback/0007_recommendation_provenance.down.sql (refuses to run while any LOCAL_OPTIMIZER plan or EXTERNAL_AI request exists, because the old
-- schema cannot express them without losing the distinction).
-- Dependent statements run through EXEC because the migration runner sends the file as one batch.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_source_proposal;
ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_source;
ALTER TABLE dbo.berth_plans ALTER COLUMN source VARCHAR(30) NOT NULL;
EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_source CHECK (source IN (''MANUAL'', ''AI'', ''AI_ADJUSTED'', ''LOCAL_OPTIMIZER'', ''LOCAL_OPTIMIZER_ADJUSTED''))');
EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_source_proposal CHECK (
    (source = ''MANUAL'' AND proposal_id IS NULL) OR (source <> ''MANUAL'' AND proposal_id IS NOT NULL))');

ALTER TABLE dbo.berth_plan_inferences DROP CONSTRAINT CK_bpi_engine;
EXEC(N'ALTER TABLE dbo.berth_plan_inferences ADD CONSTRAINT CK_bpi_engine CHECK (engine_kind IN (''LOCAL_OPTIMIZER'', ''EXTERNAL_AI'', ''EXTERNAL_PROVIDER''))');

EXEC(N'
DECLARE @n INT;
UPDATE bp SET source = CASE bp.source WHEN ''AI'' THEN ''LOCAL_OPTIMIZER'' ELSE ''LOCAL_OPTIMIZER_ADJUSTED'' END
FROM dbo.berth_plans bp
JOIN dbo.berth_plan_proposals p ON p.id = bp.proposal_id
JOIN dbo.berth_plan_inferences i ON i.id = p.inference_id
WHERE bp.source IN (''AI'', ''AI_ADJUSTED'') AND i.engine_kind = ''LOCAL_OPTIMIZER'';
SET @n = @@ROWCOUNT;
IF @n > 0
    INSERT INTO dbo.audit_events (actor, action, entity_type, entity_id, outcome, reason)
    VALUES (N''migration:0007'', ''MIGRATION_RELABEL_PLAN_SOURCE'', ''MIGRATION'', ''0007'', ''SUCCESS'', CONCAT(N''Relabelled '', @n, N'' plans from AI to LOCAL_OPTIMIZER (local deterministic optimizer, not an AI model).''));');

COMMIT TRANSACTION;
