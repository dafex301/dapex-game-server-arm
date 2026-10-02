import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, mergeWatchdogStatus, parseEnv, parseJoinCode, parseMemoryUsageGiB, parsePlayerCount, parsePlayers } from '../src/valheim.js';

test('parseEnv preserves values containing spaces and equals signs', () => {
  assert.deepEqual(parseEnv('SERVER_NAME=mbg enak\nTOKEN=a=b\n# ignored\n'), {
    SERVER_NAME: 'mbg enak',
    TOKEN: 'a=b',
  });
});

test('parseJoinCode returns the latest code', () => {
  assert.equal(parseJoinCode('Join code: 123456\nnew join code `654321`'), '654321');
  assert.equal(parseJoinCode('nothing useful'), null);
});

test('parsePlayers replays joins and disconnects', () => {
  const logs = [
    'Got character ZDOID from Alice : 1:2',
    'Got character ZDOID from Bob : 3:4',
    'Player disconnected: Alice',
  ].join('\n');
  assert.deepEqual(parsePlayers(logs), ['Bob']);
});

test('parsePlayerCount returns the latest authoritative log count', () => {
  assert.equal(parsePlayerCount('now 2 player(s)\nnow 5 player(s)'), 5);
  assert.equal(parsePlayerCount('no count here'), null);
});

test('parseMemoryUsageGiB parses Docker memory usage', () => {
  assert.equal(parseMemoryUsageGiB('7.25GiB / 9GiB'), 7.25);
  assert.equal(parseMemoryUsageGiB('7168MiB / 9GiB'), 7);
  assert.equal(parseMemoryUsageGiB(null), null);
});

test('classifyStatus distinguishes container and game health', () => {
  assert.equal(classifyStatus(null, false, ''), 'down');
  assert.equal(classifyStatus({ State: { Restarting: true } }, false, ''), 'restarting');
  assert.equal(classifyStatus({ State: { Running: true } }, false, ''), 'degraded');
  assert.equal(classifyStatus({ State: { Running: true } }, true, ''), 'starting');
  assert.equal(classifyStatus({ State: { Running: true } }, true, 'PlayFab session active'), 'online');
});

test('fresh watchdog state for the current container start is authoritative', () => {
  const now = new Date('2026-09-13T16:02:00Z');
  const direct = {
    state: 'starting', container: 'valheim', running: true,
    startedAt: '2026-09-13T16:00:00Z', joinCode: null, memory: '3GiB / 8GiB',
  };
  const watchdog = {
    schema_version: 1, status: 'restarting', reason: 'automatic recovery initiated', action: 'restart',
    observed_at: '2026-09-13T16:01:00Z',
    container: { name: 'valheim', running: true, started_at: '2026-09-13T16:00:00Z' },
    connection: { join_code: '654321' },
    recovery: { attempts_in_window: 1, max_attempts_per_window: 3 },
  };
  const merged = mergeWatchdogStatus(direct, watchdog, now, 180_000);
  assert.equal(merged.state, 'restarting');
  assert.equal(merged.reason, watchdog.reason);
  assert.equal(merged.joinCode, '654321');
  assert.equal(merged.memory, direct.memory);
});

test('stale or different-start watchdog state is ignored', () => {
  const direct = { state: 'online', container: 'valheim', running: true, startedAt: 'new' };
  const stale = {
    schema_version: 1, status: 'down', observed_at: '2026-09-13T15:00:00Z',
    container: { name: 'valheim', running: true, started_at: 'new' },
  };
  assert.equal(mergeWatchdogStatus(direct, stale, new Date('2026-09-13T16:00:00Z'), 180_000), direct);
  const differentStart = { ...stale, observed_at: '2026-09-13T15:59:30Z', container: { ...stale.container, started_at: 'old' } };
  assert.equal(mergeWatchdogStatus(direct, differentStart, new Date('2026-09-13T16:00:00Z'), 180_000), direct);
});

test('fresh maintenance state is accepted while container observation is locked', () => {
  const direct = { state: 'down', container: 'valheim', running: false, startedAt: null };
  const watchdog = {
    schema_version: 1, status: 'maintenance', reason: 'backup lock held', action: 'none',
    observed_at: '2026-09-13T15:59:30Z', container: { name: 'valheim', running: false, started_at: '' },
  };
  assert.equal(mergeWatchdogStatus(direct, watchdog, new Date('2026-09-13T16:00:00Z')).state, 'maintenance');
});
