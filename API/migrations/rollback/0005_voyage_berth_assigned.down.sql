-- Rollback for 0005_voyage_berth_assigned.sql. Run only with explicit authorization (rule 05); not run by the migration runner.
-- It REFUSES to run (THROW, nothing changed) when it would lose information: voyages that are BERTH_ASSIGNED (their state cannot be
-- expressed in the old model) and queue history rows that record a voyage leaving the queue. Resolve or export those rows first.
-- After a rollback, delete the 0005 row from dbo.schema_migrations so the runner can re-apply it.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM dbo.voyages WHERE status = 'BERTH_ASSIGNED')
    THROW 50051, 'Rollback 0005 blocked: voyages in state BERTH_ASSIGNED exist.', 1;
IF EXISTS (SELECT 1 FROM dbo.voyage_queue_changes WHERE change_type = 'LEFT_QUEUE')
    THROW 50052, 'Rollback 0005 blocked: queue history rows of type LEFT_QUEUE exist.', 1;

ALTER TABLE dbo.voyage_queue_changes DROP CONSTRAINT CK_vqc_positions;
ALTER TABLE dbo.voyage_queue_changes ALTER COLUMN to_position INT NOT NULL;
ALTER TABLE dbo.voyage_queue_changes ADD CONSTRAINT CK_vqc_positions CHECK (to_position > 0 AND (from_position IS NULL OR from_position > 0));
ALTER TABLE dbo.voyage_queue_changes DROP CONSTRAINT DF_vqc_type;
ALTER TABLE dbo.voyage_queue_changes DROP COLUMN change_type;

ALTER TABLE dbo.voyages DROP CONSTRAINT CK_voyages_valid_result;
ALTER TABLE dbo.voyages ADD CONSTRAINT CK_voyages_valid_result CHECK (
    status NOT IN ('VALIDATED', 'WAITING_BERTH', 'BERTHED', 'DEPARTED')
    OR (validation_result = 'VALID' AND validated_at IS NOT NULL AND validation_policy_version IS NOT NULL));
ALTER TABLE dbo.voyages DROP CONSTRAINT CK_voyages_status;
ALTER TABLE dbo.voyages ADD CONSTRAINT CK_voyages_status CHECK (status IN ('ANNOUNCED', 'MISSING_DOCUMENTS', 'REJECTED',
    'VALIDATED', 'WAITING_BERTH', 'BERTHED', 'DEPARTED'));

COMMIT TRANSACTION;
