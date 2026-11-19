-- dev_seed.sql: reference data for development and demo databases only.
-- Kept separate from migrations (rule 05). Idempotent: each insert is guarded by NOT EXISTS.
-- Never run against production. The runner refuses protected database names (src/config.js).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
BEGIN TRANSACTION;

-- Roles (RBAC, rule 04: default deny for undefined permissions).
-- Role codes match the legacy codes (legacy tests and specification labels) so evidence stays traceable.
-- BAN_QUAN_LY is the authorized Port Management role that approves berth plans (decision D5).
-- The SRS permission matrix (section 2.2) names five internal groups: Ban QL, Điều phối viên, NV kho bãi,
-- Kỹ thuật viên, Quản trị HT. DAI_LY_HANG_HAI (shipping agent) is an external actor outside the matrix
-- (see UC005 profile, A-1 and A-5).
IF NOT EXISTS (SELECT 1 FROM dbo.auth_roles WHERE role_code = 'QUAN_TRI_HE_THONG')
    INSERT INTO dbo.auth_roles (role_code, role_name) VALUES ('QUAN_TRI_HE_THONG', N'Quản trị hệ thống');
IF NOT EXISTS (SELECT 1 FROM dbo.auth_roles WHERE role_code = 'DIEU_PHOI_VIEN')
    INSERT INTO dbo.auth_roles (role_code, role_name) VALUES ('DIEU_PHOI_VIEN', N'Điều phối viên');
IF NOT EXISTS (SELECT 1 FROM dbo.auth_roles WHERE role_code = 'DAI_LY_HANG_HAI')
    INSERT INTO dbo.auth_roles (role_code, role_name) VALUES ('DAI_LY_HANG_HAI', N'Đại lý hàng hải');
IF NOT EXISTS (SELECT 1 FROM dbo.auth_roles WHERE role_code = 'BAN_QUAN_LY')
    INSERT INTO dbo.auth_roles (role_code, role_name) VALUES ('BAN_QUAN_LY', N'Ban quản lý (Port Management)');
IF NOT EXISTS (SELECT 1 FROM dbo.auth_roles WHERE role_code = 'NHAN_VIEN_KHO_BAI')
    INSERT INTO dbo.auth_roles (role_code, role_name) VALUES ('NHAN_VIEN_KHO_BAI', N'Nhân viên kho bãi');
IF NOT EXISTS (SELECT 1 FROM dbo.auth_roles WHERE role_code = 'KY_THUAT_VIEN')
    INSERT INTO dbo.auth_roles (role_code, role_name) VALUES ('KY_THUAT_VIEN', N'Kỹ thuật viên');

-- Ship types (UC-006 catalog). cargo_class drives berth-type matching (FR-BRT-04).
IF NOT EXISTS (SELECT 1 FROM dbo.ship_types WHERE type_code = 'CONTAINER')
    INSERT INTO dbo.ship_types (type_code, type_name, cargo_class) VALUES ('CONTAINER', N'Tàu container', 'CONTAINER');
IF NOT EXISTS (SELECT 1 FROM dbo.ship_types WHERE type_code = 'BULK')
    INSERT INTO dbo.ship_types (type_code, type_name, cargo_class) VALUES ('BULK', N'Tàu hàng rời', 'BULK');

-- Document types. required_for_arrival is NOT set here: the required set is policy content (UC015 A-1).
IF NOT EXISTS (SELECT 1 FROM dbo.document_types WHERE code = 'REGISTRATION')
    INSERT INTO dbo.document_types (code, name_vi, applies_to) VALUES ('REGISTRATION', N'Giấy chứng nhận đăng ký', 'SHIP');
IF NOT EXISTS (SELECT 1 FROM dbo.document_types WHERE code = 'INSURANCE')
    INSERT INTO dbo.document_types (code, name_vi, applies_to) VALUES ('INSURANCE', N'Bảo hiểm tàu', 'SHIP');
IF NOT EXISTS (SELECT 1 FROM dbo.document_types WHERE code = 'CARGO_MANIFEST')
    INSERT INTO dbo.document_types (code, name_vi, applies_to) VALUES ('CARGO_MANIFEST', N'Danh mục hàng hóa', 'VOYAGE');

-- System parameters (UC-007). Defaults come from the specification:
--   ETA_DEVIATION_THRESHOLD_H = 6 h (FR-VES-06, BR-05); BERTH_SAFETY_BUFFER_M = 15 m (BR-02);
--   AI_TIMEOUT_MS = 10000 (UC-015 3a, UC-016, UC-027).
IF NOT EXISTS (SELECT 1 FROM dbo.system_parameters WHERE param_key = 'ETA_DEVIATION_THRESHOLD_H')
    INSERT INTO dbo.system_parameters (param_key, param_value, default_value, value_type, description)
    VALUES ('ETA_DEVIATION_THRESHOLD_H', N'6', N'6', 'DECIMAL', N'Ngưỡng lệch ETA (giờ), FR-VES-06');
IF NOT EXISTS (SELECT 1 FROM dbo.system_parameters WHERE param_key = 'BERTH_SAFETY_BUFFER_M')
    INSERT INTO dbo.system_parameters (param_key, param_value, default_value, value_type, description)
    VALUES ('BERTH_SAFETY_BUFFER_M', N'15', N'15', 'DECIMAL', N'Khoảng đệm an toàn giữa hai tàu (m), BR-02');
IF NOT EXISTS (SELECT 1 FROM dbo.system_parameters WHERE param_key = 'AI_TIMEOUT_MS')
    INSERT INTO dbo.system_parameters (param_key, param_value, default_value, value_type, description)
    VALUES ('AI_TIMEOUT_MS', N'10000', N'10000', 'INT', N'Thời gian chờ dịch vụ AI (ms)');

-- UC-015 validation policy, version UC015-POLICY-V1 (DEVELOPMENT policy; assumption A-1 in docs/policies/uc015-uc020-policy-v1.md).
-- Neither the specification nor the legacy documents say which documents are mandatory, so this policy requires the two
-- standard vessel certificates already present in the catalog (registration and insurance, vessel level). A production
-- database must provision its own policy; with no effective policy the validation fails closed (503 POLICY_UNAVAILABLE).
-- Versions are immutable: to change the required documents, add a new version with a later effective_from.
-- The checksum is the SHA-256 of the exact JSON text (ASCII), checked on every load.
IF NOT EXISTS (SELECT 1 FROM dbo.validation_policies WHERE version = 'UC015-POLICY-V1')
BEGIN
    DECLARE @cfg NVARCHAR(MAX) = N'{"requiredDocuments":[{"type":"INSURANCE","scope":"SHIP"},{"type":"REGISTRATION","scope":"SHIP"}]}';
    INSERT INTO dbo.validation_policies (version, config_json, checksum, effective_from, description)
    VALUES ('UC015-POLICY-V1', @cfg, LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CONVERT(VARCHAR(MAX), @cfg)), 2)),
            '2000-01-01', N'Dev policy v1: ship-level registration and insurance required');
END

-- Corrections: the guarded inserts above never touch existing rows. These updates repair names that an earlier run may
-- have stored with the wrong code page (see src/db/seed.js). They only touch the seeded codes and are safe to repeat.
UPDATE dbo.auth_roles SET role_name = N'Quản trị hệ thống' WHERE role_code = 'QUAN_TRI_HE_THONG';
UPDATE dbo.auth_roles SET role_name = N'Điều phối viên' WHERE role_code = 'DIEU_PHOI_VIEN';
UPDATE dbo.auth_roles SET role_name = N'Đại lý hàng hải' WHERE role_code = 'DAI_LY_HANG_HAI';
UPDATE dbo.auth_roles SET role_name = N'Ban quản lý (Port Management)' WHERE role_code = 'BAN_QUAN_LY';
UPDATE dbo.auth_roles SET role_name = N'Nhân viên kho bãi' WHERE role_code = 'NHAN_VIEN_KHO_BAI';
UPDATE dbo.auth_roles SET role_name = N'Kỹ thuật viên' WHERE role_code = 'KY_THUAT_VIEN';
UPDATE dbo.ship_types SET type_name = N'Tàu container' WHERE type_code = 'CONTAINER';
UPDATE dbo.ship_types SET type_name = N'Tàu hàng rời' WHERE type_code = 'BULK';
UPDATE dbo.document_types SET name_vi = N'Giấy chứng nhận đăng ký' WHERE code = 'REGISTRATION';
UPDATE dbo.document_types SET name_vi = N'Bảo hiểm tàu' WHERE code = 'INSURANCE';
UPDATE dbo.document_types SET name_vi = N'Danh mục hàng hóa' WHERE code = 'CARGO_MANIFEST';
UPDATE dbo.system_parameters SET description = N'Ngưỡng lệch ETA (giờ), FR-VES-06' WHERE param_key = 'ETA_DEVIATION_THRESHOLD_H';
UPDATE dbo.system_parameters SET description = N'Khoảng đệm an toàn giữa hai tàu (m), BR-02' WHERE param_key = 'BERTH_SAFETY_BUFFER_M';
UPDATE dbo.system_parameters SET description = N'Thời gian chờ dịch vụ AI (ms)' WHERE param_key = 'AI_TIMEOUT_MS';

COMMIT TRANSACTION;
