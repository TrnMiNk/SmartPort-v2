'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, RULES_VERSION } = require('../../src/policy/placementRules');
const { deriveState } = require('../../src/policy/berthState');
const { validateBerth, validatePlacement } = require('../../src/validation/berthValidation');

const T = (h) => new Date(Date.UTC(2027, 0, 1, h)).toISOString();
const base = () => ({
  ship: { loa: 250, draft: 10, cargo_class: 'CONTAINER' },
  berth: { length_m: 300, max_depth_m: 12, berth_type: 'CONTAINER', available_cranes: 3, allows_dangerous: false, operational_status: 'IN_SERVICE' },
  placement: { position_start_m: 0, position_end_m: 260, planned_start: T(8), planned_end: T(20), required_cranes: 2 },
  buffer_m: 15, neighbors: [], maintenance: [], cargo_hazard: 'NONE',
});
const by = (r, id) => r.rules.find((x) => x.id === id);
const only = (r) => r.rules.filter((x) => x.outcome !== 'PASS').map((x) => `${x.id}:${x.outcome}`);

test('a fitting placement passes every rule and carries the flag that the plan constraint reads', () => {
  const r = evaluate(base());
  assert.deepEqual([r.outcome, r.passed, r.rules_version, r.buffer_m], ['PASS', true, RULES_VERSION, 15]);
  assert.equal(RULES_VERSION, 'UC026-RULES-V2');
  assert.deepEqual(r.rules.map((x) => x.id), ['BERTH_IN_SERVICE', 'LOA_FIT', 'DRAFT_FIT', 'BERTH_TYPE', 'CRANES', 'OVERLAP', 'SAFETY_BUFFER', 'DANGEROUS_GOODS', 'MAINTENANCE']);
  assert.equal(r.overridable, false, 'a passing check has nothing to override');
});

test('LOA: equal to the stretch passes, 1 cm more fails; the stretch must lie inside the berth', () => {
  const f = base(); f.ship.loa = 260; assert.equal(evaluate(f).outcome, 'PASS');
  f.ship.loa = 260.01; assert.deepEqual(only(evaluate(f)), ['LOA_FIT:VIOLATION']);
  const g = base(); g.placement.position_start_m = 100; g.placement.position_end_m = 350; g.ship.loa = 250;
  const r = evaluate(g);
  assert.equal(by(r, 'LOA_FIT').outcome, 'VIOLATION');
  assert.match(by(r, 'LOA_FIT').reason, /vượt chiều dài bến/);
  const h = base(); h.placement.position_end_m = 300; h.ship.loa = 300; assert.equal(evaluate(h).outcome, 'PASS', 'exactly the berth length');
});

test('draft, berth type and cranes', () => {
  const f = base(); f.ship.draft = 12; assert.equal(evaluate(f).outcome, 'PASS', 'draft equal to depth');
  f.ship.draft = 12.01; assert.deepEqual(only(evaluate(f)), ['DRAFT_FIT:VIOLATION']);
  const g = base(); g.ship.cargo_class = 'BULK'; assert.deepEqual(only(evaluate(g)), ['BERTH_TYPE:VIOLATION']);
  const h = base(); h.placement.required_cranes = 3; assert.equal(evaluate(h).outcome, 'PASS');
  h.placement.required_cranes = 4; assert.match(by(evaluate(h), 'CRANES').reason, /Cần 4 cẩu/);
});

test('BR-01 overlap and BR-02 buffer: a gap equal to the buffer passes, 1 cm less fails; time must be shared', () => {
  const n = (s, e, h0 = 8, h1 = 20) => ({ plan_id: 9, voyage_code: 'NB-1', position_start_m: s, position_end_m: e, planned_start: T(h0), planned_end: T(h1) });
  const f = base(); f.neighbors = [n(275, 300)]; // gap 15 after 260
  assert.equal(evaluate(f).outcome, 'PASS');
  f.neighbors = [n(274.99, 300)]; assert.deepEqual(only(evaluate(f)), ['SAFETY_BUFFER:VIOLATION']);
  f.neighbors = [n(250, 300)]; assert.deepEqual(only(evaluate(f)), ['OVERLAP:VIOLATION']);
  f.neighbors = [n(260, 300)]; assert.deepEqual(only(evaluate(f)), ['SAFETY_BUFFER:VIOLATION'], 'touching stretches are not an overlap but are too close');
  const before = base(); before.placement.position_start_m = 40; before.placement.position_end_m = 300; before.ship.loa = 250;
  before.neighbors = [n(0, 25)]; assert.equal(evaluate(before).outcome, 'PASS', 'gap 15 on the other side');
  const sep = base(); sep.neighbors = [n(250, 300, 20, 22)]; assert.equal(evaluate(sep).outcome, 'PASS', 'a plan that starts when this one ends shares no time');
  const buf = base(); buf.buffer_m = 30; buf.neighbors = [n(280, 300)]; assert.deepEqual(only(evaluate(buf)), ['SAFETY_BUFFER:VIOLATION'], 'the buffer comes from the input');
});

test('BR-03: the fact comes from the verified cargo hazard only; unknown is missing data, never a pass; a berth with the label needs no fact', () => {
  const f = base(); f.cargo_hazard = 'DANGEROUS'; assert.deepEqual(only(evaluate(f)), ['DANGEROUS_GOODS:VIOLATION']);
  f.berth.allows_dangerous = true; assert.equal(evaluate(f).outcome, 'PASS');
  f.cargo_hazard = null; assert.equal(evaluate(f).outcome, 'PASS', 'the berth takes both kinds of cargo');
  const g = base(); g.cargo_hazard = null;
  const r = evaluate(g);
  assert.deepEqual([r.outcome, r.passed, only(r)], ['MISSING_DATA', false, ['DANGEROUS_GOODS:MISSING_DATA']]);
  g.cargo_hazard = undefined; assert.equal(evaluate(g).outcome, 'MISSING_DATA');
  const h = base(); h.dangerous = false; h.priority_class = 'REEFER_OR_HAZARD'; h.cargo_hazard = null;
  assert.equal(evaluate(h).outcome, 'MISSING_DATA', 'neither a request flag nor the priority class is evidence');
});

test('an out-of-service berth is a violation that cannot be overridden; other violations can', () => {
  const f = base(); f.berth.operational_status = 'OUT_OF_SERVICE';
  const r = evaluate(f);
  assert.deepEqual([only(r), r.overridable, by(r, 'BERTH_IN_SERVICE').overridable], [['BERTH_IN_SERVICE:VIOLATION'], false, false]);
  const g = base(); g.ship.draft = 99;
  assert.deepEqual([evaluate(g).outcome, evaluate(g).overridable], ['VIOLATION', true]);
  g.berth.operational_status = 'OUT_OF_SERVICE'; assert.equal(evaluate(g).overridable, false, 'one hard violation makes the whole result not overridable');
});

test('maintenance: touching intervals do not block', () => {
  const m = (a, b) => ({ id: 1, starts_at: T(a), ends_at: T(b), reason: 'x' });
  const g = base(); g.maintenance = [m(19, 22)]; assert.deepEqual(only(evaluate(g)), ['MAINTENANCE:VIOLATION']);
  g.maintenance = [m(20, 22)]; assert.equal(evaluate(g).outcome, 'PASS', 'starts exactly when the plan ends');
  g.maintenance = [m(6, 8)]; assert.equal(evaluate(g).outcome, 'PASS', 'ends exactly when the plan starts');
});

test('missing data: no result is a pass; missing data wins over a violation, so a stored VIOLATION means every rule was evaluated', () => {
  const f = base(); f.ship.loa = null; f.placement.required_cranes = null;
  const r = evaluate(f);
  assert.deepEqual([r.outcome, r.passed], ['MISSING_DATA', false]);
  assert.deepEqual(only(r), ['LOA_FIT:MISSING_DATA', 'CRANES:MISSING_DATA']);
  f.ship.draft = 99; const both = evaluate(f);
  assert.deepEqual([both.outcome, both.overridable, by(both, 'DRAFT_FIT').outcome], ['MISSING_DATA', false, 'VIOLATION']);
});

test('determinism: the same facts give the same result, whatever the neighbor order', () => {
  const f = base();
  f.neighbors = [{ voyage_code: 'A', position_start_m: 250, position_end_m: 300, planned_start: T(9), planned_end: T(10) }, { voyage_code: 'B', position_start_m: 262, position_end_m: 290, planned_start: T(9), planned_end: T(10) }];
  const g = { ...f, neighbors: [...f.neighbors].reverse() };
  assert.deepEqual(evaluate(f).rules.map((x) => x.id + x.outcome), evaluate(g).rules.map((x) => x.id + x.outcome));
  assert.deepEqual(evaluate(f), evaluate(structuredClone(f)));
});

test('berth state: precedence and the four documented states plus out of service', () => {
  const plan = (s) => ({ voyage_status: s });
  assert.equal(deriveState({}), 'AVAILABLE');
  assert.equal(deriveState({ nextPlan: {} }), 'RESERVED');
  assert.equal(deriveState({ currentPlan: plan('WAITING_BERTH') }), 'RESERVED', 'the plan holds the berth but the vessel has not berthed');
  assert.equal(deriveState({ currentPlan: plan('BERTHED') }), 'IN_USE');
  assert.equal(deriveState({ currentPlan: plan('BERTHED'), maintenance: { id: 1 } }), 'MAINTENANCE');
  assert.equal(deriveState({ currentPlan: plan('BERTHED'), maintenance: { id: 1 }, operationalStatus: 'OUT_OF_SERVICE' }), 'OUT_OF_SERVICE');
  assert.equal(deriveState({ operationalStatus: 'IN_SERVICE' }), 'AVAILABLE');
});

const good = { berth_code: 'B1', berth_type: 'CONTAINER', length_m: 300, max_depth_m: 12, available_cranes: 2, allows_dangerous: false };
const fields = (r) => r.errors.map((e) => e.field).sort();

test('validateBerth create: required fields, name defaults to the code, coordinates are both or none', () => {
  const ok = validateBerth(good, 'create');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.berth_name, 'B1');
  assert.deepEqual(fields(validateBerth({}, 'create')), ['allows_dangerous', 'available_cranes', 'berth_code', 'berth_type', 'length_m', 'max_depth_m']);
  assert.deepEqual(fields(validateBerth({ ...good, length_m: 0, max_depth_m: -1 }, 'create')), ['length_m', 'max_depth_m']);
  assert.deepEqual(fields(validateBerth({ ...good, berth_code: 'B 1' }, 'create')), ['berth_code']);
  assert.deepEqual(fields(validateBerth({ ...good, berth_type: 'RORO' }, 'create')), ['berth_type']);
  assert.deepEqual(fields(validateBerth({ ...good, available_cranes: 1.5 }, 'create')), ['available_cranes']);
  assert.deepEqual(fields(validateBerth({ ...good, longitude: 106 }, 'create')), ['latitude']);
  assert.deepEqual(fields(validateBerth({ ...good, longitude: 200, latitude: 10 }, 'create')), ['longitude']);
  assert.deepEqual(validateBerth({ ...good, longitude: 106.7, latitude: 10.77 }, 'create').errors, []);
  assert.deepEqual(fields(validateBerth({ ...good, operational_status: 'IN_SERVICE' }, 'create')), ['operational_status'], 'not settable on create');
});

test('validateBerth update: subset, operational status, confirmation flag, reason, empty body', () => {
  const r = validateBerth({ length_m: 310, confirm_affected_plans: true, reason: ' mở rộng ' }, 'update');
  assert.deepEqual([r.errors, r.value, r.confirm, r.reason], [[], { length_m: 310 }, true, 'mở rộng']);
  assert.deepEqual(fields(validateBerth({}, 'update')), ['body']);
  assert.deepEqual(fields(validateBerth({ operational_status: 'BROKEN' }, 'update')), ['operational_status']);
  assert.deepEqual(validateBerth({ longitude: null, latitude: null }, 'update').value, { longitude: null, latitude: null });
  assert.deepEqual(fields(validateBerth({ longitude: null, latitude: 5 }, 'update')), ['latitude']);
});

test('validatePlacement: ids, positions, times and optional fields', () => {
  const ok = { voyage_id: 1, berth_id: 2, position_start_m: 0, position_end_m: 260, planned_start: '2027-01-01T08:00:00Z', planned_end: '2027-01-01T20:00:00Z' };
  assert.deepEqual(validatePlacement(ok).errors, []);
  assert.deepEqual(fields(validatePlacement({ ...ok, position_end_m: 0 })), ['position_end_m']);
  assert.deepEqual(fields(validatePlacement({ ...ok, planned_end: '2027-01-01T08:00:00Z' })), ['planned_end']);
  assert.deepEqual(fields(validatePlacement({ ...ok, planned_start: '2027-01-01' })), ['planned_start']);
  assert.deepEqual(fields(validatePlacement({ ...ok, required_cranes: -1 })), ['required_cranes']);
  assert.deepEqual(fields(validatePlacement({ ...ok, dangerous_goods: false })), ['dangerous_goods'], 'a client value for hazard is not accepted at all');
  assert.deepEqual(fields(validatePlacement({})), ['berth_id', 'planned_end', 'planned_start', 'position_end_m', 'position_start_m', 'voyage_id']);
  assert.deepEqual(fields(validatePlacement({ ...ok, extra: 1 })), ['extra']);
});
