'use strict';

// Pure geometry of the berth plan chart (FR-BRT-03). The chart decides nothing about a placement: UC-026 on the server does.

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../js/resources.js');

const NOW = Date.UTC(2032, 5, 10, 5, 0);   // 12:00 in UTC+7
const w = R.chartWindow(NOW, 0, 3);
const scale = R.chartScale({ fromMs: w.fromMs, toMs: w.toMs, lengthM: 400, widthPx: 720, heightPx: 200 });
const H = 3600e3;

test('window: whole UTC+7 days from the day of "now", shifted by an offset', () => {
  assert.equal(new Date(w.fromMs).toISOString(), '2032-06-09T17:00:00.000Z');
  assert.equal(w.toMs - w.fromMs, 3 * 86400e3);
  assert.equal(new Date(R.chartWindow(NOW, -1, 1).fromMs).toISOString(), '2032-06-08T17:00:00.000Z');
  assert.equal(new Date(R.chartWindow(Date.UTC(2032, 5, 10, 18, 0), 0, 1).fromMs).toISOString(), '2032-06-10T17:00:00.000Z', '18:00Z is already the next day in UTC+7');
});

test('scale: time and position convert both ways', () => {
  assert.equal(scale.x(w.fromMs), 0); assert.equal(scale.x(w.toMs), 720); assert.equal(scale.x(w.fromMs + 24 * H), 240);
  assert.equal(scale.ms(240), w.fromMs + 24 * H); assert.equal(scale.y(100), 50); assert.equal(scale.m(50), 100);
});

test('rect: a block inside the window; clipped at both edges; outside the window is null; open-ended runs to the right edge', () => {
  assert.deepEqual(R.chartRect(scale, { startMs: w.fromMs + 6 * H, endMs: w.fromMs + 18 * H, posStart: 100, posEnd: 200 }), { left: 60, width: 120, top: 50, height: 50, clippedLeft: false, clippedRight: false, openEnded: false });
  const clipped = R.chartRect(scale, { startMs: w.fromMs - 10 * H, endMs: w.toMs + 10 * H, posStart: -20, posEnd: 500 });
  assert.deepEqual([clipped.left, clipped.width, clipped.top, clipped.height, clipped.clippedLeft, clipped.clippedRight], [0, 720, 0, 200, true, true]);
  assert.equal(R.chartRect(scale, { startMs: w.toMs + H, endMs: w.toMs + 2 * H, posStart: 0, posEnd: 10 }), null);
  assert.equal(R.chartRect(scale, { startMs: w.fromMs - 5 * H, endMs: w.fromMs - H, posStart: 0, posEnd: 10 }), null);
  const open = R.chartRect(scale, { startMs: w.fromMs + 24 * H, endMs: null, posStart: 0, posEnd: 100 });
  assert.deepEqual([open.left, open.width, open.openEnded, open.clippedRight], [240, 480, true, true]);
});

test('drop: time snaps to 15 minutes, position to 1 m, size is kept, the block stays on the berth', () => {
  const orig = { startMs: w.fromMs + 6 * H, endMs: w.fromMs + 18 * H, posStart: 100, posEnd: 200 };
  const d = R.chartDrop(scale, orig, 20, 10);   // 20 px = 2 h, 10 px = 20 m
  assert.deepEqual([d.startMs - w.fromMs, d.endMs - d.startMs, d.posStart, d.posEnd], [8 * H, 12 * H, 120, 220]);
  const odd = R.chartDrop(scale, orig, 3.3, 1.1);   // not on a grid line
  assert.equal((odd.startMs - w.fromMs) % (15 * 60000), 0); assert.ok(Number.isInteger(odd.posStart)); assert.equal(odd.posEnd - odd.posStart, 100);
  assert.deepEqual([R.chartDrop(scale, orig, 0, -500).posStart, R.chartDrop(scale, orig, 0, 5000).posEnd], [0, 400], 'cannot leave the berth');
  assert.deepEqual([R.chartDrop(scale, orig, 0, 0).startMs, R.chartDrop(scale, orig, 0, 0).posStart], [orig.startMs, 100], 'no movement keeps the placement');
});

test('ticks: labelled in UTC+7 at whole steps inside the window', () => {
  assert.deepEqual(R.chartTicks(w.fromMs, w.toMs, 24).map((t) => t.label), ['06-10 00:00', '06-11 00:00', '06-12 00:00']);
  assert.deepEqual(R.chartTicks(w.fromMs, w.fromMs + 24 * H, 6).map((t) => t.label), ['06-10 00:00', '06-10 06:00', '06-10 12:00', '06-10 18:00']);
});
