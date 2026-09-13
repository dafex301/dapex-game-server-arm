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
import { statusEmbed, statusText, transitionEmbed } from './render.js';
import { loadState, saveState } from './state.js';
import { createValheim } from './valheim.js';

const config = loadConfig();
const valheim = createValheim(config);
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
const cooldowns = new Map();
let pollInFlight = false;

const commands = [
  new SlashCommandBuilder().setName('valheim').setDescription('Valheim server information and operations')
    .addSubcommand((c) => c.setName('status').setDescription('Show server health and resource usage'))
    .addSubcommand((c) => c.setName('join').setDescription('Show the current join code'))
    .addSubcommand((c) => c.setName('players').setDescription('Show players detected in recent server logs'))
    .addSubcommand((c) => c.setName('restart').setDescription('Gracefully restart the server (admin only)'))
    .addSubcommand((c) => c.setName('backup').setDescription('Stop, back up, and resume the server (admin only)')),
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
  if (message) await message.edit({ embeds: [statusEmbed(status)] });
  else message = await channel.send({ embeds: [statusEmbed(status)] });

  if (state.lastStatus && state.lastStatus !== status.state) {
    const alertChannel = await fetchTextChannel(config.alertChannelId);
    await alertChannel.send({ embeds: [transitionEmbed({ state: state.lastStatus }, status)] });
  }
  await saveState(config.stateFile, {
    statusMessageId: message.id,
    lastStatus: status.state,
    containerStartedAt: status.startedAt,
    joinCode: status.joinCode || (state.containerStartedAt === status.startedAt ? state.joinCode : null),
  });
}

async function getStatus() {
  const status = await valheim.getStatus();
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
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'valheim') return;
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
