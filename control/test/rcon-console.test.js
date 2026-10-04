import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRconConsole, normalizeRconCommand } from '../src/rcon-console.js';

test('normalizes a leading slash and blocks commands that bypass lifecycle safety', () => {
  assert.equal(normalizeRconCommand('  /time set day  '), 'time set day');
  assert.throws(() => normalizeRconCommand('/STOP'), (error) => error.status === 409 && /Maintenance/.test(error.message));
  assert.throws(() => normalizeRconCommand('minecraft:stop'), (error) => error.status === 409 && /Maintenance/.test(error.message));
  assert.throws(() => normalizeRconCommand('execute as D_Apex run minecraft:stop'), (error) => error.status === 409 && /Maintenance/.test(error.message));
  assert.throws(() => normalizeRconCommand('save-off'), (error) => error.status === 409 && /world saves/.test(error.message));
  assert.throws(() => normalizeRconCommand('say hello\nstop'), /one line/);
});

test('executes commands and persists a bounded audit history with the actor', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dapex-rcon-'));
  const calls = [];
  const console = createRconConsole({ stateDir, minecraftContainer: 'minecraft' }, {
    minecraftCommand: async (container, command) => {
      calls.push([container, command]);
      return 'There are 0 of a max of 10 players online';
    },
  });
  const result = await console.execute('/list', 'admin@example.com');
  assert.deepEqual(calls, [['minecraft', 'list']]);
  assert.equal(result.ok, true);
  assert.equal(result.command, 'list');
  assert.deepEqual((await console.history()).map(({ actor, command, ok }) => ({ actor, command, ok })), [
    { actor: 'admin@example.com', command: 'list', ok: true },
  ]);
});
