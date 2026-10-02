import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export function safeArchivePath(name) {
  return name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !name.includes('\0');
}

export function inspectZip(file, wanted = new Set(['fabric.mod.json', 'modrinth.index.json', 'manifest.json'])) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = [];
      const documents = {};
      let expandedBytes = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };

      zip.on('error', fail);
      zip.on('entry', (entry) => {
        if (!safeArchivePath(entry.fileName)) return fail(new Error(`Unsafe archive path: ${entry.fileName}`));
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixType === 0o120000) return fail(new Error(`Symbolic links are not allowed in uploads: ${entry.fileName}`));
        if (entries.length >= 10_000) return fail(new Error('Archive contains too many files'));
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > 2 * 1024 * 1024 * 1024) return fail(new Error('Archive expands beyond the 2 GiB safety limit'));
        entries.push({ name: entry.fileName, size: entry.uncompressedSize });
        const basename = entry.fileName.split('/').at(-1);
        if (!wanted.has(entry.fileName) && !wanted.has(basename)) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > 4 * 1024 * 1024) return fail(new Error(`Metadata file is unexpectedly large: ${entry.fileName}`));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          const chunks = [];
          let bytes = 0;
          stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) stream.destroy(new Error('Metadata exceeds safety limit'));
            else chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => {
            try {
              documents[basename] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              zip.readEntry();
            } catch (error) {
              fail(new Error(`Invalid JSON in ${entry.fileName}: ${error.message}`));
            }
          });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, documents, expandedBytes });
      });
      zip.readEntry();
    });
  });
}

export function hasZipMagic(file) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start: 0, end: 3 });
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).subarray(0, 2).equals(Buffer.from('PK'))));
  });
}

export function extractZipPrefix(file, prefix, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let expandedBytes = 0;
      let entries = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('entry', async (entry) => {
        try {
          if (!safeArchivePath(entry.fileName)) throw new Error(`Unsafe archive path: ${entry.fileName}`);
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixType === 0o120000) throw new Error(`Symbolic links are not allowed: ${entry.fileName}`);
          if (++entries > 10_000) throw new Error('Archive contains too many files');
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > 2 * 1024 * 1024 * 1024) throw new Error('Archive expands beyond the 2 GiB safety limit');
          if (!entry.fileName.startsWith(prefix) || entry.fileName.endsWith('/')) { zip.readEntry(); return; }
          const relative = entry.fileName.slice(prefix.length);
          if (!safeArchivePath(relative)) throw new Error(`Unsafe override path: ${relative}`);
          const target = path.join(destination, relative);
          await mkdir(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            void pipeline(stream, createWriteStream(target, { mode: 0o600 })).then(() => zip.readEntry(), fail);
          });
        } catch (error) { fail(error); }
      });
      zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.readEntry();
    });
  });
}
