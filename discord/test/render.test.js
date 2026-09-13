import test from 'node:test';
import assert from 'node:assert/strict';
import { statusEmbed, transitionEmbed } from '../src/render.js';

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
