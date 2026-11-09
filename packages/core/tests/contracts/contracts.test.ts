import assert from 'node:assert/strict';
import test from 'node:test';
import { getProfile, profiles } from '../../src/profiles.js';
import { handoffSchema, taskResultJsonSchema, taskResultSchema } from '../../src/schema.js';

test('profiles are immutable and prototype keys are not valid names', () => {
  assert.equal(getProfile().name, 'opus-medium');
  assert.equal(getProfile('opus-high').effort, 'high');
  assert.equal(getProfile('sonnet-medium').model, 'claude-sonnet-5-5');
  assert.equal(Object.isFrozen(profiles), true);
  assert.equal(Object.isFrozen(getProfile()), true);
  for (const name of ['__proto__', 'constructor', '', 'opus-max']) {
    assert.throws(() => getProfile(name), /Unknown profile/);
  }
});

test('structured results require explicit checks, unresolved issues and bounded handoffs', () => {
  const result = {
    summary: 'Found the cause; no changes made.',
    changes: [],
    checks: [{ name: 'integration', status: 'not_run', details: 'No API credentials in offline tests.' }],
    unresolved: ['Needs a live run.'],
    handoffs: [{ agent: 'explorer', task: 'Locate the caller', findings: ['Found one caller.'], evidence: [{ path: 'src/example.ts', line: 12, note: 'Calls the function.' }], unresolved: [] }],
  };
  assert.deepEqual(taskResultSchema.parse(result), result);
  assert.equal(taskResultSchema.safeParse({ summary: 'Done' }).success, false);
  assert.equal(taskResultSchema.safeParse({ ...result, checks: [{ name: 'test', status: 'probably_passed', details: '' }] }).success, false);
  assert.equal(handoffSchema.safeParse({ ...result.handoffs[0], agent: 'general-purpose' }).success, false);
  assert.equal(taskResultSchema.safeParse({ ...result, extra: true }).success, false);
  assert.equal(taskResultJsonSchema.type, 'object');
});
