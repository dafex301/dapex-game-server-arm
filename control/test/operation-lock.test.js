import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('serializes profile publication and game switching with the same operation lock', async () => {
  const [server, orchestrator, publisher] = await Promise.all([
    source('server.js'),
    source('orchestrator.js'),
    source('publish-cli.js'),
  ]);

  assert.match(server, /flock[^\n]+config\.operationLock[^\n]+publish-cli\.js|publish-cli\.js[\s\S]+config\.operationLock/);
  assert.match(orchestrator, /flock', \['-w', '900', config\.operationLock/);
  assert.match(publisher, /status\.active === 'minecraft'/);
  assert.match(publisher, /createProfiles\(config\)\.publish\(actor\)/);
});
