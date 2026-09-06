import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewerOracleRunner } from '../scripts/viewer-oracle-runner.mjs';

const scripts = ['check-scroll-integrity.mjs', 'check-display-controls.mjs'];

function run(outcomes) {
  const calls = [];
  let failure;
  try {
    ViewerOracleRunner.run(scripts, script => {
      const outcome = outcomes[calls.length];
      calls.push(script);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
  } catch (error) { failure = error; }
  assert.deepEqual(calls, scripts, 'Both independent children must run in order');
  return failure;
}

test('successful independent oracles return without an aggregate failure', () => {
  assert.equal(run([{ status: 0 }, { status: 0 }]), undefined);
});

test('scroll failure does not skip display and is still an overall failure', () => {
  const error = run([{ status: 1 }, { status: 0 }]);
  assert(error instanceof AggregateError);
  assert.equal(error.errors.length, 1);
  assert.match(error.errors[0].message, /check-scroll-integrity/);
  assert.equal(error.errors[0].cause.actual, 1);
  assert.equal(error.errors[0].cause.expected, 0);
});

test('display failure remains an overall failure after successful scroll', () => {
  const error = run([{ status: 0 }, { status: 2 }]);
  assert(error instanceof AggregateError);
  assert.equal(error.errors.length, 1);
  assert.match(error.errors[0].message, /check-display-controls/);
  assert.equal(error.errors[0].cause.actual, 2);
});

test('all unsuccessful child exit statuses are aggregated in execution order', () => {
  const error = run([{ status: 1 }, { status: null, signal: 'SIGTERM' }]);
  assert(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.match(error.errors[0].message, /check-scroll-integrity/);
  assert.match(error.errors[1].message, /check-display-controls/);
  assert.equal(error.errors[1].cause.actual, null);
  assert.match(error.errors[1].cause.message, /SIGTERM/);
});

test('reported and thrown spawn errors both survive while later oracles still run', () => {
  const reported = new Error('spawn ENOENT'), thrown = new Error('spawn EACCES');
  const error = run([{ status: null, error: reported }, thrown]);
  assert(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.equal(error.errors[0].cause, reported);
  assert.equal(error.errors[1].cause, thrown);
});

test('a thrown first-runner error does not skip a successful second oracle', () => {
  const thrown = new Error('runner threw before spawning');
  const error = run([thrown, { status: 0 }]);
  assert(error instanceof AggregateError);
  assert.equal(error.errors.length, 1);
  assert.equal(error.errors[0].cause, thrown);
});
