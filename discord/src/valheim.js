import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function safeName(value, label) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`Unsafe ${label}`);
  return value;
}

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

export function parseJoinCode(logs) {
  const matches = [...logs.matchAll(/join code\s*[:=]?\s*`?(\d{4,10})`?/gi)];
  return matches.at(-1)?.[1] ?? null;
}

export function parsePlayers(logs) {
  const players = new Set();
  for (const line of logs.split(/\r?\n/)) {
    let match = line.match(/Got character ZDOID from\s+(.+?)\s*:\s*\d+/i)
      || line.match(/(?:Player joined|Got connection SteamID).*?[: ]\s*([^,:]+)$/i);
    if (match) players.add(match[1].trim());
    match = line.match(/(?:Player disconnected|Closing socket for|connection lost).*?[: ]\s*([^,:]+)$/i);
    if (match) players.delete(match[1].trim());
  }
  return [...players].slice(0, 20);
}

export function parsePlayerCount(logs) {
  const matches = [...logs.matchAll(/now\s+(\d+)\s+player\(s\)/gi)];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : null;
}

export function parseMemoryUsageGiB(value) {
  const used = value?.split('/')[0]?.trim();
  const match = used?.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]i?B)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const factors = { KB: 1 / 1024 / 1024, KIB: 1 / 1024 / 1024, MB: 1 / 1024, MIB: 1 / 1024, GB: 1, GIB: 1, TB: 1024, TIB: 1024 };
  return amount * factors[unit];
}

export function classifyStatus(inspect, hasGameProcess, logs) {
  if (!inspect) return 'down';
  if (inspect.State?.Restarting) return 'restarting';
  if (!inspect.State?.Running) return 'down';
  if (!hasGameProcess) return 'degraded';
  if (/join code|session.*active|game server connected/i.test(logs)) return 'online';
  return 'starting';
}

const watchdogStatuses = new Set(['online', 'starting', 'restarting', 'maintenance', 'inactive', 'down', 'unknown']);

export function mergeWatchdogStatus(direct, watchdog, now = new Date(), maxAgeMs = 180_000) {
  if (!watchdog || watchdog.schema_version !== 1 || !watchdogStatuses.has(watchdog.status)) return direct;
  const observedMs = Date.parse(watchdog.observed_at);
  if (!Number.isFinite(observedMs) || now.getTime() - observedMs < 0 || now.getTime() - observedMs > maxAgeMs) return direct;
  if (watchdog.container?.name && watchdog.container.name !== direct.container) return direct;

  const watchdogStart = watchdog.container?.started_at || null;
  const exactStart = Boolean(watchdogStart && direct.startedAt && watchdogStart === direct.startedAt);
  const sameStoppedState = !watchdogStart && watchdog.container?.running === false && direct.running === false;
  const intentionalStop = ['maintenance', 'inactive'].includes(watchdog.status) && !watchdogStart;
  if (!exactStart && !sameStoppedState && !intentionalStop) return direct;

  return {
    ...direct,
    state: watchdog.status,
    reason: watchdog.reason || null,
    action: watchdog.action || 'none',
    recovery: watchdog.recovery || null,
    watchdogObservedAt: watchdog.observed_at,
    watchdogFresh: true,
    joinCode: exactStart ? (watchdog.connection?.join_code || null) : direct.joinCode,
  };
}

export function createValheim(config, overrides = {}) {
  const run = overrides.run ?? (async (file, args, options = {}) => {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeout ?? 20_000,
      cwd: options.cwd,
    });
    return result.stdout;
  });

  const container = safeName(config.container, 'container name');

  async function docker(args, options) {
    return run('docker', args, options);
  }

  async function inspectContainer() {
    try {
      const output = await docker(['inspect', container]);
      return JSON.parse(output)[0] ?? null;
    } catch {
      return null;
    }
  }

  async function getStatus() {
    const checkedAt = new Date();
    const inspect = await inspectContainer();
    let logs = '';
    let hasGameProcess = false;
    let stats = null;

    if (inspect?.State?.Running) {
      [logs, hasGameProcess, stats] = await Promise.all([
        docker(['logs', '--since', inspect.State.StartedAt, '--tail', '2500', container]).catch(() => ''),
        docker(['exec', container, 'pgrep', '-f', 'valheim_server']).then(() => true).catch(() => false),
        docker(['stats', '--no-stream', '--format', '{{json .}}', container])
          .then((text) => JSON.parse(text.trim())).catch(() => null),
      ]);
    }

    const env = await readFile(`${config.deployDir}/.env`, 'utf8').then(parseEnv).catch(() => ({}));
    const state = classifyStatus(inspect, hasGameProcess, logs);
    const direct = {
      state,
      checkedAt,
      container,
      running: inspect?.State?.Running ?? false,
      startedAt: inspect?.State?.StartedAt || null,
      restartCount: inspect?.RestartCount ?? 0,
      exitCode: inspect?.State?.ExitCode ?? null,
      oomKilled: inspect?.State?.OOMKilled ?? false,
      memory: stats?.MemUsage || null,
      cpu: stats?.CPUPerc || null,
      serverName: env.SERVER_NAME || 'Valheim',
      world: env.SERVER_WORLD || 'unknown',
      joinCode: state === 'online' ? parseJoinCode(logs) : null,
      playerCount: state === 'online' ? parsePlayerCount(logs) : 0,
      // Vanilla logs publish an authoritative count but do not identify which
      // player disconnected. Character ZDOID lines are historical activity,
      // not a live roster, so never present them as currently connected users.
      players: [],
    };
    if (!config.watchdogStateFile) return direct;
    const watchdog = await readFile(config.watchdogStateFile, 'utf8')
      .then((text) => JSON.parse(text)).catch(() => null);
    return mergeWatchdogStatus(direct, watchdog, checkedAt, config.watchdogMaxAgeMs);
  }

  async function restart() {
    await run('/usr/bin/flock', [
      '-w', '5', path.join(config.deployDir, '.maintenance.lock'),
      'docker', 'restart', '--time', '120', container,
    ], { timeout: 180_000 });
    return getStatus();
  }

  async function backup() {
    await run(`${config.deployDir}/scripts/backup.sh`, [], {
      cwd: config.deployDir,
      timeout: 300_000,
    });
    const backupDir = path.join(config.deployDir, 'backups');
    const archives = await readdir(backupDir);
    const candidates = await Promise.all(archives.filter((name) => name.endsWith('.tar.gz')).map(async (name) => ({
      name,
      modified: (await stat(path.join(backupDir, name))).mtimeMs,
    })));
    return candidates.sort((a, b) => b.modified - a.modified)[0]?.name || 'archive created';
  }

  return { getStatus, restart, backup };
}
