'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSchedule, GANTT_LIMIT } = require('../../src/validation/scheduleValidation');

const fields = (r) => r.errors.map((e) => e.field).sort();

test('defaults: list view, first page of 20, no filters', () => {
  const r = validateSchedule({});
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.value, { view: 'list', status: undefined, agentId: null, berthId: null, from: null, to: null, page: 0, size: 20 });
});

test('a valid Gantt request keeps the window as Date objects and uses the row limit instead of paging', () => {
  const r = validateSchedule({ view: 'gantt', from: '2027-08-09T17:00:00.000Z', to: '2027-08-10T17:00:00Z', status: 'BERTHED', agent_id: '3', berth_id: '4' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.from.toISOString(), '2027-08-09T17:00:00.000Z');
  assert.deepEqual([r.value.agentId, r.value.berthId, r.value.size, r.value.status], [3, 4, GANTT_LIMIT, 'BERTHED']);
});

test('refuses unknown view or status, bad ids, and times without an offset', () => {
  assert.deepEqual(fields(validateSchedule({ view: 'cards' })), ['view']);
  assert.deepEqual(fields(validateSchedule({ status: 'DONE' })), ['status']);
  assert.deepEqual(fields(validateSchedule({ agent_id: '0', berth_id: 'x' })), ['agent_id', 'berth_id']);
  assert.deepEqual(fields(validateSchedule({ from: '2027-08-10', to: '2027-08-11' })), ['from', 'to']);
});

test('window rules: both bounds, start before end, at most 31 days, required for Gantt', () => {
  assert.deepEqual(fields(validateSchedule({ view: 'gantt' })), ['from']);
  assert.deepEqual(fields(validateSchedule({ from: '2027-08-10T00:00:00Z' })), ['to']);
  assert.deepEqual(fields(validateSchedule({ from: '2027-08-10T00:00:00Z', to: '2027-08-10T00:00:00Z' })), ['to']);
  assert.deepEqual(fields(validateSchedule({ from: '2027-08-10T00:00:00Z', to: '2027-09-10T00:00:01Z' })), ['to'], '31 days and 1 second');
  assert.deepEqual(validateSchedule({ from: '2027-08-10T00:00:00Z', to: '2027-09-10T00:00:00Z' }).errors, [], 'exactly 31 days is allowed');
  assert.deepEqual(fields(validateSchedule({ from: '2027-02-30T00:00:00Z', to: '2027-03-05T00:00:00Z' })), ['from'], 'impossible date');
});

test('paging limits apply to the list view only', () => {
  assert.deepEqual(fields(validateSchedule({ size: '0' })), ['size']);
  assert.deepEqual(fields(validateSchedule({ size: '101' })), ['size']);
  assert.deepEqual(fields(validateSchedule({ page: '-1' })), ['page']);
  assert.deepEqual(validateSchedule({ view: 'gantt', from: '2027-08-10T00:00:00Z', to: '2027-08-11T00:00:00Z', size: '0' }).errors, []);
});
