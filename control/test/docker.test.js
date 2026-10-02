import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContainerResult } from '../src/docker.js';

test('treats Docker 29 empty inspect arrays as a missing container', () => {
  assert.deepEqual(inspectContainerResult('minecraft', '[]'), { name: 'minecraft', exists: false, running: false });
});
