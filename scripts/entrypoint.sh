#!/usr/bin/env bash
set -euo pipefail
case "${SERVER_PRESET:-normal}" in
  normal|casual|easy|hard|hardcore|immersive|hammer) ;;
  *) echo 'Unsupported SERVER_PRESET' >&2; exit 1 ;;
esac
grep -q '    -world ' /root/entrypoint.sh
sed '/    -world /a\    -preset "${SERVER_PRESET:-normal}" \\' /root/entrypoint.sh \
  | sed '/    -preset /a\    -modifier combat hard \\' \
  | sed '/    -modifier combat /a\    -modifier deathpenalty veryeasy \\' \
  | sed '/^    2>&1 | tee -a .* &$/a\valheim_job_pid=$!' \
  | sed 's/^wait$/wait "$valheim_job_pid"/' \
  > /tmp/valheim-entrypoint.sh
exec bash /tmp/valheim-entrypoint.sh
