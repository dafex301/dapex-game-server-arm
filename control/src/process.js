import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function run(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  });
  return result.stdout.trim();
}

export async function runOptional(file, args, options = {}) {
  try {
    return await run(file, args, options);
  } catch (error) {
    if (options.allowedExitCodes?.includes(error.code)) return error.stdout?.trim() || '';
    throw error;
  }
}
