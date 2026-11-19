# Demo: vessel notice to departure (modules 1 and 2)

Language of the screens: Vietnamese and English mixed, as built. Times on screen are UTC+7. Prepare the database as described in `final-demo-readiness.md` section 2 (database `SmartPortV2_DemoFinal`; the API now refuses to start on a database that lacks any migration, 0001 to 0008). Use two browser windows (or one normal and one private) so two accounts are signed in at once.

## 0. Start

```
# API (from API/):      SP_DB_NAME=<demo db> SP_CORS_ORIGIN=http://localhost:5500 SP_COOKIE_SECURE=false npm start
# Frontend (from Front/): npm start        -> http://localhost:5500   (use "localhost", not 127.0.0.1)
```

Window A: sign in as `demo_dieuphoi`. Window B: sign in as `demo_quanly`. Open **Vessels & berths** in both. The page has a jump bar (Đăng ký tàu, Lịch tàu, Hàng đợi, Thông báo, Cầu bến, Kế hoạch, Tàu đến, Dữ liệu mẫu).

## 1. Workflow (about 10 minutes)

| # | Window | Action | Expected |
|---|---|---|---|
| 1 | A | **Hàng đợi** shows 16 voyages in priority order. Note the length | 16 waiting |
| 2 | A | **Thông báo tàu đến → New arrival notice**: choose any ship (for example `DEMO Hải Long`), a new voyage code (for example `DEMO-01`), agent, port, a future ETA, TEU and cargo; **Submit notice** | Result dialog in under a second: status `WAITING_BERTH`, queue position, policy `UC015-POLICY-V1`, and the line "chưa có dự báo AI". Repeat with the ship `DEMO Vũng Tàu` (it has no documents): `MISSING_DOCUMENTS` with the reasons and no queue position |
| 3 | A | Open **Check berth** on the new voyage in the queue. Verify the cargo hazard (None + basis). Choose a berth (for example `D05`), stretch 0 to LOA+10 m, period, cranes 2, **Check** | Result `Đạt` with each rule. Choose too short a stretch or an unsuitable berth type to see a violation and the override box (override needs a reason; missing data cannot be overridden) |
| 4 | A | **Save draft**, then **Lưu và gửi duyệt** in **Kế hoạch cập bến** | Plan `PENDING_APPROVAL` |
| 5 | B | Without reloading, a new unread notice "Kế hoạch cập bến chờ phê duyệt" appears (measured about 0.1 to 0.5 s). Open the plan with **Review** | Stored check and a fresh check, both `Đạt` |
| 6 | B | **Approve → confirm** | Plan `APPROVED`. A cannot approve their own plan (no button; the API refuses) |
| 7 | A | Without reloading: approval notice, the voyage leaves the queue (the gap closes), the berth shows `Đã đặt trước` | Voyage `BERTH_ASSIGNED` in **Lịch tàu** (filter by status) |
| 8 | A | **Lịch tàu →** open the voyage → **Xác nhận cập bến**. The planned berth is preselected; time defaults to now. Try changing the time to an hour ago without a reason | Error "Sửa thời gian thực tế bắt buộc có lý do." Add a reason, confirm. Voyage `BERTHED`, berth `Đang sử dụng` in both windows |
| 9 | A | Open the voyage again → **Xác nhận rời bến** → confirm | Voyage `DEPARTED`, berth `Trống`, plan `COMPLETED`; the lifecycle lists all six transitions with actor and time |
| 10 | A | **Rejection path**: pick another queued voyage, make and submit a plan | `PENDING_APPROVAL` |
| 11 | B | **Review → Từ chối**, confirm with an empty reason | Error, nothing changes. Enter a reason, confirm. Plan `REJECTED` with the reason |
| 12 | A | Without reloading: notice "Kế hoạch cập bến bị từ chối" with the reason; the voyage is still queued; the berth is still `Trống`. Make a new draft for the same voyage | A rejected plan is final; a new draft is accepted |

## 2. Role checks (2 minutes)

- `demo_khobai`: sees berths read-only; no plan, berthing or departure buttons; `POST` calls are refused (403).
- `demo_daily`: sees only its own vessels; no berth, plan or movement controls.
- `demo_quanly`: sees **Review** but no **Xác nhận cập bến** or **Xác nhận rời bến** (coordinator only).
- Refusals appear as `DENIED` rows in `audit_events`.

## 2b. Berth plan chart (time x position)

On the vessels page, panel **Biểu đồ kế hoạch bến**: pick a berth, 1/3/7 days, "Hôm nay". Time (UTC+7) runs along the top, the position along the berth down the side. Legend: green approved, amber pending, dotted draft, hatched cyan vessel actually alongside, grey departed, dashed cyan proposal (not confirmed, reserves nothing), hatched grey maintenance.
1. As `demo_dieuphoi`: click **Đề xuất bến**, close the dialog: the proposals appear as dashed blocks.
2. Drag a dotted draft (or a dashed proposal) to another place: the dialog opens with the new values and the UC-026 result; the chart shows a ghost block (green dashed pass, red hatched violation). Nothing is saved until **Save draft**; a violation needs an override reason.
3. Drag a chip from "Tàu chờ chưa có kế hoạch" onto the chart: stretch = ship length, 12 h default stay, cranes must be typed.
4. As `demo_quanly`: the same chart, no dragging, no tray.
Say honestly: proposals come from the local deterministic optimizer, not trained AI.

## 3. Verify (read-only)

```
SP_DB_NAME=<demo db> node scripts/check-consistency.js      # 9 checks: status/history, queue 1..n, plans vs voyages, ATA/ATD, no double berthing, audit rows
```

## 4. What to say honestly during the demo

- All demo data is **synthetic**. A real ETA forecast is **not** available (no provider, no model, no AIS); the notice shows "chưa có dự báo AI". UC-027 proposals come from a **local deterministic optimizer** (policy `UC027-OPT-V2`), not trained AI, and the screen says so.
- The block "Dữ liệu mẫu" at the bottom of the page (KPIs, scheduling alerts, strip) is a fixed sample, not system data; the buttons in it are disabled. The sidebar workspace name, "System status (sample)", the search box and the Alerts button are template placeholders and are marked or disabled.
- Re-planning when a vessel berths elsewhere (UC-033) is not built; such a case is refused with a message.
- A vessel that has a berth but never arrives keeps the berth reserved (no rule is specified).
- UC-015 (AI part), UC-020, UC-025, UC-026, UC-028 and UC-030 are **Implemented**, not Completed (see `docs/traceability.md`).
