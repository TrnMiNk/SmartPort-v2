-- Rollback for 0008_eta_prediction_jobs.sql. Run only with explicit authorization (rule 05); not run by the migration runner.
-- It REFUSES to run (THROW, nothing changed) when it would lose information: any PENDING prediction or run (the old schema cannot hold a request that has not
-- finished) and any prediction row that carries what 0008 added (completed_at, queue_effect, attempts above zero, a claim).
-- After a rollback, delete the 0008 row from dbo.schema_migrations so the runner can re-apply it.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM dbo.voyage_eta_predictions WHERE ai_status = 'PENDING')
    THROW 50081, 'Rollback 0008 blocked: PENDING ETA predictions exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.voyage_validation_runs WHERE ai_status = 'PENDING')
    THROW 50082, 'Rollback 0008 blocked: validation runs with a PENDING AI status exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.voyage_eta_predictions WHERE completed_at IS NOT NULL OR queue_effect IS NOT NULL OR attempts > 0 OR claim_token IS NOT NULL)
    THROW 50083, 'Rollback 0008 blocked: predictions hold completion, attempt or queue-effect information.', 1;

ALTER TABLE dbo.voyage_validation_runs DROP CONSTRAINT CK_vvr_ai;
EXEC(N'ALTER TABLE dbo.voyage_validation_runs ADD CONSTRAINT CK_vvr_ai CHECK (ai_status IS NULL OR ai_status IN (''AVAILABLE'', ''UNAVAILABLE''))');

DROP INDEX IX_vep_claim ON dbo.voyage_eta_predictions;
DROP INDEX UX_vep_one_pending ON dbo.voyage_eta_predictions;
ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT CK_vep_attempts;
ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT CK_vep_effect;
ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT CK_vep_result;
ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT CK_vep_status;
EXEC(N'ALTER TABLE dbo.voyage_eta_predictions ADD CONSTRAINT CK_vep_status CHECK (ai_status IN (''AVAILABLE'', ''UNAVAILABLE''))');
EXEC(N'ALTER TABLE dbo.voyage_eta_predictions ADD CONSTRAINT CK_vep_result CHECK (
    (ai_status = ''AVAILABLE'' AND predicted_eta IS NOT NULL AND eta_confidence IS NOT NULL AND model_version IS NOT NULL AND failure_reason IS NULL)
    OR (ai_status = ''UNAVAILABLE'' AND predicted_eta IS NULL AND failure_reason IS NOT NULL))');
ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT DF_vep_attempts;
ALTER TABLE dbo.voyage_eta_predictions DROP COLUMN queue_effect, claimed_until, claim_token, attempts, completed_at;

COMMIT TRANSACTION;
