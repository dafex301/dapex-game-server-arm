import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMemoryPolicy } from '../src/memory-policy.js';

const config = {
  memoryAlertGiB: 7,
  memoryAlertResetGiB: 6,
  memoryRestartGiB: 7.5,
  memoryRestartSamples: 2,
};

test('warns once and rearms below the reset threshold', () => {
  const first = evaluateMemoryPolicy({}, 7.1, config);
  assert.equal(first.warn, true);
  const repeated = evaluateMemoryPolicy(first, 7.2, config);
  assert.equal(repeated.warn, false);
  const reset = evaluateMemoryPolicy(repeated, 5.9, config);
  assert.equal(reset.highMemoryAlerted, false);
  assert.equal(evaluateMemoryPolicy(reset, 7.1, config).warn, true);
});

test('requires consecutive restart-threshold samples', () => {
  const first = evaluateMemoryPolicy({}, 7.6, config);
  assert.equal(first.restart, false);
  const dropped = evaluateMemoryPolicy(first, 7.4, config);
  assert.equal(dropped.highMemorySamples, 0);
  const again = evaluateMemoryPolicy(dropped, 7.6, config);
  const second = evaluateMemoryPolicy(again, 7.7, config);
  assert.equal(second.restart, true);
  assert.equal(second.memoryRestartPending, true);
});

test('does not schedule another restart while one is pending', () => {
  const result = evaluateMemoryPolicy({ highMemorySamples: 2, memoryRestartPending: true }, 8, config);
  assert.equal(result.restart, false);
});
