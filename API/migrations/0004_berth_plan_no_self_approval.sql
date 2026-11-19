-- 0004_berth_plan_no_self_approval.sql
-- Decision F-4 (approved by the project owner): the user who submitted a berth plan cannot approve it.
-- The approval use case (UC-030) will also refuse it in the service with a clear message; this constraint is the database safeguard,
-- so no code path, now or later, can store a plan approved by its own submitter. Existing rows cannot violate it: no plan has an approver yet
-- or the approver differs from the submitter (checked by WITH CHECK).
-- Rollback: rollback/0004_berth_plan_no_self_approval.down.sql

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.berth_plans WITH CHECK ADD CONSTRAINT CK_bp_no_self_approval
    CHECK (approved_by_user_id IS NULL OR submitted_by_user_id IS NULL OR approved_by_user_id <> submitted_by_user_id);

COMMIT TRANSACTION;
