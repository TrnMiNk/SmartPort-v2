-- 0008_eta_prediction_jobs.sql
-- UC-015 / UC-016 asynchronous ETA (V2 design decision, subject to business acceptance). A valid notice is queued at once on its declared ETA; the AI forecast is
-- requested separately and, when a valid one arrives, the effective ETA and the queue order are updated. The prediction row is the durable job:
--   ai_status gains PENDING (a forecast was requested and has not finished), with the old rules unchanged for AVAILABLE and UNAVAILABLE;
--   claim_token and claimed_until: a worker claims a pending row for a lease, so two workers (or a restarted process) never run it at the same time, and a late
--   result from a claim that expired is recognised and ignored (the token no longer matches);
--   attempts: how many times the job was claimed (a job that keeps failing to finish is closed as UNAVAILABLE / ABANDONED by the worker);
--   completed_at: when the answer was stored;
--   queue_effect: what the answer did to the queue (REORDERED, UNCHANGED, NOT_APPLIED_LEFT_QUEUE, NOT_APPLIED_SUPERSEDED, KEPT_MANUAL_POSITION), so the history says why
--   the queue did or did not change.
-- At most one PENDING row per voyage (filtered unique index). voyage_validation_runs.ai_status may be PENDING: the run records what was known when it ran.
-- Existing rows are untouched (new columns are nullable or defaulted, the new status is only added). Dependent statements run through EXEC because the migration
-- runner sends the file as one batch.
-- Rollback: rollback/0008_eta_prediction_jobs.down.sql (refuses to run while a PENDING row exists or while any row holds the new information).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.voyage_eta_predictions ADD
    completed_at  DATETIME2(3)     NULL,
    attempts      INT              NOT NULL CONSTRAINT DF_vep_attempts DEFAULT (0),
    claim_token   UNIQUEIDENTIFIER NULL,
    claimed_until DATETIME2(3)     NULL,
    queue_effect  VARCHAR(30)      NULL;

ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT CK_vep_status;
ALTER TABLE dbo.voyage_eta_predictions DROP CONSTRAINT CK_vep_result;
EXEC(N'ALTER TABLE dbo.voyage_eta_predictions ADD CONSTRAINT CK_vep_status CHECK (ai_status IN (''PENDING'', ''AVAILABLE'', ''UNAVAILABLE''))');
EXEC(N'ALTER TABLE dbo.voyage_eta_predictions ADD CONSTRAINT CK_vep_result CHECK (
    (ai_status = ''PENDING'' AND predicted_eta IS NULL AND eta_deviation_h IS NULL AND eta_confidence IS NULL AND model_version IS NULL AND failure_reason IS NULL AND completed_at IS NULL)
    OR (ai_status = ''AVAILABLE'' AND predicted_eta IS NOT NULL AND eta_confidence IS NOT NULL AND model_version IS NOT NULL AND failure_reason IS NULL)
    OR (ai_status = ''UNAVAILABLE'' AND predicted_eta IS NULL AND failure_reason IS NOT NULL))');
EXEC(N'ALTER TABLE dbo.voyage_eta_predictions ADD CONSTRAINT CK_vep_effect CHECK (queue_effect IS NULL OR queue_effect IN (''REORDERED'', ''UNCHANGED'', ''NOT_APPLIED_LEFT_QUEUE'', ''NOT_APPLIED_SUPERSEDED'', ''KEPT_MANUAL_POSITION''))');
EXEC(N'ALTER TABLE dbo.voyage_eta_predictions ADD CONSTRAINT CK_vep_attempts CHECK (attempts >= 0)');
EXEC(N'CREATE UNIQUE INDEX UX_vep_one_pending ON dbo.voyage_eta_predictions(voyage_id) WHERE ai_status = ''PENDING''');
EXEC(N'CREATE INDEX IX_vep_claim ON dbo.voyage_eta_predictions(claimed_until, id) WHERE ai_status = ''PENDING''');

ALTER TABLE dbo.voyage_validation_runs DROP CONSTRAINT CK_vvr_ai;
EXEC(N'ALTER TABLE dbo.voyage_validation_runs ADD CONSTRAINT CK_vvr_ai CHECK (ai_status IS NULL OR ai_status IN (''PENDING'', ''AVAILABLE'', ''UNAVAILABLE''))');

COMMIT TRANSACTION;
