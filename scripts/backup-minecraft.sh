#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

maintenance_lock=${GAME_MAINTENANCE_LOCK:-$PWD/.maintenance.lock}
exec 8>"$maintenance_lock"
flock -w 10 8 || { echo 'Another game maintenance operation is running.' >&2; exit 1; }

mkdir -p backups/minecraft
running=$(docker inspect -f '{{.State.Running}}' minecraft 2>/dev/null || echo false)
resume() { [[ "$running" == true ]] && docker start minecraft >/dev/null || true; }
trap resume EXIT INT TERM
if [[ "$running" == true ]]; then docker stop -t 120 minecraft >/dev/null; fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="backups/minecraft/dapex-fabric-$timestamp.tar.gz"
sudo tar -czf "$archive" minecraft/data minecraft/generated
sudo chown "$(id -u):$(id -g)" "$archive"
tar -tzf "$archive" >/dev/null
echo "$archive"
