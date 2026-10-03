import { mkdir, readFile, readdir, rm, stat, statfs, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';

const editable = new Set(['MOTD', 'MAX_PLAYERS', 'DIFFICULTY', 'MODE', 'VIEW_DISTANCE', 'SIMULATION_DISTANCE', 'PVP', 'ALLOW_FLIGHT', 'ENABLE_COMMAND_BLOCK']);

function parseEnv(text) {
  return new Map(text.split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf('=');
    return split < 0 ? [line, ''] : [line.slice(0, split), line.slice(split + 1)];
  }));
}

function safeValue(key, value) {
  const raw = String(value).trim();
  if (['MAX_PLAYERS', 'VIEW_DISTANCE', 'SIMULATION_DISTANCE'].includes(key)) {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 2 || number > (key === 'MAX_PLAYERS' ? 100 : 32)) throw new Error(`${key} is outside the allowed range`);
  }
  if (key === 'DIFFICULTY' && !['peaceful', 'easy', 'normal', 'hard'].includes(raw)) throw new Error('Unsupported difficulty');
  if (key === 'MODE' && !['survival', 'creative', 'adventure', 'spectator'].includes(raw)) throw new Error('Unsupported game mode');
  if (['PVP', 'ALLOW_FLIGHT', 'ENABLE_COMMAND_BLOCK'].includes(key) && !['TRUE', 'FALSE'].includes(raw.toUpperCase())) throw new Error(`${key} must be true or false`);
  if (raw.length > 120 || /[\r\n]/.test(raw)) throw new Error(`${key} is invalid`);
  return raw;
}

export function createManagement(config, dependencies = { run }) {
  const envFile = path.join(config.deployDir, 'minecraft', '.env');
  const backupDir = path.join(config.deployDir, 'backups', 'minecraft');

  async function environment() { return parseEnv(await readFile(envFile, 'utf8')); }
  async function writeEnvironment(env) {
    const temporary = `${envFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${[...env].map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
    await rename(temporary, envFile);
  }
  async function overview() {
    const env = await environment();
    const disk = await statfs(config.deployDir);
    await mkdir(backupDir, { recursive: true });
    const entries = await readdir(backupDir);
    const backups = (await Promise.all(entries.filter((name) => /^dapex-fabric-.*\.tar\.gz$/.test(name)).map(async (name) => {
      const details = await stat(path.join(backupDir, name));
      return { name, size: details.size, createdAt: details.mtime.toISOString() };
    }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      disk: { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize, reserve: 15 * 1024 ** 3, localBackupLimit: 8 * 1024 ** 3 },
      backups,
      retention: { count: 5, days: 7, maxBytes: 8 * 1024 ** 3 },
      settings: Object.fromEntries([...editable].map((key) => [key, env.get(key) || ''])),
      world: { name: env.get('LEVEL') || 'world', seed: env.get('SEED') || '' },
    };
  }

  async function updateSettings(changes) {
    const env = await environment();
    for (const [key, value] of Object.entries(changes)) {
      if (!editable.has(key)) throw new Error(`Setting ${key} is not editable`);
      env.set(key, safeValue(key, value));
    }
    await writeEnvironment(env);
    return overview();
  }

  async function backup() {
    const output = await dependencies.run(path.join(config.deployDir, 'scripts', 'backup-minecraft.sh'), [], { cwd: config.deployDir, timeout: 600_000 });
    return { archive: output.trim(), ...(await overview()) };
  }

  async function resetWorld({ name, seed = '' }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error('World name must use 1–64 safe filename characters');
    if (String(seed).length > 128 || /[\r\n]/.test(String(seed))) throw new Error('Seed is invalid');
    const env = await environment();
    const current = env.get('LEVEL') || 'world';
    await backup();
    const dataDir = path.join(config.deployDir, 'minecraft', 'data');
    const currentWorld = path.resolve(dataDir, current);
    if (path.dirname(currentWorld) !== path.resolve(dataDir)) throw new Error('Current world path is unsafe');
    await rm(currentWorld, { recursive: true, force: true });
    env.set('LEVEL', name);
    if (String(seed).trim()) env.set('SEED', String(seed).trim()); else env.delete('SEED');
    await writeEnvironment(env);
    await dependencies.run('docker', ['rm', config.minecraftContainer], { timeout: 30_000 }).catch((error) => {
      if (!/No such container/i.test(error.message || '')) throw error;
    });
    return overview();
  }

  return { overview, updateSettings, backup, resetWorld };
}
