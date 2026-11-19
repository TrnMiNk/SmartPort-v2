-- 0003_berth_plan_override_cargo_hazard.sql
-- UC-028 / UC-029 (manual berth plans), UC-026 changes approved by the project owner (decisions F-1 and cargo hazard).
--  - berth_plans gets who/when/which rules for an override of a placement check. The check result keeps its own meaning:
--    constraint_check_json.passed stays false when a rule failed, and the override is stored beside it.
--  - CK_bp_reviewed is REPLACED, not removed: a submitted plan needs either a passing check, or an override reason together with
--    a check whose outcome is VIOLATION (every rule could be evaluated). Missing data can never be overridden. CK_bp_override_set
--    makes the override columns all-or-nothing. Existing plans satisfy the new rule (they all passed).
--  - UX_bp_draft_per_voyage: one draft per voyage (assumption UC-028 A-4), so a coordinator edits the draft instead of piling up copies.
--  - voyages gets the verified cargo hazard (UC-026 BR-03): NULL means not verified; a value needs a basis, the verifier and the time.
-- Dependent statements run through EXEC because the migration runner sends the file as one batch, and a column added in the
-- batch cannot be referenced by name in the same batch.
-- Rollback: rollback/0003_berth_plan_override_cargo_hazard.down.sql (refuses to run when it would lose override or hazard data).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.voyages ADD
    cargo_hazard                     VARCHAR(12)   NULL,
    cargo_hazard_basis               NVARCHAR(500) NULL,
    cargo_hazard_verified_by_user_id BIGINT        NULL,
    cargo_hazard_verified_at         DATETIME2(3)  NULL;

EXEC(N'ALTER TABLE dbo.voyages ADD CONSTRAINT CK_voyages_cargo_hazard CHECK (
    (cargo_hazard IS NULL AND cargo_hazard_basis IS NULL AND cargo_hazard_verified_by_user_id IS NULL AND cargo_hazard_verified_at IS NULL)
    OR (cargo_hazard IN (''NONE'', ''DANGEROUS'') AND LEN(LTRIM(RTRIM(cargo_hazard_basis))) > 0
        AND cargo_hazard_verified_by_user_id IS NOT NULL AND cargo_hazard_verified_at IS NOT NULL))');

ALTER TABLE dbo.berth_plans ADD
    override_by_user_id BIGINT        NULL,
    override_at         DATETIME2(3)  NULL,
    override_rules      NVARCHAR(400) NULL;

EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_override_set CHECK (
    (override_reason IS NULL AND override_by_user_id IS NULL AND override_at IS NULL AND override_rules IS NULL)
    OR (override_reason IS NOT NULL AND override_by_user_id IS NOT NULL AND override_at IS NOT NULL AND ISJSON(override_rules) = 1))');

EXEC(N'ALTER TABLE dbo.berth_plans DROP CONSTRAINT CK_bp_reviewed');
EXEC(N'ALTER TABLE dbo.berth_plans ADD CONSTRAINT CK_bp_reviewed CHECK (
    plan_status NOT IN (''PENDING_APPROVAL'', ''APPROVED'', ''COMPLETED'')
    OR (position_end_m IS NOT NULL AND required_cranes IS NOT NULL
        AND (JSON_VALUE(constraint_check_json, ''$.passed'') = ''true''
             OR (override_reason IS NOT NULL AND JSON_VALUE(constraint_check_json, ''$.outcome'') = ''VIOLATION''))))');

EXEC(N'CREATE UNIQUE INDEX UX_bp_draft_per_voyage ON dbo.berth_plans(voyage_id) WHERE plan_status = ''DRAFT''');

COMMIT TRANSACTION;
