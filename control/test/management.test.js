import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManagement } from '../src/management.js';

test('exposes bounded backup policy and safely updates approved Minecraft settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dapex-management-'));
  await mkdir(path.join(root, 'minecraft'), { recursive: true });
  await writeFile(path.join(root, 'minecraft', '.env'), 'MOTD=Old\nRCON_PASSWORD=secret\nMAX_PLAYERS=8\n');
  const management = createManagement({ deployDir: root }, { run: async () => '' });
  const result = await management.updateSettings({ MOTD: 'New world', MAX_PLAYERS: '12', PVP: 'FALSE' });
  assert.equal(result.settings.MOTD, 'New world');
  assert.equal(result.settings.PVP, 'FALSE');
  assert.equal(result.retention.count, 5);
  await assert.rejects(management.updateSettings({ RCON_PASSWORD: 'leak' }), /not editable/);
  await assert.rejects(management.updateSettings({ PVP: 'sometimes' }), /must be true or false/);
});

test('backs up before replacing a world and recreates the container configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dapex-world-'));
  await mkdir(path.join(root, 'minecraft', 'data', 'world'), { recursive: true });
  await mkdir(path.join(root, 'backups', 'minecraft'), { recursive: true });
  await writeFile(path.join(root, 'minecraft', 'data', 'world', 'level.dat'), 'world');
  await writeFile(path.join(root, 'minecraft', '.env'), 'LEVEL=world\nRCON_PASSWORD=secret\n');
  const calls = [];
  const management = createManagement({ deployDir: root, minecraftContainer: 'minecraft' }, { run: async (command, args = []) => { calls.push([command, ...args]); return 'backups/minecraft/safe.tar.gz\n'; } });
  const result = await management.resetWorld({ name: 'season-2', seed: 'dapex' });
  await assert.rejects(access(path.join(root, 'minecraft', 'data', 'world')));
  const environment = await readFile(path.join(root, 'minecraft', '.env'), 'utf8');
  assert.match(environment, /^LEVEL=season-2$/m);
  assert.match(environment, /^SEED=dapex$/m);
  assert.match(environment, /^RCON_PASSWORD=secret$/m);
  assert.equal(result.world.name, 'season-2');
  assert.ok(calls.some((call) => call[0] === 'docker' && call[1] === 'rm'));
});
