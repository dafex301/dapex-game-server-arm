#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo 'Missing control/.env; run the control installer first.' >&2; exit 1; }
read -rsp 'CurseForge API key: ' api_key
printf '\n'
[[ -n "$api_key" ]] || { echo 'API key cannot be empty.' >&2; exit 1; }

umask 077
temporary=$(mktemp .env.tmp.XXXXXX)
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    CURSEFORGE_API_KEY=*) printf 'CURSEFORGE_API_KEY=%s\n' "$api_key" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env >"$temporary"
mv "$temporary" .env
unset api_key
echo 'CurseForge API key stored with mode 600. Restart dapex-game-control to activate it.'
