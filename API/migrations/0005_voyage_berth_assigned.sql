-- 0005_voyage_berth_assigned.sql
-- Decision C-1 (project owner, 2026-11-19), applied with UC-030: a voyage whose berth plan is approved becomes BERTH_ASSIGNED ("Đã xếp bến")
-- and leaves the waiting queue. BERTHED stays the state of actual berthing and still needs an ATA (CK_voyages_ata is unchanged).
--  - CK_voyages_status and CK_voyages_valid_result accept the new state (a voyage that is validated and waiting, assigned, berthed or departed
--    must carry a VALID validation result). CK_voyages_queue_state is unchanged: every state except WAITING_BERTH must have no queue position.
--  - The queue history must record a voyage that leaves the queue without a new position: voyage_queue_changes gets change_type
--    (MOVE for the existing rows, LEFT_QUEUE for an approval) and to_position becomes nullable, with a constraint tying them together.
--    Existing rows are kept and all become MOVE.
-- Note: a CHECK passes when its expression is UNKNOWN, so every branch states IS NOT NULL explicitly (found by the migration test).
-- Data safety: only constraints and one defaulted column are changed; no row is rewritten. Existing voyages already satisfy the wider constraints.
-- Rollback: rollback/0005_voyage_berth_assigned.down.sql (refuses to run while BERTH_ASSIGNED voyages or LEFT_QUEUE rows exist).
-- Dependent statements run through EXEC because the migration runner sends the file as one batch.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.voyages DROP CONSTRAINT CK_voyages_status;
ALTER TABLE dbo.voyages ADD CONSTRAINT CK_voyages_status CHECK (status IN ('ANNOUNCED', 'MISSING_DOCUMENTS', 'REJECTED',
    'VALIDATED', 'WAITING_BERTH', 'BERTH_ASSIGNED', 'BERTHED', 'DEPARTED'));

ALTER TABLE dbo.voyages DROP CONSTRAINT CK_voyages_valid_result;
ALTER TABLE dbo.voyages ADD CONSTRAINT CK_voyages_valid_result CHECK (
    status NOT IN ('VALIDATED', 'WAITING_BERTH', 'BERTH_ASSIGNED', 'BERTHED', 'DEPARTED')
    OR (validation_result IS NOT NULL AND validation_result = 'VALID' AND validated_at IS NOT NULL AND validation_policy_version IS NOT NULL));

ALTER TABLE dbo.voyage_queue_changes ADD change_type VARCHAR(12) NOT NULL CONSTRAINT DF_vqc_type DEFAULT ('MOVE');
ALTER TABLE dbo.voyage_queue_changes DROP CONSTRAINT CK_vqc_positions;
ALTER TABLE dbo.voyage_queue_changes ALTER COLUMN to_position INT NULL;
EXEC(N'ALTER TABLE dbo.voyage_queue_changes ADD CONSTRAINT CK_vqc_positions CHECK (
    (change_type = ''MOVE'' AND to_position IS NOT NULL AND to_position > 0 AND (from_position IS NULL OR from_position > 0))
    OR (change_type = ''LEFT_QUEUE'' AND from_position IS NOT NULL AND from_position > 0 AND to_position IS NULL))');

COMMIT TRANSACTION;
