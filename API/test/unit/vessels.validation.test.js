'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateShip, validateDeactivate } = require('../../src/validation/shipValidation');
const { validateNotice, parseEta } = require('../../src/validation/voyageValidation');
const { parseId, parseIfMatch, parsePaging, parsePositiveDecimal } = require('../../src/validation/common');

const SHIP = { imo_number: '9074729', ship_name: '  MV Test  ', ship_type_id: 1, length_overall_m: 180.5, beam_m: 30, max_draft_m: 10.25, deadweight_t: 20000 };
const fields = (r) => r.errors.map((e) => e.field).sort();

test('ship create: a complete valid body passes and the name is trimmed', () => {
  const r = validateShip(SHIP, 'create');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.ship_name, 'MV Test');
  assert.equal(r.value.length_overall_m, 180.5);
});

test('ship create: every required field is reported when missing', () => {
  assert.deepEqual(fields(validateShip({}, 'create')),
    ['beam_m', 'deadweight_t', 'imo_number', 'length_overall_m', 'max_draft_m', 'ship_name', 'ship_type_id']);
});

test('ship create: IMO must be exactly seven digits (string)', () => {
  for (const imo of ['123456', '12345678', 'ABC1234', '12 4567', 1234567, null, '', "1234567'; DROP"]) {
    assert.deepEqual(fields(validateShip({ ...SHIP, imo_number: imo }, 'create')), ['imo_number'], String(imo));
  }
  assert.deepEqual(validateShip({ ...SHIP, imo_number: '0000000' }, 'create').errors, [], 'format only; no check-digit rule');
});

test('ship create: dimensions must be positive numbers with at most two decimals within column limits', () => {
  for (const bad of [0, -1, NaN, Infinity, '10', null, 100000000, 10.123]) {
    assert.deepEqual(fields(validateShip({ ...SHIP, beam_m: bad }, 'create')), ['beam_m'], String(bad));
  }
  assert.deepEqual(validateShip({ ...SHIP, beam_m: 0.01 }, 'create').errors, [], 'smallest positive value');
  assert.deepEqual(validateShip({ ...SHIP, beam_m: 99999999.99 }, 'create').errors, [], 'column maximum');
  assert.deepEqual(validateShip({ ...SHIP, deadweight_t: 9999999999.99 }, 'create').errors, []);
  assert.deepEqual(fields(validateShip({ ...SHIP, deadweight_t: 10000000000 }, 'create')), ['deadweight_t']);
});

test('ship create: name length boundaries and optional fields', () => {
  assert.deepEqual(validateShip({ ...SHIP, ship_name: 'a'.repeat(200) }, 'create').errors, []);
  assert.deepEqual(fields(validateShip({ ...SHIP, ship_name: 'a'.repeat(201) }, 'create')), ['ship_name']);
  assert.deepEqual(fields(validateShip({ ...SHIP, ship_name: '   ' }, 'create')), ['ship_name']);
  assert.deepEqual(validateShip({ ...SHIP, flag_state: null, operator_agent_id: null }, 'create').errors, []);
  assert.deepEqual(fields(validateShip({ ...SHIP, flag_state: 'x'.repeat(101) }, 'create')), ['flag_state']);
  assert.deepEqual(fields(validateShip({ ...SHIP, ship_type_id: null }, 'create')), ['ship_type_id']);
  assert.deepEqual(fields(validateShip({ ...SHIP, operator_agent_id: 0 }, 'create')), ['operator_agent_id']);
});

test('ship: unknown keys are rejected (no mass assignment of is_active, revision, id)', () => {
  const r = validateShip({ ...SHIP, is_active: false, revision: 9, id: 1, ship_code: 'X' }, 'create');
  assert.deepEqual(fields(r), ['id', 'is_active', 'revision', 'ship_code']);
});

test('ship: bodies that are not objects are refused', () => {
  for (const body of [null, undefined, 'x', 5, [], [SHIP]]) {
    assert.deepEqual(fields(validateShip(body, 'create')), ['body']);
  }
});

test('ship update: partial bodies pass, empty body is refused, reason is bounded', () => {
  assert.deepEqual(validateShip({ ship_name: 'New' }, 'update').errors, []);
  assert.deepEqual(fields(validateShip({}, 'update')), ['body']);
  assert.deepEqual(fields(validateShip({ reason: 'only a reason' }, 'update')), ['body']);
  assert.deepEqual(validateShip({ ship_name: 'New', reason: 'r'.repeat(500) }, 'update').errors, []);
  assert.deepEqual(fields(validateShip({ ship_name: 'New', reason: 'r'.repeat(501) }, 'update')), ['reason']);
  assert.deepEqual(fields(validateShip({ imo_number: '12' }, 'update')), ['imo_number']);
});

test('deactivate: a reason is required, trimmed and bounded', () => {
  assert.deepEqual(validateDeactivate({ reason: ' Hết khai thác ' }), { errors: [], reason: 'Hết khai thác' });
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, null, []]) {
    assert.ok(validateDeactivate(body).errors.length > 0, JSON.stringify(body));
  }
  assert.deepEqual(validateDeactivate({ reason: 'ok', extra: 1 }).errors.map((e) => e.field), ['extra']);
});

const NOTICE = { ship_id: 1, voyage_code: 'V-2026/01', agent_id: 2, origin_port_id: 3, declared_eta: '2026-12-01T08:00:00+07:00', declared_teu: 100, cargo_type: 'Container' };

test('notice: a valid body passes; optional fields default; ETA keeps the instant', () => {
  const r = validateNotice(NOTICE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.declared_eta.toISOString(), '2026-12-01T01:00:00.000Z');
  assert.equal(r.value.priority_class, undefined, 'the service applies the default');
});

test('notice: every required field is reported when missing', () => {
  assert.deepEqual(fields(validateNotice({})), ['agent_id', 'cargo_type', 'declared_eta', 'declared_teu', 'origin_port_id', 'ship_id', 'voyage_code']);
});

test('notice: ETA needs ISO 8601 with an offset and a real calendar date', () => {
  for (const eta of ['2026-12-01T08:00:00', '2026-12-01', '01/12/2026 08:00', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', 20261201, null, '2026-12-01T25:00:00Z', '2025-02-29T10:00:00Z', '2026-12-01T10:60:00Z', '2026-12-01T10:00:00+99:00', '2026-04-31T00:00:00Z']) {
    assert.equal(parseEta(eta), null, String(eta));
  }
  assert.ok(parseEta('2026-12-01T08:00Z'));
  assert.ok(parseEta('2026-12-01T08:00:00.123+07:00'));
  assert.ok(parseEta('2028-02-29T10:00:00Z'), 'a real leap day is accepted');
});

test('notice: TEU boundaries and types', () => {
  assert.deepEqual(validateNotice({ ...NOTICE, declared_teu: 0 }).errors, [], 'zero is allowed');
  assert.deepEqual(validateNotice({ ...NOTICE, declared_teu: 2147483647 }).errors, []);
  for (const teu of [-1, 1.5, '10', 2147483648, null, NaN]) assert.deepEqual(fields(validateNotice({ ...NOTICE, declared_teu: teu })), ['declared_teu'], String(teu));
});

test('notice: voyage code, cargo, service request and priority rules', () => {
  assert.deepEqual(validateNotice({ ...NOTICE, voyage_code: 'a'.repeat(50) }).errors, []);
  for (const code of ['', ' ', 'a'.repeat(51), 'bad code', "V';--", 'tàu-1']) assert.deepEqual(fields(validateNotice({ ...NOTICE, voyage_code: code })), ['voyage_code'], code);
  assert.deepEqual(fields(validateNotice({ ...NOTICE, cargo_type: ' ' })), ['cargo_type']);
  assert.deepEqual(validateNotice({ ...NOTICE, service_request: null }).errors, []);
  assert.deepEqual(fields(validateNotice({ ...NOTICE, service_request: 'x'.repeat(1001) })), ['service_request']);
  assert.deepEqual(validateNotice({ ...NOTICE, priority_class: 'MAIN_LINE' }).errors, []);
  assert.deepEqual(fields(validateNotice({ ...NOTICE, priority_class: 'URGENT' })), ['priority_class']);
});

test('notice: unknown keys and non-object bodies are refused (status, announced_at cannot be forged)', () => {
  assert.deepEqual(fields(validateNotice({ ...NOTICE, status: 'BERTHED', announced_at: 'x' })), ['announced_at', 'status']);
  for (const body of [null, 'x', [], 3]) assert.deepEqual(fields(validateNotice(body)), ['body']);
});

test('common helpers: ids, If-Match, paging, decimals', () => {
  assert.equal(parseId('12'), 12);
  assert.equal(parseId(12), 12);
  for (const bad of ['0', '-1', '1.5', 'abc', '12abc', '', null, undefined, '99999999999', 2147483648, 1.5, '1e3', ' 1']) assert.equal(parseId(bad), null, String(bad));
  assert.equal(parseIfMatch('"5"'), 5);
  assert.equal(parseIfMatch('5'), 5);
  assert.equal(parseIfMatch('W/"7"'), 7);
  for (const bad of ['', 'abc', '"-1"', undefined, null, '"1.5"']) assert.equal(parseIfMatch(bad), null, String(bad));
  const errs = [];
  assert.deepEqual(parsePaging({}, errs), { page: 0, size: 20 });
  assert.deepEqual(errs, []);
  assert.deepEqual(parsePaging({ page: '2', size: '100' }, errs), { page: 2, size: 100 });
  assert.deepEqual(errs, []);
  parsePaging({ page: '-1', size: '101' }, errs);
  assert.deepEqual(errs.map((e) => e.field).sort(), ['page', 'size']);
  const zero = [];
  parsePaging({ size: '0' }, zero);
  assert.deepEqual(zero.map((e) => e.field), ['size']);
  assert.equal(parsePositiveDecimal(0.1 + 0.2, 100), 0.3, 'floating point noise is normalized to two decimals');
  assert.equal(parsePositiveDecimal(0.125, 100), null, 'a real third decimal is refused');
  assert.equal(parsePositiveDecimal(1.1, 100), 1.1);
});
