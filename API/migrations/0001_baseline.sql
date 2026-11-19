-- 0001_baseline.sql
-- SmartPort V2 baseline schema for Module M1 (vessel arrival/departure) and M2 (berth scheduling),
-- plus their minimum dependencies (auth, catalogs, parameters, documents, notifications, audit).
-- Target: SQL Server. Conventions: DATETIME2(3) stored in UTC; revision columns for optimistic concurrency;
-- every table has primary and foreign keys; domain values enforced with CHECK constraints.
-- Rollback: rollback/0001_baseline.down.sql (disposable databases only).
-- Design rationale and assumption IDs (A-n) are in docs/database/schema.md.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;   -- required for filtered indexes and JSON functions
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- ---------------------------------------------------------------- catalogs
CREATE TABLE dbo.ports (
    id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ports PRIMARY KEY,
    port_code   VARCHAR(20)   NOT NULL CONSTRAINT UQ_ports_code UNIQUE,
    port_name   NVARCHAR(200) NOT NULL,
    country_code CHAR(2)      NULL,
    is_active   BIT           NOT NULL CONSTRAINT DF_ports_active DEFAULT (1),
    revision    BIGINT        NOT NULL CONSTRAINT DF_ports_revision DEFAULT (1),
    created_at  DATETIME2(3)  NOT NULL CONSTRAINT DF_ports_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_ports_code_nonblank CHECK (LEN(LTRIM(RTRIM(port_code))) > 0)
);

CREATE TABLE dbo.agents (
    id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_agents PRIMARY KEY,
    agent_code  VARCHAR(30)   NOT NULL CONSTRAINT UQ_agents_code UNIQUE,
    agent_name  NVARCHAR(200) NOT NULL,
    is_active   BIT           NOT NULL CONSTRAINT DF_agents_active DEFAULT (1),
    revision    BIGINT        NOT NULL CONSTRAINT DF_agents_revision DEFAULT (1),
    created_at  DATETIME2(3)  NOT NULL CONSTRAINT DF_agents_created DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.ship_types (
    id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ship_types PRIMARY KEY,
    type_code   VARCHAR(30)   NOT NULL CONSTRAINT UQ_ship_types_code UNIQUE,
    type_name   NVARCHAR(100) NOT NULL,
    cargo_class VARCHAR(20)   NOT NULL,
    is_active   BIT           NOT NULL CONSTRAINT DF_ship_types_active DEFAULT (1),
    revision    BIGINT        NOT NULL CONSTRAINT DF_ship_types_revision DEFAULT (1),
    CONSTRAINT CK_ship_types_cargo_class CHECK (cargo_class IN ('CONTAINER', 'BULK'))
);

CREATE TABLE dbo.document_types (
    code                  VARCHAR(40)   NOT NULL CONSTRAINT PK_document_types PRIMARY KEY,
    name_vi               NVARCHAR(200) NOT NULL,
    applies_to            VARCHAR(10)   NOT NULL,
    is_active             BIT           NOT NULL CONSTRAINT DF_document_types_active DEFAULT (1),
    CONSTRAINT CK_document_types_applies CHECK (applies_to IN ('SHIP', 'VOYAGE', 'BOTH'))
);

CREATE TABLE dbo.system_parameters (
    param_key    VARCHAR(100)  NOT NULL CONSTRAINT PK_system_parameters PRIMARY KEY,
    param_value  NVARCHAR(500) NOT NULL,
    default_value NVARCHAR(500) NOT NULL,
    value_type   VARCHAR(10)   NOT NULL,
    description  NVARCHAR(500) NULL,
    revision     BIGINT        NOT NULL CONSTRAINT DF_system_parameters_revision DEFAULT (1),
    updated_at   DATETIME2(3)  NOT NULL CONSTRAINT DF_system_parameters_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_system_parameters_type CHECK (value_type IN ('INT', 'DECIMAL', 'STRING'))
);

-- ---------------------------------------------------------------- vessels (M1)
CREATE TABLE dbo.ships (
    id                INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ships PRIMARY KEY,
    ship_code         VARCHAR(50)   NOT NULL CONSTRAINT UQ_ships_code UNIQUE,
    imo_number        CHAR(7)       NOT NULL CONSTRAINT UQ_ships_imo UNIQUE,
    ship_name         NVARCHAR(200) NOT NULL,
    flag_state        NVARCHAR(100) NULL,
    ship_type_id      INT           NOT NULL CONSTRAINT FK_ships_ship_type REFERENCES dbo.ship_types(id),
    operator_agent_id INT           NULL     CONSTRAINT FK_ships_agent REFERENCES dbo.agents(id),
    length_overall_m  DECIMAL(10,2) NOT NULL,
    beam_m            DECIMAL(10,2) NOT NULL,
    max_draft_m       DECIMAL(10,2) NOT NULL,
    deadweight_t      DECIMAL(12,2) NOT NULL,
    is_active         BIT           NOT NULL CONSTRAINT DF_ships_active DEFAULT (1),
    revision          BIGINT        NOT NULL CONSTRAINT DF_ships_revision DEFAULT (1),
    created_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_ships_created DEFAULT (SYSUTCDATETIME()),
    updated_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_ships_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_ships_imo_digits CHECK (imo_number NOT LIKE '%[^0-9]%'),
    CONSTRAINT CK_ships_dimensions CHECK (length_overall_m > 0 AND beam_m > 0 AND max_draft_m > 0 AND deadweight_t > 0)
);

-- Voyages are created before the ETA prediction table; the circular latest_eta_prediction_id FK is added afterwards.
CREATE TABLE dbo.voyages (
    id                       INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_voyages PRIMARY KEY,
    ship_id                  INT           NOT NULL CONSTRAINT FK_voyages_ship REFERENCES dbo.ships(id),
    voyage_code              VARCHAR(50)   NOT NULL,
    status                   VARCHAR(20)   NOT NULL CONSTRAINT DF_voyages_status DEFAULT ('ANNOUNCED'),
    agent_id                 INT           NOT NULL CONSTRAINT FK_voyages_agent REFERENCES dbo.agents(id),
    origin_port_id           INT           NOT NULL CONSTRAINT FK_voyages_origin_port REFERENCES dbo.ports(id),
    declared_eta             DATETIME2(3)  NOT NULL,
    declared_teu             INT           NOT NULL,
    cargo_type               NVARCHAR(100) NOT NULL,
    service_request          NVARCHAR(1000) NULL,
    priority_class           VARCHAR(20)   NOT NULL CONSTRAINT DF_voyages_priority DEFAULT ('STANDARD'),
    announced_by_user_id     BIGINT        NULL,
    announced_at             DATETIME2(3)  NOT NULL CONSTRAINT DF_voyages_announced DEFAULT (SYSUTCDATETIME()),
    validation_result        VARCHAR(20)   NULL,
    validation_reason        NVARCHAR(1000) NULL,
    validated_at             DATETIME2(3)  NULL,
    validation_policy_version VARCHAR(40)  NULL,
    queue_position           INT           NULL,
    queued_at                DATETIME2(3)  NULL,
    latest_eta_prediction_id BIGINT        NULL,
    ata                      DATETIME2(3)  NULL,
    atd                      DATETIME2(3)  NULL,
    revision                 BIGINT        NOT NULL CONSTRAINT DF_voyages_revision DEFAULT (1),
    created_at               DATETIME2(3)  NOT NULL CONSTRAINT DF_voyages_created DEFAULT (SYSUTCDATETIME()),
    updated_at               DATETIME2(3)  NOT NULL CONSTRAINT DF_voyages_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_voyages_ship_code UNIQUE (ship_id, voyage_code),
    CONSTRAINT CK_voyages_status CHECK (status IN ('ANNOUNCED', 'MISSING_DOCUMENTS', 'REJECTED',
        'VALIDATED', 'WAITING_BERTH', 'BERTHED', 'DEPARTED')),
    CONSTRAINT CK_voyages_priority CHECK (priority_class IN ('STANDARD', 'MAIN_LINE', 'REEFER_OR_HAZARD')),
    CONSTRAINT CK_voyages_validation_result CHECK (validation_result IS NULL OR
        validation_result IN ('VALID', 'MISSING_DOCUMENTS', 'REJECTED')),
    CONSTRAINT CK_voyages_teu CHECK (declared_teu >= 0),
    CONSTRAINT CK_voyages_queue CHECK (queue_position IS NULL OR queue_position > 0),
    CONSTRAINT CK_voyages_queue_state CHECK (
        (status = 'WAITING_BERTH' AND queue_position IS NOT NULL AND queued_at IS NOT NULL)
        OR (status <> 'WAITING_BERTH' AND queue_position IS NULL)),
    CONSTRAINT CK_voyages_valid_result CHECK (
        status NOT IN ('VALIDATED', 'WAITING_BERTH', 'BERTHED', 'DEPARTED')
        OR (validation_result = 'VALID' AND validated_at IS NOT NULL AND validation_policy_version IS NOT NULL)),
    CONSTRAINT CK_voyages_ata CHECK (status NOT IN ('BERTHED', 'DEPARTED') OR ata IS NOT NULL),
    CONSTRAINT CK_voyages_atd CHECK (status <> 'DEPARTED' OR (atd IS NOT NULL AND ata IS NOT NULL AND atd >= ata))
);

CREATE TABLE dbo.voyage_status_history (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_voyage_status_history PRIMARY KEY,
    voyage_id     INT           NOT NULL CONSTRAINT FK_vsh_voyage REFERENCES dbo.voyages(id),
    from_status   VARCHAR(20)   NULL,
    to_status     VARCHAR(20)   NOT NULL,
    reason        NVARCHAR(500) NULL,
    actor         NVARCHAR(100) NOT NULL,
    changed_at    DATETIME2(3)  NOT NULL CONSTRAINT DF_vsh_changed DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vsh_actor CHECK (LEN(LTRIM(RTRIM(actor))) > 0)
);

CREATE TABLE dbo.voyage_queue_changes (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_voyage_queue_changes PRIMARY KEY,
    voyage_id     INT           NOT NULL CONSTRAINT FK_vqc_voyage REFERENCES dbo.voyages(id),
    from_position INT           NULL,
    to_position   INT           NOT NULL,
    reason        NVARCHAR(500) NOT NULL,
    actor         NVARCHAR(100) NOT NULL,
    changed_at    DATETIME2(3)  NOT NULL CONSTRAINT DF_vqc_changed DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vqc_reason CHECK (LEN(LTRIM(RTRIM(reason))) > 0),
    CONSTRAINT CK_vqc_positions CHECK (to_position > 0 AND (from_position IS NULL OR from_position > 0))
);

CREATE TABLE dbo.voyage_eta_predictions (
    id              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_voyage_eta_predictions PRIMARY KEY,
    voyage_id       INT           NOT NULL CONSTRAINT FK_vep_voyage REFERENCES dbo.voyages(id),
    declared_eta    DATETIME2(3)  NOT NULL,
    ai_status       VARCHAR(20)   NOT NULL,
    predicted_eta   DATETIME2(3)  NULL,
    eta_deviation_h DECIMAL(9,3)  NULL,
    eta_confidence  DECIMAL(5,4)  NULL,
    model_version   NVARCHAR(40)  NULL,
    failure_reason  NVARCHAR(200) NULL,
    input_hash      CHAR(64)      NOT NULL,
    input_json      NVARCHAR(MAX) NOT NULL,
    requested_at    DATETIME2(3)  NOT NULL CONSTRAINT DF_vep_requested DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_vep_status CHECK (ai_status IN ('AVAILABLE', 'UNAVAILABLE')),
    CONSTRAINT CK_vep_confidence CHECK (eta_confidence IS NULL OR (eta_confidence >= 0 AND eta_confidence <= 1)),
    CONSTRAINT CK_vep_result CHECK (
        (ai_status = 'AVAILABLE' AND predicted_eta IS NOT NULL AND eta_confidence IS NOT NULL
            AND model_version IS NOT NULL AND failure_reason IS NULL)
        OR (ai_status = 'UNAVAILABLE' AND predicted_eta IS NULL AND failure_reason IS NOT NULL)),
    CONSTRAINT CK_vep_input_json CHECK (ISJSON(input_json) = 1)
);

ALTER TABLE dbo.voyages ADD CONSTRAINT FK_voyages_latest_eta
    FOREIGN KEY (latest_eta_prediction_id) REFERENCES dbo.voyage_eta_predictions(id);

-- ---------------------------------------------------------------- documents (M1, D2)
CREATE TABLE dbo.ship_documents (
    id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ship_documents PRIMARY KEY,
    ship_id             INT           NOT NULL CONSTRAINT FK_sd_ship REFERENCES dbo.ships(id),
    voyage_id           INT           NULL     CONSTRAINT FK_sd_voyage REFERENCES dbo.voyages(id),
    document_type_code  VARCHAR(40)   NOT NULL CONSTRAINT FK_sd_type REFERENCES dbo.document_types(code),
    original_filename   NVARCHAR(255) NOT NULL,
    storage_key         VARCHAR(200)  NOT NULL CONSTRAINT UQ_sd_storage UNIQUE,
    mime_type           VARCHAR(100)  NOT NULL,
    file_size_bytes     BIGINT        NOT NULL,
    review_status       VARCHAR(20)   NOT NULL CONSTRAINT DF_sd_review DEFAULT ('PENDING'),
    valid_from          DATE          NULL,
    valid_until         DATE          NULL,
    uploaded_by_user_id BIGINT        NULL,
    uploaded_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_sd_uploaded DEFAULT (SYSUTCDATETIME()),
    reviewed_by_user_id BIGINT        NULL,
    reviewed_at         DATETIME2(3)  NULL,
    review_note         NVARCHAR(2000) NULL,
    revision            BIGINT        NOT NULL CONSTRAINT DF_sd_revision DEFAULT (1),
    CONSTRAINT CK_sd_mime CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    CONSTRAINT CK_sd_size CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
    CONSTRAINT CK_sd_review CHECK (review_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT CK_sd_review_fields CHECK (
        (review_status = 'PENDING' AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
        OR (review_status IN ('APPROVED', 'REJECTED') AND reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL)),
    CONSTRAINT CK_sd_validity CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from),
    CONSTRAINT CK_sd_rejected_note CHECK (review_status <> 'REJECTED' OR LEN(LTRIM(RTRIM(review_note))) > 0)
);

-- ---------------------------------------------------------------- berths and planning (M2)
CREATE TABLE dbo.berths (
    id                INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_berths PRIMARY KEY,
    berth_code        VARCHAR(20)   NOT NULL CONSTRAINT UQ_berths_code UNIQUE,
    berth_name        NVARCHAR(200) NOT NULL,
    berth_type        VARCHAR(20)   NOT NULL,
    length_m          DECIMAL(10,2) NOT NULL,
    max_depth_m       DECIMAL(10,2) NOT NULL,
    available_cranes  INT           NOT NULL,
    allows_dangerous  BIT           NOT NULL CONSTRAINT DF_berths_dangerous DEFAULT (0),
    longitude         DECIMAL(11,8) NULL,
    latitude          DECIMAL(10,8) NULL,
    operational_status VARCHAR(20)  NOT NULL CONSTRAINT DF_berths_op_status DEFAULT ('IN_SERVICE'),
    is_active         BIT           NOT NULL CONSTRAINT DF_berths_active DEFAULT (1),
    revision          BIGINT        NOT NULL CONSTRAINT DF_berths_revision DEFAULT (1),
    created_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_berths_created DEFAULT (SYSUTCDATETIME()),
    updated_at        DATETIME2(3)  NOT NULL CONSTRAINT DF_berths_updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_berths_type CHECK (berth_type IN ('CONTAINER', 'BULK')),
    CONSTRAINT CK_berths_dims CHECK (length_m > 0 AND max_depth_m > 0 AND available_cranes >= 0),
    CONSTRAINT CK_berths_longitude CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
    CONSTRAINT CK_berths_latitude CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT CK_berths_op_status CHECK (operational_status IN ('IN_SERVICE', 'OUT_OF_SERVICE'))
);

CREATE TABLE dbo.berth_maintenance (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_berth_maintenance PRIMARY KEY,
    berth_id      INT           NOT NULL CONSTRAINT FK_bm_berth REFERENCES dbo.berths(id),
    starts_at     DATETIME2(3)  NOT NULL,
    ends_at       DATETIME2(3)  NOT NULL,
    status        VARCHAR(20)   NOT NULL CONSTRAINT DF_bm_status DEFAULT ('ACTIVE'),
    reason        NVARCHAR(500) NOT NULL,
    created_by    NVARCHAR(100) NOT NULL,
    created_at    DATETIME2(3)  NOT NULL CONSTRAINT DF_bm_created DEFAULT (SYSUTCDATETIME()),
    revision      BIGINT        NOT NULL CONSTRAINT DF_bm_revision DEFAULT (1),
    CONSTRAINT CK_bm_period CHECK (starts_at < ends_at),
    CONSTRAINT CK_bm_status CHECK (status IN ('ACTIVE', 'CANCELLED')),
    CONSTRAINT CK_bm_reason CHECK (LEN(LTRIM(RTRIM(reason))) > 0)
);

CREATE TABLE dbo.berth_plan_inferences (
    id                   BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_berth_plan_inferences PRIMARY KEY,
    requested_by_user_id BIGINT        NULL,
    requested_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_bpi_requested DEFAULT (SYSUTCDATETIME()),
    model_version        NVARCHAR(40)  NULL,
    ai_status            VARCHAR(20)   NOT NULL,
    failure_reason       NVARCHAR(200) NULL,
    request_json         NVARCHAR(MAX) NOT NULL,
    CONSTRAINT CK_bpi_status CHECK (ai_status IN ('AVAILABLE', 'UNAVAILABLE')),
    CONSTRAINT CK_bpi_json CHECK (ISJSON(request_json) = 1),
    CONSTRAINT CK_bpi_result CHECK (
        (ai_status = 'AVAILABLE' AND model_version IS NOT NULL AND failure_reason IS NULL)
        OR (ai_status = 'UNAVAILABLE' AND failure_reason IS NOT NULL))
);

CREATE TABLE dbo.berth_plan_proposals (
    id                 BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_berth_plan_proposals PRIMARY KEY,
    inference_id       BIGINT        NOT NULL CONSTRAINT FK_bpp_inference REFERENCES dbo.berth_plan_inferences(id),
    voyage_id          INT           NOT NULL CONSTRAINT FK_bpp_voyage REFERENCES dbo.voyages(id),
    berth_id           INT           NOT NULL CONSTRAINT FK_bpp_berth REFERENCES dbo.berths(id),
    rank_no            INT           NOT NULL,
    position_start_m   DECIMAL(10,2) NOT NULL,
    planned_start      DATETIME2(3)  NOT NULL,
    planned_end        DATETIME2(3)  NOT NULL,
    expected_wait_h    DECIMAL(10,2) NOT NULL,
    score              DECIMAL(9,6)  NOT NULL,
    constraint_check_json NVARCHAR(MAX) NOT NULL,
    created_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_bpp_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_bpp_rank UNIQUE (inference_id, rank_no),
    CONSTRAINT CK_bpp_rank CHECK (rank_no BETWEEN 1 AND 3),
    CONSTRAINT CK_bpp_period CHECK (planned_start < planned_end),
    CONSTRAINT CK_bpp_metrics CHECK (expected_wait_h >= 0 AND score BETWEEN 0 AND 1 AND position_start_m >= 0),
    CONSTRAINT CK_bpp_check_json CHECK (ISJSON(constraint_check_json) = 1)
);

CREATE TABLE dbo.berth_plans (
    id                    BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_berth_plans PRIMARY KEY,
    voyage_id             INT           NOT NULL CONSTRAINT FK_bp_voyage REFERENCES dbo.voyages(id),
    berth_id              INT           NOT NULL CONSTRAINT FK_bp_berth REFERENCES dbo.berths(id),
    plan_status           VARCHAR(20)   NOT NULL CONSTRAINT DF_bp_status DEFAULT ('DRAFT'),
    source                VARCHAR(20)   NOT NULL,
    proposal_id           BIGINT        NULL CONSTRAINT FK_bp_proposal REFERENCES dbo.berth_plan_proposals(id),
    supersedes_plan_id    BIGINT        NULL CONSTRAINT FK_bp_supersedes REFERENCES dbo.berth_plans(id),
    position_start_m      DECIMAL(10,2) NOT NULL,
    position_end_m        DECIMAL(10,2) NULL,
    planned_start         DATETIME2(3)  NOT NULL,
    planned_end           DATETIME2(3)  NOT NULL,
    required_cranes       INT           NULL,
    buffer_m              DECIMAL(10,2) NOT NULL,
    policy_version        VARCHAR(40)   NOT NULL,
    constraint_check_json NVARCHAR(MAX) NOT NULL,
    override_reason       NVARCHAR(500) NULL,
    rejection_reason      NVARCHAR(500) NULL,
    created_by_user_id    BIGINT        NULL,
    created_at            DATETIME2(3)  NOT NULL CONSTRAINT DF_bp_created DEFAULT (SYSUTCDATETIME()),
    submitted_by_user_id  BIGINT        NULL,
    submitted_at          DATETIME2(3)  NULL,
    approved_by_user_id   BIGINT        NULL,
    approved_at           DATETIME2(3)  NULL,
    revision              BIGINT        NOT NULL CONSTRAINT DF_bp_revision DEFAULT (1),
    CONSTRAINT CK_bp_status CHECK (plan_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED',
        'REJECTED', 'SUPERSEDED', 'COMPLETED')),
    CONSTRAINT CK_bp_source CHECK (source IN ('MANUAL', 'AI', 'AI_ADJUSTED')),
    CONSTRAINT CK_bp_source_proposal CHECK (
        (source = 'MANUAL' AND proposal_id IS NULL) OR (source IN ('AI', 'AI_ADJUSTED') AND proposal_id IS NOT NULL)),
    CONSTRAINT CK_bp_period CHECK (planned_start < planned_end),
    CONSTRAINT CK_bp_position CHECK (position_start_m >= 0 AND (position_end_m IS NULL OR position_end_m > position_start_m)),
    CONSTRAINT CK_bp_buffer CHECK (buffer_m >= 0),
    CONSTRAINT CK_bp_cranes CHECK (required_cranes IS NULL OR required_cranes >= 0),
    CONSTRAINT CK_bp_check_json CHECK (ISJSON(constraint_check_json) = 1),
    CONSTRAINT CK_bp_override CHECK (override_reason IS NULL OR LEN(LTRIM(RTRIM(override_reason))) BETWEEN 1 AND 500),
    CONSTRAINT CK_bp_reviewed CHECK (
        plan_status NOT IN ('PENDING_APPROVAL', 'APPROVED', 'COMPLETED')
        OR (position_end_m IS NOT NULL AND required_cranes IS NOT NULL
            AND JSON_VALUE(constraint_check_json, '$.passed') = 'true')),
    CONSTRAINT CK_bp_submit_pair CHECK ((submitted_by_user_id IS NULL AND submitted_at IS NULL)
        OR (submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)),
    CONSTRAINT CK_bp_approve_pair CHECK ((approved_by_user_id IS NULL AND approved_at IS NULL)
        OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT CK_bp_approved_fields CHECK (plan_status NOT IN ('APPROVED', 'COMPLETED')
        OR (approved_at IS NOT NULL AND submitted_at IS NOT NULL)),
    CONSTRAINT CK_bp_reject_reason CHECK (plan_status <> 'REJECTED' OR LEN(LTRIM(RTRIM(rejection_reason))) > 0),
    CONSTRAINT CK_bp_not_self_supersede CHECK (supersedes_plan_id IS NULL OR supersedes_plan_id <> id)
);

-- At most one open plan (pending or approved) per voyage. Berth overlap (BR-01/BR-02) is enforced in the service
-- inside a transaction that locks the berth row; see docs/database/schema.md.
CREATE UNIQUE INDEX UX_bp_open_plan_per_voyage ON dbo.berth_plans(voyage_id)
    WHERE plan_status IN ('PENDING_APPROVAL', 'APPROVED');

CREATE INDEX IX_bp_berth_time ON dbo.berth_plans(berth_id, planned_start, planned_end)
    WHERE plan_status IN ('PENDING_APPROVAL', 'APPROVED', 'COMPLETED');

CREATE TABLE dbo.berth_plan_status_history (
    id           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_bp_status_history PRIMARY KEY,
    plan_id      BIGINT        NOT NULL CONSTRAINT FK_bpsh_plan REFERENCES dbo.berth_plans(id),
    from_status  VARCHAR(20)   NULL,
    to_status    VARCHAR(20)   NOT NULL,
    reason       NVARCHAR(500) NULL,
    actor        NVARCHAR(100) NOT NULL,
    changed_at   DATETIME2(3)  NOT NULL CONSTRAINT DF_bpsh_changed DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_bpsh_to CHECK (to_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED',
        'REJECTED', 'SUPERSEDED', 'COMPLETED')),
    CONSTRAINT CK_bpsh_actor CHECK (LEN(LTRIM(RTRIM(actor))) > 0)
);

-- ---------------------------------------------------------------- authentication and RBAC (dependency)
CREATE TABLE dbo.auth_users (
    user_id             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_auth_users PRIMARY KEY,
    username            NVARCHAR(100) NOT NULL CONSTRAINT UQ_auth_users_username UNIQUE,
    display_name        NVARCHAR(200) NOT NULL,
    password_hash       VARCHAR(255)  NOT NULL,
    is_active           BIT           NOT NULL CONSTRAINT DF_auth_users_active DEFAULT (1),
    failed_login_count  INT           NOT NULL CONSTRAINT DF_auth_users_failed DEFAULT (0),
    locked_until        DATETIME2(3)  NULL,
    password_changed_at DATETIME2(3)  NOT NULL CONSTRAINT DF_auth_users_pwd DEFAULT (SYSUTCDATETIME()),
    created_at          DATETIME2(3)  NOT NULL CONSTRAINT DF_auth_users_created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_auth_users_failed CHECK (failed_login_count >= 0)
);

CREATE TABLE dbo.auth_roles (
    role_id    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_auth_roles PRIMARY KEY,
    role_code  VARCHAR(40)   NOT NULL CONSTRAINT UQ_auth_roles_code UNIQUE,
    role_name  NVARCHAR(200) NOT NULL
);

CREATE TABLE dbo.auth_user_roles (
    user_id     BIGINT       NOT NULL CONSTRAINT FK_aur_user REFERENCES dbo.auth_users(user_id),
    role_id     INT          NOT NULL CONSTRAINT FK_aur_role REFERENCES dbo.auth_roles(role_id),
    granted_at  DATETIME2(3) NOT NULL CONSTRAINT DF_aur_granted DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_auth_user_roles PRIMARY KEY (user_id, role_id)
);

-- Agent accounts may act only for their linked agent (A-7 in UC015 profile; UC013 scope rule).
CREATE TABLE dbo.auth_user_agents (
    user_id   BIGINT NOT NULL CONSTRAINT FK_aua_user REFERENCES dbo.auth_users(user_id),
    agent_id  INT    NOT NULL CONSTRAINT FK_aua_agent REFERENCES dbo.agents(id),
    CONSTRAINT PK_auth_user_agents PRIMARY KEY (user_id, agent_id)
);

CREATE TABLE dbo.auth_sessions (
    token_hash    VARBINARY(32) NOT NULL CONSTRAINT PK_auth_sessions PRIMARY KEY,
    user_id       BIGINT        NOT NULL CONSTRAINT FK_as_user REFERENCES dbo.auth_users(user_id),
    created_at    DATETIME2(3)  NOT NULL CONSTRAINT DF_as_created DEFAULT (SYSUTCDATETIME()),
    last_seen_at  DATETIME2(3)  NOT NULL CONSTRAINT DF_as_seen DEFAULT (SYSUTCDATETIME()),
    expires_at    DATETIME2(3)  NOT NULL,
    revoked_at    DATETIME2(3)  NULL,
    CONSTRAINT CK_as_expiry CHECK (expires_at > created_at)
);

-- ---------------------------------------------------------------- notifications (D6) and audit
CREATE TABLE dbo.notifications (
    id                 BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_notifications PRIMARY KEY,
    recipient_user_id  BIGINT        NULL CONSTRAINT FK_notif_user REFERENCES dbo.auth_users(user_id),
    recipient_role_code VARCHAR(40)  NULL,
    title              NVARCHAR(200) NOT NULL,
    body               NVARCHAR(1000) NOT NULL,
    entity_type        VARCHAR(40)   NULL,
    entity_id          BIGINT        NULL,
    created_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_notif_created DEFAULT (SYSUTCDATETIME()),
    read_at            DATETIME2(3)  NULL,
    CONSTRAINT CK_notif_recipient CHECK (recipient_user_id IS NOT NULL OR recipient_role_code IS NOT NULL)
);

CREATE INDEX IX_notif_user_unread ON dbo.notifications(recipient_user_id) WHERE read_at IS NULL;

-- One generic audit table for all state changes (rule 04: actor, action, target, timestamp, outcome).
CREATE TABLE dbo.audit_events (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_audit_events PRIMARY KEY,
    actor         NVARCHAR(100) NOT NULL,
    action        VARCHAR(60)   NOT NULL,
    entity_type   VARCHAR(40)   NOT NULL,
    entity_id     NVARCHAR(64)  NULL,
    outcome       VARCHAR(20)   NOT NULL,
    reason        NVARCHAR(500) NULL,
    old_json      NVARCHAR(MAX) NULL,
    new_json      NVARCHAR(MAX) NULL,
    occurred_at   DATETIME2(3)  NOT NULL CONSTRAINT DF_audit_occurred DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_audit_outcome CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILED')),
    CONSTRAINT CK_audit_old_json CHECK (old_json IS NULL OR ISJSON(old_json) = 1),
    CONSTRAINT CK_audit_new_json CHECK (new_json IS NULL OR ISJSON(new_json) = 1)
);

CREATE INDEX IX_audit_entity ON dbo.audit_events(entity_type, entity_id, occurred_at);

COMMIT TRANSACTION;
