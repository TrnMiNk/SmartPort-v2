-- 0002_validation_queue_drafts.sql
-- UC-015 (automatic voyage validation), UC-020 (berth queue) and UC-013 drafts.
--  - validation_policies: immutable, versioned policy configuration (what is required). Rules themselves are code.
--  - vessel_restrictions: the "danh sách cấm/hạn chế" of UC-015 step 1. Empty until the business supplies entries.
--  - voyage_validation_runs: one audit record per validation run (rule 06: input snapshot, policy version,
--    each rule evaluated, outcome, reason).
--  - voyage_drafts: server-side drafts of arrival notices (UC-013 alternative flow 3a, as requested by the project owner).
--  - voyage_queue_state: one row whose revision changes on every queue change; used for concurrency control (UC-020 6a).
-- Rollback: rollback/0002_validation_queue_drafts.down.sql (disposable databases only).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

CREATE TABLE dbo.validation_policies (
    version         VARCHAR(40)   NOT NULL CONSTRAINT PK_validation_policies PRIMARY KEY,
    config_json     NVARCHAR(MAX) NOT NULL,
    checksum        CHAR(64)      NOT NULL,
    effective_from  DATETIME2(3)  NOT NULL,
    effective_until DATETIME2(3)  NULL,
    description     NVARCHAR(500) NULL,
    created_at      DATETIME2(3)  NOT NULL CONSTRAINT DF_vp_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vp_json CHECK (ISJSON(config_json) = 1),
    CONSTRAINT CK_vp_window CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE dbo.vessel_restrictions (
    id               INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vessel_restrictions PRIMARY KEY,
    ship_id          INT           NOT NULL CONSTRAINT FK_vr_ship REFERENCES dbo.ships(id),
    restriction_type VARCHAR(20)   NOT NULL,
    reason           NVARCHAR(500) NOT NULL,
    valid_from       DATE          NOT NULL,
    valid_until      DATE          NULL,
    is_active        BIT           NOT NULL CONSTRAINT DF_vr_active DEFAULT (1),
    created_by       NVARCHAR(100) NOT NULL,
    created_at       DATETIME2(3)  NOT NULL CONSTRAINT DF_vr_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vr_type CHECK (restriction_type IN ('PROHIBITED', 'RESTRICTED')),
    CONSTRAINT CK_vr_reason CHECK (LEN(LTRIM(RTRIM(reason))) > 0),
    CONSTRAINT CK_vr_period CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX IX_vr_ship ON dbo.vessel_restrictions(ship_id) WHERE is_active = 1;

CREATE TABLE dbo.voyage_validation_runs (
    id             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_vvr PRIMARY KEY,
    voyage_id      INT           NOT NULL CONSTRAINT FK_vvr_voyage REFERENCES dbo.voyages(id),
    policy_version VARCHAR(40)   NOT NULL CONSTRAINT FK_vvr_policy REFERENCES dbo.validation_policies(version),
    trigger_source VARCHAR(20)   NOT NULL,
    actor          NVARCHAR(100) NOT NULL,
    outcome        VARCHAR(20)   NOT NULL,
    reason_code    VARCHAR(60)   NULL,
    reason         NVARCHAR(1000) NULL,
    input_snapshot NVARCHAR(MAX) NOT NULL,
    rule_results   NVARCHAR(MAX) NOT NULL,
    ai_status      VARCHAR(20)   NULL,
    prediction_id  BIGINT        NULL CONSTRAINT FK_vvr_prediction REFERENCES dbo.voyage_eta_predictions(id),
    queue_position INT           NULL,
    duration_ms    INT           NOT NULL,
    created_at     DATETIME2(3)  NOT NULL CONSTRAINT DF_vvr_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vvr_trigger CHECK (trigger_source IN ('SUBMIT', 'REVALIDATE')),
    CONSTRAINT CK_vvr_outcome CHECK (outcome IN ('VALID', 'MISSING_DOCUMENTS', 'REJECTED')),
    CONSTRAINT CK_vvr_reason CHECK (outcome = 'VALID' OR (reason_code IS NOT NULL AND reason IS NOT NULL)),
    CONSTRAINT CK_vvr_ai CHECK (ai_status IS NULL OR ai_status IN ('AVAILABLE', 'UNAVAILABLE')),
    CONSTRAINT CK_vvr_queue CHECK (outcome = 'VALID' OR (queue_position IS NULL AND ai_status IS NULL)),
    CONSTRAINT CK_vvr_json CHECK (ISJSON(input_snapshot) = 1 AND ISJSON(rule_results) = 1),
    CONSTRAINT CK_vvr_duration CHECK (duration_ms >= 0)
);
CREATE INDEX IX_vvr_voyage ON dbo.voyage_validation_runs(voyage_id, id);

CREATE TABLE dbo.voyage_drafts (
    id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_voyage_drafts PRIMARY KEY,
    owner_user_id       BIGINT        NOT NULL CONSTRAINT FK_vd_owner REFERENCES dbo.auth_users(user_id),
    payload             NVARCHAR(MAX) NOT NULL,
    status              VARCHAR(20)   NOT NULL CONSTRAINT DF_vd_status DEFAULT ('OPEN'),
    submitted_voyage_id INT           NULL CONSTRAINT FK_vd_voyage REFERENCES dbo.voyages(id),
    revision            BIGINT        NOT NULL CONSTRAINT DF_vd_revision DEFAULT (1),
    created_at          DATETIME2(3)  NOT NULL CONSTRAINT DF_vd_created DEFAULT (SYSUTCDATETIME()),
    updated_at          DATETIME2(3)  NOT NULL CONSTRAINT DF_vd_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vd_json CHECK (ISJSON(payload) = 1),
    CONSTRAINT CK_vd_status CHECK (status IN ('OPEN', 'SUBMITTED', 'DISCARDED')),
    CONSTRAINT CK_vd_submitted CHECK ((status = 'SUBMITTED' AND submitted_voyage_id IS NOT NULL)
        OR (status <> 'SUBMITTED' AND submitted_voyage_id IS NULL))
);
CREATE INDEX IX_vd_owner ON dbo.voyage_drafts(owner_user_id, status);

CREATE TABLE dbo.voyage_queue_state (
    id       INT    NOT NULL CONSTRAINT PK_voyage_queue_state PRIMARY KEY,
    revision BIGINT NOT NULL,
    CONSTRAINT CK_vqs_single CHECK (id = 1)
);
INSERT INTO dbo.voyage_queue_state (id, revision) VALUES (1, 1); -- structural row, not demo data

COMMIT TRANSACTION;
