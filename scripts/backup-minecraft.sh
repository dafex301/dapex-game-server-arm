#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

maintenance_lock=${GAME_MAINTENANCE_LOCK:-$PWD/.maintenance.lock}
exec 8>"$maintenance_lock"
flock -w 10 8 || { echo 'Another game maintenance operation is running.' >&2; exit 1; }

mkdir -p backups/minecraft
backup_dir=$PWD/backups/minecraft
keep_count=${MINECRAFT_LOCAL_BACKUP_COUNT:-5}
keep_days=${MINECRAFT_LOCAL_BACKUP_DAYS:-7}
max_bytes=${MINECRAFT_LOCAL_BACKUP_MAX_BYTES:-8589934592}
reserve_kib=${MINECRAFT_DISK_RESERVE_KIB:-15728640}

available_kib=$(df -Pk "$backup_dir" | awk 'NR==2 {print $4}')
source_kib=$(du -sk minecraft/data minecraft/generated | awk '{sum += $1} END {print sum + 0}')
(( available_kib - source_kib >= reserve_kib )) || {
  echo 'Not enough free disk for a safe Minecraft backup; 15 GiB must remain available.' >&2
  exit 1
}
running=$(docker inspect -f '{{.State.Running}}' minecraft 2>/dev/null || echo false)
resume() { [[ "$running" == true ]] && docker start minecraft >/dev/null || true; }
trap resume EXIT INT TERM
if [[ "$running" == true ]]; then docker stop -t 120 minecraft >/dev/null; fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="backups/minecraft/dapex-fabric-$timestamp.tar.gz"
sudo tar -czf "$archive" minecraft/data minecraft/generated
sudo chown "$(id -u):$(id -g)" "$archive"
tar -tzf "$archive" >/dev/null
current_size=$(stat -c %s "$archive")
if (( current_size > max_bytes )); then
  rm -f -- "$archive"
  echo 'Minecraft backup exceeds the entire 8 GiB local snapshot budget.' >&2
  exit 1
fi

# Local snapshots are quick rollback copies, not an unbounded archive. Off-host
# history is retained separately by restic/R2.
find "$backup_dir" -maxdepth 1 -type f -name 'dapex-fabric-*.tar.gz' -mtime "+$keep_days" -delete
mapfile -t snapshots < <(find "$backup_dir" -maxdepth 1 -type f -name 'dapex-fabric-*.tar.gz' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
for ((index=keep_count; index<${#snapshots[@]}; index++)); do rm -f -- "${snapshots[$index]}"; done
mapfile -t snapshots < <(find "$backup_dir" -maxdepth 1 -type f -name 'dapex-fabric-*.tar.gz' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
total=0
for snapshot in "${snapshots[@]}"; do
  size=$(stat -c %s "$snapshot")
  total=$((total + size))
  if (( total > max_bytes )); then rm -f -- "$snapshot"; fi
done
[[ -f $archive ]] || { echo 'New Minecraft backup was not retained.' >&2; exit 1; }
echo "$archive"
