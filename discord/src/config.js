import path from 'node:path';

const required = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_STATUS_CHANNEL_ID',
  'DISCORD_ALERT_CHANNEL_ID',
  'DISCORD_ADMIN_ROLE_ID',
];

function positiveInteger(name, fallback, minimum = 1) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function discordId(name) {
  const value = process.env[name];
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${name} must be a Discord snowflake ID`);
  return value;
}

export function loadConfig() {
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const deployDir = path.resolve(process.env.VALHEIM_DEPLOY_DIR || '/home/ubuntu/valheim-server-arm');
  const memoryAlertGiB = positiveNumber('MEMORY_ALERT_GIB', 7);
  const memoryAlertResetGiB = positiveNumber('MEMORY_ALERT_RESET_GIB', 6);
  const memoryRestartGiB = positiveNumber('MEMORY_RESTART_GIB', 7.5);
  if (memoryAlertResetGiB >= memoryAlertGiB) {
    throw new Error('MEMORY_ALERT_RESET_GIB must be lower than MEMORY_ALERT_GIB');
  }
  if (memoryRestartGiB <= memoryAlertGiB) {
    throw new Error('MEMORY_RESTART_GIB must be higher than MEMORY_ALERT_GIB');
  }
  return Object.freeze({
    token: process.env.DISCORD_BOT_TOKEN,
    guildId: discordId('DISCORD_GUILD_ID'),
    statusChannelId: discordId('DISCORD_STATUS_CHANNEL_ID'),
    alertChannelId: discordId('DISCORD_ALERT_CHANNEL_ID'),
    adminRoleId: discordId('DISCORD_ADMIN_ROLE_ID'),
    alertRoleName: process.env.DISCORD_ALERT_ROLE_NAME?.trim() || 'valheim',
    memoryAlertGiB,
    memoryAlertResetGiB,
    memoryRestartGiB,
    memoryRestartSamples: positiveInteger('MEMORY_RESTART_SAMPLES', 2),
    memoryRestartCountdownMs: positiveInteger('MEMORY_RESTART_COUNTDOWN_SECONDS', 30, 10) * 1000,
    deployDir,
    container: process.env.VALHEIM_CONTAINER || 'valheim',
    pollMs: positiveInteger('STATUS_POLL_SECONDS', 30, 10) * 1000,
    commandCooldownMs: positiveInteger('COMMAND_COOLDOWN_SECONDS', 180, 30) * 1000,
    stateFile: path.resolve(process.env.STATUS_STATE_FILE || './state.json'),
    watchdogStateFile: process.env.WATCHDOG_STATE_FILE
      ? path.resolve(process.env.WATCHDOG_STATE_FILE)
      : null,
    watchdogMaxAgeMs: positiveInteger('WATCHDOG_MAX_AGE_SECONDS', 180, 30) * 1000,
    controlApiUrl: process.env.GAME_CONTROL_API_URL?.trim() || null,
    controlApiToken: process.env.GAME_CONTROL_API_TOKEN?.trim() || null,
    minecraftContainer: process.env.MINECRAFT_CONTAINER?.trim() || 'minecraft',
    minecraftAddress: process.env.MINECRAFT_ADDRESS?.trim() || 'mc.fahrelgibran.com',
    playerPortalUrl: process.env.PLAYER_PORTAL_URL?.trim() || 'https://play.server.fahrelgibran.com',
  });
}
