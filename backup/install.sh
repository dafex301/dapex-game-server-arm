#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(id -u) -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
command -v restic >/dev/null 2>&1 || { echo 'Install restic first.' >&2; exit 1; }

deploy_dir=$PWD
service_user=${BACKUP_SERVICE_USER:-ubuntu}
getent passwd "$service_user" >/dev/null || { echo "Unknown service user: $service_user" >&2; exit 1; }

install -D -o root -g root -m 0755 backup/restic-backup /usr/local/sbin/dapex-restic-backup
for unit in backup/systemd/*.service backup/systemd/*.timer; do
  name=$(basename "$unit")
  sed -e "s|@DEPLOY_DIR@|$deploy_dir|g" -e "s|@SERVICE_USER@|$service_user|g" "$unit" \
    > "/etc/systemd/system/$name"
  chmod 0644 "/etc/systemd/system/$name"
done

if [[ ! -e /etc/dapex-game-backup.env ]]; then
  install -o root -g root -m 0600 backup/restic.env.example /etc/dapex-game-backup.env
  echo 'Created /etc/dapex-game-backup.env; configure it before enabling timers.'
fi
touch "$deploy_dir/.offsite-backup.lock"
chown "$service_user" "$deploy_dir/.offsite-backup.lock"
chmod 0600 "$deploy_dir/.offsite-backup.lock"
systemctl daemon-reload

cat <<EOF
Installed backup units. Next:
  1. Configure /etc/dapex-game-backup.env and its password file.
  2. Initialize once: sudo systemctl start dapex-offsite-backup-init.service
  3. Test: sudo systemctl start dapex-offsite-backup.service
  4. Enable: sudo systemctl enable --now dapex-offsite-backup.timer dapex-offsite-backup-maintenance.timer
EOF

