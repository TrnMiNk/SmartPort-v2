'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResources, localToIso, formatUtc7, isoToLocal, query } = require('../../js/resources');

function fakeApi(result = {}) {
  const calls = [];
  return { calls, request: async (path, opts) => { calls.push({ path, opts }); return result; } };
}

test('localToIso reads a datetime-local value as UTC+7 and rejects anything else', () => {
  assert.equal(localToIso('2026-12-01T08:00'), '2026-12-01T08:00:00+07:00');
  for (const bad of ['', '2026-12-01', '2026-12-01T08:00:00', '2026-12-01 08:00', null, undefined, 5, '2026-12-01T8:00']) {
    assert.equal(localToIso(bad), null, String(bad));
  }
  // The value sent really is 01:00 UTC.
  assert.equal(new Date(localToIso('2026-12-01T08:00')).toISOString(), '2026-12-01T01:00:00.000Z');
});

test('formatUtc7 shows the instant in UTC+7, including a date rollover, and is empty for bad input', () => {
  assert.equal(formatUtc7('2026-12-01T01:00:00.000Z'), '2026-12-01 08:00');
  assert.equal(formatUtc7('2026-12-01T20:00:00.000Z'), '2026-12-02 03:00', 'crosses midnight');
  assert.equal(formatUtc7('2026-12-31T18:30:00Z'), '2027-01-01 01:30', 'crosses the year');
  for (const bad of ['', null, undefined, 'not a date']) assert.equal(formatUtc7(bad), '', String(bad));
});

test('isoToLocal turns a stored ISO instant back into the UTC+7 form value, and round-trips with localToIso', () => {
  assert.equal(isoToLocal('2026-12-01T01:00:00.000Z'), '2026-12-01T08:00');
  assert.equal(isoToLocal('2026-12-01T20:00:00Z'), '2026-12-02T03:00');
  assert.equal(isoToLocal(null), '');
  assert.equal(isoToLocal('x'), '');
  for (const v of ['2026-12-01T08:00', '2027-01-01T00:00', '2026-02-28T23:59']) assert.equal(isoToLocal(new Date(localToIso(v)).toISOString()), v);
});

test('draft, validation and queue resource functions use the documented endpoints, verbs and revision headers', async () => {
  const api = fakeApi({ items: [{ id: 1 }] });
  const res = createResources(api);
  assert.deepEqual(await res.listDrafts(), [{ id: 1 }]);
  await res.createDraft({ cargo_type: 'x' });
  await res.updateDraft(4, 2, { cargo_type: 'y' });
  await res.discardDraft(4, 3);
  await res.submitDraft(4);
  await res.validateVoyage(9);
  await res.getQueue();
  await res.moveQueue(9, 7, { to_position: 1, reason: 'r' });
  const [list, create, update, discard, submit, validate, queue, move] = api.calls;
  assert.equal(list.path, '/api/v1/voyage-drafts');
  assert.deepEqual([create.path, create.opts.method], ['/api/v1/voyage-drafts', 'POST']);
  assert.deepEqual([update.path, update.opts.method, update.opts.headers], ['/api/v1/voyage-drafts/4', 'PUT', { 'If-Match': '"2"' }]);
  assert.deepEqual([discard.opts.method, discard.opts.headers], ['DELETE', { 'If-Match': '"3"' }]);
  assert.equal(submit.path, '/api/v1/voyage-drafts/4/submit');
  assert.deepEqual([validate.path, validate.opts.method], ['/api/v1/voyages/9/validate', 'POST']);
  assert.equal(queue.path, '/api/v1/voyages/queue');
  assert.deepEqual([move.path, move.opts.method, move.opts.headers, move.opts.body], ['/api/v1/voyages/9/queue-position', 'PATCH', { 'If-Match': '"7"' }, { to_position: 1, reason: 'r' }]);
});

test('query keeps zero, drops empty values and encodes special characters', () => {
  assert.equal(query({ page: 0, size: 10 }), '?page=0&size=10');
  assert.equal(query({ search: 'a b&c=d', includeInactive: false, x: '', y: null, z: undefined }), '?search=a%20b%26c%3Dd');
  assert.equal(query({}), '');
  assert.equal(query(undefined), '');
  assert.equal(query({ search: '%' }), '?search=%25');
});

test('resource functions use the documented endpoints, verbs, bodies and revision headers', async () => {
  const api = fakeApi({ items: [{ id: 1 }] });
  const res = createResources(api);
  assert.deepEqual(await res.shipTypes(), [{ id: 1 }]);
  assert.deepEqual(await res.ports(), [{ id: 1 }]);
  assert.deepEqual(await res.agents(), [{ id: 1 }]);
  await res.listShips({ search: 'x y', page: 2, size: 10, includeInactive: true });
  await res.getShip('7/../8');
  assert.deepEqual(await res.shipHistory(7), [{ id: 1 }]);
  assert.equal(api.calls.at(-1).path, '/api/v1/ships/7/history');
  api.calls.pop(); // keep the destructuring below aligned
  await res.createShip({ imo_number: '1234567' });
  await res.updateShip(7, 3, { ship_name: 'N' });
  await res.deactivateShip(7, 4, 'Hết khai thác');
  await res.listVoyages({ status: 'ANNOUNCED' });
  await res.createVoyage({ voyage_code: 'V1' });
  const [types, ports, agents, list, one, create, update, deact, vlist, vcreate] = api.calls;
  assert.equal(types.path, '/api/v1/catalog/ship-types');
  assert.equal(ports.path, '/api/v1/catalog/ports');
  assert.equal(agents.path, '/api/v1/catalog/agents');
  assert.equal(list.path, '/api/v1/ships?search=x%20y&page=2&size=10&includeInactive=true');
  assert.equal(one.path, '/api/v1/ships/7%2F..%2F8', 'ids are encoded so a path cannot be injected');
  assert.deepEqual([create.path, create.opts.method], ['/api/v1/ships', 'POST']);
  assert.deepEqual([update.path, update.opts.method, update.opts.headers], ['/api/v1/ships/7', 'PATCH', { 'If-Match': '"3"' }]);
  assert.deepEqual(update.opts.body, { ship_name: 'N' });
  assert.deepEqual([deact.path, deact.opts.method, deact.opts.headers, deact.opts.body],
    ['/api/v1/ships/7/deactivate', 'POST', { 'If-Match': '"4"' }, { reason: 'Hết khai thác' }]);
  assert.equal(vlist.path, '/api/v1/voyages?status=ANNOUNCED');
  assert.deepEqual([vcreate.path, vcreate.opts.method], ['/api/v1/voyages', 'POST']);
});

test('API errors pass through unchanged so pages can show field messages', async () => {
  const boom = Object.assign(new Error('x'), { status: 409, code: 'CONFLICT', details: { field: 'imo_number' } });
  const res = createResources({ request: async () => { throw boom; } });
  await assert.rejects(() => res.createShip({}), (e) => e === boom);
});

test('scheduleWindow: a day or a Monday-first week in UTC+7, as ISO instants', () => {
  const { scheduleWindow, shiftDate, todayLocal } = require('../../js/resources');
  assert.deepEqual(scheduleWindow('2027-08-10', 'day'), { from: '2027-08-09T17:00:00.000Z', to: '2027-08-10T17:00:00.000Z', firstDate: '2027-08-10', days: 1 });
  const week = scheduleWindow('2027-08-10', 'week'); // a Tuesday
  assert.deepEqual([week.firstDate, week.from, week.to, week.days], ['2027-08-09', '2027-08-08T17:00:00.000Z', '2027-08-15T17:00:00.000Z', 7]);
  assert.equal(scheduleWindow('2027-08-15', 'week').firstDate, '2027-08-09', 'Sunday belongs to the week that started on Monday');
  assert.equal(scheduleWindow('2027-02-30', 'day'), null);
  assert.equal(scheduleWindow('nope', 'day'), null);
  assert.equal(shiftDate('2027-12-31', 1), '2028-01-01');
  assert.equal(shiftDate('2028-03-01', -1), '2028-02-29');
  assert.equal(todayLocal(Date.UTC(2027, 7, 10, 18, 0)), '2027-08-11', '18:00 UTC is already the next day in UTC+7');
});

test('barGeometry and packRows: bars match the stored times, markers for voyages without an interval, overlaps get rows', () => {
  const { barGeometry, packRows } = require('../../js/resources');
  const from = '2027-08-10T00:00:00.000Z'; const to = '2027-08-11T00:00:00.000Z';
  const g = barGeometry({ start_at: '2027-08-10T06:00:00Z', end_at: '2027-08-10T18:00:00Z' }, from, to);
  assert.deepEqual([g.left, g.width, g.marker], [0.25, 0.5, false]);
  const clipped = barGeometry({ start_at: '2027-08-09T20:00:00Z', end_at: '2027-08-12T00:00:00Z' }, from, to);
  assert.deepEqual([clipped.left, clipped.width], [0, 1], 'clipped to the window');
  const open = barGeometry({ start_at: '2027-08-10T12:00:00Z', end_at: null }, from, to);
  assert.deepEqual([open.left, open.width], [0.5, 0.5], 'an open interval runs to the window end');
  const m = barGeometry({ start_at: null, declared_eta: '2027-08-10T12:00:00Z' }, from, to);
  assert.deepEqual([m.left, m.marker], [0.5, true]);
  const packed = packRows([{ id: 1, start_at: '2027-08-10T00:00:00Z', end_at: '2027-08-10T10:00:00Z' }, { id: 2, start_at: '2027-08-10T05:00:00Z', end_at: '2027-08-10T08:00:00Z' }, { id: 3, start_at: '2027-08-10T10:00:00Z', end_at: '2027-08-10T12:00:00Z' }]);
  assert.equal(packed.rows, 2);
  assert.deepEqual(packed.placed.map((x) => [x.item.id, x.row]), [[1, 0], [2, 1], [3, 0]], 'a bar that starts when another ends reuses the row');
});

test('schedule and berth resource functions use the documented endpoints', async () => {
  const api = fakeApi({ items: [{ id: 1 }] });
  const res = createResources(api);
  await res.schedule({ view: 'gantt', from: 'a', to: 'b', berth_id: 3, status: '' });
  assert.deepEqual(await res.berths(), [{ id: 1 }]);
  assert.equal(api.calls[0].path, '/api/v1/voyages/schedule?view=gantt&from=a&to=b&berth_id=3');
  assert.equal(api.calls[1].path, '/api/v1/catalog/berths');
});

test('berth resource functions use the documented endpoints, verbs and revision headers', async () => {
  const api = fakeApi({ items: [{ id: 1 }] });
  const res = createResources(api);
  await res.listBerths({ size: 100 });
  await res.getBerth('3/../4');
  await res.createBerth({ berth_code: 'B1' });
  await res.updateBerth(3, 5, { available_cranes: 4 });
  await res.berthStatus();
  await res.berthDetail(3);
  await res.checkPlacement({ voyage_id: 1 });
  const [list, one, create, update, status, detail, check] = api.calls;
  assert.equal(list.path, '/api/v1/berths?size=100');
  assert.equal(one.path, '/api/v1/berths/3%2F..%2F4', 'ids are encoded');
  assert.deepEqual([create.path, create.opts.method], ['/api/v1/berths', 'POST']);
  assert.deepEqual([update.path, update.opts.method, update.opts.headers, update.opts.body], ['/api/v1/berths/3', 'PATCH', { 'If-Match': '"5"' }, { available_cranes: 4 }]);
  assert.equal(status.path, '/api/v1/berths/status');
  assert.equal(detail.path, '/api/v1/berths/3/detail');
  assert.deepEqual([check.path, check.opts.method], ['/api/v1/berth-plan-checks', 'POST']);
});

test('approval and notification resource functions use the documented endpoints', async () => {
  const api = fakeApi({ items: [{ id: 1 }] });
  const res = createResources(api);
  await res.approvePlan(7, 3);
  await res.listNotifications({ unread: 'true', size: 20 });
  await res.readNotification('9/../1');
  const [approve, list, read] = api.calls;
  assert.deepEqual([approve.path, approve.opts.method, approve.opts.headers, approve.opts.body], ['/api/v1/berth-plans/7/approve', 'POST', { 'If-Match': '"3"' }, { confirm: true }]);
  assert.equal(list.path, '/api/v1/notifications?unread=true&size=20');
  assert.deepEqual([read.path, read.opts.method], ['/api/v1/notifications/9%2F..%2F1/read', 'POST']);
});

test('UC-027 recommendation resource functions use the documented endpoints and bodies', async () => {
  const api = fakeApi({ id: 1 });
  const res = createResources(api);
  await res.recommendBerths();
  await res.recommendBerths([3, 4]);
  await res.getRecommendation('5/../1');
  await res.ignoreRecommendation(5, 9);
  await res.ignoreRecommendation(5, 9, 'Ưu tiên tàu khác');
  const [all, some, get, ignore, ignoreReason] = api.calls;
  assert.deepEqual([all.path, all.opts.method, all.opts.body], ['/api/v1/berth-recommendations', 'POST', {}]);
  assert.deepEqual(some.opts.body, { voyage_ids: [3, 4] });
  assert.equal(get.path, '/api/v1/berth-recommendations/5%2F..%2F1');
  assert.deepEqual([ignore.path, ignore.opts.method, ignore.opts.body], ['/api/v1/berth-recommendations/5/ignore', 'POST', { voyage_id: 9 }]);
  assert.deepEqual(ignoreReason.opts.body, { voyage_id: 9, reason: 'Ưu tiên tàu khác' });
});

test('UC-016 prediction history uses the documented endpoint and encodes the id', async () => {
  const api = fakeApi({ items: [] });
  const res = createResources(api);
  await res.etaPredictions('7/../1');
  assert.equal(api.calls[0].path, '/api/v1/voyages/7%2F..%2F1/eta-predictions');
});
