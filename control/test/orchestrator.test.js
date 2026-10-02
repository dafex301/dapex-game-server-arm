import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrchestrator } from '../src/orchestrator.js';

function fixture() {
  const containers = {
    valheim: { name: 'valheim', exists: true, running: true, health: null },
    minecraft: { name: 'minecraft', exists: true, running: false, health: null },
  };
  return {
    containers,
    dependencies: {
      inspectContainer: async (name) => ({ ...containers[name] }),
      containerStats: async () => ({ cpu: '10%', memory: '2GiB / 7GiB' }),
      containerLogs: async (name) => name === 'valheim' ? 'Session with join code 123456 is active' : 'Done (4.2s)!',
      stopContainer: async (name) => { containers[name].running = false; },
      startContainer: async (name) => { containers[name].running = true; },
      run: async () => { throw new Error('unexpected process call'); },
    },
  };
}

test('switches games sequentially and preserves the exclusive invariant', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dapex-orchestrator-'));
  const { containers, dependencies } = fixture();
  const orchestrator = createOrchestrator({ stateDir: directory, deployDir: directory, valheimContainer: 'valheim', minecraftContainer: 'minecraft' }, dependencies);
  const result = await orchestrator.switchUnlocked('minecraft', 'test');
  assert.equal(result.active, 'minecraft');
  assert.equal(containers.valheim.running, false);
  assert.equal(containers.minecraft.running, true);
  assert.equal(result.invariantOk, true);
});

test('refuses to operate if both games are already running', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dapex-orchestrator-'));
  const { containers, dependencies } = fixture();
  containers.minecraft.running = true;
  const orchestrator = createOrchestrator({ stateDir: directory, deployDir: directory, valheimContainer: 'valheim', minecraftContainer: 'minecraft' }, dependencies);
  await assert.rejects(orchestrator.switchUnlocked('none', 'test'), /invariant violated/);
});

test('restores the previous game when the target fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dapex-orchestrator-'));
  const { containers, dependencies } = fixture();
  dependencies.startContainer = async (name) => {
    if (name === 'minecraft') throw new Error('boot failed');
    containers[name].running = true;
  };
  const orchestrator = createOrchestrator({ stateDir: directory, deployDir: directory, valheimContainer: 'valheim', minecraftContainer: 'minecraft' }, dependencies);
  await assert.rejects(orchestrator.switchUnlocked('minecraft', 'test'), /boot failed/);
  assert.equal(containers.valheim.running, true);
  assert.equal(containers.minecraft.running, false);
});
