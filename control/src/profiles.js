import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

  async function active() {
    return readJson(activeFile, initialProfile(config));
  }

  async function draft() {
    return readJson(draftFile, await active());
  }

  async function saveDraft(value) {
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

  async function importUpload(file, originalName, actor) {
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
    if (current.mods.some((mod) => mod.sha256 === sha256)) return current;
    current.mods.push({
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
    });
    return saveDraft(current);
  }

  function compatibility(profile) {
    const issues = [];
    const modrinthProjects = new Set(profile.mods.filter((mod) => mod.source === 'modrinth').map((mod) => mod.projectId));
    const modrinthVersions = new Set(profile.mods.filter((mod) => mod.source === 'modrinth').map((mod) => mod.versionId));
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

  return { active, draft, addModrinth, removeMod, importUpload, compatibility, publish, setVersion, clientPackFile };
}
