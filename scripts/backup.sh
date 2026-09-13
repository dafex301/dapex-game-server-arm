#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep the watchdog and Discord operations from restarting the container while
# a consistent stop-and-copy backup is in progress.
maintenance_lock=${VALHEIM_MAINTENANCE_LOCK:-$PWD/.maintenance.lock}
exec 8>"$maintenance_lock"
flock -w 10 8 || { echo 'Another Valheim maintenance operation is running.' >&2; exit 1; }

mkdir -p backups
was_running=$(docker inspect -f '{{.State.Running}}' valheim)
resume() { if [ "$was_running" = true ]; then docker start valheim >/dev/null; fi; }
trap resume EXIT
if [ "$was_running" = true ]; then docker stop -t 120 valheim >/dev/null; fi
archive="backups/world-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
# Container creates root-owned files, so read the save with sudo.
sudo tar -czf "$archive" persistentdata
sudo chown "$(id -u):$(id -g)" "$archive"
chmod 600 "$archive"
printf '%s\n' "$archive"
