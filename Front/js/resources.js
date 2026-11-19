/* API resources for Module 1 (vessels, arrival notices, catalogs). The only place that knows these endpoints; pages call
   these functions through the central client (rule 03). Also holds the small pure helpers for ETA (UTC+7) handling.
   Works in the browser (window.SP_RES) and in Node tests (module.exports). */
(function (root) {
  'use strict';

  const UTC7_MS = 7 * 60 * 60 * 1000;

  // A <input type="datetime-local"> value ("2026-12-01T08:00") is read as Vietnam time (UTC+7), the display zone in
  // the specification, and sent as ISO 8601 with an explicit offset so the server stores the right instant.
  function localToIso(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    return value + ':00+07:00';
  }

  // ISO instant -> the value of a datetime-local input in UTC+7 ("YYYY-MM-DDTHH:mm"), used to refill a saved draft.
  function isoToLocal(iso) {
    const text = formatUtc7(iso);
    return text ? text.replace(' ', 'T') : '';
  }

  // ISO instant -> "YYYY-MM-DD HH:mm" in UTC+7. Returns "" for missing or invalid values.
  function formatUtc7(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    return new Date(t + UTC7_MS).toISOString().slice(0, 16).replace('T', ' ');
  }


  // ---- Schedule (UC-021) helpers: windows are calendar days or Monday-first weeks in UTC+7 (assumption A-2) ----
  const DAY_MS = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  const dayMs = (date) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return NaN;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return ymd(ms) === date ? ms : NaN; // rejects impossible dates such as 2027-02-30
  };

  function todayLocal(now) { return ymd((now === undefined ? Date.now() : now) + UTC7_MS); }
  function shiftDate(date, days) { return ymd(dayMs(date) + days * DAY_MS); }

  // mode 'day' or 'week'; returns { from, to } as ISO instants plus the first local date shown, or null for a bad date.
  function scheduleWindow(date, mode) {
    let start = dayMs(date);
    if (Number.isNaN(start)) return null;
    if (mode === 'week') start -= ((new Date(start).getUTCDay() + 6) % 7) * DAY_MS;
    const days = mode === 'week' ? 7 : 1;
    const from = start - UTC7_MS;
    return { from: new Date(from).toISOString(), to: new Date(from + days * DAY_MS).toISOString(), firstDate: ymd(start), days };
  }

  // Bar position inside a window as fractions 0..1. start_at/end_at come from the server (actual times win over the plan).
  // A voyage without an interval is a point marker at its declared ETA; an open interval runs to the window end.
  function barGeometry(item, fromIso, toIso, minWidth) {
    const from = new Date(fromIso).getTime(); const span = new Date(toIso).getTime() - from;
    const start = new Date(item.start_at || item.declared_eta).getTime();
    const end = item.start_at ? (item.end_at ? new Date(item.end_at).getTime() : from + span) : start;
    const clamp = (x) => Math.min(1, Math.max(0, x));
    const left = clamp((start - from) / span);
    const right = clamp((end - from) / span);
    return { left, width: Math.max(right - left, minWidth === undefined ? 0.01 : minWidth), marker: !item.start_at };
  }

  // Puts the bars of one lane on rows so that bars that overlap in time never cover each other.
  function packRows(items) {
    const rows = []; const placed = [];
    const t = (x) => new Date(x.start_at || x.declared_eta).getTime();
    const e = (x) => (x.start_at ? (x.end_at ? new Date(x.end_at).getTime() : Infinity) : t(x) + 3600000);
    for (const item of [...items].sort((a, b) => t(a) - t(b) || a.id - b.id)) {
      let r = rows.findIndex((last) => last <= t(item));
      if (r === -1) { r = rows.length; rows.push(0); }
      rows[r] = e(item);
      placed.push({ item, row: r });
    }
    return { placed, rows: Math.max(1, rows.length) };
  }

  function query(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '' || value === false) continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function createResources(api) {
    const get = (path) => api.request(path);
    const withRevision = (revision) => ({ 'If-Match': `"${revision}"` });
    return {
      shipTypes: async () => (await get('/api/v1/catalog/ship-types')).items,
      ports: async () => (await get('/api/v1/catalog/ports')).items,
      agents: async () => (await get('/api/v1/catalog/agents')).items,
      listShips: (params) => get('/api/v1/ships' + query(params)),
      getShip: (id) => get(`/api/v1/ships/${encodeURIComponent(id)}`),
      shipHistory: async (id) => (await get(`/api/v1/ships/${encodeURIComponent(id)}/history`)).items,
      createShip: (body) => api.request('/api/v1/ships', { method: 'POST', body }),
      updateShip: (id, revision, body) => api.request(`/api/v1/ships/${encodeURIComponent(id)}`,
        { method: 'PATCH', body, headers: withRevision(revision) }),
      deactivateShip: (id, revision, reason) => api.request(`/api/v1/ships/${encodeURIComponent(id)}/deactivate`,
        { method: 'POST', body: { reason }, headers: withRevision(revision) }),
      getVoyage: (id) => get(`/api/v1/voyages/${encodeURIComponent(id)}`),
      listVoyages: (params) => get('/api/v1/voyages' + query(params)),
      createVoyage: (body) => api.request('/api/v1/voyages', { method: 'POST', body }),
      // UC-022 / UC-023: actual berthing and departure. `revision` is the voyage revision (If-Match).
      confirmBerthing: (id, revision, body) => api.request(`/api/v1/voyages/${encodeURIComponent(id)}/berthing`, { method: 'POST', body, headers: withRevision(revision) }),
      confirmDeparture: (id, revision, body) => api.request(`/api/v1/voyages/${encodeURIComponent(id)}/departure`, { method: 'POST', body, headers: withRevision(revision) }),
      // UC-016 5a: the prediction history of one voyage, newest first.
      etaPredictions: (id) => get(`/api/v1/voyages/${encodeURIComponent(id)}/eta-predictions`),
      validateVoyage: (id) => api.request(`/api/v1/voyages/${encodeURIComponent(id)}/validate`, { method: 'POST', body: {} }),
      // Schedule (UC-021). Berths come from Module 2's catalog and only feed the filter.
      schedule: (params) => get('/api/v1/voyages/schedule' + query(params)),
      berths: async () => (await get('/api/v1/catalog/berths')).items,
      // Berth catalog (UC-024), berth state (UC-025) and placement check (UC-026), Module 2.
      listBerths: (params) => get('/api/v1/berths' + query(params)),
      getBerth: (id) => get(`/api/v1/berths/${encodeURIComponent(id)}`),
      createBerth: (body) => api.request('/api/v1/berths', { method: 'POST', body }),
      updateBerth: (id, revision, body) => api.request(`/api/v1/berths/${encodeURIComponent(id)}`, { method: 'PATCH', body, headers: withRevision(revision) }),
      berthStatus: () => get('/api/v1/berths/status'),
      berthDetail: (id) => get(`/api/v1/berths/${encodeURIComponent(id)}/detail`),
      listPlans: (params) => get('/api/v1/berth-plans' + query(params)),
      getPlan: (id) => get(`/api/v1/berth-plans/${encodeURIComponent(id)}`),
      createPlan: (body) => api.request('/api/v1/berth-plans', { method: 'POST', body }),
      updatePlan: (id, revision, body) => api.request(`/api/v1/berth-plans/${encodeURIComponent(id)}`, { method: 'PUT', body, headers: withRevision(revision) }),
      submitPlan: (id, revision, body) => api.request(`/api/v1/berth-plans/${encodeURIComponent(id)}/submit`, { method: 'POST', body: body || {}, headers: withRevision(revision) }),
      approvePlan: (id, revision) => api.request(`/api/v1/berth-plans/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { confirm: true }, headers: withRevision(revision) }),
      rejectPlan: (id, revision, reason) => api.request(`/api/v1/berth-plans/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason }, headers: withRevision(revision) }),
      listNotifications: (params) => get('/api/v1/notifications' + query(params)),
      readNotification: (id) => api.request(`/api/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }),
      verifyHazard: (voyageId, body) => api.request(`/api/v1/voyages/${encodeURIComponent(voyageId)}/cargo-hazard`, { method: 'PUT', body }),
      // UC-027 local berth recommendations (a deterministic optimizer, not a machine-learning model).
      recommendBerths: (voyageIds) => api.request('/api/v1/berth-recommendations', { method: 'POST', body: voyageIds ? { voyage_ids: voyageIds } : {} }),
      getRecommendation: (id) => get(`/api/v1/berth-recommendations/${encodeURIComponent(id)}`),
      ignoreRecommendation: (id, voyageId, reason) => api.request(`/api/v1/berth-recommendations/${encodeURIComponent(id)}/ignore`, { method: 'POST', body: reason ? { voyage_id: voyageId, reason } : { voyage_id: voyageId } }),
      berthChart: (id, fromIso, toIso) => get(`/api/v1/berths/${encodeURIComponent(id)}/chart` + query({ from: fromIso, to: toIso })),
      checkPlacement: (body) => api.request('/api/v1/berth-plan-checks', { method: 'POST', body }),
      // Drafts of arrival notices (UC-013 3a)
      listDrafts: async () => (await get('/api/v1/voyage-drafts')).items,
      createDraft: (body) => api.request('/api/v1/voyage-drafts', { method: 'POST', body }),
      updateDraft: (id, revision, body) => api.request(`/api/v1/voyage-drafts/${encodeURIComponent(id)}`,
        { method: 'PUT', body, headers: withRevision(revision) }),
      discardDraft: (id, revision) => api.request(`/api/v1/voyage-drafts/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: withRevision(revision) }),
      submitDraft: (id) => api.request(`/api/v1/voyage-drafts/${encodeURIComponent(id)}/submit`, { method: 'POST', body: {} }),
      // Berth queue (UC-020). The queue revision is the concurrency token for moves.
      getQueue: () => get('/api/v1/voyages/queue'),
      moveQueue: (voyageId, revision, body) => api.request(`/api/v1/voyages/${encodeURIComponent(voyageId)}/queue-position`,
        { method: 'PATCH', body, headers: withRevision(revision) }),
    };
  }

  // ---- Berth plan chart (FR-BRT-03): time along x, position along the berth on y. Pure geometry; every judgement stays on the server (UC-026). ----
  // The window is whole UTC+7 days starting `offsetDays` from the day of `nowMs`.
  function chartWindow(nowMs, offsetDays, days) {
    const dayStart = Math.floor((nowMs + UTC7_MS) / DAY_MS) * DAY_MS - UTC7_MS;
    const fromMs = dayStart + offsetDays * DAY_MS;
    return { fromMs, toMs: fromMs + days * DAY_MS };
  }
  function chartScale({ fromMs, toMs, lengthM, widthPx, heightPx }) {
    return { fromMs, toMs, lengthM, widthPx, heightPx,
      x: (ms) => ((ms - fromMs) / (toMs - fromMs)) * widthPx, ms: (x) => fromMs + (x / widthPx) * (toMs - fromMs),
      y: (m) => (m / lengthM) * heightPx, m: (y) => (y / heightPx) * lengthM };
  }
  // Rectangle of an allocation clipped to the window. `endMs` null means open-ended (a vessel still alongside): it runs to the right edge.
  function chartRect(scale, { startMs, endMs, posStart, posEnd }) {
    const end = endMs == null ? scale.toMs : endMs;
    const l = Math.max(startMs, scale.fromMs); const r = Math.min(end, scale.toMs);
    if (!(r > l)) return null;
    const top = scale.y(Math.max(0, posStart)); const bottom = scale.y(Math.min(scale.lengthM, posEnd));
    return { left: scale.x(l), width: Math.max(2, scale.x(r) - scale.x(l)), top, height: Math.max(2, bottom - top),
      clippedLeft: startMs < scale.fromMs, clippedRight: endMs == null || end > scale.toMs, openEnded: endMs == null };
  }
  // Result of moving a block by (dx, dy) pixels: the time snaps to `snapMin` minutes, the stretch to `snapM` metres, the size is kept and the block stays on the berth.
  function chartDrop(scale, orig, dx, dy, { snapMin = 15, snapM = 1 } = {}) {
    const snapMs = snapMin * 60000; const dur = orig.endMs - orig.startMs; const len = orig.posEnd - orig.posStart;
    const startMs = Math.round((orig.startMs + (dx / scale.widthPx) * (scale.toMs - scale.fromMs)) / snapMs) * snapMs;
    let posStart = Math.round((orig.posStart + (dy / scale.heightPx) * scale.lengthM) / snapM) * snapM;
    posStart = Math.max(0, Math.min(scale.lengthM - len, posStart));
    return { startMs, endMs: startMs + dur, posStart, posEnd: posStart + len };
  }
  // Time axis ticks (labels in UTC+7): every `stepH` hours from the first whole step inside the window.
  function chartTicks(fromMs, toMs, stepH) {
    const step = stepH * 3600000; const out = [];
    for (let t = Math.ceil((fromMs + UTC7_MS) / step) * step - UTC7_MS; t < toMs; t += step) out.push({ ms: t, label: formatUtc7(new Date(t).toISOString()).slice(5) });
    return out;
  }

  const exported = { chartWindow, chartScale, chartRect, chartDrop, chartTicks, createResources, localToIso, formatUtc7, isoToLocal, query, todayLocal, shiftDate, scheduleWindow, barGeometry, packRows };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.SP_RES = createResources(root.SP_API);
    root.SP_RES_UTIL = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
