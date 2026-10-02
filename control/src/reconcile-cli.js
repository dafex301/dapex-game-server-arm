import 'dotenv/config';
import { loadConfig } from './config.js';
import { createOrchestrator } from './orchestrator.js';

const orchestrator = createOrchestrator(loadConfig());
const status = await orchestrator.status();
if (!status.invariantOk) throw new Error('Refusing boot reconciliation because both game containers are running');
if (status.active !== status.desired) {
  process.stdout.write(`${JSON.stringify(await orchestrator.switchUnlocked(status.desired, 'boot-reconciler'))}\n`);
} else {
  process.stdout.write(`${JSON.stringify(status)}\n`);
}
