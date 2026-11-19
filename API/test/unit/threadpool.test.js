'use strict';

// Regression: the SQL driver needs more libuv threads than Node's default of 4, otherwise simultaneous requests that
// wait for each other's locks stall the whole process.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (env) => spawnSync(process.execPath, ['-e', "require('./src/db/connection'); process.stdout.write(process.env.UV_THREADPOOL_SIZE)"],
  { cwd: path.resolve(__dirname, '..', '..'), env: { ...process.env, UV_THREADPOOL_SIZE: '', ...env }, encoding: 'utf8' }).stdout;

test('loading the database layer raises a missing or too small thread pool to at least 16', () => {
  assert.equal(run({}), '16');
  assert.equal(run({ UV_THREADPOOL_SIZE: '4' }), '16');
});

test('a larger configured thread pool is kept', () => {
  assert.equal(run({ UV_THREADPOOL_SIZE: '64' }), '64');
});
