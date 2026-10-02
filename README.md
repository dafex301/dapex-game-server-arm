# Dapex Game Server ARM

A self-hosted multiplayer game platform for running **Valheim** and a modded
**Minecraft Fabric** server on one ARM64 machine.

Small ARM servers are capable of hosting either game, but running both at once
creates unnecessary CPU and memory contention. This project treats the machine
as one exclusive game slot: Valheim, Minecraft, or offline. A local controller
performs every transition, verifies that the selected server is ready, and rolls
back to the previous game when startup fails.

The repository also includes a web dashboard, a player-facing Minecraft pack
portal, Discord operations, backups, health monitoring, and systemd deployment.

## What it does

- Runs Valheim on ARM64 through Box64/Wine using
  [`tsx-cloud/valheim-arm`](https://github.com/tsx-cloud/valheim-arm).
- Runs Minecraft Java 1.21.1 with Fabric and Java 21 using a pinned
  [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server)
  image.
- Guarantees that Valheim and Minecraft cannot intentionally run together.
- Switches games gracefully and restores the previous server after a failed boot.
- Reconciles the selected game automatically after a host restart.
- Provides a private admin dashboard and a public player onboarding page.
- Builds versioned **Dapex Fabric** releases that players can import into Prism
  Launcher as `.mrpack` files.
- Supports pinned Modrinth projects, required dependency resolution, manual
  Fabric JAR uploads, and CurseForge modpack manifests through the official API.
- Verifies downloaded file hashes and respects CurseForge author distribution
  permissions.
- Keeps Docker logs bounded and game data outside the containers.

## Architecture

```text
                         Cloudflare Access
                                │
                    ┌───────────▼───────────┐
                    │ Admin dashboard       │
                    │ server.example.com    │
                    └───────────┬───────────┘
                                │ localhost:8787
Discord bot ── bearer token ──► Game controller ◄── Player portal
                                │                    + MRPACK downloads
                       exclusive operation lock
                         ┌───────┴────────┐
                         │                │
                    Valheim           Minecraft
                  Box64 + Wine       Fabric + Java 21
                         │                │
                   world saves       world + mods
```

Both game containers use `restart=no`. The controller is the only component that
owns desired game state and boot reconciliation. The Valheim watchdog reads that
same state, so it will not mistake an intentional switch to Minecraft for an
outage and restart Valheim behind it.

## Discord integration

The included Discord bot keeps operations in the same place players already
coordinate:

- a persistent Valheim status card;
- transition and high-memory alerts;
- current Valheim player count and PlayFab join code;
- `/valheim status`, `/valheim join`, and `/valheim players`;
- admin-only `/valheim restart` and `/valheim backup`;
- `/game status` for the shared game slot;
- admin-only `/game switch` for Valheim, Minecraft, or offline.

Discord never receives direct Docker access from a command. Game switching goes
through the bounded localhost control API, uses the same exclusive lock as the
web dashboard, and accepts only the three known targets.

## Minecraft mod workflow

1. An administrator selects the Minecraft and Fabric versions.
2. Mods are added from Modrinth, uploaded as Fabric JARs, or imported from a
   CurseForge modpack ZIP.
3. The controller resolves exact versions and required dependencies.
4. Compatibility and distribution rules are checked before publishing.
5. Publishing creates an immutable release manifest, the server mod directory,
   configuration overrides, and a versioned MRPACK.
6. Players import that MRPACK into Prism Launcher and connect with their normal
   Microsoft-authenticated Minecraft Java account.

Minecraft runs with `online-mode=true` and a whitelist. Current Prism Launcher
releases require a supported modern operating system; Windows 7 is best-effort
and is not a supported deployment target.

## Repository layout

| Path | Purpose |
| --- | --- |
| `control/` | Web UI, authentication, game orchestration, mod profiles, and systemd units |
| `discord/` | Discord status, alerts, backups, and game-switch commands |
| `minecraft/` | Minecraft environment template, pinned image, world and generated-profile mounts |
| `monitoring/` | Valheim process/PlayFab watchdog and bounded recovery policy |
| `scripts/` | Container entrypoints, startup scripts, and consistent backups |

Detailed documentation:

- [Control plane, security, Cloudflare, and rollback](control/README.md)
- [Minecraft profiles and player onboarding](minecraft/README.md)
- [Valheim watchdog](monitoring/README.md)
- [Discord operations](discord/README.md)

## Resource model

The production host that motivated this project is an ARM64 VM with two CPU
cores and roughly 12 GB RAM. Current container limits are:

| Game | Memory | CPU | Typical idle memory |
| --- | ---: | ---: | ---: |
| Valheim | 9 GiB | 1.5 cores | approximately 2.7 GiB |
| Minecraft Fabric | 7 GiB | 1.75 cores | approximately 1 GiB without mods |

These are operational limits, not player-capacity guarantees. Mod complexity,
world generation, base size, exploration, and concurrent players must be tested
with the actual pack and world.

## Deployment outline

The host requires Docker, Node.js 20+, `flock`, systemd, and an ARM64 Linux
environment.

```sh
cp .env.example .env
cp minecraft/.env.example minecraft/.env
cp control/.env.example control/.env
cp discord/.env.example discord/.env
chmod 600 .env minecraft/.env control/.env discord/.env
```

Configure strong unique secrets and the required IDs, then install the watchdog
and controller according to their directory READMEs. The control service binds
to `127.0.0.1` and should only be exposed through a protected reverse tunnel.

Minecraft uses raw TCP port 25565. A normal Cloudflare Tunnel public hostname
does not proxy a vanilla Minecraft connection, so its DNS record must remain
DNS-only and the port must be allowed by both the cloud firewall and host
firewall.

## Security model

- No real secrets, world saves, backups, uploaded mods, or runtime state belong
  in Git.
- Admin web traffic is expected to pass through Cloudflare Access and an exact
  email allowlist.
- Browser mutations require the configured same origin.
- Discord authenticates with a separate same-host bearer token.
- Uploaded archives are inspected without unsafe extraction and are constrained
  by path, symlink, entry-count, and expanded-size limits.
- Container images and published mod versions are pinned.
- Docker group membership is root-equivalent; the control service is an
  operational boundary, not a sandbox against a compromised host account.

## Project status

The controller, both game containers, Discord integration, watchdog, profile
publishing, and rollback flow have been exercised on an ARM64 host. Valheim and
Minecraft were each booted to application-level readiness, switched in both
directions, and verified never to run concurrently.

This is a personal, non-commercial project for a small private group. It is not
affiliated with Iron Gate, Mojang, Microsoft, Fabric, Modrinth, CurseForge,
Overwolf, or the upstream container authors.
