import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from './config.js';
import { inspectContainer } from './docker.js';
import { writeJsonAtomic } from './files.js';

const config = loadConfig();
const [valheim, minecraft] = await Promise.all([
  inspectContainer(config.valheimContainer),
  inspectContainer(config.minecraftContainer),
]);
if (valheim.running && minecraft.running) throw new Error('Cannot initialize: both game containers are running');
const desired = valheim.running ? 'valheim' : minecraft.running ? 'minecraft' : 'none';
await writeJsonAtomic(path.join(config.stateDir, 'game-slot.json'), {
  desired,
  transition: null,
  updatedAt: new Date().toISOString(),
  initializedFrom: 'observed-containers',
});
process.stdout.write(`Initialized game slot as ${desired}\n`);
