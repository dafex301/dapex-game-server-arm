import test from 'node:test';
import assert from 'node:assert/strict';
import { gameStatusEmbed, memoryWarningEmbed, statusEmbed, transitionEmbed } from '../src/render.js';

const base = {
  serverName: 'mbg enak',
  world: 'kopdes',
  players: [],
  playerCount: 0,
  joinCode: null,
  memory: '3 GiB / 8 GiB',
  cpu: '10%',
  startedAt: '2026-09-13T16:00:00Z',
  checkedAt: new Date('2026-09-13T16:01:00Z'),
  restartCount: 1,
  oomKilled: false,
};

test('maintenance status renders health and recovery details', () => {
  const data = statusEmbed({
    ...base,
    state: 'maintenance',
    reason: 'backup lock held',
    action: 'backup',
    recovery: {
      attempts_in_window: 1,
      max_attempts_per_window: 3,
      consecutive_failures: 2,
      next_action_at: 1789315500,
    },
  }).toJSON();
  assert.match(data.title, /Maintenance/);
  assert.ok(data.fields.some((field) => field.name === 'Health detail' && field.value === 'backup lock held'));
  assert.ok(data.fields.some((field) => field.name === 'Automatic recovery' && field.value.includes('1/3 attempts')));
});

test('unknown transition has an explicit presentation', () => {
  const data = transitionEmbed({ state: 'online' }, { ...base, state: 'unknown' }).toJSON();
  assert.match(data.title, /unknown/i);
  assert.match(data.description, /Online.*Unknown/);
});

test('inactive status explains that another game owns the host', () => {
  const data = statusEmbed({ ...base, state: 'inactive', reason: 'desired game slot is minecraft' }).toJSON();
  assert.match(data.title, /another game selected/i);
  assert.ok(data.fields.some((field) => field.name === 'Health detail' && /minecraft/.test(field.value)));
});

test('memory warning shows usage and threshold', () => {
  const data = memoryWarningEmbed({ ...base, state: 'online', playerCount: 4 }, 7.2, 7).toJSON();
  assert.match(data.title, /memory warning/i);
  assert.match(data.description, /7\.20 GiB/);
  assert.ok(data.fields.some((field) => field.name === 'Players' && field.value === '4'));
});

test('unified Minecraft status shows release, address, and client pack', () => {
  const data = gameStatusEmbed({
    game: 'minecraft', state: 'online', playerCount: 2, maxPlayers: 10,
    releaseName: 'Dapex Fabric v3', memory: '1 GiB / 7 GiB', cpu: '5%',
    address: 'mc.example.com', portalUrl: 'https://play.example.com', checkedAt: new Date(),
  }).toJSON();
  assert.match(data.title, /Minecraft/);
  assert.ok(data.fields.some((field) => field.name === 'Release' && field.value === 'Dapex Fabric v3'));
  assert.ok(data.fields.some((field) => field.name === 'Address' && /mc\.example\.com/.test(field.value)));
  assert.ok(data.fields.some((field) => field.name === 'Client pack' && /play\.example\.com/.test(field.value)));
});
