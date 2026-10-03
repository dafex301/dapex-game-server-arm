import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  const bootstrap = path.join(deployDir, 'packwiz-installer-bootstrap.jar');
  await writeFile(bootstrap, 'test bootstrap');
  return {
    deployDir,
    profile: createProfiles({
      deployDir,
      stateDir: path.join(deployDir, 'runtime'),
      profileName: 'Dapex Fabric',
      minecraftVersion: '1.21.1',
      fabricLoaderVersion: '0.16.10',
      playerBaseUrl: 'https://play.example.test',
      packwizBootstrapFile: bootstrap,
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
  const manual = await profile.manualPackFile(1);
  await access(manual);
  const manualArchive = await inspectZip(manual, new Set(['manual-manifest.json']));
  assert(manualArchive.entries.some((entry) => entry.name === 'mods/example-1.0.0.jar'));
  assert.equal(manualArchive.documents['manual-manifest.json'].bundled[0].path, 'mods/example-1.0.0.jar');
  const auto = await profile.autoPackFile(1);
  const autoArchive = await inspectZip(auto);
  assert(autoArchive.entries.some((entry) => entry.name === 'minecraft/packwiz-installer-bootstrap.jar'));
  assert.match(await readFile(path.join(deployDir, 'runtime', 'profiles', 'dapex-fabric', 'packwiz', 'v1', 'pack.toml'), 'utf8'), /version = "1"/);
  assert.match(await readFile(path.join(deployDir, 'runtime', 'profiles', 'dapex-fabric', 'packwiz', 'v1', 'index.toml'), 'utf8'), /metafile = true/);
  assert(await profile.packwizPackFile(1));
  assert.equal(await profile.clientPackFile(99), null);
  assert.equal(await profile.manualPackFile(99), null);
  assert.equal(await profile.autoPackFile(99), null);
  assert.equal(await profile.packwizPackFile(99), null);
});

test('serializes concurrent uploads so every file remains in the draft', async () => {
  const { deployDir, profile } = await fixture();
  const first = path.join(deployDir, 'first.jar');
  const second = path.join(deployDir, 'second.jar');
  await Promise.all([
    createZip(first, { 'fabric.mod.json': JSON.stringify({ id: 'first', name: 'First', version: '1.0.0', environment: '*' }) }),
    createZip(second, { 'fabric.mod.json': JSON.stringify({ id: 'second', name: 'Second', version: '1.0.0', environment: '*' }) }),
  ]);
  await Promise.all([
    profile.importUpload(first, 'first.jar', 'test@example.com'),
    profile.importUpload(second, 'second.jar', 'test@example.com'),
  ]);
  const draft = await profile.draft();
  assert.deepEqual(draft.mods.map((mod) => mod.name).sort(), ['First', 'Second']);
});

test('blocks publishing when an uploaded mod requires a newer Fabric Loader', async () => {
  const { deployDir, profile } = await fixture();
  const upload = path.join(deployDir, 'future-loader.jar');
  await createZip(upload, { 'fabric.mod.json': JSON.stringify({ id: 'future-loader', name: 'Future Loader', version: '1.0.0', environment: '*', depends: { minecraft: '1.21.1', fabricloader: '>=0.19.0' } }) });
  await profile.importUpload(upload, 'future-loader.jar', 'test@example.com');
  const check = profile.compatibility(await profile.draft());
  assert.equal(check.ok, false);
  assert.match(check.issues[0].message, /Requires Fabric Loader >=0.19.0; configured 0.16.10/);
});

test('ignores an exact mod version duplicate and requires a decision for version conflicts', async () => {
  const { deployDir, profile } = await fixture();
  const first = path.join(deployDir, 'example-v1.jar');
  const duplicate = path.join(deployDir, 'example-v1-repacked.jar');
  const upgrade = path.join(deployDir, 'example-v2.jar');
  await createZip(first, { 'fabric.mod.json': JSON.stringify({ id: 'example', name: 'Example', version: '1.0.0', environment: '*' }) });
  await createZip(duplicate, { 'fabric.mod.json': JSON.stringify({ id: 'example', name: 'Example Repacked', version: '1.0.0', environment: '*' }), 'extra.txt': 'different archive' });
  await createZip(upgrade, { 'fabric.mod.json': JSON.stringify({ id: 'example', name: 'Example', version: '2.0.0', environment: '*' }) });
  await profile.importUpload(first, 'example-v1.jar', 'test@example.com');
  const ignored = await profile.importUpload(duplicate, 'example-v1-repacked.jar', 'test@example.com');
  assert.equal(ignored.upload.action, 'ignored');
  await assert.rejects(profile.importUpload(upgrade, 'example-v2.jar', 'test@example.com'), (error) => error.code === 'MOD_VERSION_CONFLICT' && error.conflict.existing.version === '1.0.0');
  const replacement = path.join(deployDir, 'example-v2-retry.jar');
  await createZip(replacement, { 'fabric.mod.json': JSON.stringify({ id: 'example', name: 'Example', version: '2.0.0', environment: '*' }) });
  await profile.importUpload(replacement, 'example-v2.jar', 'test@example.com', 'replace');
  assert.deepEqual((await profile.draft()).mods.map((mod) => mod.version), ['2.0.0']);
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
  const bootstrap = path.join(deployDir, 'packwiz-installer-bootstrap.jar');
  await writeFile(bootstrap, 'test bootstrap');
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
    const profile = createProfiles({ deployDir, stateDir: path.join(deployDir, 'runtime'), profileName: 'Dapex Fabric', minecraftVersion: '1.21.1', fabricLoaderVersion: '0.16.10', playerBaseUrl: 'https://play.example.test', packwizBootstrapFile: bootstrap, curseForgeApiKey: 'test-key' });
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
