-- Rollback for 0001_baseline.sql. DESTRUCTIVE: drops every SmartPort V2 baseline table and its data.
-- Run only against a disposable database, and only with explicit authorization (rule 05).
-- Not executed by the migration runner. Drop order is the reverse of dependencies.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.voyages DROP CONSTRAINT IF EXISTS FK_voyages_latest_eta;

DROP TABLE IF EXISTS dbo.audit_events;
DROP TABLE IF EXISTS dbo.notifications;
DROP TABLE IF EXISTS dbo.auth_sessions;
DROP TABLE IF EXISTS dbo.auth_user_agents;
DROP TABLE IF EXISTS dbo.auth_user_roles;
DROP TABLE IF EXISTS dbo.auth_roles;
DROP TABLE IF EXISTS dbo.auth_users;
DROP TABLE IF EXISTS dbo.berth_plan_status_history;
DROP TABLE IF EXISTS dbo.berth_plans;
DROP TABLE IF EXISTS dbo.berth_plan_proposals;
DROP TABLE IF EXISTS dbo.berth_plan_inferences;
DROP TABLE IF EXISTS dbo.berth_maintenance;
DROP TABLE IF EXISTS dbo.berths;
DROP TABLE IF EXISTS dbo.ship_documents;
DROP TABLE IF EXISTS dbo.voyage_eta_predictions;
DROP TABLE IF EXISTS dbo.voyage_queue_changes;
DROP TABLE IF EXISTS dbo.voyage_status_history;
DROP TABLE IF EXISTS dbo.voyages;
DROP TABLE IF EXISTS dbo.ships;
DROP TABLE IF EXISTS dbo.system_parameters;
DROP TABLE IF EXISTS dbo.document_types;
DROP TABLE IF EXISTS dbo.ship_types;
DROP TABLE IF EXISTS dbo.agents;
DROP TABLE IF EXISTS dbo.ports;

COMMIT TRANSACTION;
-- After rollback, delete the 0001 row from dbo.schema_migrations so the runner can re-apply it.
