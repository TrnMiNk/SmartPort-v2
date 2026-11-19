-- Rollback for 0002_validation_queue_drafts.sql. DESTRUCTIVE: drops these tables and their data.
-- Run only against a disposable database with explicit authorization (rule 05). Not run by the migration runner.
-- After rollback, delete the 0002 row from dbo.schema_migrations so the runner can re-apply it.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DROP TABLE IF EXISTS dbo.voyage_queue_state;
DROP TABLE IF EXISTS dbo.voyage_drafts;
DROP TABLE IF EXISTS dbo.voyage_validation_runs;
DROP TABLE IF EXISTS dbo.vessel_restrictions;
DROP TABLE IF EXISTS dbo.validation_policies;

COMMIT TRANSACTION;
