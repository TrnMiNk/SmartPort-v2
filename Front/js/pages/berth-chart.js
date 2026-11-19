/* Berth plan chart (FR-BRT-03, UC-026 4a, UC-027 step 6, UC-028 steps 1-4): time along x, position along the berth on y, for one berth.
   Data comes from GET /berths/:id/chart (plans, physical occupancy, maintenance). Nothing here judges a placement: a drag only opens the
   existing check/save dialog (BP.openCheck) with the dropped values, so UC-026 on the server, revision checks, overrides and audit stay the only path.
   A UC-027 proposal is drawn as a dashed "not confirmed" block; it is never a reservation. */
const BC = {
  s: { berthId: null, days: 3, offset: 0, showProposals: true, data: null, berths: [], sig: '', drag: null, pending: false, ghost: null, loaded: false },
  KIND: {
    APPROVED: ['approved', 'Đã duyệt'], PENDING_APPROVAL: ['pending', 'Chờ duyệt'], DRAFT: ['draft', 'Nháp'], COMPLETED: ['done', 'Đã rời bến'],
  },
  DEFAULT_STAY_H: 12,   // UI default only for a vessel dragged from the tray: the coordinator edits it in the dialog and UC-026 judges it (assumption CH-3)
  fmt: (iso) => SP_RES_UTIL.formatUtc7(iso) || '—',
  iso: (ms) => new Date(ms).toISOString(),

  panel() {
    return `<section class="panel" id="bch"><div class="ph"><div><h2>Biểu đồ kế hoạch bến · Berth plan chart</h2><div class="sub">Thời gian (ngang) × vị trí dọc bến (dọc) · giờ UTC+7 · dữ liệu thật. Kéo khối nháp hoặc đề xuất để chỉnh vị trí/thời điểm; việc kiểm tra và lưu vẫn do hệ thống thực hiện.</div></div></div>
      <div class="bc-bar" role="group" aria-label="Điều khiển biểu đồ">
        <label>Bến <select id="bcBerth" aria-label="Chọn bến"></select></label>
        <label>Khung xem <select id="bcDays" aria-label="Khung xem"><option value="1">1 ngày</option><option value="3" selected>3 ngày</option><option value="7">7 ngày</option></select></label>
        <button class="btn" type="button" id="bcPrev" aria-label="Khung trước">‹</button><button class="btn" type="button" id="bcToday">Hôm nay</button><button class="btn" type="button" id="bcNext" aria-label="Khung sau">›</button>
        <label class="bc-chk"><input type="checkbox" id="bcProp" checked> Hiện đề xuất (chưa xác nhận)</label>
        <span class="bc-range" id="bcRange" aria-live="polite"></span>
      </div>
      <ul class="bc-legend" aria-label="Chú giải">
        <li><i class="bc-sw bc-approved"></i>Đã duyệt (giữ chỗ)</li><li><i class="bc-sw bc-pending"></i>Chờ duyệt</li><li><i class="bc-sw bc-draft"></i>Nháp (kéo được)</li>
        <li><i class="bc-sw bc-actual"></i>Đang cập bến (thực tế)</li><li><i class="bc-sw bc-done"></i>Đã rời bến</li><li><i class="bc-sw bc-proposal"></i>Đề xuất của thuật toán cục bộ (chưa xác nhận, không giữ chỗ)</li>
        <li><i class="bc-sw bc-maint"></i>Bảo trì</li><li><i class="bc-sw bc-bad"></i>Vi phạm UC-026</li><li><i class="bc-sw bc-ov"></i>Có ghi đè</li><li><i class="bc-sw bc-now"></i>Hiện tại</li></ul>
      <div id="bcState" aria-live="polite"></div>
      <div class="bc-scroll" id="bcScroll" hidden><div id="bcGrid"></div></div>
      <div class="bc-live" id="bcLive" aria-live="polite"></div>
      <div id="bcTray" class="bc-tray" hidden></div>
      <div class="bc-info" id="bcMsg" aria-live="polite">Chọn một khối để xem chi tiết.</div></section>`;
  },

  window() { return SP_RES_UTIL.chartWindow(Date.now(), BC.s.offset, BC.s.days); },

  async load({ silent = false } = {}) {
    const state = $('#bcState'); if (!state || !BP.can('view')) return;
    if (!silent) state.innerHTML = VR.stateBox('loading', 'Loading…');
    try {
      const berths = await SP_RES.listBerths({ size: 100 }).then((d) => d.items);
      BC.s.berths = berths;
      if (!berths.length) { BC.s.data = null; BC.s.sig = ''; state.innerHTML = VR.stateBox('empty', 'Không có dữ liệu', 'Chưa có bến nào trong danh mục.'); $('#bcScroll').hidden = true; $('#bcBerth').innerHTML = ''; return; }
      if (!berths.some((b) => b.id === BC.s.berthId)) BC.s.berthId = berths[0].id;
      const w = BC.window();
      const d = await SP_RES.berthChart(BC.s.berthId, BC.iso(w.fromMs), BC.iso(w.toMs));
      BC.s.data = d; BC.s.loaded = true; state.innerHTML = '';
      BC.draw();
    } catch (e) { if (!silent || !BC.s.loaded) state.innerHTML = VR.stateBox('error', 'Không tải được biểu đồ kế hoạch bến', e.message, 'chart'); }
  },

  // Everything the picture shows, so an unchanged refresh does not redraw it (and a drag in progress is never interrupted).
  signature() {
    const d = BC.s.data; const rec = BC.proposals();
    return JSON.stringify([BC.s.berthId, BC.s.days, BC.s.offset, BC.s.berths.map((b) => [b.id, b.berth_code]), d && { b: d.berth, f: d.from, p: d.plans, m: d.maintenance }, rec.map((p) => p.proposal_id), BC.s.ghost, BC.trayItems().map((e) => e.voyage_id), BC.s.showProposals]);
  },

  proposals() {
    const r = BP.s.rec; if (!BC.s.showProposals || !r || !BC.s.berthId) return [];
    const out = [];
    for (const v of r.vessels || []) {
      if (v.outcome !== 'RECOMMENDED' || (v.decision && v.decision.length)) continue;
      for (const p of v.proposals) if (Number(p.berth_id) === Number(BC.s.berthId)) out.push({ ...p, voyage_id: v.voyage_id, voyage_code: v.voyage_code });
    }
    return out;
  },

  // Queued voyages that have no plan yet: they can be dragged onto the chart to start a draft (UC-028 2a).
  trayItems() {
    if (!BP.can('edit') || !VR.s.queue || !VR.s.queue.items) return [];
    const open = new Set((BP.s.plans || []).filter((p) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(p.plan_status)).map((p) => String(p.voyage_id)));
    return VR.s.queue.items.filter((e) => !open.has(String(e.voyage_id)));
  },

  draw() {
    const d = BC.s.data; if (!d) return;
    const sig = BC.signature();
    if (BC.s.drag) { BC.s.pending = true; return; }       // never redraw under a hand that is dragging
    if (sig === BC.s.sig && $('#bcGrid').innerHTML) return;
    BC.s.sig = sig; BC.s.pending = false;
    const sel = $('#bcBerth');
    sel.innerHTML = BC.s.berths.map((b) => `<option value="${b.id}"${b.id === BC.s.berthId ? ' selected' : ''}>${esc(b.berth_code)} · ${esc(b.length_m)} m</option>`).join('');
    const w = { fromMs: new Date(d.from).getTime(), toMs: new Date(d.to).getTime() };
    $('#bcRange').textContent = `${BC.fmt(d.from)} → ${BC.fmt(d.to)} (UTC+7)`;
    const L = d.berth.length_m; const hours = (w.toMs - w.fromMs) / 3600e3;
    const avail = Math.max(320, ($('#bch').clientWidth || 900) - 80);
    const widthPx = Math.max(avail, Math.round(hours * 9)); const heightPx = Math.max(240, Math.min(560, Math.round(L * 0.55)));
    const scale = SP_RES_UTIL.chartScale({ fromMs: w.fromMs, toMs: w.toMs, lengthM: L, widthPx, heightPx });
    BC.scale = scale;
    const stepH = [1, 3, 6, 12, 24].find((h) => h * (widthPx / hours) >= 90) || 24;   // labels never overlap, whatever the width
    const ticks = SP_RES_UTIL.chartTicks(w.fromMs, w.toMs, stepH);
    const yStep = [10, 25, 50, 100, 200].find((m) => scale.y(m) >= 30) || 200; const yTicks = []; for (let m = 0; m <= L; m += yStep) yTicks.push(m);
    const blocks = [];
    const rect = (r) => `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    const label = (t1, t2, r) => (r.width >= 64 && r.height >= 30 ? `<span class="bc-t">${esc(t1)}</span><span class="bc-t2">${esc(t2)}</span>` : r.width >= 40 ? `<span class="bc-t">${esc(t1)}</span>` : '');
    const mark = (p) => `${p.check_passed === false ? '<b class="bc-flag bc-flag-bad" aria-hidden="true">!</b>' : ''}${p.has_override ? '<b class="bc-flag bc-flag-ov" aria-hidden="true">⚠</b>' : ''}`;
    for (const m of d.maintenance) {
      const r = SP_RES_UTIL.chartRect(scale, { startMs: new Date(m.starts_at).getTime(), endMs: new Date(m.ends_at).getTime(), posStart: 0, posEnd: L }); if (!r) continue;
      const text = `Bảo trì: ${m.reason} · ${BC.fmt(m.starts_at)} → ${BC.fmt(m.ends_at)} (cả bến không dùng được)`;
      blocks.push(`<div class="bc-blk bc-maint" style="${rect(r)}" tabindex="0" role="group" aria-label="${esc(text)}" title="${esc(text)}" data-info="${esc(text)}">${r.width >= 50 ? `<span class="bc-t">Bảo trì</span>` : ''}</div>`);
    }
    for (const p of d.plans) {
      const berthed = p.physically_berthed;
      const kind = berthed ? ['actual', 'Đang cập bến (thực tế)'] : BC.KIND[p.plan_status];
      const from = berthed ? p.occupies_from : (p.plan_status === 'COMPLETED' ? p.occupies_from : p.planned_start);
      const to = berthed ? p.occupies_to : (p.plan_status === 'COMPLETED' ? p.occupies_to : p.planned_end);
      const r = SP_RES_UTIL.chartRect(scale, { startMs: new Date(from).getTime(), endMs: to == null ? null : new Date(to).getTime(), posStart: p.position_start_m, posEnd: p.position_end_m }); if (!r) continue;
      const draggable = p.plan_status === 'DRAFT' && BP.can('edit');
      const text = `${p.voyage_code} · ${p.ship_name} · ${kind[1]} · đoạn ${p.position_start_m}–${p.position_end_m} m · ${BC.fmt(from)} → ${to == null ? 'chưa rời bến' : BC.fmt(to)}`
        + (berthed ? ` · kế hoạch ${BC.fmt(p.planned_start)} → ${BC.fmt(p.planned_end)}` : '') + ` · nguồn: ${BP.sourceLabel(p.source)}`
        + (p.check_passed === false ? ' · UC-026: có vi phạm' : '') + (p.has_override ? ' · có ghi đè kèm lý do' : '');
      blocks.push(`<div class="bc-blk bc-${kind[0]}${p.check_passed === false ? ' bc-viol' : ''}${p.has_override ? ' bc-over' : ''}${r.openEnded ? ' bc-open' : ''}" style="${rect(r)}" tabindex="0" role="button" aria-label="${esc(text)}" title="${esc(text)}"
        data-plan="${p.plan_id}" data-voyage="${p.voyage_id}" data-info="${esc(text)}"${draggable ? ' data-drag="plan"' : ''}>${label(p.voyage_code, `${p.position_start_m}–${p.position_end_m} m`, r)}${mark(p)}${r.openEnded ? '<b class="bc-arrow" aria-hidden="true">▶</b>' : ''}</div>`);
    }
    for (const p of BC.proposals()) {
      const r = SP_RES_UTIL.chartRect(scale, { startMs: new Date(p.planned_start).getTime(), endMs: new Date(p.planned_end).getTime(), posStart: p.position_start_m, posEnd: p.position_end_m }); if (!r) continue;
      const text = `Đề xuất #${p.rank} (chưa xác nhận, không giữ chỗ) · ${p.voyage_code} · đoạn ${p.position_start_m}–${p.position_end_m} m · ${BC.fmt(p.planned_start)} → ${BC.fmt(p.planned_end)} · đã qua UC-026`;
      blocks.push(`<div class="bc-blk bc-proposal" style="${rect(r)}" tabindex="0" role="button" aria-label="${esc(text)}" title="${esc(text)}" data-prop="${p.proposal_id}" data-voyage="${p.voyage_id}" data-info="${esc(text)}"${BP.can('edit') ? ' data-drag="proposal"' : ''}>${label(`Đề xuất #${p.rank}`, p.voyage_code, r)}</div>`);
    }
    const g = BC.s.ghost;
    if (g && Number(g.berth_id) === Number(BC.s.berthId)) {
      const r = SP_RES_UTIL.chartRect(scale, { startMs: g.startMs, endMs: g.endMs, posStart: g.posStart, posEnd: g.posEnd });
      if (r) blocks.push(`<div class="bc-blk bc-ghost bc-ghost-${esc(g.outcome)}" style="${rect(r)}" role="status" aria-label="${esc(g.text)}" title="${esc(g.text)}" data-info="${esc(g.text)}"><span class="bc-t">${g.outcome === 'PASS' ? '✓' : g.outcome === 'VIOLATION' ? '✗' : '?'} ${esc(g.voyage_code)}</span></div>`);
    }
    const now = Date.now(); const nowLine = now > w.fromMs && now < w.toMs ? `<div class="bc-nowline" style="left:${scale.x(now)}px" title="Hiện tại ${esc(BC.fmt(new Date(now).toISOString()))}"></div>` : '';
    $('#bcGrid').innerHTML = `<div class="bc-inner" style="grid-template-columns:54px ${widthPx}px;grid-template-rows:24px ${heightPx}px">
      <div class="bc-corner">m ↓ / giờ →</div>
      <div class="bc-x">${ticks.map((t) => `<span style="left:${scale.x(t.ms)}px">${esc(t.label)}</span>`).join('')}</div>
      <div class="bc-y">${yTicks.map((m) => `<span style="top:${scale.y(m)}px">${m}</span>`).join('')}</div>
      <div class="bc-plot" id="bcPlot" style="width:${widthPx}px;height:${heightPx}px" data-berth="${d.berth.id}">
        ${ticks.map((t) => `<i class="bc-gx" style="left:${scale.x(t.ms)}px"></i>`).join('')}${yTicks.map((m) => `<i class="bc-gy" style="top:${scale.y(m)}px"></i>`).join('')}
        ${nowLine}${blocks.join('')}${d.plans.length || d.maintenance.length ? '' : '<p class="bc-empty">Không có kế hoạch, bảo trì hay tàu đang cập trong khung này.</p>'}</div></div>`;
    $('#bcScroll').hidden = false;
    const tray = $('#bcTray'); const items = BC.trayItems();
    tray.hidden = !items.length;
    tray.innerHTML = items.length ? `<b>Tàu chờ chưa có kế hoạch</b> <small>(kéo vào biểu đồ để lập nháp; mặc định ${BC.DEFAULT_STAY_H} giờ, chỉnh trong hộp thoại)</small><div class="bc-chips">${items.map((e) => `<span class="bc-chip" data-drag="chip" data-voyage="${e.voyage_id}" tabindex="0" role="button" aria-label="${esc(`${e.voyage_code} ${e.ship_name}, kéo vào biểu đồ hoặc nhấn Enter để lập kế hoạch`)}" title="LOA ${esc(e.length_overall_m == null ? '?' : e.length_overall_m)} m">${esc(e.voyage_code)} · ${esc(e.ship_name)} · ${esc(e.length_overall_m == null ? '?' : e.length_overall_m)} m</span>`).join('')}</div>` : '';
  },

  /* ---------- dragging (pointer events: mouse, pen and touch) ---------- */
  placementOf(el) {
    const kind = el.dataset.drag; const sc = BC.scale;
    if (kind === 'plan') { const p = BC.s.data.plans.find((x) => String(x.plan_id) === el.dataset.plan);
      return { startMs: new Date(p.planned_start).getTime(), endMs: new Date(p.planned_end).getTime(), posStart: p.position_start_m, posEnd: p.position_end_m }; }
    if (kind === 'proposal') { const p = BC.proposals().find((x) => String(x.proposal_id) === el.dataset.prop);
      return { startMs: new Date(p.planned_start).getTime(), endMs: new Date(p.planned_end).getTime(), posStart: Number(p.position_start_m), posEnd: Number(p.position_end_m) }; }
    const e = (VR.s.queue.items || []).find((x) => String(x.voyage_id) === el.dataset.voyage); const loa = Math.min(sc.lengthM, e && e.length_overall_m ? e.length_overall_m : 200);
    return { startMs: sc.fromMs, endMs: sc.fromMs + BC.DEFAULT_STAY_H * 3600e3, posStart: 0, posEnd: loa };
  },
  liveText(pl) { return `Bến ${BC.s.data.berth.berth_code} · đoạn ${pl.posStart}–${pl.posEnd} m · ${BC.fmt(BC.iso(pl.startMs))} → ${BC.fmt(BC.iso(pl.endMs))} (UTC+7)`; },
  dragStart(e) {
    const el = e.target.closest('[data-drag]'); if (!el || e.button > 0 || !BC.s.data) return;
    BC.s.drag = { el, x0: e.clientX, y0: e.clientY, moved: false, kind: el.dataset.drag, orig: BC.placementOf(el), id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable (synthetic) */ }
  },
  dragMove(e) {
    const dr = BC.s.drag; if (!dr || e.pointerId !== dr.id) return;
    const dx = e.clientX - dr.x0; const dy = e.clientY - dr.y0;
    if (!dr.moved && Math.hypot(dx, dy) < 5) return;
    dr.moved = true; dr.el.classList.add('bc-dragging');
    if (dr.kind === 'chip') {
      const pr = $('#bcPlot').getBoundingClientRect();
      dr.drop = BC.dropAt(dr, e.clientX - pr.left, e.clientY - pr.top);
      dr.el.style.transform = `translate(${dx}px,${dy}px)`;
    } else { dr.drop = SP_RES_UTIL.chartDrop(BC.scale, dr.orig, dx, dy); dr.el.style.transform = `translate(${dx}px,${dy}px)`; }
    $('#bcLive').textContent = BC.liveText(dr.drop);
  },
  dropAt(dr, x, y) { return SP_RES_UTIL.chartDrop(BC.scale, dr.orig, x, y - 0); },
  dragEnd(e) {
    const dr = BC.s.drag; if (!dr || e.pointerId !== dr.id) return;
    BC.s.drag = null; dr.el.classList.remove('bc-dragging'); dr.el.style.transform = '';
    try { dr.el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    $('#bcLive').textContent = '';
    if (!dr.moved) { BC.activate(dr.el); BC.afterDrag(); return; }
    if (e.type === 'pointercancel') { BC.afterDrag(); return; }
    if (dr.kind === 'chip') {
      const pr = $('#bcPlot').getBoundingClientRect();
      const inside = e.clientX >= pr.left && e.clientX <= pr.right && e.clientY >= pr.top && e.clientY <= pr.bottom;
      if (!inside) { BC.afterDrag(); return; }
    }
    BC.dropped(dr.el, dr.drop); BC.afterDrag();
  },
  afterDrag() { if (BC.s.pending) { BC.s.sig = ''; BC.draw(); } },

  // A click (or Enter) on a block: a draft opens the same edit dialog as the plan list; a proposal behaves like "Dùng đề xuất"; anything else shows its details.
  async activate(el) {
    if (el.dataset.drag === 'plan') { const p = await BC.draft(el.dataset.plan); if (p) BP.openCheck(p.voyage_id, p); return; }
    if (el.dataset.drag === 'proposal') { BP.recUse(el.dataset.voyage, el.dataset.prop); return; }
    if (el.dataset.drag === 'chip') { BP.openCheck(el.dataset.voyage); return; }
    if (el.dataset.info) $('#bcMsg').textContent = el.dataset.info;
  },
  async draft(planId) {
    try { return await SP_RES.getPlan(planId); } catch (e) { VR.flash(e.message); return null; }
  },

  // Dropped on a new place: the server checks it (UC-026) and the result is drawn on the chart; then the normal dialog opens with the values,
  // from which the coordinator saves, overrides with a reason or cancels. The dropped values are not stored by the drop itself.
  async dropped(el, pl) {
    const kind = el.dataset.drag; const voyageId = Number(el.dataset.voyage);
    const values = { berth_id: BC.s.berthId, position_start_m: pl.posStart, position_end_m: pl.posEnd, planned_start: BC.iso(pl.startMs), planned_end: BC.iso(pl.endMs) };
    let draft = null; let proposal = null;
    if (kind === 'plan') { draft = await BC.draft(el.dataset.plan); if (!draft) return; values.required_cranes = draft.required_cranes; }
    if (kind === 'proposal') { proposal = BC.proposals().find((x) => String(x.proposal_id) === el.dataset.prop); if (!proposal) return; values.required_cranes = proposal.required_cranes; }
    const entry = (VR.s.queue.items || []).find((x) => String(x.voyage_id) === String(voyageId));
    const code = entry ? entry.voyage_code : (draft && draft.voyage_code) || String(voyageId);
    let outcome = 'UNKNOWN'; let text = `${code}: chưa kiểm tra được vị trí mới.`;
    try {
      const r = await SP_RES.checkPlacement({ voyage_id: voyageId, ...values });
      outcome = r.outcome;
      const bad = r.rules.filter((x) => x.outcome !== 'PASS').map((x) => `${x.id}: ${x.reason}`);
      text = `${code} · kiểm tra UC-026: ${outcome === 'PASS' ? 'Đạt mọi ràng buộc' : outcome === 'VIOLATION' ? 'Vi phạm: ' + bad.join('; ') : 'Thiếu dữ liệu: ' + bad.join('; ')} · ${BC.liveText(pl)}`;
    } catch (err) { text = `${code} · ${err.message}`; }
    BC.s.ghost = { berth_id: BC.s.berthId, voyage_code: code, outcome, text, startMs: pl.startMs, endMs: pl.endMs, posStart: pl.posStart, posEnd: pl.posEnd };
    $('#bcMsg').textContent = text; BC.s.sig = ''; BC.draw();
    BP.openCheck(voyageId, draft, proposal, values);
  },

  /* ---------- wiring ---------- */
  bind() {
    const panel = $('#bch'); if (!panel) return;
    if (!BP.can('view')) { panel.hidden = true; return; }
    const reload = () => { BC.s.ghost = null; BC.s.sig = ''; BC.load(); };
    $('#bcBerth').onchange = (e) => { BC.s.berthId = Number(e.target.value); reload(); };
    $('#bcDays').onchange = (e) => { BC.s.days = Number(e.target.value); BC.s.offset = 0; reload(); };
    $('#bcPrev').onclick = () => { BC.s.offset -= BC.s.days; reload(); };
    $('#bcNext').onclick = () => { BC.s.offset += BC.s.days; reload(); };
    $('#bcToday').onclick = () => { BC.s.offset = 0; reload(); };
    $('#bcProp').onchange = (e) => { BC.s.showProposals = e.target.checked; BC.s.sig = ''; BC.draw(); };
    panel.addEventListener('pointerdown', (e) => BC.dragStart(e));
    panel.addEventListener('pointermove', (e) => BC.dragMove(e));
    panel.addEventListener('pointerup', (e) => BC.dragEnd(e));
    panel.addEventListener('pointercancel', (e) => BC.dragEnd(e));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && BC.s.drag) { const dr = BC.s.drag; BC.s.drag = null; dr.el.classList.remove('bc-dragging'); dr.el.style.transform = ''; $('#bcLive').textContent = ''; BC.afterDrag(); } });
    panel.addEventListener('keydown', (e) => { const el = e.target.closest('.bc-blk,.bc-chip'); if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); BC.activate(el); } });
    panel.addEventListener('click', (e) => { const t = e.target.closest('button'); if (t && t.dataset.retry === 'chart') BC.load(); const b = e.target.closest('.bc-blk'); if (b && b.dataset.info && !b.dataset.drag) $('#bcMsg').textContent = b.dataset.info; });
    BC.load();
  },
};
