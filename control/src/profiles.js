import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import yazl from 'yazl';
import { extractZipPrefix, inspectZip, hasZipMagic } from './archive.js';
import { readJson, writeJsonAtomic } from './files.js';
import { resolveCurseForgeFile, resolveModrinthVersion, resolveModrinthVersionId } from './catalog.js';

const allowedExtensions = new Set(['.jar', '.mrpack', '.zip']);

function initialProfile(config) {
  return {
    schemaVersion: 1,
    name: config.profileName,
    minecraftVersion: config.minecraftVersion,
    loader: 'fabric',
    release: 0,
    mods: [],
    updatedAt: null,
  };
}

function safeActor(actor) {
  return String(actor || 'unknown').slice(0, 200);
}

function hashFile(file, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadVerified(file, destination) {
  if (!file?.url?.startsWith('https://')) throw new Error(`Missing secure download URL for ${file?.name || 'mod'}`);
  const response = await fetch(file.url, { redirect: 'follow', headers: { 'User-Agent': 'dapex-game-control/0.1 (release publisher)' } });
  if (!response.ok) throw new Error(`Download failed for ${file.name} (${response.status})`);
  if (file.size && file.size > 512 * 1024 * 1024) throw new Error(`Refusing unexpectedly large mod file ${file.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (file.size && bytes.length !== file.size) throw new Error(`Size mismatch for ${file.name}`);
  const digest = createHash('sha512').update(bytes).digest('hex');
  if (file.hashes?.sha512 && digest !== file.hashes.sha512) throw new Error(`SHA-512 mismatch for ${file.name}`);
  if (file.hashes?.sha1 && createHash('sha1').update(bytes).digest('hex') !== file.hashes.sha1) throw new Error(`SHA-1 mismatch for ${file.name}`);
  await writeFileAtomic(destination, bytes);
}

async function writeFileAtomic(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, destination);
}

function primaryFile(mod) {
  return mod.files?.find((file) => file.primary) || mod.files?.[0];
}

function modIdentity(mod) {
  return mod.kind === 'fabric-mod' ? mod.metadata?.id : mod.source === 'modrinth' ? mod.slug : null;
}

function collapseExactDuplicates(profile) {
  const kept = new Map();
  const result = [];
  for (const mod of profile.mods) {
    const identity = modIdentity(mod);
    const key = identity ? `${identity}:${mod.version}` : null;
    if (!key || !kept.has(key)) {
      result.push(mod);
      if (key) kept.set(key, result.length - 1);
      continue;
    }
    const index = kept.get(key);
    if (mod.source === 'modrinth' && result[index].source !== 'modrinth') result[index] = mod;
  }
  profile.mods = result;
  return profile;
}

function satisfiesVersionRequirement(version, requirement) {
  const ranges = Array.isArray(requirement) ? requirement : [requirement];
  return ranges.some((range) => typeof range === 'string' && semver.valid(version) && semver.validRange(range) && semver.satisfies(version, range, { includePrerelease: true }));
}

function addBuffer(zip, value, name) {
  zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(value), name);
}

function writeZip(zip, destination) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', async () => {
      try { await writeFileAtomic(destination, Buffer.concat(chunks)); resolve(); } catch (error) { reject(error); }
    });
    zip.end();
  });
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function writeManualPack(profile, destination, loaderVersion) {
  const files = profile.mods.filter((mod) => mod.source === 'modrinth' && mod.side?.client !== 'unsupported').map((mod) => {
    const file = primaryFile(mod);
    if (!file?.url || !file.hashes?.sha512) throw new Error(`Manual installer requires a URL and SHA-512 for ${mod.name}`);
    return { name: file.name, url: file.url, sha512: file.hashes.sha512.toUpperCase(), size: file.size };
  });
  const unsupported = profile.mods.filter((mod) => mod.source !== 'modrinth' && mod.side !== 'server');
  if (unsupported.length) throw new Error(`Manual installer cannot safely distribute: ${unsupported.map((mod) => mod.name).join(', ')}`);
  const fileRows = files.map((file) => `  @{ Name=${powershellLiteral(file.name)}; Url=${powershellLiteral(file.url)}; Sha512=${powershellLiteral(file.sha512)}; Size=${Number(file.size || 0)} }`).join(",\r\n");
  const script = `$ErrorActionPreference = 'Stop'\r\n[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12\r\n$gameDir = Split-Path -Parent $MyInvocation.MyCommand.Path\r\n$modsDir = Join-Path $gameDir 'mods'\r\n$managedFile = Join-Path $modsDir '.dapex-managed-mods.txt'\r\n$files = @(\r\n${fileRows}\r\n)\r\n$newNames = @($files | ForEach-Object { $_.Name })\r\nNew-Item -ItemType Directory -Force -Path $modsDir | Out-Null\r\n$oldNames = @()\r\nif (Test-Path $managedFile) { $oldNames = @(Get-Content $managedFile | Where-Object { $_ }) }\r\n$allowed = @($newNames + $oldNames | Select-Object -Unique)\r\n$foreign = @(Get-ChildItem $modsDir -Filter '*.jar' -ErrorAction SilentlyContinue | Where-Object { $allowed -notcontains $_.Name })\r\nif ($foreign.Count -gt 0) {\r\n  Write-Host 'STOP: This is not a clean Dapex game directory.' -ForegroundColor Red\r\n  Write-Host ('Remove these foreign mods or extract this ZIP into a new folder: ' + (($foreign | ForEach-Object { $_.Name }) -join ', '))\r\n  exit 2\r\n}\r\n$sha512 = [System.Security.Cryptography.SHA512]::Create()\r\n$web = New-Object System.Net.WebClient\r\nforeach ($file in $files) {\r\n  $target = Join-Path $modsDir $file.Name\r\n  $temporary = $target + '.download'\r\n  Write-Host ('Downloading ' + $file.Name + '...') -ForegroundColor Cyan\r\n  $web.DownloadFile($file.Url, $temporary)\r\n  $stream = [System.IO.File]::OpenRead($temporary)\r\n  try { $hash = ([BitConverter]::ToString($sha512.ComputeHash($stream))).Replace('-', '') } finally { $stream.Dispose() }\r\n  if ($hash -ne $file.Sha512) { Remove-Item $temporary -Force; throw ('Hash verification failed for ' + $file.Name) }\r\n  Move-Item $temporary $target -Force\r\n}\r\nforeach ($oldName in $oldNames) {\r\n  if ($newNames -notcontains $oldName) { Remove-Item (Join-Path $modsDir $oldName) -Force -ErrorAction SilentlyContinue }\r\n}\r\n$newNames | Set-Content -Encoding ASCII $managedFile\r\nWrite-Host ''\r\nWrite-Host 'Dapex Fabric mods installed and verified.' -ForegroundColor Green\r\nWrite-Host 'Launch the dedicated Minecraft ${profile.minecraftVersion} / Fabric ${loaderVersion} profile, then connect to mc.fahrelgibran.com.'\r\n`;
  const readme = `DAPEX FABRIC ${profile.releaseName || `V${profile.release}`} - MANUAL WINDOWS SETUP\r\n\r\nThis package is for launchers that cannot import MRPACK, including legacy Windows 7 setups.\r\n\r\n1. Create a NEW, EMPTY game directory, for example C:\\Minecraft\\Dapex.\r\n2. In your launcher, create Minecraft ${profile.minecraftVersion} with Fabric Loader ${loaderVersion}.\r\n3. Set that launcher's Game Directory to the new Dapex folder.\r\n4. Extract every file from this ZIP into that folder.\r\n5. Double-click install-mods.bat. It downloads and verifies the exact release files.\r\n6. Launch the dedicated profile and connect to mc.fahrelgibran.com.\r\n\r\nDo not extract this into an existing RPG/modpack instance. The installer refuses unknown JAR files to prevent protocol mismatches.\r\nJava 21 is required by Minecraft ${profile.minecraftVersion}.\r\n`;
  const tutorial = `TUTORIAL DAPEX FABRIC ${profile.releaseName || `V${profile.release}`} - WINDOWS MANUAL\r\n\r\nINSTALASI PERTAMA\r\n1. Buat profil Minecraft ${profile.minecraftVersion} dengan Fabric Loader ${loaderVersion} di launcher.\r\n2. Pakai Game Directory baru dan kosong, contoh C:\\Minecraft\\Dapex.\r\n3. Extract seluruh isi ZIP ini ke Game Directory tersebut.\r\n4. Klik dua kali install-mods.bat dan tunggu sampai muncul pesan berhasil.\r\n5. Jalankan profil Fabric tadi lalu masuk ke mc.fahrelgibran.com.\r\n\r\nKETIKA ADA UPDATE MOD\r\n1. Buka https://play.fahrelgibran.com dan download Manual Windows versi terbaru.\r\n2. Extract/replace isinya ke Game Directory Dapex yang sama.\r\n3. Jalankan install-mods.bat lagi. Mod Dapex lama akan diperbarui atau dihapus otomatis.\r\n4. Jangan menyalakan Minecraft selama installer berjalan.\r\n\r\nPENTING\r\n- Jangan campur folder ini dengan modpack RPG atau mod lain.\r\n- Installer menolak JAR asing untuk mencegah Network Protocol Error.\r\n- Minecraft ${profile.minecraftVersion} membutuhkan Java 21.\r\n- Jika installer gagal, screenshot seluruh pesan di jendela hitam dan kirim ke admin.\r\n`;
  const batch = '@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-mods.ps1"\r\necho.\r\npause\r\n';
  const zip = new yazl.ZipFile();
  addBuffer(zip, readme, 'README-WINDOWS.txt');
  addBuffer(zip, tutorial, 'TUTORIAL.txt');
  addBuffer(zip, batch, 'install-mods.bat');
  addBuffer(zip, script, 'install-mods.ps1');
  addBuffer(zip, `${JSON.stringify({ release: profile.release, minecraft: profile.minecraftVersion, fabricLoader: loaderVersion, files }, null, 2)}\n`, 'manual-manifest.json');
  await writeZip(zip, destination);
  return destination;
}

async function exposeToContainer(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await exposeToContainer(target);
    else if (entry.isFile()) await chmod(target, 0o644);
  }
}

export function createProfiles(config) {
  const profileDir = path.join(config.stateDir, 'profiles', 'dapex-fabric');
  const draftFile = path.join(profileDir, 'draft.json');
  const activeFile = path.join(profileDir, 'active.json');
  const uploadDir = path.join(profileDir, 'uploads');
  const releasesDir = path.join(profileDir, 'releases');
  let uploadMutation = Promise.resolve();

  async function active() {
    return readJson(activeFile, initialProfile(config));
  }

  async function draft() {
    return readJson(draftFile, await active());
  }

  async function saveDraft(value) {
    collapseExactDuplicates(value);
    value.updatedAt = new Date().toISOString();
    await writeJsonAtomic(draftFile, value);
    return value;
  }

  async function addModrinth(project, actor) {
    const current = await draft();
    if (current.mods.some((mod) => mod.source === 'modrinth' && mod.projectId === project.projectId)) return current;
    const resolving = new Set();
    async function stage(projectId, requestedVersionId = null, hint = {}) {
      if (current.mods.some((mod) => mod.source === 'modrinth' && mod.projectId === projectId)) return;
      if (resolving.has(projectId)) return;
      resolving.add(projectId);
      const resolved = requestedVersionId
        ? await resolveModrinthVersionId(requestedVersionId, current.minecraftVersion)
        : await resolveModrinthVersion(projectId, current.minecraftVersion);
      for (const dependency of resolved.dependencies || []) {
        if (dependency.dependency_type !== 'required') continue;
        const dependencyId = dependency.project_id || (await resolveModrinthVersionId(dependency.version_id, current.minecraftVersion)).projectId;
        await stage(dependencyId, dependency.version_id);
      }
      current.mods.push({
        source: 'modrinth', projectId: resolved.projectId || projectId,
        slug: hint.slug || resolved.slug, name: hint.name || resolved.projectName || projectId,
        side: resolved.environment || 'unknown', versionId: resolved.versionId,
        version: resolved.version, minecraftVersion: current.minecraftVersion,
        dependencies: resolved.dependencies, files: resolved.files,
        addedBy: safeActor(actor), addedAt: new Date().toISOString(),
      });
      resolving.delete(projectId);
    }
    await stage(project.projectId, null, project);
    return saveDraft(current);
  }

  async function removeMod(key) {
    const current = await draft();
    const before = current.mods.length;
    current.mods = current.mods.filter((mod) => `${mod.source}:${mod.projectId || mod.sha256}` !== key);
    if (current.mods.length === before) throw new Error('Mod was not found in the draft');
    return saveDraft(current);
  }

  async function importUploadUnlocked(file, originalName, actor, onConflict = 'reject') {
    const extension = path.extname(originalName).toLowerCase();
    if (!allowedExtensions.has(extension)) throw new Error('Only .jar, .mrpack, and .zip uploads are accepted');
    if (!(await hasZipMagic(file))) throw new Error('Uploaded file is not a valid ZIP/JAR archive');
    const archive = await inspectZip(file);
    const sha256 = await hashFile(file);
    await mkdir(uploadDir, { recursive: true });
    const stored = path.join(uploadDir, `${sha256}${extension}`);
    await copyFile(file, stored);
    await rm(file, { force: true });

    let kind = 'unknown-archive';
    let metadata = {};
    if (archive.documents['fabric.mod.json']) {
      kind = 'fabric-mod';
      const fabric = archive.documents['fabric.mod.json'];
      metadata = { id: fabric.id, name: fabric.name || fabric.id, version: fabric.version, environment: fabric.environment || '*', depends: fabric.depends || {} };
    } else if (archive.documents['modrinth.index.json']) {
      kind = 'modrinth-pack';
      const pack = archive.documents['modrinth.index.json'];
      metadata = { name: pack.name, version: pack.versionId, dependencies: pack.dependencies, files: pack.files?.length || 0 };
    } else if (archive.documents['manifest.json']?.minecraft) {
      kind = 'curseforge-pack';
      const pack = archive.documents['manifest.json'];
      metadata = { name: pack.name, version: pack.version, minecraft: pack.minecraft, files: pack.files || [], overrides: pack.overrides || 'overrides' };
    }

    const current = await draft();
    if (current.mods.some((mod) => mod.sha256 === sha256)) return { profile: current, upload: { action: 'ignored', reason: 'same-file' } };
    const incoming = {
      source: 'upload',
      projectId: metadata.id || null,
      sha256,
      originalName,
      stored,
      kind,
      name: metadata.name || originalName,
      version: metadata.version || 'unknown',
      side: metadata.environment || 'unknown',
      metadata,
      addedBy: safeActor(actor),
      addedAt: new Date().toISOString(),
    };
    if (kind === 'fabric-mod' && metadata.id) {
      const duplicate = current.mods.find((mod) => (mod.metadata?.id || mod.slug || mod.projectId) === metadata.id);
      if (duplicate && String(duplicate.version) === String(incoming.version)) {
        return { profile: current, upload: { action: 'ignored', reason: 'same-version', existing: { name: duplicate.name, version: duplicate.version, source: duplicate.source } } };
      }
      if (duplicate && onConflict !== 'replace') {
        const error = new Error(`${metadata.name} ${metadata.version} conflicts with staged version ${duplicate.version}`);
        error.status = 409;
        error.code = 'MOD_VERSION_CONFLICT';
        error.conflict = {
          id: metadata.id,
          existing: { name: duplicate.name, version: duplicate.version, source: duplicate.source },
          incoming: { name: incoming.name, version: incoming.version, source: incoming.source, originalName },
        };
        throw error;
      }
      if (duplicate) current.mods = current.mods.filter((mod) => mod !== duplicate);
    }
    current.mods.push(incoming);
    const saved = await saveDraft(current);
    return { profile: saved, upload: { action: 'staged', replaced: kind === 'fabric-mod' ? metadata.id : null } };
  }

  async function importUpload(file, originalName, actor, onConflict = 'reject') {
    const result = uploadMutation.then(() => importUploadUnlocked(file, originalName, actor, onConflict));
    uploadMutation = result.catch(() => {});
    return result;
  }

  function compatibility(profile) {
    const issues = [];
    const modrinthProjects = new Set(profile.mods.filter((mod) => mod.source === 'modrinth').map((mod) => mod.projectId));
    const modrinthVersions = new Set(profile.mods.filter((mod) => mod.source === 'modrinth').map((mod) => mod.versionId));
    const versionsByIdentity = new Map();
    for (const mod of profile.mods) {
      const identity = modIdentity(mod);
      if (!identity) continue;
      const versions = versionsByIdentity.get(identity) || new Set();
      versions.add(String(mod.version));
      versionsByIdentity.set(identity, versions);
    }
    for (const [identity, versions] of versionsByIdentity) {
      if (versions.size > 1) issues.push({ level: 'block', mod: identity, message: `Multiple versions staged: ${[...versions].join(', ')}` });
    }
    for (const mod of profile.mods) {
      if (mod.kind === 'unknown-archive') issues.push({ level: 'block', mod: mod.name, message: 'Archive type could not be identified' });
      if (mod.kind === 'curseforge-pack') {
        const gameVersion = mod.metadata?.minecraft?.version;
        if (gameVersion && gameVersion !== profile.minecraftVersion) issues.push({ level: 'block', mod: mod.name, message: `Pack targets Minecraft ${gameVersion}` });
        const loaders = mod.metadata?.minecraft?.modLoaders || [];
        if (loaders.length && !loaders.some((loader) => String(loader.id).startsWith('fabric-'))) issues.push({ level: 'block', mod: mod.name, message: 'Pack does not declare a Fabric loader' });
        if (!config.curseForgeApiKey) issues.push({ level: 'block', mod: mod.name, message: 'CURSEFORGE_API_KEY is required to resolve the pack files' });
      }
      if (mod.kind === 'modrinth-pack') issues.push({ level: 'block', mod: mod.name, message: 'Nested Modrinth pack import is not supported; add its projects from the catalog or upload individual JARs' });
      if (mod.kind === 'fabric-mod') {
        const requirement = mod.metadata?.depends?.minecraft;
        if (!requirement) issues.push({ level: 'warn', mod: mod.name, message: 'Minecraft compatibility is not declared' });
        else if (typeof requirement === 'string' && semver.valid(profile.minecraftVersion) && semver.validRange(requirement) && !semver.satisfies(profile.minecraftVersion, requirement, { includePrerelease: true })) {
          issues.push({ level: 'block', mod: mod.name, message: `Declares Minecraft requirement ${requirement}` });
        }
        const loaderRequirement = mod.metadata?.depends?.fabricloader;
        if (loaderRequirement && !satisfiesVersionRequirement(config.fabricLoaderVersion, loaderRequirement)) {
          issues.push({ level: 'block', mod: mod.name, message: `Requires Fabric Loader ${Array.isArray(loaderRequirement) ? loaderRequirement.join(' or ') : loaderRequirement}; configured ${config.fabricLoaderVersion}` });
        }
      }
      if (mod.source === 'modrinth') {
        if (mod.minecraftVersion !== profile.minecraftVersion) issues.push({ level: 'block', mod: mod.name, message: `Resolved for Minecraft ${mod.minecraftVersion}, not ${profile.minecraftVersion}` });
        for (const dependency of mod.dependencies || []) {
          if (dependency.dependency_type !== 'required') continue;
          const present = dependency.version_id
            ? modrinthVersions.has(dependency.version_id)
            : Boolean(dependency.project_id && modrinthProjects.has(dependency.project_id));
          if (!present) issues.push({ level: 'block', mod: mod.name, message: `Missing required Modrinth dependency ${dependency.project_id || dependency.version_id}` });
        }
      }
    }
    return { ok: !issues.some((issue) => issue.level === 'block'), issues };
  }

  async function publish(actor) {
    const current = await draft();
    const check = compatibility(current);
    if (!check.ok) throw new Error(`Draft is blocked: ${check.issues.map((issue) => issue.message).join('; ')}`);
    const release = current.release + 1;
    const published = { ...current, release, releaseName: `${current.name} v${release}`, publishedBy: safeActor(actor), publishedAt: new Date().toISOString() };
    await mkdir(releasesDir, { recursive: true });
    const clientPack = await materializeServerProfile(published);
    await writeJsonAtomic(path.join(releasesDir, `v${release}.json`), published);
    await copyFile(clientPack, path.join(releasesDir, `dapex-fabric-v${release}.mrpack`));
    try {
      await writeManualPack(published, path.join(releasesDir, `dapex-fabric-v${release}-manual.zip`), config.fabricLoaderVersion);
    } catch (error) {
      if (!String(error.message).startsWith('Manual installer cannot safely distribute:')) throw error;
    }
    await writeJsonAtomic(activeFile, published);
    await writeJsonAtomic(draftFile, published);
    return published;
  }

  async function materializeServerProfile(profile) {
    const generatedDir = path.join(config.deployDir, 'minecraft', 'generated');
    const buildDir = path.join(config.deployDir, 'minecraft', `.generated-v${profile.release}-${process.pid}`);
    const serverMods = path.join(buildDir, 'server-mods');
    const serverOverrides = path.join(buildDir, 'server-overrides');
    await rm(buildDir, { recursive: true, force: true });
    await mkdir(path.dirname(generatedDir), { recursive: true });
    await Promise.all([mkdir(serverMods, { recursive: true }), mkdir(serverOverrides, { recursive: true })]);
    const indexFiles = [];
    const clientOverrides = [];
    for (const mod of profile.mods) {
      if (mod.source === 'modrinth') {
        const file = primaryFile(mod);
        if (!file) throw new Error(`No downloadable file recorded for ${mod.name}`);
        const environment = { client: mod.side?.client || 'required', server: mod.side?.server || 'required' };
        indexFiles.push({ path: `mods/${file.name}`, hashes: file.hashes, env: environment, downloads: [file.url], fileSize: file.size });
        if (environment.server !== 'unsupported') await downloadVerified(file, path.join(serverMods, file.name));
      }
      if (mod.source === 'upload' && mod.kind === 'fabric-mod') {
        const fileName = `${mod.projectId || mod.sha256.slice(0, 12)}-${String(mod.version).replace(/[^a-zA-Z0-9._-]/g, '_')}.jar`;
        if (mod.side !== 'client') await copyFile(mod.stored, path.join(serverMods, fileName));
        clientOverrides.push({ source: mod.stored, path: `overrides/mods/${fileName}` });
      }
      if (mod.source === 'upload' && mod.kind === 'curseforge-pack') {
        const overridePrefix = `${String(mod.metadata.overrides || 'overrides').replace(/^\/+|\/+$/g, '')}/`;
        await extractZipPrefix(mod.stored, overridePrefix, serverOverrides);
        for (const reference of mod.metadata.files || []) {
          const file = await resolveCurseForgeFile(reference.projectID, reference.fileID, config.curseForgeApiKey);
          const destination = path.join(serverMods, file.name);
          await downloadVerified(file, destination);
          const inspected = await inspectZip(destination);
          const fabric = inspected.documents['fabric.mod.json'];
          if (!fabric) throw new Error(`CurseForge file ${file.name} is not a Fabric mod JAR`);
          const sha512 = await hashFile(destination, 'sha512');
          const hashes = { ...file.hashes, sha512 };
          const environment = fabric.environment || '*';
          indexFiles.push({ path: `mods/${file.name}`, hashes, env: { client: environment === 'server' ? 'unsupported' : 'required', server: environment === 'client' ? 'unsupported' : 'required' }, downloads: [file.url], fileSize: file.size });
          if (environment === 'client') await rm(destination, { force: true });
        }
        const overrideFiles = await import('node:fs/promises').then(({ readdir }) => readdir(serverOverrides, { recursive: true, withFileTypes: true }).catch(() => []));
        for (const entry of overrideFiles) {
          if (!entry.isFile()) continue;
          const source = path.join(entry.parentPath || entry.path, entry.name);
          const relative = path.relative(serverOverrides, source);
          clientOverrides.push({ source, path: `overrides/${relative.split(path.sep).join('/')}` });
        }
      }
    }
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: `v${profile.release}`,
      name: profile.name,
      summary: `${profile.name} v${profile.release}, managed by Dapex Game Control`,
      files: indexFiles,
      dependencies: { minecraft: profile.minecraftVersion, 'fabric-loader': config.fabricLoaderVersion },
    };
    const zip = new yazl.ZipFile();
    addBuffer(zip, `${JSON.stringify(index, null, 2)}\n`, 'modrinth.index.json');
    for (const file of clientOverrides) zip.addFile(file.source, file.path);
    await writeZip(zip, path.join(buildDir, `dapex-fabric-v${profile.release}.mrpack`));
    await writeJsonAtomic(path.join(buildDir, 'profile.json'), profile);
    await exposeToContainer(serverMods);
    await exposeToContainer(serverOverrides);
    const previous = `${generatedDir}.previous`;
    await rm(previous, { recursive: true, force: true });
    try { await rename(generatedDir, previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(buildDir, generatedDir); } catch (error) {
      try { await rename(previous, generatedDir); } catch {}
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    return path.join(generatedDir, `dapex-fabric-v${profile.release}.mrpack`);
  }

  async function setVersion(version) {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid Minecraft version');
    const current = await draft();
    const resolvedMods = [];
    for (const mod of current.mods) {
      if (mod.source !== 'modrinth') {
        resolvedMods.push(mod);
        continue;
      }
      const resolved = await resolveModrinthVersion(mod.projectId, version);
      resolvedMods.push({ ...mod, versionId: resolved.versionId, version: resolved.version, minecraftVersion: version, side: resolved.environment || mod.side, dependencies: resolved.dependencies, files: resolved.files });
    }
    current.minecraftVersion = version;
    current.mods = resolvedMods;
    return saveDraft(current);
  }

  async function clientPackFile(release) {
    if (!Number.isSafeInteger(release) || release < 1) return null;
    const manifest = await readJson(path.join(releasesDir, `v${release}.json`), null);
    return manifest ? path.join(releasesDir, `dapex-fabric-v${release}.mrpack`) : null;
  }

  async function manualPackFile(release) {
    if (!Number.isSafeInteger(release) || release < 1) return null;
    const manifest = await readJson(path.join(releasesDir, `v${release}.json`), null);
    if (!manifest) return null;
    const destination = path.join(releasesDir, `dapex-fabric-v${release}-manual.zip`);
    try { await access(destination); } catch {
      try { await writeManualPack(manifest, destination, config.fabricLoaderVersion); } catch (error) {
        if (String(error.message).startsWith('Manual installer cannot safely distribute:')) return null;
        throw error;
      }
    }
    return destination;
  }

  return { active, draft, addModrinth, removeMod, importUpload, compatibility, publish, setVersion, clientPackFile, manualPackFile };
}
