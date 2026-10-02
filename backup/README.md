# Off-host backups

This directory adds encrypted, deduplicated off-host backups with
[restic](https://restic.net/). It works with S3-compatible stores such as
Cloudflare R2, SFTP, a rest-server, and local/removable repositories.

Each run invokes the existing Valheim and Minecraft backup scripts. Those
scripts share the game maintenance lock, stop a running game long enough to
produce a consistent tarball, verify the Minecraft archive, and restore the
previous running state. The resulting two archives are uploaded in one restic
snapshot. Temporary local archives are deleted only after a successful upload
unless `KEEP_LOCAL_ARCHIVES=true`.

The off-site lock prevents overlapping scheduled uploads. It is deliberately
separate from the game maintenance lock, because each game backup script owns
that lock while it makes its consistent local archive.

## Installation

Install `restic`, then from the repository root:

```bash
sudo ./backup/install.sh
sudo ./backup/configure-r2.sh
sudo systemctl start dapex-offsite-backup-init.service
sudo systemctl start dapex-offsite-backup.service
sudo systemctl enable --now dapex-offsite-backup.timer dapex-offsite-backup-maintenance.timer
```

Create provider credentials with access to only the backup bucket/prefix. Do
not reuse a Cloudflare global API key. Keep the env and password files owned by
root, readable only by the dedicated backup service group, and not world-readable.
The repository password is required for restoration;
store a separate copy in a password manager.

For Cloudflare R2, create a private bucket and an R2 API token restricted to
Object Read & Write for that bucket. Set the S3 repository URL and the
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION=auto`
variables shown in `restic.env.example`.

On the prepared `wa-bot` host, enter the one-time R2 values without putting
them in shell history or process arguments:

```bash
ssh -t wa-bot 'cd ~/valheim-server-arm && sudo ./backup/configure-r2.sh'
```

## Operations

```bash
# View snapshots without exposing credentials in shell history
sudo systemctl start dapex-offsite-backup.service
sudo journalctl -u dapex-offsite-backup.service -n 100

# For an interactive restic command, load the root-only environment
sudo bash -c 'set -a; source /etc/dapex-game-backup.env; set +a; /usr/local/sbin/dapex-restic-backup snapshots'

# Restore into an empty staging directory; never restore over a live world
sudo bash -c 'set -a; source /etc/dapex-game-backup.env; set +a; restic restore latest --target /srv/dapex-restore'
```

Inspect restored archives with `tar -tzf` before stopping a live game. Restore
the desired `persistentdata` or `minecraft/data` tree using the same ownership
as the existing deployment. A backup is not considered proven until a test
restore has been performed.

The daily timer runs at 04:15 Asia/Jakarta. The weekly timer applies retention
(7 daily, 5 weekly, 12 monthly, 2 yearly by default), prunes unreferenced data,
and reads a random 5% of repository data. Set `RESTIC_CHECK_SUBSET=100%` for a
full check during a planned maintenance window.
