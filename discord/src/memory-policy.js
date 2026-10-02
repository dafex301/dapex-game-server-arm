export function evaluateMemoryPolicy(state, usedGiB, config) {
  let highMemoryAlerted = Boolean(state.highMemoryAlerted);
  let highMemorySamples = Number.isInteger(state.highMemorySamples) ? state.highMemorySamples : 0;
  const memoryRestartPending = Boolean(state.memoryRestartPending);

  if (usedGiB === null) {
    return { highMemoryAlerted, highMemorySamples, memoryRestartPending, warn: false, restart: false };
  }

  const warn = usedGiB >= config.memoryAlertGiB && !highMemoryAlerted;
  if (warn) highMemoryAlerted = true;
  if (usedGiB <= config.memoryAlertResetGiB) highMemoryAlerted = false;

  highMemorySamples = usedGiB >= config.memoryRestartGiB ? highMemorySamples + 1 : 0;
  const restart = highMemorySamples >= config.memoryRestartSamples && !memoryRestartPending;

  return {
    highMemoryAlerted,
    highMemorySamples,
    memoryRestartPending: memoryRestartPending || restart,
    warn,
    restart,
  };
}
