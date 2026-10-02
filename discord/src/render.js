import { EmbedBuilder } from 'discord.js';

const presentation = {
  online: { icon: '🟢', label: 'Online', color: 0x57f287 },
  starting: { icon: '🟡', label: 'Starting', color: 0xfee75c },
  restarting: { icon: '🟠', label: 'Restarting', color: 0xfaa61a },
  maintenance: { icon: '🔧', label: 'Maintenance', color: 0x3498db },
  inactive: { icon: '🎮', label: 'Inactive — another game selected', color: 0x5865f2 },
  degraded: { icon: '🔴', label: 'Game process stopped', color: 0xed4245 },
  down: { icon: '⚫', label: 'Offline', color: 0x747f8d },
  unknown: { icon: '❔', label: 'Unknown', color: 0x9b59b6 },
};

function display(status) {
  return presentation[status.state] ?? presentation.down;
}

function relativeTime(date) {
  if (!date) return '—';
  const unix = Math.floor(new Date(date).getTime() / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:R>` : '—';
}

export function statusEmbed(status) {
  const view = display(status);
  const playerCount = status.playerCount ?? status.players.length;
  const embed = new EmbedBuilder()
    .setTitle(`${view.icon} ${status.serverName} — ${view.label}`)
    .setColor(view.color)
    .addFields(
      { name: 'World', value: status.world, inline: true },
      { name: 'Players', value: `${playerCount}`, inline: true },
      { name: 'Join code', value: status.joinCode ? `\`${status.joinCode}\`` : 'Unavailable', inline: true },
      { name: 'Memory', value: status.memory || '—', inline: true },
      { name: 'CPU', value: status.cpu || '—', inline: true },
      { name: 'Started', value: relativeTime(status.startedAt), inline: true },
    )
    .setFooter({ text: `Restart count: ${status.restartCount}${status.oomKilled ? ' • last exit was OOM-killed' : ''}` })
    .setTimestamp(status.checkedAt);
  if (status.reason) embed.addFields({ name: 'Health detail', value: status.reason.slice(0, 1024) });
  if (status.action && status.action !== 'none') embed.addFields({ name: 'Recovery action', value: status.action, inline: true });
  if (status.recovery) {
    const recovery = status.recovery;
    const attempts = `${recovery.attempts_in_window ?? 0}/${recovery.max_attempts_per_window ?? '—'} attempts`;
    const failures = `${recovery.consecutive_failures ?? 0} consecutive failure(s)`;
    const next = recovery.next_action_at ? ` • next action <t:${recovery.next_action_at}:R>` : '';
    embed.addFields({ name: 'Automatic recovery', value: `${attempts} • ${failures}${next}`.slice(0, 1024) });
  }
  return embed;
}

export function gameStatusEmbed(status) {
  if (status.game === 'valheim') return statusEmbed(status);
  const view = display(status.state);
  const title = status.game === 'minecraft' ? 'Minecraft · Dapex Fabric' : 'Shared game server';
  const embed = new EmbedBuilder()
    .setTitle(`${view.icon} ${title} — ${view.label}`)
    .setColor(view.color)
    .addFields(
      { name: 'Active game', value: status.game === 'none' ? 'None' : 'Minecraft', inline: true },
      { name: 'Players', value: status.playerCount == null ? '—' : `${status.playerCount}${status.maxPlayers ? ` / ${status.maxPlayers}` : ''}`, inline: true },
      { name: 'Release', value: status.releaseName || '—', inline: true },
      { name: 'Memory', value: status.memory || '—', inline: true },
      { name: 'CPU', value: status.cpu || '—', inline: true },
      { name: 'Address', value: status.address ? `\`${status.address}\`` : '—', inline: true },
    )
    .setTimestamp(status.checkedAt || new Date());
  if (status.portalUrl) embed.addFields({ name: 'Client pack', value: `[Download and setup instructions](${status.portalUrl})` });
  if (status.reason) embed.addFields({ name: 'Health detail', value: status.reason.slice(0, 1024) });
  return embed;
}

export function gameTransitionEmbed(previous, current) {
  const view = display(current);
  const game = current.game === 'none' ? 'Shared game server' : current.game === 'minecraft' ? 'Minecraft' : 'Valheim';
  return new EmbedBuilder()
    .setTitle(`${view.icon} ${game} is ${view.label.toLowerCase()}`)
    .setColor(view.color)
    .setDescription(`State changed from **${display(previous).label}** to **${view.label}**.`)
    .setTimestamp(current.checkedAt || new Date());
}

export function transitionEmbed(previous, current) {
  const view = display(current);
  return new EmbedBuilder()
    .setTitle(`${view.icon} Valheim is ${view.label.toLowerCase()}`)
    .setColor(view.color)
    .setDescription(`State changed from **${display(previous).label}** to **${view.label}**.`)
    .setTimestamp(current.checkedAt);
}

export function memoryWarningEmbed(status, usedGiB, thresholdGiB) {
  return new EmbedBuilder()
    .setTitle('⚠️ Valheim memory warning')
    .setColor(0xed4245)
    .setDescription(`**${status.serverName}** is using **${usedGiB.toFixed(2)} GiB** of memory. The warning threshold is **${thresholdGiB} GiB**.`)
    .addFields(
      { name: 'Current usage', value: status.memory || `${usedGiB.toFixed(2)} GiB`, inline: true },
      { name: 'Players', value: `${status.playerCount ?? 0}`, inline: true },
      { name: 'Action', value: 'Save progress and expect an automatic restart if memory continues toward the 9 GiB container limit.' },
    )
    .setTimestamp(status.checkedAt);
}

export function statusText(status) {
  const view = display(status);
  const code = status.joinCode ? ` Join code: \`${status.joinCode}\`.` : '';
  return `${view.icon} **${status.serverName}** is **${view.label.toLowerCase()}**.${code}`;
}
