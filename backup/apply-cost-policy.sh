#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
env_file=${DAPEX_BACKUP_ENV_FILE:-/etc/dapex-game-backup.env}
[[ -f $env_file ]] || { echo "Missing $env_file" >&2; exit 1; }

temporary=$(mktemp "${env_file}.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
awk -F= '
  BEGIN {
    values["RESTIC_KEEP_DAILY"]="4"
    values["RESTIC_KEEP_WEEKLY"]="2"
    values["RESTIC_KEEP_MONTHLY"]="2"
    values["RESTIC_KEEP_YEARLY"]="1"
    values["RESTIC_MAX_REPOSITORY_BYTES"]="7516192768"
    values["RESTIC_MIN_SNAPSHOTS"]="2"
  }
  $1 in values { print $1 "=" values[$1]; seen[$1]=1; next }
  { print }
  END { for (key in values) if (!seen[key]) print key "=" values[key] }
' "$env_file" > "$temporary"
chown --reference="$env_file" "$temporary"
chmod --reference="$env_file" "$temporary"
mv -f -- "$temporary" "$env_file"
trap - EXIT
echo 'Applied bounded R2 retention: 4 daily, 2 weekly, 2 monthly, 1 yearly, 7 GiB maximum, 2 snapshots minimum.'
