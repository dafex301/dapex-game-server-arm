# Valheim on wa-bot (ARM64)

Vanilla world `kopdes`, server `mbg enak`, intended for up to six PC players.
Runs the Windows dedicated server through Box64/Wine using
[tsx-cloud/valheim-arm](https://github.com/tsx-cloud/valheim-arm).
Upstream code was inspected before deployment. The container image is pinned in
`image.txt`; Steam downloads/updates the game on each container startup.

## Connection

Crossplay is enabled so players can use the PlayFab join code from the server log.
In Valheim, select Join Game -> Add server and enter the join code, then the password.
The code can change on restart. Retrieve current connection details:

```sh
ssh wa-bot 'docker logs --tail 300 valheim 2>&1 | grep -iE "join code|session.*active|game server connected"'
ssh wa-bot 'cat ~/valheim-server-arm/.env'
```

The password is randomly generated and stored only on the server in `.env` (mode 600).
Do not commit it. Crossplay works for Steam PC clients too.

[Valheim's official guide](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/)
says crossplay does not need port forwarding. No inbound game ports are published.
Ordinary [Cloudflare Tunnel public hostnames](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)
do not expose UDP. Private Cloudflare networking would require player-side client setup.
For direct Steam networking instead, disable crossplay and publish UDP 2456-2457,
then allow those ports in both Oracle Cloud ingress rules and the host firewall.
A Cloudflare DNS record would need DNS-only mode for that direct connection.

## Operations

Remote directory: `/home/ubuntu/valheim-server-arm`.

```sh
ssh wa-bot 'docker logs --tail 100 valheim'
ssh wa-bot 'docker stats --no-stream valheim'
ssh wa-bot 'docker stop -t 120 valheim'
ssh wa-bot 'docker start valheim'
```

`unless-stopped` restarts the container after host reboot unless manually stopped.
Limits: 8 GiB memory, no extra swap allowance, 1.5 CPU cores; Docker logs rotate at
3 x 10 MB. Saves are in `persistentdata`, Steam files in `server`.
The game saves every 15 minutes and retains six automatic backups.
The upstream image also writes logs beneath `persistentdata/logs`; inspect their
size periodically because Docker log rotation does not cover those files.

For a consistent manual backup (brief downtime):

```sh
ssh wa-bot 'cd ~/valheim-server-arm && ./scripts/backup.sh'
```

Copy the resulting archive off the host for protection against host loss.
To restore, stop Valheim, back up the current directory, extract the archive into
the deployment directory, then start Valheim. Archives contain `persistentdata/`.

To change settings, edit the remote `.env`, then back up and recreate the container
(the bind-mounted world survives container removal):

```sh
cd ~/valheim-server-arm
./scripts/backup.sh
docker stop -t 120 valheim
docker rm valheim
VALHEIM_IMAGE="$(cat image.txt)" ./scripts/start.sh
```

For initial installation: copy `.env.example` to `.env`, choose a strong password,
set mode 600, pull the image, record its repository digest in `image.txt`, and run
`VALHEIM_IMAGE="$(cat image.txt)" ./scripts/start.sh`.

## Availability and Discord operations

Two optional, independent components are staged locally and are not installed on
the live host yet:

- `monitoring/` contains a one-minute systemd watchdog. It verifies the Docker
  container, actual Valheim process, and current PlayFab session; distinguishes
  startup and intentional maintenance; and performs at most three recoveries per
  hour with exponential backoff. It writes atomic JSON state and can ping an
  external dead-man heartbeat for whole-host outage detection.
- `discord/` contains an outbound-only Discord bot with a persistent status card,
  transition alerts, player/join information, and admin-restricted restart and
  backup commands. It consumes the watchdog state when available.

Both components coordinate through `.maintenance.lock`, preventing the watchdog
from fighting an intentional backup or administrator restart. Install the
watchdog first, then configure the Discord `.env` and enable the bot. See each
directory's README for rollout and rollback instructions.

## Capacity

Inspected 2026-09-13: Oracle ARM Neoverse-N1, 2 cores, 12 GB RAM, Ubuntu 24.04,
approximately 48 GB free disk before installation. Existing Node/PM2 applications
share the host. Six-player capacity and latency require gameplay testing; startup
and idle resource usage alone cannot establish this. Large bases and exploration
may expose CPU limits under emulation.

## Deployment validation (2026-09-13)

Installed Valheim 1.0.12 (network version 40). Fresh world generation completed
and PlayFab reported an active session. Initial idle sample: 2.65 GiB RAM and
approximately 18% of one CPU core; this is not a six-player benchmark.
Graceful shutdown completed in approximately five seconds and produced the world
save. The backup archive was inspected and copied to local `backups/`.
This game version stores the world under `worlds_local/WaBot/` using `.db2`,
`.fwl2`, and chunk files; back up the entire directory rather than assuming two
legacy `.db`/`.fwl` files.

First install encountered SteamCMD `Missing configuration`; a retry downloaded
the game successfully. The upstream entrypoint does not stop immediately on an
unsuccessful Steam install. Check logs for a successful install and an active
PlayFab session; a running container alone is not a readiness check.

Reviewed upstream revision: `3ed9b27bca9b9b6637e0eb17415912e1e5200a9a`.
Restart validation passed: the existing world loaded and a new PlayFab session
became active. Post-restart idle sample was 2.74 GiB RAM and 17.5% of one CPU core.
Player login and six-player gameplay have not been tested.

During a five-player session on 2026-09-13, world generation pushed the game past
the original 6 GiB container limit and the kernel killed it after a successful
save. The limit was raised to 8 GiB. The local entrypoint wrapper also tracks the
Valheim pipeline explicitly so an unexpected game exit terminates the container
and allows Docker's restart policy to recover it; upstream otherwise keeps the
container alive via Xvfb while the game is no longer running.

Current world preset: **Hard** (`SERVER_PRESET=hard`). The entrypoint wrapper adds
the official `-preset` argument to the pinned upstream startup script. This
reapplies the preset on startup, overriding other world modifiers. World identity
and progress are preserved.
