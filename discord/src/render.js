import { EmbedBuilder } from 'discord.js';

const presentation = {
  online: { icon: '🟢', label: 'Online', color: 0x57f287 },
  starting: { icon: '🟡', label: 'Starting', color: 0xfee75c },
  restarting: { icon: '🟠', label: 'Restarting', color: 0xfaa61a },
  maintenance: { icon: '🔧', label: 'Maintenance', color: 0x3498db },
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

export function transitionEmbed(previous, current) {
  const view = display(current);
  return new EmbedBuilder()
    .setTitle(`${view.icon} Valheim is ${view.label.toLowerCase()}`)
    .setColor(view.color)
    .setDescription(`State changed from **${display(previous).label}** to **${view.label}**.`)
    .setTimestamp(current.checkedAt);
}

export function statusText(status) {
  const view = display(status);
  const code = status.joinCode ? ` Join code: \`${status.joinCode}\`.` : '';
  return `${view.icon} **${status.serverName}** is **${view.label.toLowerCase()}**.${code}`;
}
