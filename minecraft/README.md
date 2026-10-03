# Dapex Fabric

The current target is Minecraft Java 1.21.1, Fabric Loader 0.19.5, Java 21,
online authentication, and a whitelist. The container is pinned by repository
digest in `image.txt`; Minecraft, loader, and mod versions never update merely
because a newer release exists.

## Admin workflow

1. Switch Minecraft off (Valheim or `none` may own the slot).
2. Search Modrinth and add a compatible project, drag an individual Fabric JAR,
   or upload a CurseForge-exported modpack ZIP.
3. Review compatibility warnings and publish a numbered release.
4. Back up the Minecraft world before a risky change.
5. Switch the slot to Minecraft and inspect first-start logs.

The dashboard's **Files** section is for day-to-day Minecraft directories:
Fabric config, world datapacks, resource packs, logs, crash reports, and a
read-only world view. Minecraft must be Offline before any write, and every
write is preceded by a verified local snapshot. Keep mod JARs in Mod Workshop;
placing them manually would leave the player MRPACK out of sync.

Changing the Minecraft version re-resolves every managed Modrinth project for
Fabric on that version. If any project has no compatible release, the change
fails and the previous draft remains. Manual JAR metadata is checked when
possible, but an undeclared/non-semver Fabric requirement appears as a warning
rather than being guessed.

## Player workflow

The public page at `play.fahrelgibran.com` shows the active release and a
versioned `.mrpack` download. In Prism Launcher, use **Add Instance -> Import**,
select the file, sign into the player's original Microsoft account, and connect
to `mc.fahrelgibran.com` after the username has been added to the whitelist.

The MRPACK pins Minecraft, Fabric Loader, Modrinth file URLs/hashes, and embeds
manual JAR overrides. The exact same release can therefore be re-imported by
every player. Client-only Modrinth projects stay out of the server mod folder;
server-supported projects are downloaded and hash-verified at publish time.

Current Prism releases require Windows 10 or newer. Windows 7 is unsupported and
best-effort: a player can use a compatible legacy launcher that imports MRPACK,
or manually install the exact Minecraft/Fabric versions and mods represented by
the release. Do not weaken server online authentication for legacy clients.

## Data and backups

- `minecraft/data/`: world, whitelist, ops, and generated server configuration;
- `minecraft/generated/`: active server mods, profile manifest, and client pack;
- controller state: uploaded source JARs and immutable release artifacts.

Run `scripts/backup-minecraft.sh` while Minecraft owns the game slot. The script
uses the shared maintenance lock, stops the container, archives and verifies the
world, and resumes it afterward. Local archives keep at most five snapshots for
seven days and 8 GiB total, and refuse to consume the final 15 GiB of host disk.
The admin dashboard exposes this quick-rollback layer separately from encrypted
off-host restic/R2 history.
