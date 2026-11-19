-- dev_demo_catalog.sql: DEMO ports and agents so the vessel and arrival-notice forms have options in a development
-- database. Fictional demo values, not business data; the business owner must supply the real lists (UC-006).
-- Apply with: npm run seed:demo   (idempotent; refuses protected databases). Never run against production.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM dbo.ports WHERE port_code = 'VNHPH')
    INSERT INTO dbo.ports (port_code, port_name, country_code) VALUES ('VNHPH', N'Hải Phòng (demo)', 'VN');
IF NOT EXISTS (SELECT 1 FROM dbo.ports WHERE port_code = 'VNSGN')
    INSERT INTO dbo.ports (port_code, port_name, country_code) VALUES ('VNSGN', N'Sài Gòn (demo)', 'VN');
IF NOT EXISTS (SELECT 1 FROM dbo.ports WHERE port_code = 'SGSIN')
    INSERT INTO dbo.ports (port_code, port_name, country_code) VALUES ('SGSIN', N'Singapore (demo)', 'SG');

IF NOT EXISTS (SELECT 1 FROM dbo.agents WHERE agent_code = 'DEMO-AG-1')
    INSERT INTO dbo.agents (agent_code, agent_name) VALUES ('DEMO-AG-1', N'Đại lý hàng hải Demo 1');
IF NOT EXISTS (SELECT 1 FROM dbo.agents WHERE agent_code = 'DEMO-AG-2')
    INSERT INTO dbo.agents (agent_code, agent_name) VALUES ('DEMO-AG-2', N'Đại lý hàng hải Demo 2');

COMMIT TRANSACTION;
