#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

env_file=${MINECRAFT_ENV_FILE:-minecraft/.env}
image_file=${MINECRAFT_IMAGE_FILE:-minecraft/image.txt}
[[ -f "$env_file" ]] || { echo "Missing $env_file; copy minecraft/.env.example and set secrets" >&2; exit 1; }
[[ -f "$image_file" ]] || { echo "Missing pinned Minecraft image file: $image_file" >&2; exit 1; }

mkdir -p minecraft/data/mods minecraft/generated/server-mods minecraft/generated/server-overrides
chmod -R a+rX minecraft/generated/server-mods
chmod -R a+rX minecraft/generated/server-overrides
image=$(tr -d '[:space:]' < "$image_file")
[[ "$image" == *@sha256:* ]] || { echo "Minecraft image must be pinned by digest" >&2; exit 1; }

# /data survives container replacement, while /mods is the exact published
# release. Remove stale managed JARs so upgrades and removals cannot leave a
# second version for Fabric to discover. The container copies /mods back into
# /data during initialization.
find minecraft/data/mods -mindepth 1 -maxdepth 1 -type f -name '*.jar' -delete

docker run -d --name minecraft --restart no \
  --stop-timeout 120 --memory 7g --memory-swap 7g --cpus 1.75 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file "$env_file" \
  -p 25565:25565/tcp \
  -v "$PWD/minecraft/data:/data" \
  -v "$PWD/minecraft/generated/server-mods:/mods:ro" \
  -v "$PWD/minecraft/generated/server-overrides:/config:ro" \
  "$image"
