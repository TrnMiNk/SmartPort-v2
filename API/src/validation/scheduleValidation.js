'use strict';

// Query validation for the schedule (UC-021). Times are ISO 8601 with an offset; a Gantt window is limited so the
// answer stays complete and small.

const { parseId, parsePaging } = require('./common');
const { parseEta } = require('./voyageValidation');

const STATUSES = ['ANNOUNCED', 'MISSING_DOCUMENTS', 'REJECTED', 'VALIDATED', 'WAITING_BERTH', 'BERTH_ASSIGNED', 'BERTHED', 'DEPARTED'];
const MAX_WINDOW_MS = 31 * 86400000;
const GANTT_LIMIT = 500;

function validateSchedule(query) {
  const errors = [];
  const view = query.view === undefined ? 'list' : query.view;
  if (view !== 'list' && view !== 'gantt') errors.push({ field: 'view', message: 'Chế độ xem phải là list hoặc gantt.' });
  if (query.status !== undefined && !STATUSES.includes(query.status)) errors.push({ field: 'status', message: 'Trạng thái không hợp lệ.' });
  const id = (key, label) => {
    if (query[key] === undefined) return null;
    const v = parseId(query[key]);
    if (v === null) errors.push({ field: key, message: `${label} không hợp lệ.` });
    return v;
  };
  const agentId = id('agent_id', 'Mã đại lý');
  const berthId = id('berth_id', 'Mã cầu bến');
  const hasFrom = query.from !== undefined; const hasTo = query.to !== undefined;
  const from = hasFrom ? parseEta(query.from) : null; const to = hasTo ? parseEta(query.to) : null;
  if (hasFrom && !from) errors.push({ field: 'from', message: 'Thời điểm bắt đầu phải theo ISO 8601 kèm múi giờ.' });
  if (hasTo && !to) errors.push({ field: 'to', message: 'Thời điểm kết thúc phải theo ISO 8601 kèm múi giờ.' });
  if (view === 'gantt' && !(hasFrom && hasTo)) errors.push({ field: 'from', message: 'Dạng Gantt cần khung thời gian (from và to).' });
  if (hasFrom !== hasTo) errors.push({ field: hasFrom ? 'to' : 'from', message: 'Cần cả from và to.' });
  if (from && to && !(from < to)) errors.push({ field: 'to', message: 'Thời điểm kết thúc phải sau thời điểm bắt đầu.' });
  if (from && to && to - from > MAX_WINDOW_MS) errors.push({ field: 'to', message: 'Khung thời gian tối đa 31 ngày.' });
  const paging = view === 'list' ? parsePaging(query, errors) : { page: 0, size: GANTT_LIMIT };
  return { errors, value: { view, status: query.status, agentId, berthId, from, to, page: paging.page, size: paging.size } };
}

module.exports = { validateSchedule, GANTT_LIMIT };
