#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/server/scripts"

cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  inspect)
    [[ ${FAKE_EXISTS:-true} == true ]] || exit 1
    if [[ "$2" == -f ]]; then
      printf '%s|%s|%s\n' "${FAKE_RUNNING:-true}" "${FAKE_STARTED_AT:-2026-09-13T00:00:00Z}" "${FAKE_HEALTH:-none}"
    fi
    ;;
  exec)
    [[ ${FAKE_PROCESS_READY:-true} == true ]] || exit 1
    ;;
  logs) printf '%s\n' "${FAKE_LOGS:-09/13/2026 16:06:10: Session \"mbg enak\" with join code 123456 and IP 0.0.0.0 is active with 0 player(s)}" ;;
  start|restart) exit "${FAKE_ACTION_EXIT:-0}" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$tmp/bin/docker"
cat >"$tmp/bin/flock" <<'EOF'
#!/usr/bin/env bash
if [[ ${FAKE_FLOCK_FAIL_SHARED:-false} == true && $1 == -sn ]]; then exit 1; fi
exit 0
EOF
chmod +x "$tmp/bin/flock"

cat >"$tmp/config" <<EOF
CONTAINER_NAME=valheim
SERVER_DIR=$tmp/server
LOCK_FILE=$tmp/watchdog.lock
GAME_SLOT_STATE_FILE=$tmp/game-slot.json
STARTUP_GRACE_SECONDS=0
RESTART_WINDOW_SECONDS=3600
MAX_RESTARTS_PER_WINDOW=3
BACKOFF_BASE_SECONDS=0
BACKOFF_MAX_SECONDS=0
EOF

state=$tmp/state.json
watchdog=$root/monitoring/valheim-watchdog
export PATH="$tmp/bin:$PATH"

assert_json() {
  python3 - "$state" "$1" "$2" <<'PY'
import json, sys
d=json.load(open(sys.argv[1]))
v=d
for part in sys.argv[2].split('.'):
    v=v[part]
expected=sys.argv[3]
actual=str(v).lower() if isinstance(v, bool) else str(v)
assert actual == expected, f"{sys.argv[2]}: expected {expected!r}, got {actual!r}"
PY
}

VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
assert_json status online
assert_json connection.join_code 123456

# The ready marker and join code remain valid when they rotate out of logs.
FAKE_LOGS=x VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
assert_json status online
assert_json connection.join_code 123456

FAKE_STARTED_AT=2026-09-13T00:00:01Z FAKE_PROCESS_READY=false FAKE_LOGS=x VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state" --dry-run || true
assert_json status down
assert_json action would_restart
assert_json recovery.attempts_in_window 0

FAKE_RUNNING=false VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
assert_json status restarting
assert_json action start

rm -f "$state"
FAKE_HEALTH=unhealthy VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
assert_json status restarting
assert_json action restart

# Startup grace suppresses recovery while Steam/Wine/Valheim are still loading.
sed 's/STARTUP_GRACE_SECONDS=0/STARTUP_GRACE_SECONDS=900/' "$tmp/config" >"$tmp/config-grace"
rm -f "$state"
FAKE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  FAKE_PROCESS_READY=false FAKE_LOGS=x \
  VALHEIM_WATCHDOG_CONFIG=$tmp/config-grace "$watchdog" --state-file "$state"
assert_json status starting
assert_json recovery.attempts_in_window 0

# A permanently false-up wrapper consumes a finite budget, then cools down.
rm -f "$state"
for _ in 1 2 3; do
  FAKE_PROCESS_READY=false FAKE_LOGS=x VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
done
FAKE_PROCESS_READY=false FAKE_LOGS=x VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state" || true
assert_json status down
assert_json action cooldown
assert_json recovery.attempts_in_window 3

# Intentional maintenance never triggers a competing recovery.
FAKE_FLOCK_FAIL_SHARED=true VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
assert_json status maintenance
assert_json action none

# Selecting Minecraft suppresses Valheim recovery and clears stale online state.
printf '{"desired":"minecraft"}\n' >"$tmp/game-slot.json"
FAKE_RUNNING=false VALHEIM_WATCHDOG_CONFIG=$tmp/config "$watchdog" --state-file "$state"
assert_json status inactive
assert_json action none
assert_json checks.playfab_ready false

echo 'watchdog tests passed'
