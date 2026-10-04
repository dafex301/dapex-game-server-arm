import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { minecraftCommand } from './docker.js';

const blocked = new Map([
  ['stop', 'Use Enter Maintenance so the control plane can stop Minecraft safely.'],
  ['save-off', 'Disabling world saves from the web console is blocked.'],
]);

export function normalizeRconCommand(value) {
  const command = String(value ?? '').trim().replace(/^\/+/, '').trim();
  if (!command || command.length > 512 || /[\u0000-\u001f\u007f]/.test(command)) throw new Error('Command must be one line between 1 and 512 characters');
  const root = command.split(/\s+/, 1)[0].toLowerCase().split(':').pop();
  if (blocked.has(root)) {
    const error = new Error(blocked.get(root));
    error.status = 409;
    throw error;
  }
  const nested = command.match(/\brun\s+(?:minecraft:)?(stop|save-off)(?:\s|$)/i)?.[1]?.toLowerCase();
  if (nested && blocked.has(nested)) {
    const error = new Error(blocked.get(nested));
    error.status = 409;
    throw error;
  }
  return command;
}

export function createRconConsole(config, dependencies = { minecraftCommand }) {
  const auditFile = path.join(config.stateDir, 'rcon-history.jsonl');

  async function history(limit = 30) {
    const text = await readFile(auditFile, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    return text.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse();
  }

  async function execute(rawCommand, actor) {
    const command = normalizeRconCommand(rawCommand);
    const startedAt = new Date().toISOString();
    let output;
    let ok = true;
    try {
      output = await dependencies.minecraftCommand(config.minecraftContainer, command);
    } catch (error) {
      ok = false;
      output = error.message || 'RCON command failed';
      throw error;
    } finally {
      const audit = { startedAt, actor: String(actor || 'unknown').slice(0, 200), command, output: output || '(Command completed with no output)', ok };
      await mkdir(path.dirname(auditFile), { recursive: true });
      await appendFile(auditFile, `${JSON.stringify(audit)}\n`, { mode: 0o600 });
    }
    return { startedAt, actor, command, output: output || '(Command completed with no output)', ok };
  }

  return { execute, history };
}
