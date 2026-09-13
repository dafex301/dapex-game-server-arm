#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

install -D -o root -g root -m 0755 valheim-watchdog /usr/local/sbin/valheim-watchdog
if [[ ! -e /etc/default/valheim-watchdog ]]; then
  install -D -o root -g root -m 0600 valheim-watchdog.conf.example /etc/default/valheim-watchdog
else
  echo 'Preserving existing /etc/default/valheim-watchdog'
fi
install -D -o root -g root -m 0644 systemd/valheim-watchdog.service /etc/systemd/system/valheim-watchdog.service
install -D -o root -g root -m 0644 systemd/valheim-watchdog.timer /etc/systemd/system/valheim-watchdog.timer
install -d -o root -g root -m 0755 /var/lib/valheim-watchdog
# Preserve this inode across reinstalls so an active maintenance lock is never
# replaced while the watchdog or Discord bot is using it.
touch /home/ubuntu/valheim-server-arm/.maintenance.lock
chown ubuntu:docker /home/ubuntu/valheim-server-arm/.maintenance.lock
chmod 0660 /home/ubuntu/valheim-server-arm/.maintenance.lock
systemctl daemon-reload
systemctl enable --now valheim-watchdog.timer
systemctl start valheim-watchdog.service
systemctl --no-pager status valheim-watchdog.timer
