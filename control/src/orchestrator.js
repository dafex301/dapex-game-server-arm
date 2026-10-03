import path from 'node:path';
import { inspectContainer, containerLogs, containerStats, removeContainer, startContainer, stopContainer } from './docker.js';
import { readJson, writeJsonAtomic } from './files.js';
import { run } from './process.js';

const games = new Set(['valheim', 'minecraft', 'none']);

const defaultDependencies = { inspectContainer, containerLogs, containerStats, removeContainer, startContainer, stopContainer, run };

export function createOrchestrator(config, dependencies = defaultDependencies) {
  const stateFile = path.join(config.stateDir, 'game-slot.json');
  const auditFile = path.join(config.stateDir, 'operations.json');

  const containers = {
    valheim: config.valheimContainer,
    minecraft: config.minecraftContainer,
  };

  async function observed() {
    const [valheim, minecraft] = await Promise.all([
      dependencies.inspectContainer(containers.valheim),
      dependencies.inspectContainer(containers.minecraft),
    ]);
    const running = [valheim, minecraft].filter((item) => item.running).map((item) => item.name);
    return { valheim, minecraft, running, invariantOk: running.length <= 1 };
  }

  async function status() {
    const [state, observation] = await Promise.all([readJson(stateFile, { desired: 'valheim' }), observed()]);
    const active = observation.valheim.running ? 'valheim' : observation.minecraft.running ? 'minecraft' : 'none';
    const targetContainer = active === 'none' ? null : containers[active];
    const stats = targetContainer ? await dependencies.containerStats(targetContainer) : null;
    return {
      desired: state.desired || 'valheim',
      active,
      transition: state.transition || null,
      invariantOk: observation.invariantOk,
      containers: observation,
      stats,
      updatedAt: state.updatedAt || null,
    };
  }

  async function appendAudit(entry) {
    const current = await readJson(auditFile, []);
    current.unshift(entry);
    await writeJsonAtomic(auditFile, current.slice(0, 200));
  }

  async function createMissingContainer(game) {
    const script = game === 'minecraft' ? 'scripts/start-minecraft.sh' : 'scripts/start.sh';
    await dependencies.run(path.join(config.deployDir, script), [], { cwd: config.deployDir, timeout: 300_000 });
  }

  async function waitUntilRunning(game, timeoutMs = 900_000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const current = await dependencies.inspectContainer(containers[game]);
      if (current.running && current.health === 'healthy') return current;
      if (current.health === 'unhealthy') throw new Error(`${game} container reported unhealthy`);
      if (current.running && !current.health) {
        const logs = await dependencies.containerLogs(containers[game], current.startedAt);
        const ready = game === 'valheim'
          ? /join code|session.*active|game server connected/i.test(logs)
          : /Done \([0-9.]+s\)!|RCON running on/i.test(logs);
        if (ready) return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);
    throw new Error(`${game} did not become ready within ${timeoutMs / 1000} seconds`);
  }

  async function switchUnlocked(target, actor = 'system') {
    if (!games.has(target)) throw new Error(`Unsupported game target: ${target}`);
    const before = await observed();
    if (!before.invariantOk) throw new Error('Safety invariant violated: Valheim and Minecraft are both running');
    const active = before.valheim.running ? 'valheim' : before.minecraft.running ? 'minecraft' : 'none';
    if (active === target) return status();

    const transition = { from: active, to: target, actor, startedAt: new Date().toISOString() };
    await writeJsonAtomic(stateFile, { desired: target, transition, updatedAt: transition.startedAt });
    try {
      if (active !== 'none') await dependencies.stopContainer(containers[active]);
      if (target !== 'none') {
        const targetState = await dependencies.inspectContainer(containers[target]);
        if (target === 'minecraft' && targetState.exists) {
          await dependencies.removeContainer(containers[target]);
          await createMissingContainer(target);
        } else if (targetState.exists) await dependencies.startContainer(containers[target]);
        else await createMissingContainer(target);
        await waitUntilRunning(target);
      }
      const after = await observed();
      if (!after.invariantOk) throw new Error('Post-switch invariant violated: more than one game is running');
      if (target !== 'none' && !after[target].running) throw new Error(`${target} did not reach Docker running state`);
      const completedAt = new Date().toISOString();
      await writeJsonAtomic(stateFile, { desired: target, transition: null, updatedAt: completedAt });
      await appendAudit({ type: 'switch', actor, from: active, to: target, startedAt: transition.startedAt, completedAt, outcome: 'success' });
      return status();
    } catch (error) {
      let rollback = 'not-needed';
      if (active !== 'none') {
        try {
          const prior = await dependencies.inspectContainer(containers[active]);
          if (!prior.running) await dependencies.startContainer(containers[active]);
          await waitUntilRunning(active);
          rollback = 'restored-previous-game';
        } catch (rollbackError) {
          rollback = `failed: ${rollbackError.message}`;
        }
      }
      await writeJsonAtomic(stateFile, { desired: active, transition: null, updatedAt: new Date().toISOString(), lastError: error.message });
      await appendAudit({ type: 'switch', actor, from: active, to: target, startedAt: transition.startedAt, completedAt: new Date().toISOString(), outcome: 'failed', rollback, error: error.message });
      throw error;
    }
  }

  async function switchGame(target, actor) {
    const helper = path.join(config.deployDir, 'control', 'src', 'switch-cli.js');
    const output = await dependencies.run('flock', ['-w', '10', config.operationLock, process.execPath, helper, target, actor || 'api'], {
      cwd: config.deployDir,
      env: process.env,
      timeout: 960_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(output);
  }

  return { status, switchGame, switchUnlocked, observed };
}
