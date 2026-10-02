import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { inspectZip, safeArchivePath } from '../src/archive.js';

function createZip(file, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name);
    zip.outputStream.pipe(createWriteStream(file)).on('close', resolve).on('error', reject);
    zip.end();
  });
}

test('inspects Fabric metadata without extracting the archive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dapex-archive-'));
  const file = path.join(directory, 'mod.jar');
  await createZip(file, { 'fabric.mod.json': JSON.stringify({ id: 'example', version: '1.0.0' }), 'example.class': 'bytes' });
  const result = await inspectZip(file);
  assert.equal(result.documents['fabric.mod.json'].id, 'example');
  assert.equal(result.entries.length, 2);
});

test('rejects traversal and absolute archive paths', () => {
  assert.equal(safeArchivePath('safe/mod.jar'), true);
  assert.equal(safeArchivePath('../escape.txt'), false);
  assert.equal(safeArchivePath('safe/../../escape.txt'), false);
  assert.equal(safeArchivePath('/etc/passwd'), false);
  assert.equal(safeArchivePath('windows\\escape.txt'), false);
});
