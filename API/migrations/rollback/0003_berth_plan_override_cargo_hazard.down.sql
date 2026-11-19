-- Rollback for 0003_berth_plan_override_cargo_hazard.sql. Run only with explicit authorization (rule 05); not run by the migration runner.
-- It REFUSES to run (THROW, nothing is changed) when it would lose data: plans that carry an override, and voyages with a verified
-- cargo hazard. Export or resolve those rows first. The original CK_bp_reviewed is restored, so a plan that depends on an override
-- would also be impossible after the rollback.
-- After a rollback, delete the 0003 row from dbo.schema_migrations so the runner can re-apply it.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM dbo.berth_plans WHERE override_by_user_id IS NOT NULL OR override_reason IS NOT NULL)
    THROW 50031, 'Rollback 0003 blocked: berth plans with an override exist. Export or remove them first.', 1;
IF EXISTS (SELECT 1 FROM dbo.voyages WHERE cargo_hazard IS NOT NULL)
    THROW 50032, 'Rollback 0003 blocked: voyages with a verified cargo hazard exist. Export or clear them first.', 1;

DROP INDEX UX_bp_draft_per_voyage ON dbo.berth_plans;
ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_reviewed;
ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_override_set;
EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_reviewed CHECK (
    plan_status NOT IN (''PENDING_APPROVAL'', ''APPROVED'', ''COMPLETED'')
    OR (position_end_m IS NOT NULL AND required_cranes IS NOT NULL
        AND JSON_VALUE(constraint_check_json, ''$.passed'') = ''true''))');
ALTER TABLE dbo.berth_plans DROP COLUMN override_by_user_id, override_at, override_rules;

ALTER TABLE dbo.voyages DROP CONSTRAINT CK_voyages_cargo_hazard;
ALTER TABLE dbo.voyages DROP COLUMN cargo_hazard, cargo_hazard_basis, cargo_hazard_verified_by_user_id, cargo_hazard_verified_at;

COMMIT TRANSACTION;
