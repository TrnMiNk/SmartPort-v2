-- 0006_berth_recommendations.sql
-- UC-027 (FR-BRT-05, FR-BRT-12, NFR-ACC-04): storage for berth recommendations, per-vessel outcomes and the human's final choice.
-- The first schema stored only the request and allowed three proposals per request (UQ_bpp_rank was unique per inference, not per vessel),
-- and nothing recorded the human decision. This migration, for the existing (still empty) tables and without touching any other data:
--   berth_plan_inferences      + engine_kind (LOCAL_OPTIMIZER or EXTERNAL_PROVIDER), snapshot_hash (reproducibility), response_json (the full
--                                answer), duration_ms, completed_at. model_version holds the algorithm version (for example UC027-OPT-V1).
--   berth_plan_inference_vessels (new): one row per vessel of a request: queue position, effective ETA, outcome RECOMMENDED or UNSCHEDULABLE,
--                                how many candidates UC-026 refused, and the reasons. This is what makes "no feasible placement" auditable.
--   berth_plan_proposals       + position_end_m, explanation_json; rank is now unique per vessel inside a request, not per request.
--   berth_plan_decisions (new): the final human choice for a vessel of a request: ACCEPTED (plan equals the proposal), MODIFIED (plan from the
--                                proposal but changed) or IGNORED. A plan made from a proposal carries source AI or AI_ADJUSTED and proposal_id
--                                (columns that already existed on berth_plans).
-- Existing rows stay as they are. Dependent statements run through EXEC because the migration runner sends the file as one batch.
-- Rollback: rollback/0006_berth_recommendations.down.sql (refuses to run while any recommendation, decision or AI-sourced plan exists).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.berth_plan_inferences ADD
    engine_kind   VARCHAR(20)  NOT NULL CONSTRAINT DF_bpi_engine DEFAULT ('EXTERNAL_PROVIDER'),
    snapshot_hash CHAR(64)     NULL,
    response_json NVARCHAR(MAX) NULL,
    duration_ms   INT          NULL,
    completed_at  DATETIME2(3) NULL;
EXEC(N'ALTER TABLE dbo.berth_plan_inferences ADD CONSTRAINT CK_bpi_engine CHECK (engine_kind IN (''LOCAL_OPTIMIZER'', ''EXTERNAL_PROVIDER''))');
EXEC(N'ALTER TABLE dbo.berth_plan_inferences ADD CONSTRAINT CK_bpi_response_json CHECK (response_json IS NULL OR ISJSON(response_json) = 1)');
EXEC(N'ALTER TABLE dbo.berth_plan_inferences ADD CONSTRAINT CK_bpi_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)');
EXEC(N'ALTER TABLE dbo.berth_plan_inferences ADD CONSTRAINT CK_bpi_hash CHECK (snapshot_hash IS NULL OR snapshot_hash NOT LIKE ''%[^0-9a-f]%'')');

CREATE TABLE dbo.berth_plan_inference_vessels (
    id                    BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_bpiv PRIMARY KEY,
    inference_id          BIGINT        NOT NULL CONSTRAINT FK_bpiv_inference REFERENCES dbo.berth_plan_inferences(id),
    voyage_id             INT           NOT NULL CONSTRAINT FK_bpiv_voyage REFERENCES dbo.voyages(id),
    queue_position        INT           NULL,
    effective_eta         DATETIME2(3)  NOT NULL,
    eta_source            VARCHAR(10)   NOT NULL,
    outcome               VARCHAR(16)   NOT NULL,
    candidates_considered INT           NOT NULL,
    candidates_rejected   INT           NOT NULL,
    reasons_json          NVARCHAR(MAX) NOT NULL,
    CONSTRAINT UQ_bpiv_vessel UNIQUE (inference_id, voyage_id),
    CONSTRAINT CK_bpiv_outcome CHECK (outcome IN ('RECOMMENDED', 'UNSCHEDULABLE')),
    CONSTRAINT CK_bpiv_eta_source CHECK (eta_source IN ('DECLARED', 'AI')),
    CONSTRAINT CK_bpiv_counts CHECK (candidates_considered >= 0 AND candidates_rejected >= 0 AND candidates_rejected <= candidates_considered),
    CONSTRAINT CK_bpiv_reasons CHECK (ISJSON(reasons_json) = 1)
);

ALTER TABLE dbo.berth_plan_proposals ADD
    position_end_m   DECIMAL(10,2) NULL,
    explanation_json NVARCHAR(MAX) NULL;
EXEC(N'ALTER TABLE dbo.berth_plan_proposals ADD CONSTRAINT CK_bpp_end CHECK (position_end_m IS NULL OR position_end_m > position_start_m)');
EXEC(N'ALTER TABLE dbo.berth_plan_proposals ADD CONSTRAINT CK_bpp_explanation CHECK (explanation_json IS NULL OR ISJSON(explanation_json) = 1)');
ALTER TABLE dbo.berth_plan_proposals DROP CONSTRAINT UQ_bpp_rank;
ALTER TABLE dbo.berth_plan_proposals ADD CONSTRAINT UQ_bpp_rank_vessel UNIQUE (inference_id, voyage_id, rank_no);

CREATE TABLE dbo.berth_plan_decisions (
    id                 BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_bpd PRIMARY KEY,
    inference_id       BIGINT        NOT NULL CONSTRAINT FK_bpd_inference REFERENCES dbo.berth_plan_inferences(id),
    voyage_id          INT           NOT NULL CONSTRAINT FK_bpd_voyage REFERENCES dbo.voyages(id),
    proposal_id        BIGINT        NULL CONSTRAINT FK_bpd_proposal REFERENCES dbo.berth_plan_proposals(id),
    plan_id            BIGINT        NULL CONSTRAINT FK_bpd_plan REFERENCES dbo.berth_plans(id),
    decision           VARCHAR(10)   NOT NULL,
    reason             NVARCHAR(500) NULL,
    decided_by_user_id BIGINT        NOT NULL,
    decided_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_bpd_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_bpd_decision CHECK (decision IN ('ACCEPTED', 'MODIFIED', 'IGNORED')),
    CONSTRAINT CK_bpd_links CHECK (
        (decision = 'IGNORED' AND plan_id IS NULL AND proposal_id IS NULL)
        OR (decision IN ('ACCEPTED', 'MODIFIED') AND plan_id IS NOT NULL AND proposal_id IS NOT NULL)),
    CONSTRAINT CK_bpd_reason CHECK (reason IS NULL OR LEN(LTRIM(RTRIM(reason))) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX UX_bpd_plan ON dbo.berth_plan_decisions(plan_id) WHERE plan_id IS NOT NULL;
CREATE UNIQUE INDEX UX_bpd_ignore ON dbo.berth_plan_decisions(inference_id, voyage_id) WHERE decision = 'IGNORED';

COMMIT TRANSACTION;
