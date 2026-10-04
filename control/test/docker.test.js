import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContainerResult, minecraftCommand, minecraftWhitelist } from '../src/docker.js';

test('treats Docker 29 empty inspect arrays as a missing container', () => {
  assert.deepEqual(inspectContainerResult('minecraft', '[]'), { name: 'minecraft', exists: false, running: false });
});

test('passes an RCON command as one Docker argument without invoking a shell', async () => {
  let call;
  const output = await minecraftCommand('minecraft', 'give D_Apex minecraft:diamond 64', async (file, args, options) => {
    call = { file, args, options };
    return 'Gave 64 diamond to D_Apex';
  });
  assert.equal(output, 'Gave 64 diamond to D_Apex');
  assert.deepEqual(call.args, ['exec', 'minecraft', 'rcon-cli', 'give D_Apex minecraft:diamond 64']);
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
