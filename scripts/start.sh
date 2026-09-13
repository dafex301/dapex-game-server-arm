#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${VALHEIM_IMAGE:?Set VALHEIM_IMAGE to the pinned image reference in image.txt}"
[ -f .env ] || { echo 'Create .env from .env.example first.' >&2; exit 1; }
mkdir -p server persistentdata
# Crossplay uses outbound PlayFab relays; no inbound ports are published.
docker run -d --name valheim --restart unless-stopped \
  --stop-timeout 120 --memory 8g --memory-swap 8g --cpus 1.5 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file .env --entrypoint /bin/bash \
  -v "$PWD/scripts/entrypoint.sh:/opt/valheim-entrypoint.sh:ro" \
  -v "$PWD/server:/root/valheim-server" \
  -v "$PWD/persistentdata:/root/.config/unity3d/IronGate/Valheim" \
  "$VALHEIM_IMAGE" /opt/valheim-entrypoint.sh
