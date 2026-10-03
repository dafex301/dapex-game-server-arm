import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileExplorer, parseMinecraftLogLine, safeRelativePath } from '../src/file-explorer.js';

test('rejects paths outside Minecraft file areas', () => {
  assert.equal(safeRelativePath('spark/config.json'), true);
  assert.equal(safeRelativePath('../.env'), false);
  assert.equal(safeRelativePath('/etc/passwd'), false);
  assert.equal(safeRelativePath('windows\\system.ini'), false);
});

test('classifies Minecraft log severity and player lifecycle lines', () => {
  assert.equal(parseMinecraftLogLine('[16:01:28] [Server thread/INFO]: Dadiink lost connection: Disconnected').kind, 'player');
  assert.equal(parseMinecraftLogLine('[15:58:11] [main/WARN]: Invalid option ignored').kind, 'warn');
  assert.equal(parseMinecraftLogLine('[15:58:11] [main/ERROR]: Failed to decode packet').kind, 'error');
  assert.equal(parseMinecraftLogLine('   |-- fabric-crash-report-info-v1 0.2.29').kind, 'info');
});

test('lists curated files while hiding secrets and symlink-like special names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dapex-files-'));
  const configDir = path.join(root, 'minecraft', 'data', 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'lithium.properties'), 'enabled=true');
  await writeFile(path.join(configDir, '.hidden'), 'secret');
  const management = { overview: async () => ({ world: { name: 'world' } }), backup: async () => ({}) };
  const explorer = createFileExplorer({ deployDir: root }, management, { run: async () => '' });
  const listing = await explorer.list('config');
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['lithium.properties']);
  assert.equal(listing.entries[0].editable, true);
  await assert.rejects(() => explorer.readText('config', '.hidden'), /Protected Minecraft file/);
  await assert.rejects(() => explorer.readText('config', 'server.properties'), /Protected Minecraft file/);
});

test('keeps read-only world data immutable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dapex-files-'));
  await mkdir(path.join(root, 'minecraft', 'data', 'world'), { recursive: true });
  const management = { overview: async () => ({ world: { name: 'world' } }), backup: async () => ({}) };
  const explorer = createFileExplorer({ deployDir: root }, management, { run: async () => '' });
  await assert.rejects(() => explorer.createDirectory('world', 'unsafe'), /read-only/);
});
