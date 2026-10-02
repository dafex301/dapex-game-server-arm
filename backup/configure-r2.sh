#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }

account_id=${CLOUDFLARE_ACCOUNT_ID:-cfdcd7f5481ea4de4734e670e1c9b75a}
bucket=${R2_BACKUP_BUCKET:-dapex-game-server-backups}
env_file=/etc/dapex-game-backup.env
password_file=/etc/dapex-game-backup.password

read -rp 'R2 Access Key ID: ' access_key
read -rsp 'R2 Secret Access Key: ' secret_key
printf '\n'
[[ -n $access_key && -n $secret_key ]] || { echo 'Both R2 credentials are required.' >&2; exit 1; }

umask 077
temporary=$(mktemp /etc/dapex-game-backup.env.tmp.XXXXXX)
trap 'rm -f -- "$temporary"; unset access_key secret_key' EXIT
cat >"$temporary" <<EOF
RESTIC_REPOSITORY=s3:https://${account_id}.r2.cloudflarestorage.com/${bucket}
RESTIC_PASSWORD_FILE=${password_file}
AWS_ACCESS_KEY_ID=${access_key}
AWS_SECRET_ACCESS_KEY=${secret_key}
AWS_DEFAULT_REGION=auto
RESTIC_KEEP_DAILY=7
RESTIC_KEEP_WEEKLY=5
RESTIC_KEEP_MONTHLY=12
RESTIC_KEEP_YEARLY=2
KEEP_LOCAL_ARCHIVES=false
EOF
chown root:root "$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$env_file"

if [[ ! -s $password_file ]]; then
  openssl rand -base64 48 >"$password_file"
fi
chown root:root "$password_file"
chmod 0600 "$password_file"
unset access_key secret_key
echo "R2 backup configuration stored for bucket ${bucket}."
echo 'The repository password remains only on this host; save a separate recovery copy before relying on the backup.'
