# Coverage audit: UC-001 to UC-035 (legacy)

Read-only audit of `../SmartPort` and `../SmartPort-FE`. No legacy test was executed in this audit. Tests were identified by file name and content only.

Scope note: `FINAL_UC_ACCEPTANCE.md` covers UC-010 to UC-035. UC-001 to UC-009 have no acceptance row. Their evidence is code only.

## Evidence classes

- **D**: Documented only. Spec or legacy doc, no code link.
- **R**: Route identified. Endpoint exists in one layer.
- **I**: Implementation identified. Code path across at least two layers (FE, Spring, Node, DB) for the UC's main flow.
- **T**: Test evidence identified. A test file names the UC or exercises its endpoint. Not executed here.
- **V**: Verified by executed tests. None established in this audit. Legacy docs report PASS counts, which are historical doc claims and are not counted as V.

Legacy status (FINAL_UC_ACCEPTANCE.md) is shown as a doc claim. It is not used to set the class.

## Per-UC classification

| UC | Title | Class | Layers traced | Test evidence | Legacy doc claim | Gap or conflict |
|---|---|---|---|---|---|---|
| UC-001 | Đăng nhập | I | FE `auth.js` → Spring `AuthController` → Node `routes/auth.js` → `auth_users`, `auth_sessions` | `SmartPort-FE/test/auth.test.cjs` | none | None found |
| UC-002 | Đăng xuất & phiên | I | FE `auth.js` (`logout`) → Spring `DELETE /logout` → Node `DELETE /logout` | `auth.test.cjs` | none | None found |
| UC-003 | Tạo/cập nhật tài khoản | I | FE `admin.js` → Spring `AccountAdminController` → Node `accountAdministration.js` → `auth_users`, `auth_user_audit_log` | `account-administration.test.js`, `admin.test.cjs` | none | None found |
| UC-004 | Khóa/mở khóa, đặt lại mật khẩu | I (partial) | Spring `PATCH /users/{id}/deactivate` → Node → `auth_users`. Password reset endpoint not found | `account-administration.test.js` | none | Password reset not found in routes |
| UC-005 | Phân quyền RBAC | I | Spring `PUT /users/{id}/roles` → Node → `auth_roles`, `auth_user_roles` | `account-administration.test.js` | none | None found |
| UC-006 | Danh mục nền | D | none | none | none | No route or table found |
| UC-007 | Tham số hệ thống | D | none | none | none | No route or table found |
| UC-008 | Tra cứu nhật ký kiểm toán | D | table `auth_user_audit_log` only | none | none | No query endpoint found |
| UC-009 | Xem chi tiết/xuất nhật ký | D | none | none | none | No route found |
| UC-010 | Tạo hồ sơ tàu | I | FE `vessel-create.js` → Spring `VesselController POST` → Node `POST /api/ships` (inline in `server.js`) → `ships` | `uc010-create.test.js`, `vessel-create.test.cjs` | BLOCKED | **`ships` table not created in any migration** (see G1) |
| UC-011 | Cập nhật/vô hiệu hóa hồ sơ tàu | I | FE `vessel-lifecycle.js` → Spring `PUT`, `PATCH deactivate` → Node inline `/api/ships/:id` → `ships`, `ship_audit_log` (002) | `vessel-lifecycle.test.cjs` | BLOCKED (schema/IMO mutability) | G1 |
| UC-012 | Tài liệu tàu và thẩm định | I | FE `vessel-documents.js`, `document-lifecycle.js` → Spring `VesselDocumentController` → Node `shipDocuments.js` → `ship_documents` (003) | `uc012-documents.test.js`, `vessel-documents.test.cjs` | PARTIAL; BLOCKED | Ship-level documents, not voyage-level (G8) |
| UC-013 | Tạo thông báo tàu đến | I | FE `arrival-notice.js` → Spring `VoyageController POST` → Node `voyages.js` → `voyages`, `voyage_status_history`, `voyage_idempotency` | No Node file names UC013. Java `VoyageHttpIntegrationTest` covers the intake paths (per P1 doc) | BLOCKED | No dedicated test file found in Node |
| UC-014 | Tiếp nhận qua API đại lý | I | Partner client → Spring `PartnerIntegrationController` → Node `partnerIntegration.js` → partner tables (005) | `uc014-partner-integration.test.js` | BLOCKED (key/config/runtime) | None in code |
| UC-015 | Kiểm tra hợp lệ, đưa vào hàng đợi | I (partial) | Node `voyageValidation.js`, `automaticVoyageValidation.js`; Spring `VoyageController POST /{id}/validate`; FE: none found | `uc015-validation.test.js`, `uc015-configuration.test.js`, `p1-automatic-validation.test.js` | PARTIAL; BLOCKED | **Auto path never calls the AI service** (G3). Policy not provisioned (A-1). No FE page found |
| UC-016 | Dự báo ETA bằng AI | I (stub) | FE `eta-update.js` → Spring `POST /{id}/eta-prediction` → Node `voyageEtaPrediction.js` → HTTP adapter → `ai-eta` `POST /predict/eta` | `uc016-eta-prediction.test.js` | BLOCKED (model/data/config) | **`ai-eta` returns `UNAVAILABLE / NOT_CONFIGURED` for every request** (G3) |
| UC-017 | Cảnh báo lệch ETA | I | FE `eta-alerts.js` → Spring `OperationsController` → Node `etaAlerts.js` → `eta_alert_dismissals` | `uc017-eta-alerts.test.js` | BLOCKED | Real prediction input depends on UC-016 (G3) |
| UC-018 | Cập nhật ETA thủ công | I | FE `eta-update.js` → Spring `PUT /voyages/{id}/eta` → Node `voyageOperations.js` → `voyages`, `voyage_eta_changes` | `uc018-eta-update.test.js` | BLOCKED (tolerance/policy) | Tolerance policy not configured (A-1 pattern) |
| UC-019 | Lịch sử ETA | I | FE `eta-history.js` → Spring `GET /voyages/{id}/eta-history` → Node `voyageOperations.js` → `voyage_eta_changes` | Covered inside `uc018-eta-update.test.js` (no separate file) | BLOCKED | Prediction-attempt history depends on UC-016 |
| UC-020 | Hàng đợi cập bến | I | FE `queue-operations.js`, `vessels.js` → Spring `GET /voyages/queue-state`, `PATCH queue-position` → Node `voyageOperations.js`, `voyageQueue.js` → `voyage_queue_changes` | `uc020-queue-position.test.js` | PARTIAL; BLOCKED (SQL audit, realtime) | Realtime delivery not verified |
| UC-021 | Lịch tàu (list/Gantt) | I | FE `vessels.js`, `overview.js` → Spring `GET /voyages/schedule` → Node `voyageOperations.js` → `voyages`, `ships`, `berth_plans`, `berths`, `agents` | `uc021-voyage-schedule.test.js` | PARTIAL; BLOCKED (assigned-berth, lifecycle) | Shipping-line mapping not confirmed (G7) |
| UC-022 | Xác nhận cập bến | I | FE `voyage-berthing.js` → Spring `POST /voyages/{id}/berthing` → Node `voyageOperations.js` (`voyages`, `ships`, `berth_plans`, `voyage_status_history`, `planning_audit`) | `uc022-berthing.test.js`, `voyage-berthing.test.cjs` | BLOCKED (needs approved UC-030 plan) | Depends on UC-030 (G7) |
| UC-023 | Xác nhận rời bến | I | FE `voyage-departure.js` → Spring `POST /voyages/{id}/departure` → Node `voyageOperations.js` (`voyages`, `ships`, `berth_plans`, `voyage_status_history`, `planning_audit`) | `uc023-departure.test.js`, `voyage-departure.test.cjs` | BLOCKED | Depends on UC-022 |
| UC-024 | Danh mục cầu bến | I | FE `berth-planning.js`, `api.js` → Spring `OperationsController /berths` → Node `berthPlanning.js` → `berths` | `uc024-berth-catalog.test.js` | Not extracted | **`berths` table not created in any migration** (G2) |
| UC-025 | Trạng thái cầu bến | I | FE `api.js`, `overview.js` → Spring `GET /berths/status` → Node `berthPlanning.js` → `berths`, `berth_plans`, `berth_maintenance` | `uc025-berth-status.test.js` | Not extracted | G2 |
| UC-026 | Kiểm tra ràng buộc | I | FE `berth-planning.js` (`check`) → Spring `POST /berth-plans/check` → Node `berthPlanning.js` → `berth_plans`, `berths` | `uc026-berth-constraints.test.js` | Not extracted | G2 |
| UC-027 | AI đề xuất cập bến | I (provider missing) | FE `api.js` (`proposals`, `generate`) → Spring → Node `berthRecommendations.js` → `berth_plan_proposals`, `berth_plan_inferences`. Adapter posts to `BERTH_AI_BASE_URL/recommend/berth` | `uc027-berth-recommendations.test.js` | Not extracted | **No `/recommend/berth` in `ai-eta`; provider not in repo** (G5). When unset, returns `MODEL_NOT_CONFIGURED` |
| UC-028 | Chấp nhận/điều chỉnh phương án | I | FE `berth-planning.js` → Spring `OperationsController` (`POST /berth-plans`, `PUT /berth-plans/{id}`) → Node `berthPlanning.js` (`proposalId` creates a DRAFT) | `uc028-plan-acceptance*.test.js`; Java `Uc028PlanAcceptanceProxyTest` (covers draft create, edit, submit) | Not extracted | No dedicated "accept" endpoint. Naming mismatch (G6). Route is not missing |
| UC-029 | Lưu và gửi phê duyệt | I | FE `berth-planning.js` (`submit`) → Spring `POST /berth-plans/{id}/submit` → Node `berthPlanning.js` → `berth_plans`, `berth_plan_status_history`, `planning_audit` | `m2-berth-plan-review.test.js` | Not extracted | None found |
| UC-030 | Phê duyệt kế hoạch | I | FE `berth-planning.js` (`approve`) → Spring `POST /berth-plans/{id}/approve` → Node → `berth_plans`, `berth_plan_status_history` | `m2-berth-plan-review.test.js` | Not extracted | Node route name not in UC-030 code. Link by endpoint only |
| UC-031 | Từ chối kế hoạch | I | FE (`reject`) → Spring `POST .../reject` → Node → `berth_plans`, `berth_plan_status_history` | `m2-berth-plan-review.test.js` | Not extracted | Same as UC-030 |
| UC-032 | Tàu bị ảnh hưởng, gợi ý lập lại | I | FE `berth-planning.js` (alerts) → Spring `OperationsController` `/replanning-alerts` → Node `replanningImpact.js` → `replanning_alerts`, `berth_plans`, `berth_maintenance`, `ships`, `berths` | `uc032-replanning-impact.test.js`; `Uc032ReplanningImpactProxyTest.java` | Not extracted | `berths` table baseline (G2) |
| UC-033 | Lập lại kế hoạch | I | FE `replan` button → Spring `POST /berth-plans/{id}/replan` → Node `berthPlanning.js` → `berth_plans` | Covered in `m2-berth-plan-review.test.js` | Not extracted | Test file does not name UC-033 |
| UC-034 | Đặt bến vào bảo trì | I | FE `berth-planning.js` (`maint-create`) → Spring `POST /berths/{id}/maintenance` → Node `berthPlanning.js` → `berth_maintenance` | `uc034-maintenance-creation.test.js`; `Uc034MaintenanceProxyTest.java` | Not extracted | G2 |
| UC-035 | Hủy/điều chỉnh bảo trì | I | FE (`maint-save`, `maint-cancel`) → Spring `PUT`, `PATCH .../cancel` → Node → `berth_maintenance` | `uc035-maintenance-adjustment.test.js`; `Uc035MaintenanceAdjustmentProxyTest.java` | Not extracted | G2 |

## Summary by class (UC-001 to UC-035)

- **I (implementation identified, most with T):** 26 UCs (UC-001 to UC-005, UC-010 to UC-035, excluding UC-006 to UC-009).
- **I with a stub or missing provider:** UC-016, UC-017 (depends on 016), UC-027, UC-015 (auto AI path).
- **D (documented only):** UC-006, UC-007, UC-008 (table only), UC-009.
- **V (verified by executed tests):** none established in this audit.

No UC is marked Completed. The legacy acceptance doc marks every UC in its scope BLOCKED or PARTIAL, which is consistent with the classes above.

## Remaining uncertainty

- Test execution was not performed. Whether the listed test files pass today is unknown.
- FE-to-Spring-to-Node contracts were checked by route names and a few handlers, not by request and response schemas.
- Spring proxy paths were compared with Node mounts by name. Parameter and body contracts were not compared field by field.
- UC-033 and UC-019 have no test file that names them.
