import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinecraft, parsePlayerList } from '../src/minecraft.js';

test('parses the vanilla RCON player list', () => {
  assert.deepEqual(parsePlayerList('There are 2 of a max of 20 players online: Alex, Steve'), {
    playerCount: 2, maxPlayers: 20, players: ['Alex', 'Steve'],
  });
});
