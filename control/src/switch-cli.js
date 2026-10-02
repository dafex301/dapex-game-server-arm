import 'dotenv/config';
import { loadConfig } from './config.js';
import { createOrchestrator } from './orchestrator.js';

const [target, actor = 'cli'] = process.argv.slice(2);
if (!target) throw new Error('Usage: switch-cli.js <valheim|minecraft|none> [actor]');
const result = await createOrchestrator(loadConfig()).switchUnlocked(target, actor);
process.stdout.write(`${JSON.stringify(result)}\n`);
