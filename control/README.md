# Dapex game control

The control service is a Node 20 application bound to `127.0.0.1:8787`. It is
designed to be reached only through a Cloudflare Tunnel and protected with a
Cloudflare Access policy. Never publish port 8787 directly.

## What it owns

- one exclusive slot: `valheim`, `minecraft`, or `none`;
- fail-closed detection if both containers are ever running;
- stop-before-start switching with rollback to the previous game on failure;
- Minecraft version and pinned Fabric mod draft/release state;
- Modrinth catalog search and exact version/hash resolution;
- optional CurseForge search with an API key;
- inspected manual Fabric JAR upload and complete CurseForge pack ZIP import;
- immutable Dapex Fabric release manifests, downloadable MRPACK snapshots, and
  a hash-verified Packwiz feed used by the import-once Prism profile.
- an operations dashboard with bounded local backups, safe server settings,
  disk-reserve reporting, and backup-first world replacement.
- a Minecraft-only file explorer for curated configuration, datapack, resource
  pack, world, log, and crash-report areas.

Modrinth mods are downloaded over HTTPS and verified against the recorded
SHA-512 before being placed in the server profile. Uploaded JARs and packs are
checked as ZIP archives and path/symlink/size limits are enforced. CurseForge
pack manifests are resolved by exact project/file IDs through the official API;
download hashes are verified, Fabric metadata determines client/server placement,
and the pack's overrides are carried into both the server profile and MRPACK.
Files whose authors disable API distribution fail the release explicitly rather
than being silently omitted. Nested MRPACK import remains blocked; add those
projects through the Modrinth catalog instead.

Each successful publish also creates an immutable Packwiz directory and a Prism
instance ZIP containing the pinned Packwiz bootstrapper. `play.fahrelgibran.com`
serves the current `pack.toml` without caching, while versioned indexes,
metadata, and uploaded blobs are immutable. Prism runs the client-side updater
before launch, so an interrupted or invalid download prevents Minecraft from
starting with a partially updated profile.

Local Minecraft snapshots are deliberately bounded to five files, seven days,
and 8 GiB while preserving a 15 GiB free-disk reserve. Creating a new world is
only allowed while Minecraft is offline; the controller verifies a backup,
removes the old live world, records the new name/seed, and recreates the
container so its environment cannot remain stale. Long-term snapshots remain
encrypted in the separate restic/R2 repository.

The file explorer can browse and download while Minecraft is running. Writing,
uploading, creating a folder, or deleting requires Minecraft to be offline and
creates a verified snapshot before the change. Only `config`, the active world's
`datapacks`, and `resourcepacks` are writable. World data, logs, and crash reports
are read-only; dotfiles, symlinks, secrets, whitelist/operator data, and
`server.properties` are hidden and blocked. Mods remain managed by Mod Workshop
so the server manifest and player MRPACK cannot silently drift apart.

## Host installation

Copy the examples, set secrets, and keep them mode 600:

```sh
cp control/.env.example control/.env
cp minecraft/.env.example minecraft/.env
chmod 600 control/.env minecraft/.env
```

Required values include `CURSEFORGE_API_KEY`, a long random `CONTROL_INTERNAL_TOKEN`
shared with the Discord bot, and a long random Minecraft
RCON password. `GAME_DEPLOY_DIR` must match the checkout location. Then run:

```sh
./control/install.sh
```

To enter the CurseForge key without shell history or chat, use
`./control/set-curseforge-key.sh`, then restart `dapex-game-control`.

The installer snapshots the currently observed active game into controller state
before changing Valheim's Docker restart policy. It installs but does not start
the web service. After configuring Access and Tunnel, start it explicitly:

```sh
sudo systemctl start dapex-game-control
sudo systemctl status dapex-game-control dapex-game-reconcile
```

## Cloudflare and network layout

- `server.fahrelgibran.com` -> Tunnel -> `http://127.0.0.1:8787`, protected by
  Cloudflare Access. Anyone admitted by its policy can use the dashboard; membership
  is managed only in Cloudflare rather than duplicated in application configuration.
- `play.fahrelgibran.com` -> the same Tunnel origin, public player page.
- `mc.fahrelgibran.com` -> DNS-only A/AAAA record to the VM public address.

Minecraft is raw TCP on port 25565. A normal Cloudflare Tunnel hostname cannot
proxy a public vanilla Minecraft connection, so allow TCP 25565 in Oracle ingress
and the host firewall and keep the Minecraft DNS record unproxied. The Minecraft
server itself still requires Microsoft-authenticated Java accounts and a whitelist.

Use two Tunnel public-hostname entries for the web origins. Apply Access only to
the admin hostname. The application also binds localhost, checks the Access email,
and requires same-origin mutating browser requests. The internal bearer token is
intended only for the same-host Discord service.

## Rollback and recovery

If the controller is unavailable, both game containers remain manually operable:

```sh
docker stop -t 120 minecraft
docker start valheim
```

Repair the service, then reconcile controller state before re-enabling boot
reconciliation. If the invariant is ever violated and both games are running,
the controller refuses further switching; stop one container manually, inspect
why it started, and run the reconciler again.

Runtime state lives in `/var/lib/dapex-game-control` by default. Uploaded JARs,
release manifests, and every published MRPACK are retained there. World data is
separate in `minecraft/data` and must be backed up with
`scripts/backup-minecraft.sh` before risky mod or version changes.

The controller unit permits privilege elevation for the repository's existing
backup scripts. Its Docker group membership is already root-equivalent, so this
does not create a new security boundary; protect Cloudflare Access, the internal
token, and host login accordingly.
