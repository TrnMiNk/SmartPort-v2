# Legacy UC inventory

Scope: the 111 use cases in `../SmartPort/runtime-verification/final-acceptance/usecases.txt` (UC-001 to UC-111). Read-only analysis of `../SmartPort` and `../SmartPort-FE`.

## Legend

- **Source line**: heading line in `usecases.txt`.
- **Legacy acceptance**: status in `../SmartPort/FINAL_UC_ACCEPTANCE.md` (doc-only, not re-verified). "Not extracted" means the UC is in that file's scope but its row was not read in this run.
- **Code evidence**:
  - `code`: a route, migration, or test file in the legacy code is named for this UC or matches its endpoints.
  - `route only`: an endpoint exists, but no UC identifier appears in the code. The UC link comes from the spec's matrix or endpoint name.
  - `none`: no UC identifier and no matching endpoint found.

Searches were by UC identifier and endpoint path, not by behavior. A `none` result means "not found by these searches", not "not implemented".

## Summary

- UCs in the spec: 111.
- Code evidence `code` or `route only`: 31 (UC-001 to UC-005, and UC-010 to UC-035).
- No code evidence found: 80 (UC-006 to UC-009, and UC-036 to UC-111).
- Legacy acceptance table covers UC-010 to UC-023 (row-level). UC-024 to UC-035 are in that file's scope but were not extracted.

| UC | Title | Source line | Legacy acceptance | Code evidence | Evidence |
|---|---|---|---|---|---|
| UC-001 | Đăng nhập hệ thống | 1606 | Not extracted | route only | `backend-nodejs/routes/auth.js` (`POST /login`, `GET /me`) |
| UC-002 | Đăng xuất & quản lý phiên làm việc | 1648 | Not extracted | route only | `routes/auth.js` (`DELETE /logout`); `auth_sessions` in migration 011 |
| UC-003 | Tạo và cập nhật tài khoản người dùng | 1689 | Not extracted | code | `routes/accountAdministration.js` (`POST /users`); migration 014 |
| UC-004 | Khóa/mở khóa tài khoản và đặt lại mật khẩu | 1732 | Not extracted | code | `routes/accountAdministration.js` (`PATCH /users/:id/deactivate`); migration 014 |
| UC-005 | Phân quyền theo vai trò (RBAC) | 1775 | Not extracted | code | `routes/accountAdministration.js` (`PUT /users/:id/roles`); migration 011 |
| UC-006 | Quản lý danh mục nền | 1818 | Not extracted | none | — |
| UC-007 | Cấu hình tham số hệ thống | 1860 | Not extracted | none | — |
| UC-008 | Tra cứu nhật ký kiểm toán | 1899 | Not extracted | none | `auth_user_audit_log` exists (migration 014); no UC identifier |
| UC-009 | Xem chi tiết và xuất nhật ký kiểm toán | 1936 | Not extracted | none | — |
| UC-010 | Tạo hồ sơ tàu | 1976 | BLOCKED | code | `backend-nodejs/server.js` (`POST /api/ships`); `test/uc010-create.test.js`; `SmartPort-FE/test/vessel-create.test.cjs`; migration 001 |
| UC-011 | Cập nhật và vô hiệu hóa hồ sơ tàu | 2015 | BLOCKED | code | `server.js` (`PUT /api/ships/:id`, `PATCH /api/ships/:id/deactivate`); migration 002; `SmartPort-FE/test/vessel-lifecycle.test.cjs` |
| UC-012 | Đính kèm và theo dõi thẩm định tài liệu hồ sơ tàu | 2057 | PARTIAL; BLOCKED | code | `routes/shipDocuments.js`; `test/uc012-documents.test.js`; migration 003; `SmartPort-FE/test/vessel-documents.test.cjs` |
| UC-013 | Tạo thông báo tàu đến | 2098 | BLOCKED | code | `routes/voyages.js` (`POST /api/voyages`); migration 004; `services/automaticVoyageValidation.js` |
| UC-014 | Tiếp nhận thông báo tàu đến qua API đại lý | 2140 | BLOCKED | code | `routes/partnerIntegration.js` (`POST /api/v1/integration/voyages`); `test/uc014-partner-integration.test.js`; migration 005 |
| UC-015 | Kiểm tra hợp lệ hồ sơ và đưa tàu vào hàng đợi | 2183 | PARTIAL; BLOCKED | code | `routes/voyageValidation.js`; `services/automaticVoyageValidation.js`; `test/uc015-*.test.js`; migration 006 |
| UC-016 | Dự báo ETA bằng AI | 2224 | BLOCKED | code | `routes/voyageEtaPrediction.js`; `test/uc016-eta-prediction.test.js`; migration 007 |
| UC-017 | Cảnh báo lệch ETA | 2263 | BLOCKED | code | `routes/etaAlerts.js`; `test/uc017-eta-alerts.test.js`; migration 008 |
| UC-018 | Cập nhật ETA | 2303 | BLOCKED | code | `routes/voyageOperations.js` (`PUT /:id/eta`); `test/uc018-eta-update.test.js`; migration 009 |
| UC-019 | Xem lịch sử thay đổi ETA | 2343 | BLOCKED | code | `routes/voyageOperations.js` (`GET /:id/eta-history`); migration 009 |
| UC-020 | Xem và điều chỉnh hàng đợi cập bến | 2380 | PARTIAL; BLOCKED | code | `routes/voyageOperations.js` (`GET /queue-state`, `PATCH /:id/queue-position`); `test/uc020-queue-position.test.js`; migration 009 |
| UC-021 | Xem lịch tàu dạng danh sách và Gantt | 2420 | PARTIAL; BLOCKED | code | `routes/voyageOperations.js` (`GET /schedule`); `test/uc021-voyage-schedule.test.js` |
| UC-022 | Xác nhận tàu cập bến | 2458 | BLOCKED | code | `routes/voyageOperations.js` (`POST /:id/berthing`); `test/uc022-berthing.test.js`; `SmartPort-FE/test/voyage-berthing.test.cjs` |
| UC-023 | Xác nhận tàu rời bến | 2500 | BLOCKED | code | `routes/voyageOperations.js` (`POST /:id/departure`); `test/uc023-departure.test.js`; `SmartPort-FE/test/voyage-departure.test.cjs` |
| UC-024 | Quản lý danh mục cầu bến | 2542 | Not extracted | code | `routes/berthPlanning.js` (`/berths`); `test/uc024-berth-catalog.test.js` |
| UC-025 | Theo dõi trạng thái cầu bến thời gian thực | 2582 | Not extracted | code | `routes/berthPlanning.js` (`GET /berths/status`); `test/uc025-berth-status.test.js` |
| UC-026 | Kiểm tra ràng buộc kế hoạch cập bến | 2619 | Not extracted | code | `routes/berthPlanning.js` (`POST /berth-plans/check`); `test/uc026-berth-constraints.test.js` |
| UC-027 | Yêu cầu AI đề xuất phương án cập bến | 2661 | Not extracted | code | `routes/berthRecommendations.js`; `test/uc027-berth-recommendations.test.js`; migration 015 |
| UC-028 | Chấp nhận hoặc điều chỉnh phương án cập bến | 2702 | Not extracted | code | Migration 016; `test/uc028-plan-acceptance*.test.js`; `QLDAPM/.../Uc028PlanAcceptanceProxyTest.java`. Route not located |
| UC-029 | Lưu kế hoạch cập bến và gửi phê duyệt | 2742 | Not extracted | code | `routes/berthPlanning.js` (`POST /berth-plans/:id/submit`); migration 017 |
| UC-030 | Phê duyệt kế hoạch cập bến | 2782 | Not extracted | route only | `routes/berthPlanning.js` (`POST /berth-plans/:id/approve`); `test/m2-berth-plan-review.test.js` |
| UC-031 | Từ chối kế hoạch cập bến | 2823 | Not extracted | route only | `routes/berthPlanning.js` (`POST /berth-plans/:id/reject`) |
| UC-032 | Xác định tàu bị ảnh hưởng và gợi ý lập lại kế hoạch | 2863 | Not extracted | code | `routes/replanningImpact.js`; `test/uc032-replanning-impact.test.js`; migration 018; `QLDAPM/.../Uc032ReplanningImpactProxyTest.java` |
| UC-033 | Lập lại kế hoạch cập bến | 2900 | Not extracted | route only | `routes/berthPlanning.js` (`POST /berth-plans/:id/replan`) |
| UC-034 | Đặt bến vào bảo trì | 2937 | Not extracted | code | `routes/berthPlanning.js` (`POST /berths/:id/maintenance`); `test/uc034-maintenance-creation.test.js`; `UC034_MAINTENANCE_CREATION_API.md` |
| UC-035 | Hủy hoặc điều chỉnh lịch bảo trì bến | 2974 | Not extracted | code | `routes/berthPlanning.js` (`PUT`/`PATCH .../maintenance/...`); `test/uc035-maintenance-adjustment.test.js` |
| UC-036 | Nhập manifest thủ công | 3013 | Out of scope | none | — |
| UC-037 | Nhập manifest từ tệp CSV/Excel | 3052 | Out of scope | none | — |
| UC-038 | Tiếp nhận manifest qua API đại lý | 3094 | Out of scope | none | — |
| UC-039 | Lập stowage plan | 3136 | Out of scope | none | — |
| UC-040 | Kiểm tra ràng buộc và lưu phiên bản stowage plan | 3177 | Out of scope | none | — |
| UC-041 | Phân công cẩu bờ | 3217 | Out of scope | none | — |
| UC-042 | Theo dõi tiến độ và đổi cẩu bờ | 3254 | Out of scope | none | — |
| UC-043 | Nhận dạng mã container bằng OCR | 3294 | Out of scope | none | ai-eta not searched by keyword |
| UC-044 | Đối chiếu manifest và cập nhật trạng thái container | 3334 | Out of scope | none | — |
| UC-045 | Theo dõi năng suất cẩu thời gian thực | 3375 | Out of scope | none | — |
| UC-046 | Xác nhận hoặc nhập tay mã container khi sai lệch OCR | 3413 | Out of scope | none | — |
| UC-047 | Ghi nhận hàng ngoài manifest | 3455 | Out of scope | none | — |
| UC-048 | Ghi nhận sự cố/hư hỏng container | 3495 | Out of scope | none | — |
| UC-049 | Xem lịch sử sự cố container | 3531 | Out of scope | none | — |
| UC-050 | Tổng hợp số liệu và lập báo cáo chênh lệch manifest | 3569 | Out of scope | none | — |
| UC-051 | Xác nhận kết thúc làm hàng | 3607 | Out of scope | none | — |
| UC-052 | Quản lý cấu trúc bãi | 3646 | Out of scope | none | — |
| UC-053 | AI gợi ý vị trí hạ bãi | 3686 | Out of scope | none | — |
| UC-054 | Xác nhận hạ bãi và cập nhật vị trí container | 3728 | Out of scope | none | — |
| UC-055 | Theo dõi mức lấp đầy bãi và cảnh báo | 3769 | Out of scope | none | — |
| UC-056 | Tìm kiếm container và định vị trên sơ đồ bãi | 3807 | Out of scope | none | — |
| UC-057 | Đặt lịch xe lấy/giao container | 3846 | Out of scope | none | — |
| UC-058 | Hủy hoặc đổi lịch xe | 3884 | Out of scope | none | — |
| UC-059 | Nhận dạng và đối chiếu xe, container tại cổng vào | 3925 | Out of scope | none | — |
| UC-060 | Kiểm tra thông quan điện tử | 3966 | Out of scope | none | — |
| UC-061 | Lập EIR chiều vào và mở barrier | 4004 | Out of scope | none | — |
| UC-062 | Xác nhận xuất bãi container | 4043 | Out of scope | none | — |
| UC-063 | Xử lý xe ra cổng và giao container | 4082 | Out of scope | none | — |
| UC-064 | Xử lý ngoại lệ tại Smart Gate | 4120 | Out of scope | none | — |
| UC-065 | Quản lý danh mục kho và vị trí kho | 4160 | Out of scope | none | — |
| UC-066 | Nhập kho hàng | 4200 | Out of scope | none | — |
| UC-067 | Xuất kho hàng | 4240 | Out of scope | none | — |
| UC-068 | Theo dõi tồn kho và kiểm kê | 4281 | Out of scope | none | — |
| UC-069 | Quản lý danh mục dịch vụ và biểu cước | 4322 | Out of scope | none | — |
| UC-070 | Gửi duyệt biểu cước | 4363 | Out of scope | none | — |
| UC-071 | Phê duyệt hoặc từ chối biểu cước | 4402 | Out of scope | none | — |
| UC-072 | Tạo lệnh dịch vụ cảng | 4442 | Out of scope | none | — |
| UC-073 | Thực hiện và xác nhận hoàn thành lệnh dịch vụ | 4482 | Out of scope | none | — |
| UC-074 | Hủy hoặc tạm hoãn lệnh dịch vụ | 4522 | Out of scope | none | — |
| UC-075 | Tính phí cầu bến tự động | 4561 | Out of scope | none | — |
| UC-076 | Tính phí lưu bãi tự động | 4600 | Out of scope | none | — |
| UC-077 | Tính phí dịch vụ phát sinh và lập bảng kê cước | 4640 | Out of scope | none | — |
| UC-078 | Điều chỉnh khoản cước thủ công | 4680 | Out of scope | none | — |
| UC-079 | Lập, phát hành và gửi hóa đơn điện tử | 4719 | Out of scope | none | — |
| UC-080 | Hủy hóa đơn điện tử | 4760 | Out of scope | none | — |
| UC-081 | Điều chỉnh hóa đơn điện tử | 4801 | Out of scope | none | — |
| UC-082 | Tra cứu hóa đơn và theo dõi công nợ | 4840 | Out of scope | none | — |
| UC-083 | Ghi nhận thanh toán hóa đơn | 4878 | Out of scope | none | — |
| UC-084 | Xác nhận tàu rời cảng và giải phóng bến | 4919 | Out of scope | none | — |
| UC-085 | Quản lý danh mục thiết bị IoT | 4956 | Out of scope | none | — |
| UC-086 | Quản lý phương tiện nội bộ | 4997 | Out of scope | none | — |
| UC-087 | Thu nhận telemetry IoT | 5036 | Out of scope | none | — |
| UC-088 | Xem trạng thái hiện tại và lịch sử telemetry thiết bị | 5076 | Out of scope | none | — |
| UC-089 | Phát hiện thiết bị mất kết nối | 5113 | Out of scope | none | — |
| UC-090 | Sinh cảnh báo vượt ngưỡng thiết bị | 5151 | Out of scope | none | — |
| UC-091 | Dự đoán hỏng hóc bằng AI | 5189 | Out of scope | none | — |
| UC-092 | Tiếp nhận và xử lý cảnh báo thiết bị | 5227 | Out of scope | none | — |
| UC-093 | Cấu hình ngưỡng cảnh báo theo loại thiết bị | 5265 | Out of scope | none | — |
| UC-094 | Tạo lệnh bảo trì | 5306 | Out of scope | none | — |
| UC-095 | Cập nhật tiến độ và hoàn tất lệnh bảo trì | 5343 | Out of scope | none | — |
| UC-096 | Quản lý lịch bảo trì định kỳ và lịch sử bảo trì | 5382 | Out of scope | none | — |
| UC-097 | Xem camera an ninh bờ cảng | 5421 | Out of scope | none | — |
| UC-098 | Lưu ảnh sự kiện và liên kết với cảnh báo | 5457 | Out of scope | none | — |
| UC-099 | Xem bản đồ số và vị trí thời gian thực | 5496 | Out of scope | none | — |
| UC-100 | Xem Digital Twin và tìm container | 5536 | Out of scope | none | — |
| UC-101 | Phát lại lịch sử di chuyển của tàu và thiết bị | 5575 | Out of scope | none | — |
| UC-102 | Xem dashboard KPI POC/TOC | 5613 | Out of scope | none | — |
| UC-103 | Xử lý cảnh báo tại trung tâm cảnh báo | 5649 | Out of scope | none | — |
| UC-104 | Vận hành chế độ kiosk, carousel và ghim màn hình phụ | 5689 | Out of scope | none | — |
| UC-105 | Xem báo cáo vận hành | 5728 | Out of scope | none | — |
| UC-106 | Xem báo cáo tài chính | 5766 | Out of scope | none | — |
| UC-107 | Xuất báo cáo ra CSV/Excel/PDF | 5804 | Out of scope | none | — |
| UC-108 | Xem phân tích xu hướng và dự báo lưu lượng tàu | 5842 | Out of scope | none | — |
| UC-109 | Đánh giá chất lượng mô hình AI | 5879 | Out of scope | none | — |
| UC-110 | Sao lưu dữ liệu | 5917 | Out of scope | none | — |
| UC-111 | Phục hồi dữ liệu | 5957 | Out of scope | none | — |

## Notes

- "Out of scope" means the legacy acceptance audit header covers UC-010 to UC-035 only (`FINAL_UC_ACCEPTANCE.md` line 1). It does not mean these UCs are unimplemented. Code evidence for them was not found.
- Some UCs appear in the spec's FR-to-UC matrix (`usecases.txt` around lines 5998 to 6076) but have no identifier in code. Those links are doc-only.
- Titles are copied from the spec headings. Verify wording against the spec before using in a plan.
