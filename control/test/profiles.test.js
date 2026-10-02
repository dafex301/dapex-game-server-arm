import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { inspectZip } from '../src/archive.js';
import { createProfiles } from '../src/profiles.js';

function createZip(file, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name);
    zip.outputStream.pipe(createWriteStream(file)).on('close', resolve).on('error', reject);
    zip.end();
  });
}

async function fixture() {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), 'dapex-profile-'));
  return {
    deployDir,
    profile: createProfiles({
      deployDir,
      stateDir: path.join(deployDir, 'runtime'),
      profileName: 'Dapex Fabric',
      minecraftVersion: '1.21.1',
      fabricLoaderVersion: '0.16.10',
    }),
  };
}

test('publishes uploaded Fabric jars into server mods and an importable MRPACK', async () => {
  const { deployDir, profile } = await fixture();
  const upload = path.join(deployDir, 'incoming.jar');
  await createZip(upload, { 'fabric.mod.json': JSON.stringify({ id: 'example', name: 'Example', version: '1.0.0', environment: '*' }) });
  await profile.importUpload(upload, 'example.jar', 'test@example.com');
  const published = await profile.publish('test@example.com');
  assert.equal(published.release, 1);
  await access(path.join(deployDir, 'minecraft', 'generated', 'server-mods', 'example-1.0.0.jar'));
  const pack = path.join(deployDir, 'minecraft', 'generated', 'dapex-fabric-v1.mrpack');
  const inspected = await inspectZip(pack);
  assert.equal(inspected.documents['modrinth.index.json'].dependencies.minecraft, '1.21.1');
  assert.equal(inspected.documents['modrinth.index.json'].dependencies['fabric-loader'], '0.16.10');
  assert(inspected.entries.some((entry) => entry.name === 'overrides/mods/example-1.0.0.jar'));
  assert.equal(JSON.parse(await readFile(path.join(deployDir, 'minecraft', 'generated', 'profile.json'))).release, 1);
  await access(await profile.clientPackFile(1));
  assert.equal(await profile.clientPackFile(99), null);
});

test('blocks a CurseForge pack archive instead of silently publishing an incomplete release', async () => {
  const { deployDir, profile } = await fixture();
  const upload = path.join(deployDir, 'pack.zip');
  await createZip(upload, { 'manifest.json': JSON.stringify({ name: 'Example Pack', version: '1', minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.10' }] }, files: [] }) });
  await profile.importUpload(upload, 'pack.zip', 'test@example.com');
  await assert.rejects(profile.publish('test@example.com'), /CURSEFORGE_API_KEY/);
});

test('resolves a CurseForge pack into server mods, overrides, and the client MRPACK', async () => {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), 'dapex-profile-'));
  const jar = path.join(deployDir, 'curse-mod.jar');
  await createZip(jar, { 'fabric.mod.json': JSON.stringify({ id: 'curse-example', name: 'Curse Example', version: '2.0.0', environment: '*' }) });
  const jarBytes = await readFile(jar);
  const sha1 = createHash('sha1').update(jarBytes).digest('hex');
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === 'https://cdn.example/mod.jar') return new Response(jarBytes);
    return new Response(JSON.stringify({ data: { fileName: 'curse-example.jar', fileLength: jarBytes.length, downloadUrl: 'https://cdn.example/mod.jar', hashes: [{ algo: 1, value: sha1 }] } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const profile = createProfiles({ deployDir, stateDir: path.join(deployDir, 'runtime'), profileName: 'Dapex Fabric', minecraftVersion: '1.21.1', fabricLoaderVersion: '0.16.10', curseForgeApiKey: 'test-key' });
    const upload = path.join(deployDir, 'pack.zip');
    await createZip(upload, {
      'manifest.json': JSON.stringify({ name: 'Example Pack', version: '1', minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.10' }] }, files: [{ projectID: 10, fileID: 20, required: true }], overrides: 'overrides' }),
      'overrides/config/example.json': '{"enabled":true}',
    });
    await profile.importUpload(upload, 'pack.zip', 'test@example.com');
    await profile.publish('test@example.com');
    await access(path.join(deployDir, 'minecraft', 'generated', 'server-mods', 'curse-example.jar'));
    await access(path.join(deployDir, 'minecraft', 'generated', 'server-overrides', 'config', 'example.json'));
    const inspected = await inspectZip(path.join(deployDir, 'minecraft', 'generated', 'dapex-fabric-v1.mrpack'));
    assert(inspected.entries.some((entry) => entry.name === 'overrides/config/example.json'));
    assert.equal(inspected.documents['modrinth.index.json'].files[0].hashes.sha1, sha1);
  } finally {
    global.fetch = originalFetch;
  }
});
