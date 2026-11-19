'use strict';

// UC-022 / UC-023 request validation: time defaults, future, edited-time tolerance, reason, unknown fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMovement } = require('../../src/validation/movementValidation');

const now = new Date('2031-05-01T10:00:00Z');
const v = (body, needsBerth = true) => validateMovement(body, { needsBerth, now });
const fields = (r) => r.errors.map((e) => e.field).sort();

test('berthing needs a berth id; the time defaults to now and is not an edit', () => {
  assert.deepEqual(fields(v({})), ['berth_id']);
  const ok = v({ berth_id: 3 });
  assert.deepEqual([ok.errors.length, ok.berthId, ok.at.getTime(), ok.edited], [0, 3, now.getTime(), false]);
});

test('departure takes no berth id and refuses unknown fields', () => {
  assert.equal(v({}, false).errors.length, 0);
  assert.deepEqual(fields(v({ berth_id: 3 }, false)), ['berth_id']);
  assert.deepEqual(fields(v({ extra: 1 }, false)), ['extra']);
});

test('time: within 5 minutes of now is not an edit; beyond that needs a reason; the future is refused; bad format is refused', () => {
  assert.equal(v({ berth_id: 1, actual_time: '2031-05-01T09:56:00Z' }).edited, false);
  assert.deepEqual(fields(v({ berth_id: 1, actual_time: '2031-05-01T09:00:00Z' })), ['reason']);
  const ok = v({ berth_id: 1, actual_time: '2031-05-01T09:00:00Z', reason: ' bổ sung ' });
  assert.deepEqual([ok.errors.length, ok.edited, ok.reason], [0, true, 'bổ sung']);
  assert.deepEqual(fields(v({ berth_id: 1, actual_time: '2031-05-01T11:00:00Z', reason: 'x' })), ['actual_time']);
  assert.equal(v({ berth_id: 1, actual_time: '2031-05-01T10:00:30Z' }).errors.length, 0, 'a minute of clock skew is tolerated');
  for (const t of ['yesterday', '2031-05-01', '2031-05-01T09:00:00', 20310501, '']) assert.deepEqual(fields(v({ berth_id: 1, actual_time: t })), ['actual_time'], String(t));
});

test('reason: 1 to 500 characters when given; a body that is not an object is refused', () => {
  assert.deepEqual(fields(v({ berth_id: 1, reason: '   ' })), ['reason']);
  assert.deepEqual(fields(v({ berth_id: 1, reason: 'x'.repeat(501) })), ['reason']);
  assert.equal(v({ berth_id: 1, reason: 'x'.repeat(500) }).errors.length, 0);
  for (const body of [null, [], 'x', undefined]) assert.deepEqual(fields(v(body)), ['body']);
});
