import { run, runOptional } from './process.js';

export async function inspectContainer(name) {
  const output = await runOptional('docker', ['inspect', name], { allowedExitCodes: [1] });
  if (!output) return { name, exists: false, running: false };
  const [inspect] = JSON.parse(output);
  return {
    name,
    exists: true,
    running: Boolean(inspect.State?.Running),
    status: inspect.State?.Status || 'unknown',
    health: inspect.State?.Health?.Status || null,
    startedAt: inspect.State?.StartedAt || null,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    memoryLimitBytes: inspect.HostConfig?.Memory || 0,
    cpuLimit: inspect.HostConfig?.NanoCpus ? inspect.HostConfig.NanoCpus / 1_000_000_000 : null,
    image: inspect.Config?.Image || null,
  };
}

export async function containerStats(name) {
  const output = await runOptional('docker', ['stats', '--no-stream', '--format', '{{json .}}', name], { allowedExitCodes: [1] });
  if (!output) return null;
  const value = JSON.parse(output);
  return { cpu: value.CPUPerc, memory: value.MemUsage, memoryPercent: value.MemPerc };
}

export async function stopContainer(name, timeoutSeconds = 120) {
  await run('docker', ['stop', '--time', String(timeoutSeconds), name], { timeout: (timeoutSeconds + 15) * 1000 });
}

export async function startContainer(name) {
  await run('docker', ['start', name], { timeout: 180_000 });
}

export async function containerLogs(name, since = null) {
  const args = ['logs', '--tail', '500'];
  if (since) args.push('--since', since);
  args.push(name);
  return runOptional('docker', args, { allowedExitCodes: [1], timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
}
