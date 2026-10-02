# Dapex game control

The control service is a Node 20 application bound to `127.0.0.1:8787`. It is
designed to be reached only through a Cloudflare Tunnel and protected with a
Cloudflare Access email allowlist. Never publish port 8787 directly.

## What it owns

- one exclusive slot: `valheim`, `minecraft`, or `none`;
- fail-closed detection if both containers are ever running;
- stop-before-start switching with rollback to the previous game on failure;
- Minecraft version and pinned Fabric mod draft/release state;
- Modrinth catalog search and exact version/hash resolution;
- optional CurseForge search with an API key;
- inspected manual Fabric JAR upload and complete CurseForge pack ZIP import;
- immutable Dapex Fabric release manifests and downloadable MRPACK files.

Modrinth mods are downloaded over HTTPS and verified against the recorded
SHA-512 before being placed in the server profile. Uploaded JARs and packs are
checked as ZIP archives and path/symlink/size limits are enforced. CurseForge
pack manifests are resolved by exact project/file IDs through the official API;
download hashes are verified, Fabric metadata determines client/server placement,
and the pack's overrides are carried into both the server profile and MRPACK.
Files whose authors disable API distribution fail the release explicitly rather
than being silently omitted. Nested MRPACK import remains blocked; add those
projects through the Modrinth catalog instead.

## Host installation

Copy the examples, set secrets, and keep them mode 600:

```sh
cp control/.env.example control/.env
cp minecraft/.env.example minecraft/.env
chmod 600 control/.env minecraft/.env
```

Required values include `CONTROL_ALLOWED_EMAILS`, `CURSEFORGE_API_KEY`, a long random
`CONTROL_INTERNAL_TOKEN` shared with the Discord bot, and a long random Minecraft
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
  Cloudflare Access and the configured exact email allowlist.
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
