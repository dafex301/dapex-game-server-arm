import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContainerResult, minecraftWhitelist } from '../src/docker.js';

test('treats Docker 29 empty inspect arrays as a missing container', () => {
  assert.deepEqual(inspectContainerResult('minecraft', '[]'), { name: 'minecraft', exists: false, running: false });
});

test('turns an unavailable RCON socket into a useful readiness error', async () => {
  const runCommand = async () => {
    throw new Error('Failed to connect to RCON server dial tcp [::1]:25575: connect: connection refused');
  };

  await assert.rejects(
    minecraftWhitelist('minecraft', 'add', 'DaFeX_', runCommand),
    (error) => error.status === 409 && /still starting.*healthy/i.test(error.message),
  );
});
