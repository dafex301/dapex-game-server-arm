import 'dotenv/config';
import { loadConfig } from './config.js';
import { createOrchestrator } from './orchestrator.js';
import { createProfiles } from './profiles.js';

const [actor = 'cli'] = process.argv.slice(2);
const config = loadConfig();
const orchestrator = createOrchestrator(config);
const status = await orchestrator.status();
if (status.active === 'minecraft') throw new Error('Stop or switch away from Minecraft before publishing a profile');
const result = await createProfiles(config).publish(actor);
process.stdout.write(`${JSON.stringify(result)}\n`);
