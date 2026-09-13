# Valheim watchdog

This directory is the host-side availability layer. It does not depend on the
Discord bot, so recovery continues if Discord or the bot is unavailable.

Every minute the systemd timer performs a single locked check. A server is
`online` only when all of these are true:

1. the Docker container exists and is running;
2. `pgrep -f` finds the Valheim server process inside the container;
3. the current container start's logs contain a PlayFab-ready marker.

During the configured 15-minute cold-start grace it reports `starting`. After
that, false-up containers are restarted. Missing containers are recreated from
`SERVER_DIR/image.txt` and `scripts/start.sh`; stopped containers are started.
Recovery uses exponential backoff and stops after three attempts in an hour.
Docker's own `unless-stopped` policy remains the fast first line of recovery.
Readiness and the join code are cached for the lifetime of the exact container
start, so log rotation cannot turn a healthy long-running server into a false
outage and the timer never repeatedly scans the full log history.

Backup and manual operations should hold an exclusive maintenance lock while
they intentionally stop or replace the container. The watchdog takes that lock
shared and nonblocking and reports `maintenance` without recovery when it is
held. For example:

```sh
flock /home/ubuntu/valheim-server-arm/.maintenance.lock ./scripts/backup.sh
```

The installer creates this lock as `ubuntu:docker` with mode `0660` and
preserves its inode on later installs. The deployment's `scripts/backup.sh`
already acquires it; the explicit `flock` example is for other maintenance.

## Install

From the project directory on the host:

```sh
sudo ./monitoring/install.sh
```

Review `/etc/default/valheim-watchdog` first if the deployment is not
`/home/ubuntu/valheim-server-arm`. The installer preserves an existing config.
It installs the config mode `0600` because a heartbeat URL contains a unique
credential. It installs files outside the repository only when explicitly run.

Useful operations:

```sh
sudo /usr/local/sbin/valheim-watchdog --dry-run
cat /var/lib/valheim-watchdog/state.json | python3 -m json.tool
systemctl status valheim-watchdog.timer
journalctl -u valheim-watchdog.service --since today
```

Rollback without touching the Valheim container or saves:

```sh
sudo systemctl disable --now valheim-watchdog.timer
sudo rm /etc/systemd/system/valheim-watchdog.service \
  /etc/systemd/system/valheim-watchdog.timer
sudo systemctl daemon-reload
```

The installed script, configuration, and state may be retained for inspection or
removed separately after the timer is disabled.

The state file is replaced atomically and is mode `0644`, allowing an
unprivileged local Discord bot to read it. Important fields are `status`
(`online`, `starting`, `restarting`, `maintenance`, `down`, or `unknown`), `reason`, `action`,
the individual health checks, the current join code, and recovery counters.
Because the join code is public to local users through this file, restrict host
login access appropriately. The Valheim password is never read or emitted.

Set `HOST_HEARTBEAT_URL` to a Healthchecks.io-compatible ping URL to provide an
external dead-man signal. It is called after every completed check regardless of
game status, making total host/network/watchdog loss detectable from outside.
Heartbeat errors are logged but never affect game health or recovery.

`--dry-run` does not change Docker and does not consume the restart budget. The
test suite uses a fake Docker executable and can be run without root:

```sh
./monitoring/tests/run.sh
```

When wiring Discord alerts, notify on `status` transitions rather than every
timer execution. A host-local bot cannot alert when the entire VM or network is
down; use an external heartbeat/dead-man monitor for that failure mode.
