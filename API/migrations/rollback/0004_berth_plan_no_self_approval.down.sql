-- Rollback for 0004_berth_plan_no_self_approval.sql. Removes only the constraint; no data is touched.
-- Not run by the migration runner. After a rollback, delete the 0004 row from dbo.schema_migrations so the runner can re-apply it.

SET XACT_ABORT ON;
BEGIN TRANSACTION;
ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_no_self_approval;
COMMIT TRANSACTION;
