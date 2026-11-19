'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffShip } = require('../../src/services/shipService');

const base = { imo_number: '9074729', ship_name: 'A', flag_state: 'VN', ship_type_name: 'Container', operator_agent_name: 'Agent 1',
  length_overall_m: 180, beam_m: 30, max_draft_m: 10, deadweight_t: 20000, is_active: true, revision: 1, updated_at: 'x' };

test('diffShip reports only the changed fields with old and new values', () => {
  const after = { ...base, ship_name: 'B', flag_state: null, revision: 2, updated_at: 'y' };
  assert.deepEqual(diffShip(JSON.stringify(base), JSON.stringify(after)), [
    { field: 'ship_name', old: 'A', new: 'B' },
    { field: 'flag_state', old: 'VN', new: null },
  ]);
});

test('diffShip uses readable names for reference fields and ignores revision and timestamps', () => {
  const after = { ...base, ship_type_name: 'Bulk', operator_agent_name: null, revision: 5, updated_at: 'z' };
  assert.deepEqual(diffShip(JSON.stringify(base), JSON.stringify(after)), [
    { field: 'ship_type', old: 'Container', new: 'Bulk' },
    { field: 'operator_agent', old: 'Agent 1', new: null },
  ]);
  assert.deepEqual(diffShip(JSON.stringify(base), JSON.stringify({ ...base, revision: 9, updated_at: 'q' })), []);
});

test('diffShip handles missing snapshots and unchanged data', () => {
  assert.deepEqual(diffShip(null, JSON.stringify(base)), []);
  assert.deepEqual(diffShip(JSON.stringify(base), null), []);
  assert.deepEqual(diffShip(JSON.stringify(base), JSON.stringify(base)), []);
  assert.deepEqual(diffShip(JSON.stringify(base), JSON.stringify({ ...base, is_active: false })), [{ field: 'is_active', old: true, new: false }]);
});
