'use strict';

// UC-021: voyage schedule as a list or as Gantt data. Read only; the route requires the M1 `view` action.

const schedule = require('../repositories/scheduleRepository');
const { validateSchedule } = require('../validation/scheduleValidation');
const { errors } = require('../errors');

async function get(db, query) {
  const { errors: bad, value } = validateSchedule(query);
  if (bad.length) throw errors.validation(bad);
  const { items, total } = await schedule.query(db, { ...value, offset: value.page * value.size, limit: value.size });
  // "Not shown as complete when it is not": a Gantt answer cut by the row limit says so.
  return { view: value.view, items, total, page: value.page, size: value.size, truncated: value.view === 'gantt' && total > items.length };
}

module.exports = { get };
