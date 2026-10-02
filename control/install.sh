#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
deploy_dir=$PWD
service_user=$(id -un)
node_bin=$(command -v node)

[[ -f control/.env ]] || { echo 'Create control/.env from control/.env.example first' >&2; exit 1; }
[[ -f minecraft/.env ]] || { echo 'Create minecraft/.env from minecraft/.env.example first' >&2; exit 1; }

sudo install -d -o "$service_user" -g docker -m 0770 /var/lib/dapex-game-control
sudo touch /var/lock/dapex-game-control.lock
sudo chown "$service_user":docker /var/lock/dapex-game-control.lock
sudo chmod 0660 /var/lock/dapex-game-control.lock
npm --prefix control ci --omit=dev
"$node_bin" --env-file=control/.env control/src/initialize-cli.js
if docker inspect valheim >/dev/null 2>&1; then
  docker update --restart=no valheim >/dev/null
fi
for unit in dapex-game-control.service dapex-game-reconcile.service; do
  sed -e "s|@DEPLOY_DIR@|$deploy_dir|g" \
      -e "s|@NODE_BIN@|$node_bin|g" \
      -e "s|@SERVICE_USER@|$service_user|g" \
      "control/systemd/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
  sudo chmod 0644 "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable dapex-game-control.service dapex-game-reconcile.service
echo 'Installed. Start the control service after configuring Cloudflare Access and the tunnel route.'
