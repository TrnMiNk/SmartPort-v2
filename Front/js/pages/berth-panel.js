/* Module 2 first slice: berth catalog (UC-024), live berth state with refresh hints (UC-025) and the placement check
   (UC-026). Uses the helpers of vessel-registry.js (dialog, fld, showErrors, stateBox, flash). Buttons are shown by
   permission for usability only; the API refuses anything the role may not do. All dynamic text is escaped. */
const BSTATE = {
  AVAILABLE: ['Trống', 'ok'], IN_USE: ['Đang sử dụng', 'info'], MAINTENANCE: ['Bảo trì', 'warn'], RESERVED: ['Đã đặt trước', 'mute'], OUT_OF_SERVICE: ['Ngừng hoạt động', 'bad'],
};
const BERTH_FIELDS = ['berth_code', 'berth_name', 'berth_type', 'length_m', 'max_depth_m', 'available_cranes', 'allows_dangerous', 'longitude', 'latitude', 'operational_status', 'reason'];
const CHECK_FIELDS = ['berth_id', 'position_start_m', 'position_end_m', 'planned_start', 'planned_end', 'required_cranes', 'dangerous_goods'];
const RULE_LABEL = {
  BERTH_IN_SERVICE: 'Bến đang hoạt động',
  LOA_FIT: 'LOA trong đoạn bến', DRAFT_FIT: 'Mớn nước ≤ độ sâu bến', BERTH_TYPE: 'Loại bến phù hợp loại hàng', CRANES: 'Đủ cẩu bờ',
  OVERLAP: 'Không chồng lấn (BR-01)', SAFETY_BUFFER: 'Khoảng đệm an toàn (BR-02)', DANGEROUS_GOODS: 'Hàng nguy hiểm (BR-03)', MAINTENANCE: 'Không trong thời gian bảo trì',
};

const BP = {
  s: { items: [], state: '', type: '', es: null, warned: false, poll: null, reopen: null, confirm: false },
  can: (a) => SP_AUTH_UTIL.can(SP_AUTH.user, 'M2_BERTHS', a),
  fmt: (iso) => SP_RES_UTIL.formatUtc7(iso) || '—',
  // Where a plan came from. The local optimizer is a deterministic algorithm and is never shown as an AI model; AI is only an external AI provider.
  SOURCE: { MANUAL: 'Thủ công', LOCAL_OPTIMIZER: 'Thuật toán tối ưu cục bộ', LOCAL_OPTIMIZER_ADJUSTED: 'Thuật toán tối ưu cục bộ (đã chỉnh)', AI: 'Dịch vụ AI ngoài', AI_ADJUSTED: 'Dịch vụ AI ngoài (đã chỉnh)' },
  sourceLabel: (s) => BP.SOURCE[s] || s,

  panel() {
    return `<section class="panel" id="brt"><div class="ph"><div><h2>Cầu bến · Berths</h2><div class="sub">Catalog and live state · live data · times in UTC+7</div></div>
      <button class="btn pri" id="addBerth" type="button" hidden>+ Add berth</button></div>
      <p class="lmsg warn" id="brtWarn" role="status" hidden style="margin:0 16px 8px">Dữ liệu có thể chưa cập nhật. Đang kết nối lại…</p>
      <div class="filters" style="padding:12px 16px;gap:10px;flex-wrap:wrap">
        <label>State <select id="brtState" aria-label="Filter by state"><option value="">All</option>${Object.entries(BSTATE).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></label>
        <label>Type <select id="brtType" aria-label="Filter by berth type"><option value="">All</option><option value="CONTAINER">Container</option><option value="BULK">Bulk</option></select></label>
      </div><div id="berthList" aria-live="polite"></div></section>`;
  },

  table(items) {
    const edit = BP.can('edit');
    const shown = items.filter((b) => (!BP.s.state || b.state === BP.s.state) && (!BP.s.type || b.berth_type === BP.s.type));
    if (!items.length) return VR.stateBox('empty', 'Không có dữ liệu', 'Chưa có bến nào trong danh mục.');
    if (!shown.length) return VR.stateBox('empty', 'Không có dữ liệu', 'Không có bến nào khớp bộ lọc.');
    const note = (b) => b.state === 'IN_USE' && b.current_plan ? `${esc(b.current_plan.ship_name)} · ${esc(b.current_plan.voyage_code)}`
      : b.state === 'MAINTENANCE' && b.maintenance ? `đến ${esc(BP.fmt(b.maintenance.ends_at))}`
      : (b.state === 'RESERVED') ? (b.current_plan ? `${esc(b.current_plan.voyage_code)} (chưa cập bến)` : b.next_plan ? `${esc(b.next_plan.voyage_code)} từ ${esc(BP.fmt(b.next_plan.planned_start))}` : '') : '';
    return `<div class="tw"><table><thead><tr><th>Berth</th><th>Type</th><th>Length / depth (m)</th><th>Cranes</th><th>Dangerous goods</th><th>State</th><th>Now / next</th><th>Actions</th></tr></thead><tbody>${shown.map((b) => `<tr data-berth="${b.id}">
      <td><button type="button" class="linkbtn" data-bact="detail" data-id="${b.id}">${esc(b.berth_code)}</button><br><small style="color:var(--dim)">${esc(b.berth_name)}</small></td>
      <td>${esc(b.berth_type)}</td><td class="mono num">${esc(b.length_m)} / ${esc(b.max_depth_m)}</td><td class="mono num">${esc(b.available_cranes)}</td><td>${b.allows_dangerous ? 'Allowed' : 'No'}</td>
      <td><span class="pill ${BSTATE[b.state][1]}">${BSTATE[b.state][0]}</span></td><td>${note(b) || '<span style="color:var(--dim)">—</span>'}</td>
      <td>${edit ? `<button class="btn" type="button" data-bact="edit" data-id="${b.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="tfoot"><span>As of ${esc(BP.fmt(BP.s.asOf))}</span><span>${shown.length} of ${items.length} berths</span></div>`;
  },

  // Draw only when the data changed (as_of changes every time, so it is left out of the comparison).
  draw(box, key, data, html) { const sig = JSON.stringify(data); if (BP.s[key] === sig && box.innerHTML) return; BP.s[key] = sig; box.innerHTML = html(); },
  async load({ silent = false } = {}) {
    const box = $('#berthList'); if (!box) return;
    if (!silent) box.innerHTML = VR.stateBox('loading', 'Loading…');
    try {
      const d = await SP_RES.berthStatus();
      BP.s.items = d.items; BP.s.asOf = d.as_of; BP.draw(box, 'sigBerths', d.items.map((b) => ({ ...b, as_of: undefined })), () => BP.table(d.items));
    } catch (e) { if (!silent) box.innerHTML = VR.stateBox('error', 'Không tải được trạng thái bến', e.message, 'berths'); else BP.warn(true); }
  },
  // A refresh hint (a plan was submitted or approved, the catalog changed): reload what may have changed, without flashing "Loading".
  refreshAll() {
    BP.load({ silent: true }); BP.loadPlans(); BP.loadNotes();
    if (typeof VR !== 'undefined') { VR.refreshEtaViews(); if ($('#noticeList')) VR.loadNotices({ silent: true }); }
    if (typeof VR !== 'undefined' && $('#queueList') && VR.can('view')) VR.loadQueue({ silent: true });
    if (typeof VR !== 'undefined' && $('#schBody') && VR.can('view')) VR.loadSchedule({ silent: true });
  },
  // A notice was validated or the queue was moved: only the notices, the queue and the schedule can have changed (each redraws only when its data changed).
  refreshQueueViews() {
    if (typeof VR === 'undefined') return;
    if ($('#noticeList')) VR.loadNotices({ silent: true });
    if ($('#queueList') && VR.can('view')) VR.loadQueue({ silent: true });
    if ($('#schBody') && VR.can('view')) VR.loadSchedule({ silent: true });
  },
  warn(on) { const w = $('#brtWarn'); if (w) w.hidden = !on; BP.s.warned = on; },

  // Refresh hints (UC-025): the server tells the client to re-read; the client also reloads on reconnect and on a timer,
  // because a hint is not proof of delivery and time-based changes (a plan starting) send no event.
  connect() {
    if (typeof EventSource === 'undefined') { BP.warn(true); return; }
    const es = new EventSource(SP_CONFIG.apiBaseUrl + '/api/v1/realtime/m2/events', { withCredentials: true });
    BP.s.es = es;
    es.addEventListener('refresh', (ev) => {
      let type = ''; try { type = JSON.parse(ev.data).type; } catch (e) { /* unknown hint: reload everything */ }
      if (type === 'VOYAGE_VALIDATED' || type === 'QUEUE_MOVED') BP.refreshQueueViews(); else BP.refreshAll();
    });
    es.onopen = () => { if (BP.s.warned) { BP.warn(false); BP.load({ silent: true }); } };
    es.onerror = () => {
      BP.warn(true);
      if (es.readyState === 2) { clearTimeout(BP.s.reopen); BP.s.reopen = setTimeout(() => { es.close(); BP.connect(); }, 5000); } // closed by the server (for example 401): try again
    };
  },

  // Notification hints for users who cannot open the berth channel: the server only says "re-read your notifications".
  connectNotes() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(SP_CONFIG.apiBaseUrl + '/api/v1/realtime/notifications', { withCredentials: true });
    es.addEventListener('refresh', () => BP.loadNotes());
    es.onerror = () => { if (es.readyState === 2) setTimeout(() => { es.close(); BP.connectNotes(); }, 5000); };
  },

  /* ---------- UC-024 form ---------- */
  async openForm(berth) {
    const b = berth || {}; const editing = !!berth; BP.s.confirm = false;
    const input = (id, val, extra = '') => `<input id="f-${id}" value="${esc(val == null ? '' : val)}" ${extra}>`;
    VR.dialog(`<h2 style="margin:0 0 4px">${editing ? 'Edit berth' : 'Add berth'}</h2><p style="margin:0 0 14px;color:var(--dim)">${editing ? esc(b.berth_code) : 'Add a berth to the catalog. It can be chosen in planning at once.'}</p>
      <form id="bf" novalidate><div class="grid2">
        ${VR.fld('berth_code', 'Berth code', input('berth_code', b.berth_code, 'maxlength="20" autocomplete="off"'))}
        ${VR.fld('berth_name', 'Name (optional)', input('berth_name', editing && b.berth_name !== b.berth_code ? b.berth_name : '', 'maxlength="200"'))}
        ${VR.fld('berth_type', 'Berth type', `<select id="f-berth_type"><option value="">Select…</option>${['CONTAINER', 'BULK'].map((t) => `<option${b.berth_type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>`)}
        ${VR.fld('available_cranes', 'Available shore cranes', input('available_cranes', b.available_cranes, 'type="number" min="0" step="1"'))}
        ${VR.fld('length_m', 'Length (m)', input('length_m', b.length_m, 'type="number" min="0" step="0.01"'))}
        ${VR.fld('max_depth_m', 'Max depth / draft (m)', input('max_depth_m', b.max_depth_m, 'type="number" min="0" step="0.01"'))}
        ${VR.fld('longitude', 'Longitude (WGS84, optional)', input('longitude', b.longitude, 'type="number" step="any"'))}
        ${VR.fld('latitude', 'Latitude (WGS84, optional)', input('latitude', b.latitude, 'type="number" step="any"'))}
        ${VR.fld('allows_dangerous', 'Dangerous goods', `<select id="f-allows_dangerous"><option value="false">Not allowed</option><option value="true"${b.allows_dangerous ? ' selected' : ''}>Allowed</option></select>`)}
        ${editing ? VR.fld('operational_status', 'Operational status', `<select id="f-operational_status">${['IN_SERVICE', 'OUT_OF_SERVICE'].map((t) => `<option${b.operational_status === t ? ' selected' : ''}>${t}</option>`).join('')}</select>`) : ''}
      </div>${editing ? VR.fld('reason', 'Reason for change (optional)', '<textarea id="f-reason" maxlength="500" rows="2"></textarea>') : ''}
      <div id="bwarn" class="lmsg warn" role="alert" hidden></div>
      <div class="lmsg bad" id="fmsg" role="alert" hidden></div>
      <div class="stack"><button class="btn pri" type="submit">${editing ? 'Save changes' : 'Create berth'}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
    const f = $('#bf');
    const body = () => {
      const g = (id) => f.querySelector('#f-' + id).value; const n = (id) => (g(id).trim() === '' ? null : Number(g(id)));
      const out = { berth_code: g('berth_code').trim(), berth_type: g('berth_type') || null, length_m: n('length_m'), max_depth_m: n('max_depth_m'), available_cranes: n('available_cranes'),
        allows_dangerous: g('allows_dangerous') === 'true', longitude: n('longitude'), latitude: n('latitude') };
      if (g('berth_name').trim()) out.berth_name = g('berth_name').trim();
      if (!editing) { if (out.longitude === null && out.latitude === null) { delete out.longitude; delete out.latitude; } return out; }
      const send = {};
      for (const k of Object.keys(out)) { const old = b[k] === undefined ? null : b[k]; if (out[k] !== old && !(k === 'berth_name' && out[k] === b.berth_name)) send[k] = out[k]; }
      if (f.querySelector('#f-operational_status').value !== b.operational_status) send.operational_status = f.querySelector('#f-operational_status').value;
      const reason = f.querySelector('#f-reason').value.trim(); if (reason) send.reason = reason;
      if (BP.s.confirm) send.confirm_affected_plans = true;
      return send;
    };
    f.onsubmit = async (e) => {
      e.preventDefault(); const send = body();
      if (editing && !Object.keys(send).filter((k) => k !== 'reason' && k !== 'confirm_affected_plans').length) { VR.showErrors(f, { code: 'LOCAL', message: 'Không có thay đổi nào để lưu.' }, BERTH_FIELDS); return; }
      VR.busy(f, true);
      try {
        const saved = editing ? await SP_RES.updateBerth(b.id, b.revision, send) : await SP_RES.createBerth(send);
        VR.close(); VR.flash((editing ? 'Đã cập nhật bến ' : 'Đã thêm bến ') + saved.berth_code + '.', 'ok'); BP.load({ silent: true });
      } catch (err) {
        VR.busy(f, false, editing ? 'Save changes' : 'Create berth');
        if (editing && err.status === 409 && err.details && err.details.rule === 'BERTH_HAS_PLANS') { BP.askConfirm(f, err.details.plans); return; }
        if (editing && err.status === 409 && err.details && err.details.current_revision !== undefined) {
          try { const fresh = await SP_RES.getBerth(b.id); await BP.openForm(fresh); const m = $('#fmsg'); m.textContent = 'Thông tin bến vừa được người khác thay đổi. Dữ liệu mới nhất đã được tải lại; vui lòng kiểm tra rồi lưu lại.'; m.hidden = false; return; } catch (e2) { /* fall through to the plain message */ }
        }
        VR.showErrors(f, err, BERTH_FIELDS);
      }
    };
  },
  // Spec 6a: warn about the affected plans and ask for confirmation; the next save carries the confirmation.
  askConfirm(f, plans) {
    const w = f.querySelector('#bwarn');
    w.innerHTML = `<b>Bến đang có ${plans.length} kế hoạch cập bến có thể bị ảnh hưởng:</b><ul>${plans.map((p) => `<li>${esc(p.voyage_code)} · ${esc(p.plan_status)} · ${esc(BP.fmt(p.planned_start))} → ${esc(BP.fmt(p.planned_end))}</li>`).join('')}</ul>
      <button class="btn pri" type="button" data-bact="confirm">Xác nhận và lưu</button>`;
    w.hidden = false;
  },

  /* ---------- UC-027 local berth recommendation ---------- */
  // A deterministic optimizer (policy UC027-OPT-V1), NOT a trained AI model; the screen says so. Every proposal shown passed UC-026; the coordinator
  // uses it (opens the normal draft dialog and may change it), ignores it, or plans by hand. Nothing is planned or approved from here.
  async openRecommend() {
    VR.dialog('<h2 style="margin:0 0 8px">Đề xuất bến</h2><p aria-busy="true">Đang tính phương án…</p>');
    let r;
    try { r = await SP_RES.recommendBerths(); } catch (e) {
      VR.dialog(`<h2 style="margin:0 0 8px">Không tạo được đề xuất</h2><p>${esc(e.message)}</p><p>Vẫn có thể lập kế hoạch thủ công từ hàng đợi ("Check berth").</p><div class="stack"><button class="btn" type="button" data-close>Close</button></div>`); return;
    }
    BP.s.rec = r; BP.drawRecommend();
  },
  drawRecommend() {
    const r = BP.s.rec; const t = BP.fmt;
    const label = (d) => (d === 'IGNORED' ? 'Đã bỏ qua đề xuất' : d === 'ACCEPTED' ? 'Đã dùng đề xuất' : 'Đã dùng đề xuất và chỉnh sửa');
    const proposal = (v, p) => `<tr data-prop="${p.proposal_id}"><td>${p.rank}</td><td>${esc(p.berth_code)}</td><td class="mono num">${esc(p.position_start_m)} – ${esc(p.position_end_m)} m</td><td class="mono num">${esc(t(p.planned_start))}<br>→ ${esc(t(p.planned_end))}</td>
      <td class="mono num">${esc(p.expected_wait_h)} h</td><td class="mono num">${esc(p.required_cranes)}</td><td><span class="pill ok" title="Đã qua kiểm tra UC-026 (9 luật)">UC-026 đạt</span> <small title="Điểm tiện ích của thuật toán, không phải xác suất hay độ tin cậy">điểm ${esc(p.score)}</small>
      <details><summary>Lý do</summary><ul class="hist">${p.reasons.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></details></td>
      <td>${BP.can('edit') && !v.decision.length ? `<button class="btn pri" type="button" data-bact="rec-use" data-voyage="${v.voyage_id}" data-proposal="${p.proposal_id}">Dùng đề xuất</button>` : ''}</td></tr>`;
    const vessel = (v) => `<section class="rec-v" data-rec-voyage="${v.voyage_id}"><h3 style="margin:14px 0 4px;font-size:14px">${esc(v.voyage_code)} · hàng đợi #${esc(v.queue_position)} <small style="color:var(--dim)">ETA ${esc(t(v.effective_eta))} (${v.eta_source === 'AI' ? 'dự báo AI' : 'khai báo'})</small></h3>
      ${v.decision.length ? `<p class="lmsg ${v.decision[0].decision === 'IGNORED' ? 'warn' : 'ok'}">Quyết định: <b>${esc(label(v.decision[0].decision))}</b>${v.decision[0].reason ? ' · ' + esc(v.decision[0].reason) : ''}</p>` : ''}
      ${v.outcome === 'RECOMMENDED'
        ? `<div class="tw"><table><thead><tr><th>Hạng</th><th>Bến</th><th>Đoạn bến</th><th>Cập → rời (UTC+7)</th><th>Chờ</th><th>Cẩu</th><th>Kiểm tra</th><th></th></tr></thead><tbody>${v.proposals.map((p) => proposal(v, p)).join('')}</tbody></table></div>
           ${BP.can('edit') && !v.decision.length ? `<div class="stack"><button class="btn" type="button" data-bact="rec-ignore" data-voyage="${v.voyage_id}">Bỏ qua đề xuất</button></div>` : ''}
           <small style="color:var(--dim)">${v.candidates_rejected_by_uc026} phương án bị UC-026 loại, không hiển thị.</small>`
        : `<div class="lmsg warn"><b>Không xếp được tự động.</b> Lập kế hoạch thủ công từ hàng đợi.<ul>${v.reasons.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></div>`}</section>`;
    VR.dialog(`<div id="recBox"><h2 style="margin:0 0 4px">Đề xuất bến</h2>
      <p class="lmsg warn" id="recNote" style="margin:0 0 8px"><b>Thuật toán tối ưu cục bộ (${esc(r.policy_version)})</b>: tất định, dùng luật UC-026; <b>không phải mô hình học máy</b>. Dự báo AI: <b>chưa có</b>. Đề xuất chỉ để tham khảo, không tự lập hay duyệt kế hoạch.</p>
      <p style="margin:0 0 6px;color:var(--mute)">${r.summary.vessels} tàu · ${r.summary.recommended} có đề xuất · ${r.summary.unschedulable} chưa xếp được · ${r.summary.proposals} phương án · tính trong ${esc(r.duration_ms)} ms · dữ liệu lúc ${esc(t(r.as_of))} (UTC+7)</p>
      ${r.status === 'NO_FEASIBLE_PLACEMENT' ? '<div class="lmsg warn">Không có phương án khả thi cho tàu nào. Hãy lập kế hoạch thủ công.</div>' : ''}
      ${r.vessels.map(vessel).join('')}
      <div class="stack"><button class="btn" type="button" data-close>Close</button></div></div>`);
    if (typeof BC !== 'undefined' && BC.s.loaded) BC.draw();   // the chart shows the proposals as unconfirmed blocks
  },
  recUse(voyageId, proposalId) {
    const v = BP.s.rec.vessels.find((x) => String(x.voyage_id) === String(voyageId)); const p = v && v.proposals.find((x) => String(x.proposal_id) === String(proposalId)); if (!p) return;
    VR.close(); BP.openCheck(voyageId, null, p);
  },
  async recIgnore(voyageId) {
    try { BP.s.rec = await SP_RES.ignoreRecommendation(BP.s.rec.id, voyageId); BP.drawRecommend(); } catch (e) { VR.flash(e.message); }
  },

  /* ---------- UC-025 detail ---------- */
  async openDetail(id) {
    let d; try { d = await SP_RES.berthDetail(id); } catch (e) { VR.flash(e.message); return; }
    const [label, cls] = BSTATE[d.state];
    VR.dialog(`<div id="bdetail"><h2 style="margin:0 0 4px">${esc(d.berth_code)} · ${esc(d.berth_name)}</h2><p style="margin:0 0 12px"><span class="pill ${cls}">${label}</span> <small style="color:var(--dim)">as of ${esc(BP.fmt(d.as_of))}</small></p>
      <dl class="dtl" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 18px"><dt>Type</dt><dd>${esc(d.berth_type)}</dd><dt>Length / depth</dt><dd>${esc(d.length_m)} m / ${esc(d.max_depth_m)} m</dd><dt>Cranes</dt><dd>${esc(d.available_cranes)}</dd>
        <dt>Dangerous goods</dt><dd>${d.allows_dangerous ? 'Allowed' : 'Not allowed'}</dd><dt>Coordinates</dt><dd>${d.longitude == null ? '—' : esc(d.longitude) + ', ' + esc(d.latitude)}</dd>
        <dt>Vessel now</dt><dd>${d.current_plan && d.state === 'IN_USE' ? esc(d.current_plan.ship_name) + ' · ' + esc(d.current_plan.voyage_code) : '—'}</dd></dl>
      <h3 style="margin:16px 0 6px;font-size:14px">Upcoming plans</h3>${d.upcoming_plans.length ? `<ul class="hist">${d.upcoming_plans.map((p) => `<li><b>${esc(p.voyage_code)}</b> · ${esc(p.ship_name)} · ${esc(p.plan_status)} · ${esc(BP.fmt(p.planned_start))} → ${esc(BP.fmt(p.planned_end))}</li>`).join('')}</ul>` : '<p style="color:var(--dim)">Không có dữ liệu</p>'}
      <h3 style="margin:16px 0 6px;font-size:14px">Maintenance</h3>${d.upcoming_maintenance.length ? `<ul class="hist">${d.upcoming_maintenance.map((m) => `<li>${esc(BP.fmt(m.starts_at))} → ${esc(BP.fmt(m.ends_at))} · ${esc(m.reason)}</li>`).join('')}</ul>` : '<p style="color:var(--dim)">Không có dữ liệu</p>'}
      <div class="stack"><button class="btn" type="button" data-close>Close</button></div></div>`);
  },

  /* ---------- UC-026 check, UC-028 draft and UC-029 submission, started from a queued voyage ---------- */
  HAZARD: { NONE: 'Đã xác minh: không có hàng nguy hiểm', DANGEROUS: 'Đã xác minh: có hàng nguy hiểm' },
  // `values` (optional) are placement values from a drag on the chart: they replace the stored ones in the form and the check runs at once. Saving is the usual path.
  async openCheck(voyageId, plan, proposal, values) {
    const entry = (VR.s.queue.items || []).find((x) => String(x.voyage_id) === String(voyageId)); if (!entry) return;
    const draft = plan || (BP.s.plans || []).find((p) => String(p.voyage_id) === String(voyageId) && p.plan_status === 'DRAFT');
    const open = (BP.s.plans || []).find((p) => String(p.voyage_id) === String(voyageId) && (p.plan_status === 'PENDING_APPROVAL' || p.plan_status === 'APPROVED'));
    if (open) { VR.flash('Chuyến này đã có kế hoạch ' + open.plan_status + '. Không lập thêm kế hoạch.'); return; }
    let berths, voyage;
    try { [berths, voyage] = await Promise.all([SP_RES.listBerths({ size: 100 }).then((d) => d.items), SP_RES.getVoyage(voyageId)]); } catch (e) { VR.flash(e.message); return; }
    if (!berths.length) { VR.flash('Chưa có bến nào trong danh mục.'); return; }
    const d = draft || (proposal ? { berth_id: proposal.berth_id, required_cranes: proposal.required_cranes, position_start_m: proposal.position_start_m, position_end_m: proposal.position_end_m, planned_start: proposal.planned_start, planned_end: proposal.planned_end } : {}); const canSave = BP.can('edit');
    const dv = values ? { ...d, ...values } : d;
    const hazardBox = () => `<div id="hz" style="margin:8px 0;padding:8px 10px;border:1px solid var(--line)"><b>Hàng nguy hiểm (BR-03):</b> <span id="hzNow">${voyage.cargo_hazard ? esc(BP.HAZARD[voyage.cargo_hazard]) + ' · ' + esc(voyage.cargo_hazard_basis) : 'Chưa xác minh'}</span>
      ${VR.can('edit') ? `<div class="grid2" style="margin-top:6px"><label>Xác minh <select id="f-hz"><option value="NONE">Không có hàng nguy hiểm</option><option value="DANGEROUS">Có hàng nguy hiểm</option></select></label>
        <label>Căn cứ <input id="f-hz_basis" maxlength="500" placeholder="Ví dụ: danh mục hàng hóa số …"></label></div><div class="fe" id="e-hz" role="alert"></div><button class="btn" type="button" id="hzBtn">Lưu xác minh</button>` : ''}</div>`;
    VR.dialog(`<h2 style="margin:0 0 4px">${draft ? 'Edit draft berth plan' : 'Berth placement'}</h2><p style="margin:0 0 14px;color:var(--mute)">${esc(entry.ship_name)} · ${esc(entry.voyage_code)}. "Check" only reads the rules; "Save draft" stores a draft that reserves nothing and does not change the voyage. Times are UTC+7.</p>
      ${hazardBox()}
      <form id="cf" novalidate><div class="grid2">
        ${VR.fld('berth_id', 'Berth', `<select id="f-berth_id">${VR.opts(berths.map((b) => ({ id: b.id, name: `${b.berth_code} · ${b.length_m} m${b.operational_status === 'OUT_OF_SERVICE' ? ' (out of service)' : ''}` })), dv.berth_id, 'Select…')}</select>`)}
        ${VR.fld('required_cranes', 'Shore cranes needed', `<input id="f-required_cranes" type="number" min="0" step="1" value="${esc(dv.required_cranes == null ? '' : dv.required_cranes)}">`)}
        ${VR.fld('position_start_m', 'Stretch start (m)', `<input id="f-position_start_m" type="number" min="0" step="0.01" value="${esc(dv.position_start_m == null ? '' : dv.position_start_m)}">`)}
        ${VR.fld('position_end_m', 'Stretch end (m)', `<input id="f-position_end_m" type="number" min="0" step="0.01" value="${esc(dv.position_end_m == null ? '' : dv.position_end_m)}">`)}
        ${VR.fld('planned_start', 'Berthing time', `<input id="f-planned_start" type="datetime-local" value="${esc(SP_RES_UTIL.isoToLocal(dv.planned_start || entry.effective_eta))}">`)}
        ${VR.fld('planned_end', 'Departure time', `<input id="f-planned_end" type="datetime-local" value="${esc(SP_RES_UTIL.isoToLocal(dv.planned_end))}">`)}
      </div><div class="lmsg bad" id="fmsg" role="alert" hidden></div><div id="chkResult" aria-live="polite"></div>
      <div class="stack"><button class="btn pri" type="submit">Check</button>${canSave ? '<button class="btn" type="button" id="savePlan">Save draft</button>' : ''}<button class="btn" type="button" data-close>Close</button></div></form>`);
    const f = $('#cf');
    const gather = () => { const g = (id) => f.querySelector('#f-' + id).value; const n = (id) => (g(id) === '' ? null : Number(g(id)));
      const body = { voyage_id: entry.voyage_id, berth_id: n('berth_id'), position_start_m: n('position_start_m'), position_end_m: n('position_end_m'),
        planned_start: SP_RES_UTIL.localToIso(g('planned_start')), planned_end: SP_RES_UTIL.localToIso(g('planned_end')) };
      if (g('required_cranes') !== '') body.required_cranes = n('required_cranes');
      if (!draft && proposal) body.proposal_id = proposal.proposal_id;   // the server compares the plan with the proposal: AI if equal, AI_ADJUSTED if changed, and records the decision
      return body; };
    f.onsubmit = async (e) => {
      e.preventDefault(); VR.busy(f, true); $('#chkResult').innerHTML = '';
      try { const body = gather(); delete body.proposal_id; /* the check endpoint only judges the placement; the proposal is for saving */ const r = await SP_RES.checkPlacement(body); VR.clearErrors(f); VR.busy(f, false, 'Check'); $('#chkResult').innerHTML = BP.result(r); }
      catch (err) { VR.busy(f, false, 'Check'); VR.showErrors(f, err, CHECK_FIELDS); }
    };
    if (values) setTimeout(() => { if ($('#cf') === f) f.dispatchEvent(new Event('submit', { cancelable: true })); }, 0);   // show the UC-026 result of the dropped placement
    // UC-028: save the draft. A violation is shown first; it is saved only with an override reason (3a).
    const save = async (overrideReason) => {
      const body = gather(); if (overrideReason) body.override_reason = overrideReason;
      const btn = $('#savePlan'); btn.disabled = true;
      try {
        const saved = draft ? await SP_RES.updatePlan(draft.id, draft.revision, body) : await SP_RES.createPlan(body);
        VR.close(); VR.flash('Đã lưu kế hoạch nháp cho ' + entry.voyage_code + (saved.override_reason ? ' (có ghi đè ràng buộc).' : '.') + ' Chưa gửi duyệt.', 'ok'); BP.loadPlans();
      } catch (err) {
        btn.disabled = false;
        const rule = err.details && err.details.rule;
        if (err.status === 409 && err.details && err.details.check) { VR.clearErrors(f); BP.showViolation(err.details, save); return; }
        if (err.status === 409 && err.details && err.details.current_revision !== undefined) err.message = 'Kế hoạch nháp vừa được thay đổi ở nơi khác. Hãy đóng và mở lại.';
        if (rule === 'DRAFT_EXISTS' || rule === 'VOYAGE_HAS_OPEN_PLAN' || rule === 'VOYAGE_NOT_IN_QUEUE') BP.loadPlans();
        VR.showErrors(f, err, CHECK_FIELDS);
      }
    };
    if (canSave) $('#savePlan').onclick = () => save(null);
    if ($('#hzBtn')) $('#hzBtn').onclick = async () => {
      const basis = $('#f-hz_basis').value.trim(); const err = $('#e-hz'); err.textContent = '';
      try { const v = await SP_RES.verifyHazard(voyageId, { cargo_hazard: $('#f-hz').value, basis });
        voyage.cargo_hazard = v.cargo_hazard; voyage.cargo_hazard_basis = v.cargo_hazard_basis; $('#hzNow').textContent = BP.HAZARD[v.cargo_hazard] + ' · ' + v.cargo_hazard_basis; $('#f-hz_basis').value = ''; }
      catch (e) { err.textContent = (e.details && e.details[0] && e.details[0].message) || e.message; }
    };
  },
  // A refused save or submission: show every failed rule and, when the violation can be overridden and the user may do it, ask for a reason.
  showViolation(details, retry) {
    const box = $('#chkResult'); const c = details.check;
    const canOverride = details.rule === 'CONSTRAINT_VIOLATION' && c.overridable && BP.can('override');
    box.innerHTML = BP.result(c) + `<div class="lmsg ${details.rule === 'CONSTRAINT_VIOLATION' && canOverride ? 'warn' : 'bad'}" id="ovBox" role="alert">${esc(details.rule === 'CONSTRAINT_VIOLATION' && !c.overridable ? 'Có vi phạm không thể ghi đè.' : '')}
      ${details.rule === 'INSUFFICIENT_DATA' ? 'Thiếu dữ liệu: không thể lưu hoặc ghi đè. Bổ sung dữ liệu rồi kiểm tra lại.' : ''}${details.rule === 'NOT_OVERRIDABLE' ? 'Không thể ghi đè (bến ngừng hoạt động). Chọn bến khác.' : ''}
      ${canOverride ? `<label for="f-override_reason"><b>Ghi đè kèm lý do (được ghi nhật ký):</b></label><textarea id="f-override_reason" maxlength="500" rows="2"></textarea><div class="fe" id="e-override_reason" role="alert"></div><button class="btn pri" type="button" id="ovBtn">Tiếp tục với ghi đè</button>` : ''}</div>`;
    if (canOverride) $('#ovBtn').onclick = () => { const r = $('#f-override_reason').value.trim(); if (!r) { $('#e-override_reason').textContent = 'Vui lòng nhập lý do ghi đè.'; return; } retry(r); };
  },
  result(r) {
    const mark = { PASS: ['ok', 'Đạt'], VIOLATION: ['bad', 'Vi phạm'], MISSING_DATA: ['warn', 'Thiếu dữ liệu'] };
    const head = { PASS: 'Đạt mọi ràng buộc', VIOLATION: 'Có vi phạm: cần điều chỉnh hoặc ghi đè kèm lý do', MISSING_DATA: 'Thiếu dữ liệu: chưa thể lưu kế hoạch' }[r.outcome];
    return `<div id="chkOutcome" data-outcome="${esc(r.outcome)}"><p><span class="pill ${mark[r.outcome][0]}">${esc(head)}</span> <small style="color:var(--dim)">${r.buffer_m != null ? 'Khoảng đệm ' + esc(r.buffer_m) + ' m · ' : ''}${esc(r.rules_version || '')}</small></p>
      <ul class="hist">${r.rules.map((x) => `<li data-rule="${esc(x.id)}" data-outcome="${esc(x.outcome)}"><span class="pill ${mark[x.outcome][0]}">${mark[x.outcome][1]}</span> <b>${esc(RULE_LABEL[x.id] || x.id)}</b>${x.reason ? ' — ' + esc(x.reason) : ''}</li>`).join('')}</ul></div>`;
  },

  /* ---------- UC-028/029 plan list ---------- */
  planPanel() {
    return `<section class="panel" id="plp"><div class="ph"><div><h2>Kế hoạch cập bến · Berth plans</h2><div class="sub">Manual drafts and plans sent for approval · live data · times in UTC+7. Approval is a separate step by port management.</div></div></div>
      <div id="planList" aria-live="polite"></div></section>`;
  },
  planTable(items) {
    if (!items.length) return VR.stateBox('empty', 'Không có dữ liệu', 'Chưa có kế hoạch cập bến nào.');
    const canEdit = BP.can('edit');
    const pill = { DRAFT: 'mute', PENDING_APPROVAL: 'warn', APPROVED: 'ok', REJECTED: 'bad', SUPERSEDED: 'mute', COMPLETED: 'info' };
    return `<div class="tw"><table><thead><tr><th>Voyage</th><th>Berth</th><th>Stretch (m)</th><th>Time (UTC+7)</th><th>Status</th><th>Check</th><th>Actions</th></tr></thead><tbody>${items.map((p) => `<tr data-plan="${p.id}">
      <td><b style="font-weight:500">${esc(p.ship_name)}</b><br><small class="mono" style="color:var(--dim)">${esc(p.voyage_code)}</small></td><td>${esc(p.berth_code)}</td>
      <td class="mono num">${esc(p.position_start_m)} – ${esc(p.position_end_m)}</td><td class="mono num">${esc(BP.fmt(p.planned_start))} → ${esc(BP.fmt(p.planned_end))}</td>
      <td><span class="pill ${pill[p.plan_status] || 'mute'}">${esc(p.plan_status)}</span>${p.source && p.source !== 'MANUAL' ? `<br><small style="color:var(--dim)" data-source="${esc(p.source)}">${esc(BP.sourceLabel(p.source))}</small>` : ''}${p.rejection_reason ? `<br><small style="color:var(--bad)" data-reason>${esc(p.rejection_reason)}</small>` : ''}</td>
      <td>${p.override_reason ? '<span class="pill warn" title="' + esc(p.override_reason) + '">Có ghi đè</span>' : p.check.passed ? '<span class="pill ok">Đạt</span>' : '<span class="pill bad">Vi phạm</span>'}</td>
      <td>${p.plan_status === 'PENDING_APPROVAL' && BP.can('approve') ? `<button class="btn pri" type="button" data-bact="plan-review" data-id="${p.id}">Xem và phê duyệt</button>` : ''}${p.plan_status === 'DRAFT' && canEdit ? `<button class="btn" type="button" data-bact="plan-edit" data-id="${p.id}">Edit</button> <button class="btn pri" type="button" data-bact="plan-submit" data-id="${p.id}">Lưu và gửi duyệt</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  },
  async loadPlans() {
    const box = $('#planList'); if (!box) return;
    try { const d = await SP_RES.listPlans({ size: 50 }); BP.s.plans = d.items; BP.draw(box, 'sigPlans', d.items, () => BP.planTable(d.items)); if (typeof BC !== 'undefined') BC.load({ silent: true }); }
    catch (e) { if (!BP.s.plans) box.innerHTML = VR.stateBox('error', 'Không tải được kế hoạch cập bến', e.message, 'plans'); }
  },
  // UC-029: submit a draft. A rule that fails now (the data may have changed since the draft) is shown, and only an override reason lets it through.
  async submitPlan(id, overrideReason) {
    const p = (BP.s.plans || []).find((x) => String(x.id) === String(id)); if (!p) return;
    try {
      await SP_RES.submitPlan(p.id, p.revision, overrideReason ? { override_reason: overrideReason } : undefined);
      VR.close(); VR.flash('Đã gửi kế hoạch ' + p.voyage_code + ' chờ phê duyệt. Ban quản lý đã được thông báo.', 'ok'); BP.loadPlans();
    } catch (err) {
      if (err.status === 409 && err.details && err.details.check) {
        VR.dialog(`<h2 style="margin:0 0 4px">Không thể gửi duyệt</h2><p style="margin:0 0 12px;color:var(--mute)">${esc(p.voyage_code)} · bến ${esc(p.berth_code)}. ${esc(err.message)}</p><div id="chkResult"></div><div class="stack"><button class="btn" type="button" data-close>Close</button></div>`);
        BP.showViolation(err.details, (reason) => BP.submitPlan(id, reason));
        return;
      }
      if (err.status === 409) BP.loadPlans();
      VR.flash(err.message);
    }
  },

  /* ---------- UC-030: review and approve a pending plan ---------- */
  async openReview(id) {
    let plan; try { plan = await SP_RES.getPlan(id); } catch (e) { VR.flash(e.message); return; }
    const own = Number(plan.submitted_by_user_id) === Number(SP_AUTH.user.id);
    const stored = plan.check;
    let now = null; let nowErr = null;
    try { now = await SP_RES.checkPlacement({ voyage_id: plan.voyage_id, berth_id: plan.berth_id, position_start_m: Number(plan.position_start_m), position_end_m: Number(plan.position_end_m), planned_start: new Date(plan.planned_start).toISOString(), planned_end: new Date(plan.planned_end).toISOString(), required_cranes: plan.required_cranes }); }
    catch (e) { nowErr = e.message; }
    const pending = plan.plan_status === 'PENDING_APPROVAL';
    const canApprove = pending && now && now.outcome === 'PASS' && !own;
    const why = !pending ? 'Kế hoạch không còn chờ phê duyệt (' + plan.plan_status + ').' : own ? 'Bạn là người gửi kế hoạch này nên không được tự phê duyệt.' : nowErr ? 'Không kiểm tra lại được: ' + nowErr : now.outcome !== 'PASS' ? 'Kiểm tra lại ngay bây giờ không đạt nên không thể phê duyệt.' : '';
    VR.dialog(`<div id="reviewBox"><h2 style="margin:0 0 4px">Phê duyệt kế hoạch cập bến</h2><p style="margin:0 0 12px;color:var(--mute)">${esc(plan.ship_name)} · ${esc(plan.voyage_code)} · bến ${esc(plan.berth_code)}</p>
      <dl class="dtl" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 18px"><dt>Đoạn bến</dt><dd>${esc(plan.position_start_m)} – ${esc(plan.position_end_m)} m</dd><dt>Thời gian (UTC+7)</dt><dd>${esc(BP.fmt(plan.planned_start))} → ${esc(BP.fmt(plan.planned_end))}</dd>
        <dt>Cẩu bờ</dt><dd>${esc(plan.required_cranes)}</dd><dt>Nguồn</dt><dd>${esc(BP.sourceLabel(plan.source))}</dd><dt>Người gửi</dt><dd>${esc(plan.submitted_by_name || '—')} · ${esc(BP.fmt(plan.submitted_at))}</dd>
        <dt>Trạng thái</dt><dd>${esc(plan.plan_status)}</dd></dl>
      ${plan.override_reason ? `<div class="lmsg warn" id="ovInfo"><b>Kế hoạch có ghi đè ràng buộc</b> (${esc((plan.override_rules || []).join(', '))}): ${esc(plan.override_reason)}. Ghi đè chỉ cho phép gửi duyệt, không thay cho việc đạt ràng buộc.</div>` : ''}
      <h3 style="margin:14px 0 6px;font-size:14px">Kết quả kiểm tra lúc gửi</h3><div id="storedCheck">${BP.result(stored)}</div>
      <h3 style="margin:14px 0 6px;font-size:14px">Kiểm tra lại ngay bây giờ</h3><div id="chkResult">${now ? BP.result(now) : '<p style="color:var(--dim)">Không có kết quả.</p>'}</div>
      <div class="lmsg ${canApprove ? '' : 'bad'}" id="fmsg" role="alert" ${why ? '' : 'hidden'}>${esc(why)}</div>
      <div id="confirmBox" hidden class="lmsg warn" role="alert">Xác nhận phê duyệt kế hoạch này? Bến sẽ được đặt trước và chuyến tàu rời hàng đợi.
        <div class="stack"><button class="btn pri" type="button" id="confirmApprove">Xác nhận phê duyệt</button><button class="btn" type="button" id="cancelApprove">Hủy</button></div></div>
      <div id="rejectBox" hidden class="lmsg warn" role="alert"><label for="f-reject_reason"><b>Lý do từ chối (bắt buộc, gửi cho điều phối viên):</b></label><textarea id="f-reject_reason" maxlength="500" rows="2"></textarea><div class="fe" id="e-reject_reason" role="alert"></div>
        <div class="stack"><button class="btn pri" type="button" id="confirmReject">Xác nhận từ chối</button><button class="btn" type="button" id="cancelReject">Hủy</button></div></div>
      <div class="stack"><button class="btn pri" type="button" id="approveBtn" ${canApprove ? '' : 'disabled'}>Phê duyệt</button><button class="btn" type="button" id="rejectBtn" ${pending ? '' : 'disabled'}>Từ chối</button><button class="btn" type="button" data-close>Close</button></div></div>`);
    $('#rejectBtn').onclick = () => { $('#rejectBox').hidden = false; $('#rejectBtn').disabled = true; $('#f-reject_reason').focus(); };
    $('#cancelReject').onclick = () => { $('#rejectBox').hidden = true; $('#rejectBtn').disabled = !pending; };
    $('#confirmReject').onclick = async () => {
      const reason = $('#f-reject_reason').value.trim(); const e = $('#e-reject_reason'); e.textContent = '';
      if (!reason) { e.textContent = 'Từ chối bắt buộc có lý do.'; return; }
      const btn = $('#confirmReject'); btn.disabled = true;
      try { await SP_RES.rejectPlan(plan.id, plan.revision, reason); VR.close(); VR.flash('Đã từ chối kế hoạch ' + plan.voyage_code + '. Điều phối viên đã được thông báo kèm lý do.', 'ok'); BP.refreshAll(); }
      catch (err) {
        btn.disabled = false; const d = err.details || {};
        e.textContent = d.rule === 'NOT_PENDING' ? 'Kế hoạch vừa được xử lý ở nơi khác (' + d.plan_status + '). Danh sách đã được tải lại.' : d.current_revision !== undefined ? 'Kế hoạch vừa được thay đổi. Hãy đóng và mở lại.' : (Array.isArray(d) && d[0] && d[0].message) || err.message;
        if (d.rule === 'NOT_PENDING' || d.current_revision !== undefined) BP.refreshAll();
      }
    };
    $('#approveBtn').onclick = () => { $('#confirmBox').hidden = false; $('#approveBtn').disabled = true; };
    $('#cancelApprove').onclick = () => { $('#confirmBox').hidden = true; $('#approveBtn').disabled = !canApprove; };
    $('#confirmApprove').onclick = async () => {
      const btn = $('#confirmApprove'); btn.disabled = true;
      try {
        const done = await SP_RES.approvePlan(plan.id, plan.revision);
        VR.close(); VR.flash('Đã phê duyệt kế hoạch ' + plan.voyage_code + '. Chuyến tàu đã được xếp bến ' + plan.berth_code + ' và rời hàng đợi.', 'ok'); BP.refreshAll(); void done;
      } catch (err) {
        btn.disabled = false;
        const d = err.details || {}; const m = $('#fmsg');
        if (d.check) $('#chkResult').innerHTML = BP.result(d.check);
        m.textContent = d.rule === 'SELF_APPROVAL' ? 'Bạn là người gửi kế hoạch này nên không được tự phê duyệt.'
          : d.rule === 'CONSTRAINT_VIOLATION_AT_APPROVAL' ? 'Kế hoạch không còn thỏa các ràng buộc nên không thể phê duyệt. Người gửi đã được thông báo.'
          : d.rule === 'NOT_PENDING' ? 'Kế hoạch đã được xử lý ở nơi khác (' + d.plan_status + '). Danh sách đã được tải lại.'
          : d.current_revision !== undefined ? 'Kế hoạch vừa được thay đổi. Hãy đóng và mở lại để xem phiên bản mới nhất.' : err.message;
        m.className = 'lmsg bad'; m.hidden = false; $('#confirmBox').hidden = true;
        if (d.rule === 'NOT_PENDING' || d.current_revision !== undefined || d.rule === 'VOYAGE_NOT_IN_QUEUE') BP.refreshAll();
      }
    };
  },

  /* ---------- notifications (UC-029 AC-2) ---------- */
  notePanel() {
    return `<section class="panel" id="nts"><div class="ph"><div><h2>Thông báo · Notifications <span class="pill warn" id="noteCount" hidden></span></h2><div class="sub">Notices addressed to you or to your role · live data</div></div>
      <label style="display:flex;gap:6px;align-items:center;color:var(--mute);font-size:12px"><input type="checkbox" id="noteUnread" checked> Unread only</label></div><div id="noteList" aria-live="polite"></div></section>`;
  },
  async loadNotes() {
    const box = $('#noteList'); if (!box) return;
    try {
      const d = await SP_RES.listNotifications({ unread: $('#noteUnread').checked ? 'true' : undefined, size: 20 });
      const c = $('#noteCount'); c.hidden = !d.unread; c.textContent = d.unread + ' mới';
      BP.draw(box, 'sigNotes', d, () => d.items.length ? `<ul class="list">${d.items.map((n) => `<li data-note="${n.id}" data-unread="${n.read_at ? 'false' : 'true'}"><div><b>${esc(n.title)}</b><small>${esc(n.body)} · ${esc(BP.fmt(n.created_at))}${n.for_role ? ' · gửi cho vai trò' : ''}</small></div>
        ${n.read_at ? '<span class="pill mute" style="align-self:flex-start">Đã đọc</span>' : `<button class="btn" type="button" data-bact="note-read" data-id="${n.id}">Đánh dấu đã đọc</button>`}</li>`).join('')}</ul>${$('#noteUnread').checked && d.unread > d.items.length ? `<p class="note-more">Đang hiển thị ${d.items.length} thông báo mới nhất trong ${d.unread} chưa đọc.</p>` : ''}`
        : VR.stateBox('empty', 'Không có dữ liệu', 'Không có thông báo nào.'));
    } catch (e) { box.innerHTML = VR.stateBox('error', 'Không tải được thông báo', e.message, 'notes'); }
  },
  bindNotes() {
    $('#noteUnread').onchange = () => BP.loadNotes();
    BP.loadNotes(); setInterval(() => BP.loadNotes(), 30000);   // fallback timer when no hint arrives
    if (!BP.can('view')) BP.connectNotes();                      // users without the berth channel (agents) get content-free hints instead of waiting for the timer
  },

  /* ---------- wiring ---------- */
  bind() {
    BP.bindNotes();
    if (!BP.can('view')) { for (const id of ['#brt', '#plp', '#bch']) { const p = $(id); if (p) p.hidden = true; } return; }
    const rb = $('#recBtn'); if (rb) rb.hidden = !BP.can('edit');
    $('#addBerth').hidden = !BP.can('edit'); $('#addBerth').onclick = () => BP.openForm(null);
    $('#brtState').onchange = (e) => { BP.s.state = e.target.value; $('#berthList').innerHTML = BP.table(BP.s.items); };
    $('#brtType').onchange = (e) => { BP.s.type = e.target.value; $('#berthList').innerHTML = BP.table(BP.s.items); };
    document.addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.retry === 'berths') return BP.load();
      if (t.dataset.retry === 'plans') return BP.loadPlans();
      if (t.dataset.retry === 'notes') return BP.loadNotes();
      const act = t.dataset.bact; if (!act) return;
      if (act === 'detail') return BP.openDetail(t.dataset.id);
      if (act === 'edit') { try { return BP.openForm(await SP_RES.getBerth(t.dataset.id)); } catch (err) { VR.flash(err.message); return; } }
      if (act === 'rec-open') return BP.openRecommend();
      if (act === 'rec-use') return BP.recUse(t.dataset.voyage, t.dataset.proposal);
      if (act === 'rec-ignore') return BP.recIgnore(t.dataset.voyage);
      if (act === 'plan-edit') { const p = (BP.s.plans || []).find((x) => String(x.id) === t.dataset.id); return p && BP.openCheck(p.voyage_id, p); }
      if (act === 'plan-review') return BP.openReview(t.dataset.id);
      if (act === 'note-read') { try { await SP_RES.readNotification(t.dataset.id); BP.loadNotes(); } catch (err) { VR.flash(err.message); } return; }
      if (act === 'plan-submit') return BP.submitPlan(t.dataset.id);
      if (act === 'confirm') { BP.s.confirm = true; const f = $('#bf'); if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true })); }
    });
    BP.load(); BP.connect(); BP.loadPlans();
    BP.s.poll = setInterval(() => BP.load({ silent: true }), 60000);
  },
};
