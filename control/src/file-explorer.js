import { createReadStream } from 'node:fs';
import { lstat, mkdir, open as openFile, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';

const textExtensions = new Set(['.json', '.json5', '.toml', '.yaml', '.yml', '.properties', '.conf', '.cfg', '.txt', '.md']);
const hiddenNames = new Set(['.rcon-cli.env', '.rcon-cli.yaml', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json', 'server.properties']);
const safeUploadName = /^[A-Za-z0-9][A-Za-z0-9._ +()[\]-]{0,127}$/;

export function safeRelativePath(value = '') {
  return typeof value === 'string' && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..');
}

export function parseMinecraftLogLine(raw) {
  const match = raw.match(/^\[([^\]]+)] \[([^/]+)\/([A-Z]+)]:\s?(.*)$/);
  const entry = match ? { timestamp: match[1], thread: match[2], level: match[3].toLowerCase(), message: match[4], raw } : { timestamp: null, thread: null, level: 'info', message: raw, raw };
  if (/error|fatal/i.test(entry.level) || /exception|failed to|network protocol|crash/i.test(entry.message)) entry.kind = 'error';
  else if (/warn/i.test(entry.level)) entry.kind = 'warn';
  else if (/joined the game|lost connection|left the game|logged in/i.test(entry.message)) entry.kind = 'player';
  else entry.kind = 'info';
  return entry;
}

export function createFileExplorer(config, management, dependencies = { run }) {
  const dataDir = path.join(config.deployDir, 'minecraft', 'data');

  async function scopes() {
    const current = (await management.overview()).world.name;
    return {
      config: { root: path.join(dataDir, 'config'), writable: true, description: 'Mod and server-side configuration' },
      datapacks: { root: path.join(dataDir, current, 'datapacks'), writable: true, description: 'Datapacks for the active world' },
      resourcepacks: { root: path.join(dataDir, 'resourcepacks'), writable: true, description: 'Server resource-pack files' },
      world: { root: path.join(dataDir, current), writable: false, description: 'Active world data (read-only)' },
      logs: { root: path.join(dataDir, 'logs'), writable: false, description: 'Runtime logs (read-only)' },
      crashes: { root: path.join(dataDir, 'crash-reports'), writable: false, description: 'Crash reports (read-only)' },
    };
  }

  async function ensureRoot(scope) {
    await mkdir(scope.root, { recursive: true }).catch(async (error) => {
      if (error.code !== 'EACCES') throw error;
      await dependencies.run('sudo', ['mkdir', '-p', '--', scope.root]);
      await dependencies.run('sudo', ['chown', '--reference', path.dirname(scope.root), scope.root]);
    });
  }

  async function resolve(scopeName, relative = '') {
    if (!safeRelativePath(relative)) throw new Error('Unsafe file path');
    const available = await scopes();
    const scope = available[scopeName];
    if (!scope) throw new Error('Unknown Minecraft file area');
    const target = path.resolve(scope.root, relative || '.');
    if (target !== path.resolve(scope.root) && !target.startsWith(`${path.resolve(scope.root)}${path.sep}`)) throw new Error('File path escapes its Minecraft area');
    const segments = relative.split('/').filter(Boolean);
    if (segments.some((segment) => segment.startsWith('.') || hiddenNames.has(segment))) throw new Error('Protected Minecraft file');
    let cursor = scope.root;
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      const details = await lstat(cursor).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (details?.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    }
    return { ...scope, scopeName, target, relative };
  }

  async function list(scopeName, relative = '') {
    const location = await resolve(scopeName, relative);
    const details = await lstat(location.target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!details) return { scope: scopeName, path: relative, writable: location.writable, description: location.description, entries: [] };
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('Requested path is not a safe directory');
    const names = (await readdir(location.target)).filter((name) => !hiddenNames.has(name) && !name.startsWith('.')).slice(0, 1000);
    const entries = await Promise.all(names.map(async (name) => {
      const item = await lstat(path.join(location.target, name));
      if (item.isSymbolicLink()) return null;
      return { name, type: item.isDirectory() ? 'directory' : 'file', size: item.size, modifiedAt: item.mtime.toISOString(), editable: item.isFile() && textExtensions.has(path.extname(name).toLowerCase()) && item.size <= 2 * 1024 * 1024 };
    }));
    return { scope: scopeName, path: relative, writable: location.writable, description: location.description, entries: entries.filter(Boolean).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1) };
  }

  async function readText(scopeName, relative) {
    const location = await resolve(scopeName, relative);
    const details = await lstat(location.target);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 2 * 1024 * 1024 || !textExtensions.has(path.extname(location.target).toLowerCase())) throw new Error('File is not an editable text document');
    return { content: await readFile(location.target, 'utf8'), modifiedAt: details.mtime.toISOString(), writable: location.writable };
  }

  async function mutate(scopeName, relative, operation) {
    const location = await resolve(scopeName, relative);
    if (!location.writable) throw new Error('This Minecraft area is read-only');
    const existing = await lstat(location.target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new Error('Symbolic links cannot be changed');
    await management.backup();
    await ensureRoot(location);
    await operation(location);
    return list(scopeName, path.dirname(relative) === '.' ? '' : path.dirname(relative));
  }

  async function saveText(scopeName, relative, content) {
    if (Buffer.byteLength(content) > 2 * 1024 * 1024 || !textExtensions.has(path.extname(relative).toLowerCase())) throw new Error('Only small configuration text files can be edited');
    return mutate(scopeName, relative, async ({ target }) => {
      const incoming = path.join(config.stateDir, 'incoming');
      await mkdir(incoming, { recursive: true });
      const temporary = path.join(incoming, `edit-${process.pid}-${Date.now()}.tmp`);
      await writeFile(temporary, content, { mode: 0o660 });
      try {
        await dependencies.run('sudo', ['install', '-m', '0660', temporary, target]);
        await dependencies.run('sudo', ['chown', '--reference', path.dirname(target), target]);
      } finally { await rm(temporary, { force: true }); }
    });
  }

  async function upload(scopeName, relativeDirectory, uploadedFile) {
    const safeName = path.basename(uploadedFile.originalname);
    if (!safeUploadName.test(safeName) || safeName !== uploadedFile.originalname || hiddenNames.has(safeName) || safeName.startsWith('.')) throw new Error('Unsafe upload filename');
    const relative = path.posix.join(relativeDirectory || '', safeName);
    return mutate(scopeName, relative, async ({ target }) => {
      await dependencies.run('sudo', ['mkdir', '-p', '--', path.dirname(target)]);
      await dependencies.run('sudo', ['install', '-m', '0660', uploadedFile.path, target]);
      await dependencies.run('sudo', ['chown', '--reference', path.dirname(target), target]);
      await rm(uploadedFile.path, { force: true });
    });
  }

  async function createDirectory(scopeName, relative) {
    const name = path.posix.basename(relative);
    if (!safeUploadName.test(name) || name.startsWith('.') || hiddenNames.has(name)) throw new Error('Unsafe folder name');
    return mutate(scopeName, relative, async ({ target }) => {
      await dependencies.run('sudo', ['mkdir', '-p', '--', target]);
      await dependencies.run('sudo', ['chown', '--reference', path.dirname(target), target]);
    });
  }

  async function remove(scopeName, relative) {
    if (!relative) throw new Error('The root folder cannot be deleted');
    return mutate(scopeName, relative, async ({ target }) => dependencies.run('sudo', ['rm', '-rf', '--', target]));
  }

  async function download(scopeName, relative) {
    const location = await resolve(scopeName, relative);
    const canonical = await realpath(location.target);
    if (canonical !== location.target) throw new Error('Symbolic links are not downloadable');
    const details = await stat(canonical);
    if (!details.isFile() || details.size > 512 * 1024 * 1024) throw new Error('Only files up to 512 MiB can be downloaded');
    return { stream: createReadStream(canonical), name: path.basename(canonical), size: details.size };
  }

  async function latestLog(limit = 250) {
    const logFile = path.join(dataDir, 'logs', 'latest.log');
    const details = await stat(logFile).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!details) return { source: 'latest.log', modifiedAt: null, entries: [], crashes: [] };
    const readSize = Math.min(details.size, 512 * 1024);
    const buffer = Buffer.alloc(readSize);
    const handle = await openFile(logFile, 'r');
    try { await handle.read(buffer, 0, readSize, details.size - readSize); } finally { await handle.close(); }
    let text = buffer.toString('utf8');
    if (details.size > readSize) text = text.slice(text.indexOf('\n') + 1);
    const entries = text.split(/\r?\n/).filter(Boolean).slice(-limit).map(parseMinecraftLogLine);
    const crashDir = path.join(dataDir, 'crash-reports');
    const crashNames = await readdir(crashDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const crashes = (await Promise.all(crashNames.filter((name) => !name.startsWith('.')).map(async (name) => {
      const crash = await stat(path.join(crashDir, name));
      return crash.isFile() ? { name, modifiedAt: crash.mtime.toISOString(), size: crash.size } : null;
    }))).filter(Boolean).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 5);
    return { source: 'latest.log', modifiedAt: details.mtime.toISOString(), entries, crashes };
  }

  return { list, readText, saveText, upload, createDirectory, remove, download, latestLog };
}
