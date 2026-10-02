import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameControl } from '../src/game-control.js';

test('game control authenticates and sends a bounded switch target', async () => {
  const observed = [];
  const fetchImpl = async (url, options) => {
    observed.push({ url: String(url), options });
    return String(url).endsWith('/switch')
      ? { ok: true, json: async () => ({ id: 'operation-1', state: 'running' }) }
      : { ok: true, json: async () => ({ id: 'operation-1', state: 'complete', result: { active: 'minecraft' } }) };
  };
  const client = createGameControl({ controlApiUrl: 'http://127.0.0.1:8787', controlApiToken: 'secret' }, fetchImpl, async () => {});
  const result = await client.switchGame('minecraft');
  assert.equal(result.active, 'minecraft');
  assert.equal(observed[0].url, 'http://127.0.0.1:8787/api/admin/switch');
  assert.equal(observed[0].options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(observed[0].options.body), { target: 'minecraft' });
  assert.equal(observed[1].url, 'http://127.0.0.1:8787/api/admin/operations/operation-1');
});

test('whitelist uses the bounded controller API and validates usernames', async () => {
  const observed = [];
  const fetchImpl = async (url, options) => {
    observed.push({ url: String(url), options });
    return { ok: true, json: async () => ({ message: 'Added Alex' }) };
  };
  const client = createGameControl({ controlApiUrl: 'http://127.0.0.1:8787', controlApiToken: 'secret' }, fetchImpl);
  await client.minecraftWhitelist('add', 'Alex');
  assert.equal(observed[0].url, 'http://127.0.0.1:8787/api/admin/minecraft/whitelist');
  assert.equal(observed[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(observed[0].options.body), { username: 'Alex' });
  assert.throws(() => client.minecraftWhitelist('remove', 'bad;name'), /username/);
});
