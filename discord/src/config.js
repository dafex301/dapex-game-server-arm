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

function discordId(name) {
  const value = process.env[name];
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${name} must be a Discord snowflake ID`);
  return value;
}

export function loadConfig() {
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const deployDir = path.resolve(process.env.VALHEIM_DEPLOY_DIR || '/home/ubuntu/valheim-server-arm');
  return Object.freeze({
    token: process.env.DISCORD_BOT_TOKEN,
    guildId: discordId('DISCORD_GUILD_ID'),
    statusChannelId: discordId('DISCORD_STATUS_CHANNEL_ID'),
    alertChannelId: discordId('DISCORD_ALERT_CHANNEL_ID'),
    adminRoleId: discordId('DISCORD_ADMIN_ROLE_ID'),
    deployDir,
    container: process.env.VALHEIM_CONTAINER || 'valheim',
    pollMs: positiveInteger('STATUS_POLL_SECONDS', 30, 10) * 1000,
    commandCooldownMs: positiveInteger('COMMAND_COOLDOWN_SECONDS', 180, 30) * 1000,
    stateFile: path.resolve(process.env.STATUS_STATE_FILE || './state.json'),
    watchdogStateFile: process.env.WATCHDOG_STATE_FILE
      ? path.resolve(process.env.WATCHDOG_STATE_FILE)
      : null,
    watchdogMaxAgeMs: positiveInteger('WATCHDOG_MAX_AGE_SECONDS', 180, 30) * 1000,
  });
}
