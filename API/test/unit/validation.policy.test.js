'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, parsePolicy, etaDateUtc7, PolicyError } = require('../../src/policy/validationPolicy');

const POLICY = JSON.stringify({ requiredDocuments: [{ type: 'REGISTRATION', scope: 'SHIP' }, { type: 'INSURANCE', scope: 'SHIP' }] });
const doc = (type, over = {}) => ({ id: 1, document_type_code: type, voyage_id: null, review_status: 'APPROVED', valid_from: null, valid_until: '2027-12-31', ...over });
const snap = (over = {}) => ({
  voyage: { id: 10, voyage_code: 'V1', declared_eta: '2026-12-01T01:00:00.000Z', declared_teu: 100, cargo_type: 'Container', origin_port_id: 1, agent_id: 2 },
  ship: { imo_number: '9074729', is_active: true },
  restrictions: [],
  documents: [doc('REGISTRATION'), doc('INSURANCE', { id: 2 })],
  ...over,
});
const run = (s = snap(), p = POLICY) => evaluate(p, s);
const codes = (r) => r.reasonCodes;

test('a complete notice with approved, valid required documents is VALID with no reason', () => {
  const r = run();
  assert.equal(r.outcome, 'VALID');
  assert.equal(r.reason, null);
  assert.deepEqual(r.reasonCodes, []);
  assert.deepEqual(r.rules.map((x) => [x.id, x.status]), [['R01', 'PASS'], ['R02', 'PASS'], ['R03', 'PASS'], ['R04', 'PASS'], ['R05', 'PASS'], ['R06', 'PASS']]);
});

test('R01 missing or invalid fields give MISSING_DOCUMENTS with the field names', () => {
  const r = run(snap({ voyage: { ...snap().voyage, cargo_type: '  ', declared_teu: -1, agent_id: null } }));
  assert.equal(r.outcome, 'MISSING_DOCUMENTS');
  assert.equal(r.reasonCode, 'MISSING_REQUIRED_FIELD');
  assert.match(r.reason, /agent_id/);
  assert.match(r.reason, /cargo_type/);
  assert.match(r.reason, /declared_teu/);
  assert.equal(run(snap({ voyage: { ...snap().voyage, declared_teu: 1.5 } })).outcome, 'MISSING_DOCUMENTS');
  assert.equal(run(snap({ voyage: { ...snap().voyage, declared_teu: 0 } })).outcome, 'VALID', 'zero TEU is allowed');
  assert.equal(run(snap({ voyage: { ...snap().voyage, declared_eta: 'garbage' } })).outcome, 'MISSING_DOCUMENTS');
});

test('R02 a wrong IMO gives MISSING_DOCUMENTS (spec 1a: thiếu/sai hồ sơ)', () => {
  for (const imo of ['123456', '12345678', 'ABC1234', '', null]) {
    const r = run(snap({ ship: { imo_number: imo, is_active: true } }));
    assert.equal(r.outcome, 'MISSING_DOCUMENTS', String(imo));
    assert.equal(r.reasonCode, 'INVALID_IMO');
  }
});

test('R03 an inactive vessel and R04 a prohibited or restricted vessel give REJECTED', () => {
  assert.deepEqual([run(snap({ ship: { imo_number: '9074729', is_active: false } })).outcome, run(snap({ ship: { imo_number: '9074729', is_active: false } })).reasonCode], ['REJECTED', 'VESSEL_INACTIVE']);
  const prohibited = run(snap({ restrictions: [{ restriction_type: 'PROHIBITED', reason: 'Lệnh cấm', valid_from: '2026-01-01', valid_until: null }] }));
  assert.deepEqual([prohibited.outcome, prohibited.reasonCode], ['REJECTED', 'VESSEL_PROHIBITED']);
  assert.match(prohibited.reason, /Lệnh cấm/);
  const restricted = run(snap({ restrictions: [{ restriction_type: 'RESTRICTED', reason: 'Hạn chế tải', valid_from: '2026-01-01', valid_until: '2026-12-31' }] }));
  assert.deepEqual([restricted.outcome, restricted.reasonCode], ['REJECTED', 'VESSEL_RESTRICTED']);
});

test('restriction windows are checked against the ETA date: boundaries inclusive, outside ignored', () => {
  const at = (from, until) => run(snap({ restrictions: [{ restriction_type: 'PROHIBITED', reason: 'x', valid_from: from, valid_until: until }] })).outcome;
  // declared ETA 2026-12-01T01:00Z is 2026-12-01 08:00 in UTC+7
  assert.equal(at('2026-12-01', '2026-12-01'), 'REJECTED', 'single day window containing the ETA date');
  assert.equal(at('2026-12-02', null), 'VALID', 'starts the day after');
  assert.equal(at('2026-01-01', '2026-11-30'), 'VALID', 'ended the day before');
  assert.equal(at('2026-12-01', null), 'REJECTED', 'starts on the ETA date');
});

test('the ETA date is the calendar date in UTC+7, not in UTC', () => {
  assert.equal(etaDateUtc7('2026-12-01T20:00:00Z'), '2026-12-02');
  assert.equal(etaDateUtc7('2026-12-01T16:59:59Z'), '2026-12-01');
  assert.equal(etaDateUtc7('2026-12-01T17:00:00Z'), '2026-12-02');
  for (const none of [null, undefined, '', 'garbage']) assert.equal(etaDateUtc7(none), null, String(none)); // regression: null used to give 1970-01-01
  const late = snap({ voyage: { ...snap().voyage, declared_eta: '2026-12-01T20:00:00Z' }, documents: [doc('REGISTRATION', { valid_until: '2026-12-01' }), doc('INSURANCE', { id: 2 })] });
  assert.equal(run(late).reasonCode, 'DOCUMENT_EXPIRED', 'expired on the UTC+7 ETA date 2026-12-02');
});

test('R05 missing, pending or rejected required documents give MISSING_DOCUMENTS', () => {
  const none = run(snap({ documents: [] }));
  assert.deepEqual([none.outcome, none.reasonCode], ['MISSING_DOCUMENTS', 'DOCUMENT_MISSING']);
  assert.match(none.reason, /INSURANCE\/SHIP/);
  assert.match(none.reason, /REGISTRATION\/SHIP/);
  for (const status of ['PENDING', 'REJECTED', 'weird']) {
    const r = run(snap({ documents: [doc('REGISTRATION', { review_status: status }), doc('INSURANCE', { id: 2 })] }));
    assert.deepEqual([r.outcome, r.reasonCode], ['MISSING_DOCUMENTS', 'DOCUMENT_NOT_APPROVED'], status);
  }
});

test('R06 expired or not-yet-valid approved documents give REJECTED, with inclusive date boundaries', () => {
  const withReg = (over) => run(snap({ documents: [doc('REGISTRATION', over), doc('INSURANCE', { id: 2 })] }));
  assert.equal(withReg({ valid_until: '2026-12-01' }).outcome, 'VALID', 'valid on its last day');
  assert.deepEqual([withReg({ valid_until: '2026-11-30' }).outcome, withReg({ valid_until: '2026-11-30' }).reasonCode], ['REJECTED', 'DOCUMENT_EXPIRED']);
  assert.equal(withReg({ valid_from: '2026-12-01' }).outcome, 'VALID', 'valid from the ETA date');
  assert.deepEqual([withReg({ valid_from: '2026-12-02' }).outcome, withReg({ valid_from: '2026-12-02' }).reasonCode], ['REJECTED', 'DOCUMENT_NOT_YET_VALID']);
  assert.equal(withReg({ valid_from: null, valid_until: null }).outcome, 'VALID', 'approved without dates is accepted (assumption A-4)');
});

test('precedence: REJECTED wins over MISSING_DOCUMENTS and only the deciding failures are listed', () => {
  const r = run(snap({
    restrictions: [{ restriction_type: 'PROHIBITED', reason: 'x', valid_from: '2026-01-01', valid_until: null }],
    documents: [], voyage: { ...snap().voyage, cargo_type: '' },
  }));
  assert.equal(r.outcome, 'REJECTED');
  assert.deepEqual(r.reasonCodes, ['VESSEL_PROHIBITED']);
  assert.ok(!r.reason.includes('Thiếu'), 'missing-document reasons are not mixed into a rejection');
  assert.equal(r.rules.find((x) => x.id === 'R05').status, 'FAIL', 'but every rule result is still recorded');
  const mixed = run(snap({ documents: [doc('REGISTRATION', { valid_until: '2020-01-01' })] }));
  assert.equal(mixed.outcome, 'REJECTED', 'one expired and one missing document: rejected');
  assert.deepEqual(mixed.reasonCodes, ['DOCUMENT_EXPIRED']);
});

test('voyage-specific documents: scope SHIP accepts a standing or this-voyage document; scope VOYAGE needs this voyage; other voyages never count', () => {
  const voyagePolicy = JSON.stringify({ requiredDocuments: [{ type: 'CARGO_MANIFEST', scope: 'VOYAGE' }] });
  assert.equal(run(snap({ documents: [doc('CARGO_MANIFEST', { voyage_id: 10 })] }), voyagePolicy).outcome, 'VALID');
  assert.equal(run(snap({ documents: [doc('CARGO_MANIFEST', { voyage_id: null })] }), voyagePolicy).reasonCode, 'DOCUMENT_MISSING', 'a ship-level document does not satisfy a voyage requirement');
  assert.equal(run(snap({ documents: [doc('CARGO_MANIFEST', { voyage_id: 99 })] }), voyagePolicy).reasonCode, 'DOCUMENT_MISSING', 'another voyage');
  const shipDocs = (regVoyage) => snap({ documents: [doc('REGISTRATION', { voyage_id: regVoyage }), doc('INSURANCE', { id: 2 })] });
  assert.equal(run(shipDocs(null)).outcome, 'VALID');
  assert.equal(run(shipDocs(10)).outcome, 'VALID', 'a document attached to this voyage satisfies a ship requirement');
  assert.equal(run(shipDocs(99)).reasonCode, 'DOCUMENT_MISSING', 'a document of another voyage does not');
});

test('determinism: equal inputs give identical results regardless of array order, and repeat runs are identical', () => {
  const s = snap({
    documents: [doc('INSURANCE', { id: 2, valid_until: '2020-01-01' }), doc('REGISTRATION'), doc('REGISTRATION', { id: 3, review_status: 'PENDING' })],
    restrictions: [{ restriction_type: 'RESTRICTED', reason: 'b', valid_from: '2026-01-01', valid_until: null }, { restriction_type: 'PROHIBITED', reason: 'a', valid_from: '2026-01-01', valid_until: null }],
  });
  const a = JSON.stringify(run(s));
  const reversed = { ...s, documents: [...s.documents].reverse(), restrictions: [...s.restrictions].reverse() };
  assert.equal(JSON.stringify(run(reversed)), a);
  assert.equal(JSON.stringify(run(s)), a);
  const reorderedPolicy = JSON.stringify({ requiredDocuments: [{ type: 'INSURANCE', scope: 'SHIP' }, { type: 'REGISTRATION', scope: 'SHIP' }] });
  assert.equal(JSON.stringify(run(s, reorderedPolicy)), a, 'the order of entries in the policy does not matter');
});

test('policy version change: a different required-document set changes the decision for the same snapshot', () => {
  const s = snap({ documents: [doc('REGISTRATION')] });
  assert.equal(run(s, JSON.stringify({ requiredDocuments: [{ type: 'REGISTRATION', scope: 'SHIP' }] })).outcome, 'VALID');
  assert.equal(run(s, POLICY).outcome, 'MISSING_DOCUMENTS');
  assert.equal(run(s, JSON.stringify({ requiredDocuments: [] })).outcome, 'VALID', 'a policy requiring nothing accepts a complete notice');
});

test('parsePolicy fails closed on unusable configuration', () => {
  for (const bad of ['not json', '{}', '{"requiredDocuments":"x"}', '{"requiredDocuments":[{"type":"reg","scope":"SHIP"}]}',
    '{"requiredDocuments":[{"type":"REGISTRATION","scope":"PORT"}]}', '{"requiredDocuments":[{"type":"A","scope":"SHIP"},{"type":"A","scope":"SHIP"}]}', 'null', '[]']) {
    assert.throws(() => parsePolicy(bad), PolicyError, bad);
  }
  assert.deepEqual(parsePolicy('{"requiredDocuments":[]}'), { requiredDocuments: [] });
});

test('R05 and R06 are evaluated only when the ETA date is known', () => {
  const r = run(snap({ voyage: { ...snap().voyage, declared_eta: null }, documents: [] }));
  assert.equal(r.outcome, 'MISSING_DOCUMENTS');
  assert.deepEqual(codes(r), ['MISSING_REQUIRED_FIELD']);
});
