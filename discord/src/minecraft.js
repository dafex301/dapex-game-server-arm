import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export function parsePlayerList(output = '') {
  const match = output.match(/There are (\d+) of a max of (\d+) players online(?::\s*(.*))?/i);
  if (!match) return { playerCount: null, maxPlayers: null, players: [] };
  return {
    playerCount: Number(match[1]),
    maxPlayers: Number(match[2]),
    players: match[3] ? match[3].split(',').map((name) => name.trim()).filter(Boolean) : [],
  };
}

export function createMinecraft(config, run = execFileAsync) {
  async function rcon(args) {
    const { stdout = '' } = await run('docker', ['exec', config.minecraftContainer, 'rcon-cli', ...args], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  return {
    async players() {
      try { return parsePlayerList(await rcon(['list'])); }
      catch { return { playerCount: null, maxPlayers: null, players: [] }; }
    },
  };
}
