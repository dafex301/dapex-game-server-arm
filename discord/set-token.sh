#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo 'Missing .env; configure IDs first.' >&2; exit 1; }
read -rsp 'Discord bot token: ' bot_token
printf '\n'
[[ -n "$bot_token" ]] || { echo 'Token cannot be empty.' >&2; exit 1; }

umask 077
temporary=$(mktemp .env.tmp.XXXXXX)
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    DISCORD_BOT_TOKEN=*) printf 'DISCORD_BOT_TOKEN=%s\n' "$bot_token" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env >"$temporary"
mv "$temporary" .env
unset bot_token
echo 'Discord token stored with mode 600.'
