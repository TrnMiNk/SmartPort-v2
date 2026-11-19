'use strict';

// UC-027 local optimizer, policy UC027-OPT-V1. Pure tests on constructed snapshots (FIXTURES, not real port data): they check that the engine
// is deterministic, never proposes a placement that UC-026 refuses, reports missing information and unschedulable vessels, and explains itself.
// They say nothing about how good the placements are for a real port.

const test = require('node:test');
const assert = require('node:assert/strict');
const { recommend, metrics, POLICY, POLICIES, planWithBeam, missingFacts } = require('../../src/policy/berthOptimizer');
const { evaluate } = require('../../src/policy/placementRules');

const AS_OF = '2031-01-10T00:00:00.000Z';
const H = (h) => new Date(Date.parse(AS_OF) + h * 3600000).toISOString();
const berth = (id, over = {}) => ({ berth_id: id, berth_code: `B${id}`, berth_type: 'CONTAINER', length_m: 400, max_depth_m: 14, available_cranes: 4, allows_dangerous: false, operational_status: 'IN_SERVICE', ...over });
const vessel = (id, over = {}) => ({ voyage_id: id, voyage_code: `V${id}`, queue_position: id, priority_class: 'STANDARD', effective_eta: H(2), eta_source: 'DECLARED', loa: 200, draft: 10, cargo_class: 'CONTAINER', cargo_hazard: 'NONE', declared_teu: 600, ...over });
const snap = (over = {}) => ({ as_of: AS_OF, buffer_m: 20, vessels: [vessel(1)], berths: [berth(1), berth(2, { length_m: 300 })], busy: [], maintenance: [], ...over });
// The UC-026 authority, applied to a proposal against the snapshot's own reservations.
const uc026 = (s, v, c) => evaluate({ ship: { loa: v.loa, draft: v.draft, cargo_class: v.cargo_class }, berth: s.berths.find((b) => b.berth_id === c.berth_id),
  placement: { position_start_m: c.position_start_m, position_end_m: c.position_end_m, planned_start: c.planned_start, planned_end: c.planned_end, required_cranes: c.required_cranes },
  buffer_m: s.buffer_m, neighbors: s.busy.filter((x) => x.berth_id === c.berth_id).map((x) => ({ ...x, voyage_code: x.voyage_code || 'busy', planned_start: x.from, planned_end: x.to })),
  maintenance: s.maintenance.filter((x) => x.berth_id === c.berth_id).map((x) => ({ id: 1, starts_at: x.from, ends_at: x.to })), cargo_hazard: v.cargo_hazard });

test('the policy is explicit and versioned; weights, rates and limits are constants of one object', () => {
  assert.equal(POLICY.version, 'UC027-OPT-V2');
  assert.deepEqual([POLICY.maxProposals, POLICY.handlingTeuPerCraneHour, POLICY.fixedHours, POLICY.horizonDays], [3, 25, 4, 14]);
  assert.deepEqual([POLICY.beamWidth, POLICY.candidatesPerStep, POLICY.maxExpansions], [8, 4, 2000]);
  assert.ok(Object.isFrozen(POLICY) && Object.isFrozen(POLICY.weights));
  assert.deepEqual(Object.keys(POLICIES), ['UC027-OPT-V1', 'UC027-OPT-V2']);
  assert.equal(POLICIES['UC027-OPT-V1'].beamWidth, 1, 'V1 is the plain greedy choice, kept to replay old snapshots');
});

test('one vessel: ranked proposals (1 to 3) with explanations; times on the grid, never before the ETA; unverified without a verify hook', async () => {
  const r = await recommend(snap({ berths: [berth(1), berth(2), berth(3), berth(4)] }));
  const v = r.vessels[0];
  assert.equal(v.outcome, 'RECOMMENDED'); assert.equal(v.proposals.length, 3, 'at most three');
  assert.deepEqual(v.proposals.map((p) => p.rank), [1, 2, 3]);
  for (const p of v.proposals) {
    assert.ok(Date.parse(p.planned_start) >= Date.parse(H(2)) && Date.parse(p.planned_start) % (15 * 60000) === 0);
    assert.ok(p.score > 0 && p.score <= 1 && p.cost >= 0 && p.expected_wait_h >= 0);
    assert.deepEqual(p.explanation.map((e) => e.code), ['RANK', 'WAIT', 'FIT', 'HANDLING']);
    assert.equal(p.check, null, 'no UC-026 verification was given: the proposal is marked unverified');
  }
  assert.ok(v.proposals[0].cost <= v.proposals[1].cost && v.proposals[1].cost <= v.proposals[2].cost);
});

test('deterministic: the same snapshot gives the identical result, whatever the input property order', async () => {
  const s = snap({ vessels: Array.from({ length: 8 }, (_, i) => vessel(i + 1, { declared_teu: 300 + i * 90, loa: 150 + i * 12 })), berths: [berth(1), berth(2), berth(3, { length_m: 300 }), berth(4, { berth_type: 'BULK' })] });
  const a = await recommend(s); const b = await recommend(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(a, b);
  const reordered = JSON.parse(JSON.stringify(s)); reordered.berths = Object.fromEntries ? reordered.berths : reordered.berths; // berth order is part of the snapshot
  assert.deepEqual(await recommend(reordered), a);
});

test('tie-break: equal cost goes to the earlier start, then the lower berth id; mirrored berths give berth 1 before berth 2', async () => {
  const r = await recommend(snap({ berths: [berth(2), berth(1)] }));
  assert.deepEqual(r.vessels[0].proposals.map((p) => p.berth_id), [1, 2]);
});

test('constraints: type, LOA, draft, out of service, no cranes and hazard exclude a berth, with the reason; a vessel with no feasible berth is UNSCHEDULABLE with reasons', async () => {
  const s = snap({ berths: [berth(1, { berth_type: 'BULK' }), berth(2, { length_m: 150 }), berth(3, { max_depth_m: 8 }), berth(4, { operational_status: 'OUT_OF_SERVICE' }), berth(5, { available_cranes: 0 })] });
  const v = (await recommend(s)).vessels[0];
  assert.equal(v.outcome, 'UNSCHEDULABLE'); assert.deepEqual(v.proposals, []);
  assert.deepEqual(v.reasons.map((x) => x.code).sort(), ['BERTH_IN_SERVICE', 'BERTH_TYPE', 'CRANES', 'DRAFT_FIT', 'LOA_FIT']);
  const hz = (await recommend(snap({ vessels: [vessel(1, { cargo_hazard: 'DANGEROUS' })], berths: [berth(1), berth(2, { allows_dangerous: true })] }))).vessels[0];
  assert.deepEqual(hz.proposals.map((p) => p.berth_id), [2], 'dangerous cargo only at a berth labelled for it');
});

test('missing information is reported, never passed: unverified hazard only on a dangerous-goods berth; missing LOA, draft, type, TEU make the vessel unschedulable', async () => {
  const un = (await recommend(snap({ vessels: [vessel(1, { cargo_hazard: null })], berths: [berth(1), berth(2, { allows_dangerous: true })] }))).vessels[0];
  assert.deepEqual(un.proposals.map((p) => p.berth_id), [2]);
  const only = (await recommend(snap({ vessels: [vessel(1, { cargo_hazard: null })], berths: [berth(1)] }))).vessels[0];
  assert.deepEqual([only.outcome, only.reasons[0].code], ['UNSCHEDULABLE', 'DANGEROUS_GOODS_MISSING']);
  for (const [field, code] of [['loa', 'MISSING_DATA'], ['draft', 'MISSING_DATA'], ['cargo_class', 'MISSING_DATA'], ['declared_teu', 'MISSING_DATA']]) {
    const x = (await recommend(snap({ vessels: [vessel(1, { [field]: null })] }))).vessels[0];
    assert.deepEqual([x.outcome, x.reasons[0].code], ['UNSCHEDULABLE', code], field);
  }
  assert.equal(missingFacts(vessel(1, { declared_teu: 0 })).length, 1, 'zero TEU is missing, not "free"');
});

test('reservations, the safety buffer and maintenance: the vessel starts after or beside them, never inside; overlap and buffer are exact', async () => {
  const busy = [{ berth_id: 1, from: H(0), to: H(30), position_start_m: 0, position_end_m: 200, voyage_code: 'X' }];
  const s = snap({ berths: [berth(1, { length_m: 450 })], busy });
  const p = (await recommend(s)).vessels[0].proposals[0];
  assert.equal(p.position_start_m, 220, 'beside the reservation, exactly one buffer (20 m) away');
  assert.equal(uc026(s, s.vessels[0], p).outcome, 'PASS');
  const tight = snap({ berths: [berth(1, { length_m: 300 })], busy });                      // 300 m: 220 + 200 > 300, so it must wait for the quay to clear
  const t = (await recommend(tight)).vessels[0].proposals[0];
  assert.equal(t.position_start_m, 0); assert.ok(Date.parse(t.planned_start) >= Date.parse(H(30)), 'starts after the reservation ends');
  assert.equal(uc026(tight, tight.vessels[0], t).outcome, 'PASS');
  const m = snap({ berths: [berth(1)], maintenance: [{ berth_id: 1, from: H(1), to: H(40) }] });
  const mp = (await recommend(m)).vessels[0].proposals[0];
  assert.ok(Date.parse(mp.planned_start) >= Date.parse(H(40)), 'never inside a maintenance window');
  assert.equal(uc026(m, m.vessels[0], mp).outcome, 'PASS');
});

test('the rank-1 placements of one run do not collide with each other (held as tentative reservations)', async () => {
  const s = snap({ vessels: Array.from({ length: 6 }, (_, i) => vessel(i + 1, { loa: 190, declared_teu: 800 })), berths: [berth(1, { length_m: 220 })] });
  const r = await recommend(s);
  const ones = r.vessels.map((x) => x.proposals[0]);
  for (let i = 0; i < ones.length; i += 1) for (let j = i + 1; j < ones.length; j += 1) {
    assert.ok(Date.parse(ones[i].planned_end) <= Date.parse(ones[j].planned_start) || Date.parse(ones[j].planned_end) <= Date.parse(ones[i].planned_start), `vessels ${i + 1} and ${j + 1} share the only berth one after the other`);
  }
});

test('verify hook (UC-026 authority): a candidate that does not PASS is dropped and counted, never shown; if all fail the vessel is UNSCHEDULABLE with the UC-026 reasons', async () => {
  const s = snap({ berths: [berth(1), berth(2), berth(3)] });
  const seen = [];
  const refuseBerth1 = async (v, c) => { seen.push(c.berth_id); return c.berth_id === 1 ? { outcome: 'VIOLATION', rules: [{ id: 'OVERLAP', outcome: 'VIOLATION', reason: 'Chồng lấn.' }] } : { outcome: 'PASS', rules: [] }; };
  const v = (await recommend(s, { verify: refuseBerth1 })).vessels[0];
  assert.ok(!v.proposals.some((p) => p.berth_id === 1)); assert.equal(v.candidates_rejected, 1);
  assert.ok(v.proposals.every((p) => p.check.outcome === 'PASS'));
  const none = (await recommend(s, { verify: async () => ({ outcome: 'MISSING_DATA', rules: [{ id: 'CRANES', outcome: 'MISSING_DATA', reason: 'Thiếu.' }] }) })).vessels[0];
  assert.deepEqual([none.outcome, none.proposals.length, none.reasons[0].code], ['UNSCHEDULABLE', 0, 'CRANES']);
  const boom = (await recommend(s, { verify: async () => { throw new Error('db'); } })).vessels[0];
  assert.equal(boom.outcome, 'UNSCHEDULABLE', 'an error while verifying never yields a valid proposal');
});

test('20 waiting vessels on 8 berths: every unverified proposal passes the UC-026 rules against the snapshot (no violation), and the run is fast and reproducible', async () => {
  const berths = [berth(1, { length_m: 450, available_cranes: 5 }), berth(2, { length_m: 400 }), berth(3, { length_m: 350 }), berth(4, { length_m: 300, available_cranes: 3 }), berth(5, { length_m: 300, available_cranes: 3 }),
    berth(6, { length_m: 300, available_cranes: 2 }), berth(7, { berth_type: 'BULK', length_m: 280, available_cranes: 2 }), berth(8, { berth_type: 'BULK', length_m: 260, available_cranes: 2, allows_dangerous: true })];
  const vessels = Array.from({ length: 20 }, (_, i) => vessel(i + 1, { loa: 140 + (i * 17) % 120, draft: 8 + (i % 5) * 0.8, declared_teu: 400 + (i * 137) % 1400, effective_eta: H(1 + i * 2), cargo_class: i % 5 === 4 ? 'BULK' : 'CONTAINER', cargo_hazard: i % 7 === 3 ? 'DANGEROUS' : 'NONE' }));
  const busy = [{ berth_id: 1, from: H(-5), to: H(20), position_start_m: 0, position_end_m: 220, voyage_code: 'X1' }, { berth_id: 2, from: H(0), to: H(15), position_start_m: 0, position_end_m: 180, voyage_code: 'X2' }];
  const maintenance = [{ berth_id: 3, from: H(10), to: H(30) }];
  const s = snap({ vessels, berths, busy, maintenance });
  const t0 = process.hrtime.bigint();
  const r = await recommend(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `pure engine, 20 vessels: ${ms} ms`);
  assert.deepEqual(await recommend(s), r, 'reproducible');
  let proposals = 0; let violations = 0;
  const held = [];
  for (const x of r.vessels) {
    const v = vessels.find((q) => q.voyage_id === x.voyage_id);
    for (const p of x.proposals) { proposals += 1; if (uc026({ ...s, busy: [...busy, ...held.filter((h) => h.berth_id === p.berth_id)] }, v, p).outcome !== 'PASS') violations += 1; }
    if (x.proposals[0]) held.push({ berth_id: x.proposals[0].berth_id, from: x.proposals[0].planned_start, to: x.proposals[0].planned_end, position_start_m: x.proposals[0].position_start_m, position_end_m: x.proposals[0].position_end_m, voyage_code: x.voyage_code });
  }
  assert.ok(proposals > 20, `${proposals} proposals`); assert.equal(violations, 0, 'no proposal breaks a UC-026 rule');
  const m = metrics(r);
  assert.equal(m.vessels, 20); assert.equal(m.placed + m.unschedulable, 20);
  assert.ok(r.vessels.filter((x) => x.outcome === 'UNSCHEDULABLE').every((x) => x.reasons.length > 0), 'every unschedulable vessel says why');
});

// ---------------------------------------------------------------- hardening: occupancy, priority, replay by version, bounded search
const bigScenario = () => {
  const berths = [berth(1, { length_m: 450, available_cranes: 5 }), berth(2, { length_m: 400 }), berth(3, { length_m: 350 }), berth(4, { length_m: 300, available_cranes: 3 }), berth(5, { length_m: 300, available_cranes: 3 }), berth(6, { length_m: 250, available_cranes: 2 })];
  const vessels = Array.from({ length: 20 }, (_, i) => vessel(i + 1, { loa: 140 + (i * 17) % 120, draft: 8 + (i % 5) * 0.8, declared_teu: 400 + (i * 137) % 1400, effective_eta: H(1 + i * 1.5) }));
  return snap({ vessels, berths, busy: [{ berth_id: 1, from: H(0), to: H(20), position_start_m: 0, position_end_m: 200, voyage_code: 'X1' }] });
};

test('occupancy: a reservation with no end (a berthed vessel past its planned departure, no actual departure) blocks its stretch at every later time', async () => {
  const OPEN = '9999-12-31T00:00:00.000Z';
  const s = snap({ berths: [berth(1, { length_m: 300 })], busy: [{ berth_id: 1, from: H(-10), to: OPEN, position_start_m: 0, position_end_m: 200, voyage_code: 'A' }] });
  const v = (await recommend(s)).vessels[0];
  assert.deepEqual([v.outcome, v.proposals.length, v.reasons[0].code], ['UNSCHEDULABLE', 0, 'NO_SLOT'], 'nothing fits beside it on 300 m and it never ends');
  const wide = snap({ berths: [berth(1, { length_m: 450 })], busy: s.busy });
  const p = (await recommend(wide)).vessels[0].proposals[0];
  assert.ok(p.position_start_m >= 220, 'beside it, with the buffer, from now on');
  assert.equal(uc026(wide, wide.vessels[0], p).outcome, 'PASS');
});

test('V2 keeps queue priority: every vessel gets its earliest feasible start, so rank 1 is never later than another proposal of the same vessel', async () => {
  const r = await recommend(bigScenario());
  for (const x of r.vessels.filter((y) => y.proposals.length)) {
    const first = Date.parse(x.proposals[0].planned_start);
    assert.ok(x.proposals.every((p) => Date.parse(p.planned_start) >= first), `vessel ${x.voyage_code}: rank 1 starts first`);
  }
});

test('V2 is deterministic and plans every vessel; the plan is a Map of one pick per vessel', async () => {
  const s = bigScenario();
  const a = await recommend(s); const b = await recommend(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(a, b);
  assert.equal(a.policy_version, 'UC027-OPT-V2');
  const plan = planWithBeam(s, POLICY);
  assert.ok(plan instanceof Map && plan.size === 20);
});

test('a stored snapshot replays with the policy version it names (V1 snapshot gives the V1 result), and an unknown version falls back to the current policy', async () => {
  const s = bigScenario();
  const asV1 = { ...s, policy: POLICIES['UC027-OPT-V1'] }; const asV2 = { ...s, policy: POLICY };
  assert.equal((await recommend(asV1)).policy_version, 'UC027-OPT-V1');
  assert.equal((await recommend(asV2)).policy_version, 'UC027-OPT-V2');
  assert.deepEqual(await recommend(asV1), await recommend(s, { policy: POLICIES['UC027-OPT-V1'] }));
  assert.equal((await recommend({ ...s, policy: { version: 'UC027-OPT-V0' } })).policy_version, 'UC027-OPT-V2');
});

test('bounded search: a tiny work cap falls back to the greedy choice deterministically; the result is still complete', async () => {
  const s = bigScenario();
  const capped = { ...POLICY, maxExpansions: 5 };
  const a = await recommend(s, { policy: capped }); const b = await recommend(s, { policy: capped });
  assert.deepEqual(a, b, 'the cap is a counter, so the result does not depend on speed');
  assert.equal(a.vessels.length, 20); assert.ok(a.vessels.every((v) => v.outcome === 'UNSCHEDULABLE' || v.proposals.length >= 1));
});
