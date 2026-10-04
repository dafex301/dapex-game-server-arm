#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/project/scripts" "$tmp/project/backups/minecraft"
printf 'secret\n' > "$tmp/password"

cat > "$tmp/bin/restic" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RESTIC_TEST_LOG"
case "$1" in
  stats) printf '{"total_size":948533274}\n' ;;
  snapshots) printf '[{"id":"aaaaaaaaaaaaaaaa","time":"2026-10-01T00:00:00Z"},{"id":"bbbbbbbbbbbbbbbb","time":"2026-10-02T00:00:00Z"}]\n' ;;
esac
SH
cat > "$tmp/bin/flock" <<'SH'
#!/usr/bin/env bash
# The unit test only needs a successful nonblocking lock; Linux CI exercises
# the real util-linux flock command.
exit 0
SH
cat > "$tmp/project/scripts/valheim" <<'SH'
#!/usr/bin/env bash
mkdir -p backups
printf data > backups/valheim-test.tar.gz
printf '%s\n' backups/valheim-test.tar.gz
SH
cat > "$tmp/project/scripts/minecraft" <<'SH'
#!/usr/bin/env bash
mkdir -p backups/minecraft
printf data > backups/minecraft/minecraft-test.tar.gz
printf '%s\n' backups/minecraft/minecraft-test.tar.gz
SH
chmod +x "$tmp/bin/restic" "$tmp/bin/flock" "$tmp/project/scripts/valheim" "$tmp/project/scripts/minecraft"

common=(
  PATH="$tmp/bin:$PATH"
  BACKUP_PROJECT_ROOT="$tmp/project"
  RESTIC_BIN="$tmp/bin/restic"
  RESTIC_REPOSITORY="$tmp/repository"
  RESTIC_PASSWORD_FILE="$tmp/password"
  RESTIC_TEST_LOG="$tmp/restic.log"
  VALHEIM_BACKUP_COMMAND="$tmp/project/scripts/valheim"
  MINECRAFT_BACKUP_COMMAND="$tmp/project/scripts/minecraft"
)

env "${common[@]}" "$repo_root/backup/restic-backup" backup
grep -q '^backup .*backups/valheim-test.tar.gz backups/minecraft/minecraft-test.tar.gz$' "$tmp/restic.log"
[[ ! -e "$tmp/project/backups/valheim-test.tar.gz" ]]
[[ ! -e "$tmp/project/backups/minecraft/minecraft-test.tar.gz" ]]

env "${common[@]}" KEEP_LOCAL_ARCHIVES=true "$repo_root/backup/restic-backup" backup
[[ -e "$tmp/project/backups/valheim-test.tar.gz" ]]
[[ -e "$tmp/project/backups/minecraft/minecraft-test.tar.gz" ]]

cat > "$tmp/bin/restic-fail" <<'SH'
#!/usr/bin/env bash
exit 23
SH
chmod +x "$tmp/bin/restic-fail"
rm -f "$tmp/project/backups/valheim-test.tar.gz" "$tmp/project/backups/minecraft/minecraft-test.tar.gz"
if env "${common[@]}" RESTIC_BIN="$tmp/bin/restic-fail" "$repo_root/backup/restic-backup" backup; then
  echo 'failed upload unexpectedly succeeded' >&2
  exit 1
fi
[[ -e "$tmp/project/backups/valheim-test.tar.gz" ]]
[[ -e "$tmp/project/backups/minecraft/minecraft-test.tar.gz" ]]

env "${common[@]}" "$repo_root/backup/restic-backup" forget
grep -q '^forget --prune --tag dapex-game-server --keep-daily 4 --keep-weekly 2 --keep-monthly 2 --keep-yearly 1$' "$tmp/restic.log"
env "${common[@]}" "$repo_root/backup/restic-backup" enforce-limit
grep -q '^stats --mode raw-data --json --tag dapex-game-server$' "$tmp/restic.log"

cat > "$tmp/bin/restic-limit" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RESTIC_TEST_LOG"
case "$1" in
  stats)
    [[ -e $RESTIC_LIMIT_PRUNED ]] && printf '{"total_size":7000000000}\n' || printf '{"total_size":8000000000}\n'
    ;;
  snapshots)
    printf '[{"id":"aaaaaaaaaaaaaaaa","time":"2026-10-01T00:00:00Z"},{"id":"bbbbbbbbbbbbbbbb","time":"2026-10-02T00:00:00Z"},{"id":"cccccccccccccccc","time":"2026-10-03T00:00:00Z"}]\n'
    ;;
  forget) touch "$RESTIC_LIMIT_PRUNED" ;;
esac
SH
chmod +x "$tmp/bin/restic-limit"
env "${common[@]}" RESTIC_BIN="$tmp/bin/restic-limit" RESTIC_LIMIT_PRUNED="$tmp/pruned" "$repo_root/backup/restic-backup" enforce-limit
grep -q '^forget --prune aaaaaaaaaaaaaaaa$' "$tmp/restic.log"

env "${common[@]}" "$repo_root/backup/restic-backup" check
grep -q '^check --read-data-subset=5%$' "$tmp/restic.log"

if env -u RESTIC_REPOSITORY RESTIC_BIN="$tmp/bin/restic" RESTIC_PASSWORD_FILE="$tmp/password" \
  "$repo_root/backup/restic-backup" snapshots 2>/dev/null; then
  echo 'missing repository unexpectedly succeeded' >&2
  exit 1
fi

echo 'off-host backup tests passed'
