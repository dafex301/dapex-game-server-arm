import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { loadConfig } from './config.js';
import { gameStatusEmbed, gameTransitionEmbed, memoryWarningEmbed, statusEmbed, statusText } from './render.js';
import { loadState, saveState } from './state.js';
import { createValheim, parseMemoryUsageGiB } from './valheim.js';
import { evaluateMemoryPolicy } from './memory-policy.js';
import { createGameControl } from './game-control.js';
import { createMinecraft } from './minecraft.js';

const config = loadConfig();
const valheim = createValheim(config);
const gameControl = createGameControl(config);
const minecraft = createMinecraft(config);
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
const cooldowns = new Map();
let pollInFlight = false;
let alertRoleId = null;

const commands = [
  new SlashCommandBuilder().setName('valheim').setDescription('Valheim server information and operations')
    .addSubcommand((c) => c.setName('status').setDescription('Show server health and resource usage'))
    .addSubcommand((c) => c.setName('join').setDescription('Show the current join code'))
    .addSubcommand((c) => c.setName('players').setDescription('Show players detected in recent server logs'))
    .addSubcommand((c) => c.setName('restart').setDescription('Gracefully restart the server (admin only)'))
    .addSubcommand((c) => c.setName('backup').setDescription('Stop, back up, and resume the server (admin only)')),
  new SlashCommandBuilder().setName('game').setDescription('Shared game server operations')
    .addSubcommand((c) => c.setName('status').setDescription('Show the active game slot'))
    .addSubcommand((c) => c.setName('switch').setDescription('Switch the exclusive game slot (admin only)')
      .addStringOption((option) => option.setName('target').setDescription('Game to start').setRequired(true)
        .addChoices(
          { name: 'Valheim', value: 'valheim' },
          { name: 'Minecraft', value: 'minecraft' },
          { name: 'Offline', value: 'none' },
        ))),
  new SlashCommandBuilder().setName('minecraft').setDescription('Minecraft server information and operations')
    .addSubcommand((c) => c.setName('status').setDescription('Show Minecraft health, players, and active pack'))
    .addSubcommand((c) => c.setName('whitelist-add').setDescription('Add a Java username to the whitelist (admin only)')
      .addStringOption((option) => option.setName('username').setDescription('Minecraft Java username').setRequired(true)))
    .addSubcommand((c) => c.setName('whitelist-remove').setDescription('Remove a Java username from the whitelist (admin only)')
      .addStringOption((option) => option.setName('username').setDescription('Minecraft Java username').setRequired(true)))
    .addSubcommand((c) => c.setName('whitelist-list').setDescription('List whitelisted players (admin only)')),
].map((command) => command.toJSON());

function hasAdminRole(interaction) {
  return interaction.member?.roles?.cache?.has(config.adminRoleId)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function claimCooldown(key) {
  const now = Date.now();
  const until = cooldowns.get(key) || 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  cooldowns.set(key, now + config.commandCooldownMs);
  return 0;
}

async function fetchTextChannel(id) {
  const channel = await client.channels.fetch(id);
  if (!channel?.isTextBased() || typeof channel.send !== 'function') {
    throw new Error(`Discord channel ${id} is not a writable text channel`);
  }
  return channel;
}

async function updatePersistentStatus(status) {
  const state = await loadState(config.stateFile);
  const channel = await fetchTextChannel(config.statusChannelId);
  let message = null;
  if (state.statusMessageId) {
    message = await channel.messages.fetch(state.statusMessageId).catch(() => null);
  }
  if (message) await message.edit({ embeds: [gameStatusEmbed(status)] });
  else message = await channel.send({ embeds: [gameStatusEmbed(status)] });

  const statusKey = `${status.game || 'valheim'}:${status.state}`;
  if (state.lastStatusKey && state.lastStatusKey !== statusKey) {
    const alertChannel = await fetchTextChannel(config.alertChannelId);
    await alertChannel.send({ embeds: [gameTransitionEmbed({ state: state.lastStatus }, status)] });
  }
  const usedGiB = status.game === 'valheim' ? parseMemoryUsageGiB(status.memory) : null;
  const memoryPolicy = status.game === 'valheim'
    ? evaluateMemoryPolicy(state, usedGiB, config)
    : { warn: false, restart: false, highMemoryAlerted: false, highMemorySamples: 0, memoryRestartPending: false };
  if (memoryPolicy.warn) {
    const alertChannel = await fetchTextChannel(config.alertChannelId);
    const mention = alertRoleId ? `<@&${alertRoleId}>` : `@${config.alertRoleName}`;
    await alertChannel.send({
      content: `${mention} Valheim memory is close to the crash range.`,
      embeds: [memoryWarningEmbed(status, usedGiB, config.memoryAlertGiB)],
      allowedMentions: alertRoleId ? { roles: [alertRoleId] } : { parse: [] },
    });
  }
  if (memoryPolicy.restart) {
    const alertChannel = await fetchTextChannel(config.alertChannelId);
    const mention = alertRoleId ? `<@&${alertRoleId}>` : `@${config.alertRoleName}`;
    await alertChannel.send({
      content: `${mention} Valheim stayed above ${config.memoryRestartGiB} GiB for ${config.memoryRestartSamples} checks. A graceful save and restart will begin in ${config.memoryRestartCountdownMs / 1000} seconds.`,
      allowedMentions: alertRoleId ? { roles: [alertRoleId] } : { parse: [] },
    });
  }
  await saveState(config.stateFile, {
    statusMessageId: message.id,
    lastStatus: status.state,
    lastStatusKey: statusKey,
    containerStartedAt: status.startedAt,
    joinCode: status.joinCode || (state.containerStartedAt === status.startedAt ? state.joinCode : null),
    highMemoryAlerted: memoryPolicy.highMemoryAlerted,
    highMemorySamples: memoryPolicy.highMemorySamples,
    memoryRestartPending: memoryPolicy.memoryRestartPending,
  });
  if (memoryPolicy.restart) {
    setTimeout(async () => {
      try {
        await valheim.restart();
        const current = await loadState(config.stateFile);
        await saveState(config.stateFile, {
          ...current,
          highMemorySamples: 0,
          memoryRestartPending: false,
        });
        await poll();
      } catch (error) {
        console.error('Automatic high-memory restart failed:', error);
        const current = await loadState(config.stateFile);
        await saveState(config.stateFile, { ...current, memoryRestartPending: false });
      }
    }, config.memoryRestartCountdownMs).unref();
  }
}

async function getStatus() {
  let controller;
  try { controller = await gameControl.status(); }
  catch { controller = null; }
  const active = controller?.status?.active;
  if (active === 'minecraft') {
    const container = controller.status.containers?.minecraft || {};
    const players = await minecraft.players();
    return {
      game: 'minecraft',
      state: container.running && (!container.health || container.health === 'healthy') ? 'online' : container.running ? 'starting' : 'degraded',
      reason: container.health === 'unhealthy' ? 'Minecraft container reported unhealthy' : null,
      ...players,
      memory: controller.status.stats?.memory || null,
      cpu: controller.status.stats?.cpu || null,
      releaseName: controller.active?.releaseName || (controller.active?.release ? `${controller.active.name} v${controller.active.release}` : null),
      address: config.minecraftAddress,
      portalUrl: config.playerPortalUrl,
      checkedAt: new Date(),
    };
  }
  if (active === 'none') return { game: 'none', state: 'down', playerCount: 0, players: [], memory: null, cpu: null, checkedAt: new Date() };
  const status = await valheim.getStatus();
  status.game = 'valheim';
  if (!status.joinCode && status.state === 'online' && !status.watchdogFresh) {
    const state = await loadState(config.stateFile);
    if (state.containerStartedAt === status.startedAt) status.joinCode = state.joinCode || null;
  }
  return status;
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await updatePersistentStatus(await getStatus());
  } catch (error) {
    console.error('Status poll failed:', error);
  } finally {
    pollInFlight = false;
  }
}

async function onReady(readyClient) {
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(readyClient.user.id, config.guildId), { body: commands });
  const guild = await readyClient.guilds.fetch(config.guildId);
  const roles = await guild.roles.fetch();
  alertRoleId = roles.find((role) => role.name.toLowerCase() === config.alertRoleName.toLowerCase())?.id || null;
  if (!alertRoleId) console.warn(`Discord alert role @${config.alertRoleName} was not found; warnings will be sent without a real mention`);
  console.log(`Ready as ${readyClient.user.tag}; commands registered in guild ${config.guildId}`);
  await poll();
  setInterval(poll, config.pollMs).unref();
}

client.once(Events.ClientReady, (readyClient) => {
  void onReady(readyClient).catch((error) => {
    console.error('Discord initialization failed:', error);
    client.destroy();
    process.exitCode = 1;
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'game') {
    const subcommand = interaction.options.getSubcommand();
    try {
      if (subcommand === 'status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await gameControl.status();
        await interaction.editReply(`Active: **${result.status.active}** · Desired: **${result.status.desired}** · Interlock: **${result.status.invariantOk ? 'armed' : 'FAULT'}**`);
        return;
      }
      if (!hasAdminRole(interaction)) {
        await interaction.reply({ content: 'This command requires the configured game admin role.', flags: MessageFlags.Ephemeral });
        return;
      }
      const target = interaction.options.getString('target', true);
      const remaining = claimCooldown('game-switch');
      if (remaining) {
        await interaction.reply({ content: `Game switching is cooling down. Try again in ${remaining}s.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await gameControl.switchGame(target);
      await interaction.editReply(`Game slot switched successfully. Active: **${result.active}**.`);
    } catch (error) {
      console.error(`/${interaction.commandName} ${subcommand} failed:`, error);
      const content = `The operation failed: ${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (interaction.commandName === 'minecraft') {
    const subcommand = interaction.options.getSubcommand();
    try {
      if (subcommand === 'status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ embeds: [gameStatusEmbed(await getStatus())] });
        return;
      }
      if (!hasAdminRole(interaction)) {
        await interaction.reply({ content: 'This command requires the configured game admin role.', flags: MessageFlags.Ephemeral });
        return;
      }
      const remaining = claimCooldown(`minecraft-${subcommand}`);
      if (remaining) {
        await interaction.reply({ content: `That command is cooling down. Try again in ${remaining}s.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const action = subcommand.replace('whitelist-', '');
      const username = action === 'list' ? null : interaction.options.getString('username', true);
      const result = await gameControl.minecraftWhitelist(action, username);
      const message = result.message || (Array.isArray(result.players) ? result.players.join(', ') || 'Whitelist is empty.' : 'Whitelist updated.');
      await interaction.editReply(`\`${message}\``);
    } catch (error) {
      console.error(`/${interaction.commandName} ${subcommand} failed:`, error);
      const content = `The operation failed: ${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  if (interaction.commandName !== 'valheim') return;
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === 'restart' || subcommand === 'backup') {
      if (!hasAdminRole(interaction)) {
        await interaction.reply({ content: 'This command requires the configured Valheim admin role.', flags: MessageFlags.Ephemeral });
        return;
      }
      const remaining = claimCooldown(subcommand);
      if (remaining) {
        await interaction.reply({ content: `That command is cooling down. Try again in ${remaining}s.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (subcommand === 'restart') {
        const status = await valheim.restart();
        await interaction.editReply(`Restart requested successfully. ${statusText(status)}`);
      } else {
        const archive = await valheim.backup();
        await interaction.editReply(`Backup completed successfully: \`${archive}\``);
      }
      await poll();
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await getStatus();
    if (subcommand === 'status') await interaction.editReply({ embeds: [statusEmbed(status)] });
    if (subcommand === 'join') {
      const code = status.joinCode ? `Current PlayFab join code: \`${status.joinCode}\`` : 'The join code is not currently available.';
      await interaction.editReply(`${code}\nServer: **${status.serverName}** • World: **${status.world}**\nIn Valheim, use Join Game → Add server. Ask an admin for the password.`);
    }
    if (subcommand === 'players') {
      const count = status.playerCount ?? status.players.length;
      await interaction.editReply(`**${count} player(s) connected.**\n\n_Vanilla Valheim logs do not provide a trustworthy live player-name roster._`);
    }
  } catch (error) {
    console.error(`/${interaction.commandName} ${subcommand} failed:`, error);
    const content = 'The operation failed. Check the bot service logs for details.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`Received ${signal}; disconnecting from Discord`);
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.token);
