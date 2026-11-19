'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, insertionIndex } = require('../../src/policy/queueOrder');

const e = (id, priority_class, day, queuedMinute = 0) => ({ id, priority_class, effective_eta: `2027-03-0${day}T00:00:00Z`, queued_at: `2027-02-01T00:0${queuedMinute}:00Z` });
const sorted = (list) => [...list].sort(compare).map((x) => x.id);

test('priority tier first: main line and reefer/hazard outrank standard whatever their ETA', () => {
  assert.deepEqual(sorted([e(1, 'STANDARD', 1), e(2, 'MAIN_LINE', 9), e(3, 'REEFER_OR_HAZARD', 8)]), [3, 2, 1]);
});

test('main line and reefer/hazard share one tier, so ETA decides between them (assumption Q-2)', () => {
  assert.deepEqual(sorted([e(1, 'MAIN_LINE', 5), e(2, 'REEFER_OR_HAZARD', 4)]), [2, 1]);
});

test('same tier: earlier effective ETA first; ties: earlier queue entry, then lower id', () => {
  assert.deepEqual(sorted([e(1, 'STANDARD', 3), e(2, 'STANDARD', 1)]), [2, 1]);
  assert.deepEqual(sorted([e(5, 'STANDARD', 2, 3), e(4, 'STANDARD', 2, 1)]), [4, 5]);
  assert.deepEqual(sorted([e(9, 'STANDARD', 2, 1), e(7, 'STANDARD', 2, 1)]), [7, 9]);
});

test('the order does not depend on the input order (deterministic), and unknown priority is treated as standard', () => {
  const list = [e(1, 'STANDARD', 2), e(2, 'MAIN_LINE', 3), e(3, 'STANDARD', 2, 1), e(4, 'WEIRD', 1), e(5, 'REEFER_OR_HAZARD', 3, 2)];
  const expected = sorted(list);
  assert.deepEqual(sorted([...list].reverse()), expected);
  assert.deepEqual(sorted([list[2], list[4], list[0], list[3], list[1]]), expected);
  assert.deepEqual(expected, [2, 5, 4, 1, 3]);
});

test('insertionIndex puts a new entry before the first entry it outranks, or at the end', () => {
  const queue = [e(1, 'MAIN_LINE', 2), e(2, 'STANDARD', 1), e(3, 'STANDARD', 4)];
  assert.equal(insertionIndex(queue, e(10, 'STANDARD', 2, 9)), 2, 'between the standard entries');
  assert.equal(insertionIndex(queue, e(11, 'MAIN_LINE', 1)), 0, 'ahead of everything');
  assert.equal(insertionIndex(queue, e(12, 'STANDARD', 9)), 3, 'at the end');
  assert.equal(insertionIndex([], e(13, 'STANDARD', 1)), 0, 'empty queue');
  // Same tier, ETA and entry time as entry 2: the lower id (2) stays ahead, and the candidate still precedes entry 3 (ETA day 4).
  assert.equal(insertionIndex(queue, e(14, 'STANDARD', 1, 0)), 2);
});
