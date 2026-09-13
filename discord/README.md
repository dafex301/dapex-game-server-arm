# Valheim Discord operations bot

This bot runs on the same host as Docker and provides:

- a single persistent status card, edited every poll;
- transition-only alerts when state changes among online, starting, restarting,
  maintenance, degraded, offline, and unknown;
- `/valheim status`, `/valheim join`, and `/valheim players`;
- role-restricted `/valheim restart` and `/valheim backup` with cooldowns;
- guild-scoped slash-command registration on startup.

`/valheim join` intentionally never exposes the server password. It only shows the
current PlayFab join code parsed from recent logs, plus the server and world name.
Player count uses Valheim's latest `now N player(s)` line. Player names are not
shown because vanilla logs do not identify which named character disconnected;
character activity is not a trustworthy live roster. The join code is cached per
container start so it remains available after its log line falls out of the
polling window.

## Install

Requires Node.js 20+, `/usr/bin/flock`, access to the Docker socket, and permission
to run the deployment's existing backup script.

```sh
cd /home/ubuntu/valheim-server-arm/discord
npm install
cp .env.example .env
chmod 600 .env
# Edit .env and add the Discord IDs and bot token.
npm test
npm start
```

On the prepared `wa-bot` deployment, enter the token without placing it in shell
history or a process argument:

```sh
ssh -t wa-bot '~/valheim-server-arm/discord/set-token.sh'
```

The Discord bot needs `bot` and `applications.commands` scopes and these channel
permissions: View Channel, Send Messages, Embed Links, and Read Message History.
Privileged intents are not needed.

## systemd

After filling in `.env`, install the included unit:

```sh
sudo cp valheim-discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now valheim-discord
journalctl -u valheim-discord -f
```

Rollback without touching the Valheim container or saves:

```sh
sudo systemctl disable --now valheim-discord
sudo rm /etc/systemd/system/valheim-discord.service
sudo systemctl daemon-reload
```

The bot directory and `.env` remain in place unless deliberately removed.

The service restarts after failures and on boot. Host-level outage alerts still
require an external heartbeat monitor: a bot running on this host cannot notify
Discord while the host or its network is unavailable.

The included unit uses the Node 20.20.0 NVM path currently installed on `wa-bot`.
Update both its `Environment=PATH` and `ExecStart` if that runtime moves. Manual
restarts share the deployment's `.maintenance.lock` with the watchdog; backups
rely on the deployment backup script acquiring the same lock. The watchdog
installer creates it as `ubuntu:docker` with mode `0660` before this service is
enabled.

Set `WATCHDOG_STATE_FILE=/var/lib/valheim-watchdog/state.json` to use fresh
watchdog observations as the authoritative lifecycle, reason, action, recovery,
and join-code source. The bot accepts them only when they are recent and refer to
the current container start (maintenance is accepted while the lock prevents a
container observation). Direct Docker CPU and memory statistics are still used.

The unit intentionally does not set systemd's `NoNewPrivileges=true`: the current
backup workflow may invoke narrowly scoped `sudo` operations. Membership in the
Docker group is already root-equivalent, so this unit is not a security boundary;
protect the bot token, host login, and files accordingly.
