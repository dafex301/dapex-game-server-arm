import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { createAuth, requireSameOrigin } from './auth.js';
import { searchCurseForge, searchModrinth } from './catalog.js';
import { loadConfig } from './config.js';
import { createOrchestrator } from './orchestrator.js';
import { createProfiles } from './profiles.js';
import { minecraftWhitelist } from './docker.js';
import { createManagement } from './management.js';
import { createFileExplorer } from './file-explorer.js';
import { run } from './process.js';
import { createRconConsole } from './rcon-console.js';

const config = loadConfig();
const orchestrator = createOrchestrator(config);
const profiles = createProfiles(config);
const management = createManagement(config);
const explorer = createFileExplorer(config, management);
const rconConsole = createRconConsole(config);
const app = express();
const uploadDir = path.join(config.stateDir, 'incoming');
await mkdir(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: config.maxUploadBytes, files: 1 } });
const auth = createAuth(config);
const operations = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { index: false, maxAge: '5m' }));
app.use('/packwiz/releases', express.static(path.join(config.stateDir, 'profiles', 'dapex-fabric', 'packwiz'), { index: false, dotfiles: 'deny', immutable: true, maxAge: '1y' }));

const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
const querySchema = z.object({ query: z.string().trim().min(2).max(100), source: z.enum(['modrinth', 'curseforge']).default('modrinth') });
const addSchema = z.object({ source: z.literal('modrinth'), projectId: z.string().min(1).max(100), slug: z.string().max(100).nullable().optional(), name: z.string().min(1).max(200) });
const versionSchema = z.object({ version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/) });
const switchSchema = z.object({ target: z.enum(['valheim', 'minecraft', 'none']) });
const whitelistSchema = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/) });
const worldSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'World name must start with a letter or number and use only letters, numbers, dot, dash, or underscore'),
  seed: z.string().max(128).optional().default(''),
});
const directorySchema = z.object({ path: z.string().min(1).max(512) });
const logQuerySchema = z.object({ lines: z.coerce.number().int().min(50).max(500).default(250) });
const commandSchema = z.object({ command: z.string().min(1).max(512) });

async function requireMinecraftReady() {
  const status = await orchestrator.status();
  if (status.active !== 'minecraft' || !status.containers.minecraft.running) {
    const error = new Error('Minecraft must be active before managing its whitelist');
    error.status = 409;
    throw error;
  }
  if (status.containers.minecraft.health !== 'healthy') {
    const error = new Error('Minecraft is still starting. Wait until it shows healthy, then try the whitelist command again.');
    error.status = 409;
    throw error;
  }
}

async function requireMinecraftStopped() {
  const status = await orchestrator.status();
  if (status.active === 'minecraft') {
    const error = new Error('Switch Minecraft to Offline before changing files');
    error.status = 409;
    throw error;
  }
}

app.get('/', (request, response) => {
  const playerHost = new URL(config.playerBaseUrl).hostname;
  const page = request.hostname === playerHost ? 'play.html' : 'admin.html';
  response.sendFile(path.join(import.meta.dirname, '..', 'public', page));
});
app.get('/play', (_request, response) => response.sendFile(path.join(import.meta.dirname, '..', 'public', 'play.html')));

app.get('/api/public', asyncRoute(async (_request, response) => {
  const [status, profile] = await Promise.all([orchestrator.status(), profiles.active()]);
  const [manualPackFile, autoPackFile] = profile.release ? await Promise.all([profiles.manualPackFile(profile.release), profiles.autoPackFile(profile.release)]) : [null, null];
  response.json({ status: { active: status.active, stats: status.stats }, profile, minecraftAddress: config.minecraftAddress, clientPack: profile.release ? `/downloads/dapex-fabric-v${profile.release}.mrpack` : null, autoPack: autoPackFile ? `/downloads/dapex-fabric-auto-v${profile.release}.zip` : null, manualPack: manualPackFile ? `/downloads/dapex-fabric-v${profile.release}-manual.zip` : null });
}));
app.get('/packwiz/pack.toml', asyncRoute(async (_request, response) => {
  const profile = await profiles.active();
  const file = await profiles.packwizPackFile(profile.release);
  if (!file) return response.status(404).type('text/plain').send('No auto-update pack has been published yet.');
  response.set('Cache-Control', 'no-store');
  response.type('text/plain').sendFile(file);
}));
app.use('/packwiz', asyncRoute(async (request, response, next) => {
  if (!['GET', 'HEAD'].includes(request.method) || request.path.startsWith('/releases/')) return next();
  const relative = request.path.replace(/^\/+/, '');
  const profile = await profiles.active();
  const file = await profiles.packwizAssetFile(profile.release, relative);
  if (!file) return response.status(404).type('text/plain').send('Packwiz asset not found.');
  response.set('Cache-Control', 'no-store');
  response.sendFile(file);
}));
app.get('/downloads/dapex-fabric-v:release.mrpack', asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.release)) return response.status(404).json({ error: 'Release not found' });
  const release = Number(request.params.release);
  const file = await profiles.clientPackFile(release);
  if (!file) return response.status(404).json({ error: 'Release not found' });
  response.download(file, `Dapex-Fabric-v${release}.mrpack`);
}));
app.get('/downloads/dapex-fabric-v:release-manual.zip', asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.release)) return response.status(404).json({ error: 'Release not found' });
  const release = Number(request.params.release);
  const file = await profiles.manualPackFile(release);
  if (!file) return response.status(404).json({ error: 'Release not found' });
  response.download(file, `Dapex-Fabric-v${release}-Manual-Windows.zip`);
}));
app.get('/downloads/dapex-fabric-auto-v:release.zip', asyncRoute(async (request, response) => {
  if (!/^\d+$/.test(request.params.release)) return response.status(404).json({ error: 'Release not found' });
  const release = Number(request.params.release);
  const file = await profiles.autoPackFile(release);
  if (!file) return response.status(404).json({ error: 'Auto-update profile not found' });
  response.download(file, `Dapex-Fabric-Auto-Update-v${release}.zip`);
}));

app.use('/api/admin', auth, requireSameOrigin(config));
app.get('/api/admin/status', asyncRoute(async (request, response) => {
  const [status, active, draft] = await Promise.all([orchestrator.status(), profiles.active(), profiles.draft()]);
  response.json({ actor: request.actor, status, active, draft, compatibility: profiles.compatibility(draft), capabilities: { curseForgeSearch: Boolean(config.curseForgeApiKey) } });
}));
app.post('/api/admin/switch', asyncRoute(async (request, response) => {
  const { target } = switchSchema.parse(request.body);
  const id = randomUUID();
  const operation = { id, type: 'switch', target, state: 'running', actor: request.actor, startedAt: new Date().toISOString() };
  operations.set(id, operation);
  void orchestrator.switchGame(target, request.actor).then((result) => {
    operations.set(id, { ...operation, state: 'complete', completedAt: new Date().toISOString(), result });
  }).catch((error) => {
    operations.set(id, { ...operation, state: 'failed', completedAt: new Date().toISOString(), error: error.message });
  });
  while (operations.size > 100) operations.delete(operations.keys().next().value);
  response.status(202).json(operation);
}));
app.get('/api/admin/operations/:id', (request, response) => {
  const operation = operations.get(request.params.id);
  if (!operation) return response.status(404).json({ error: 'Operation not found or the controller restarted' });
  response.json(operation);
});
app.get('/api/admin/catalog', asyncRoute(async (request, response) => {
  const { query, source } = querySchema.parse(request.query);
  const draft = await profiles.draft();
  const results = source === 'modrinth'
    ? await searchModrinth(query, draft.minecraftVersion)
    : await searchCurseForge(query, draft.minecraftVersion, config.curseForgeApiKey);
  response.json({ results });
}));
app.post('/api/admin/mods', asyncRoute(async (request, response) => {
  const mod = addSchema.parse(request.body);
  response.status(201).json(await profiles.addModrinth(mod, request.actor));
}));
app.delete('/api/admin/mods/:key', asyncRoute(async (request, response) => response.json(await profiles.removeMod(decodeURIComponent(request.params.key)))));
app.post('/api/admin/upload', upload.single('file'), asyncRoute(async (request, response) => {
  if (!request.file) throw new Error('A file is required');
  try {
    const onConflict = request.query.onConflict === 'replace' ? 'replace' : 'reject';
    response.status(201).json(await profiles.importUpload(request.file.path, request.file.originalname, request.actor, onConflict));
  } catch (error) {
    await rm(request.file.path, { force: true });
    throw error;
  }
}));
app.post('/api/admin/version', asyncRoute(async (request, response) => {
  const { version } = versionSchema.parse(request.body);
  response.json(await profiles.setVersion(version));
}));
app.post('/api/admin/publish', asyncRoute(async (request, response) => {
  const helper = path.join(config.deployDir, 'control', 'src', 'publish-cli.js');
  const output = await run('flock', ['-w', '900', config.operationLock, process.execPath, helper, request.actor], {
    cwd: config.deployDir,
    env: process.env,
    timeout: 960_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  response.status(201).json(JSON.parse(output));
}));
app.get('/api/admin/minecraft/whitelist', asyncRoute(async (_request, response) => {
  await requireMinecraftReady();
  const output = await minecraftWhitelist(config.minecraftContainer);
  const names = output.match(/:\s*(.*)$/)?.[1]?.split(',').map((name) => name.trim()).filter(Boolean) || [];
  response.json({ players: names, message: output });
}));
app.post('/api/admin/minecraft/whitelist', asyncRoute(async (request, response) => {
  const { username } = whitelistSchema.parse(request.body);
  await requireMinecraftReady();
  const message = await minecraftWhitelist(config.minecraftContainer, 'add', username);
  response.status(201).json({ message });
}));
app.delete('/api/admin/minecraft/whitelist', asyncRoute(async (request, response) => {
  const { username } = whitelistSchema.parse(request.body);
  await requireMinecraftReady();
  const message = await minecraftWhitelist(config.minecraftContainer, 'remove', username);
  response.json({ message });
}));

app.get('/api/admin/management', asyncRoute(async (_request, response) => response.json(await management.overview())));
app.get('/api/admin/logs/latest', asyncRoute(async (request, response) => {
  const { lines } = logQuerySchema.parse(request.query);
  response.json(await explorer.latestLog(lines));
}));
app.get('/api/admin/minecraft/commands', asyncRoute(async (_request, response) => response.json({ entries: await rconConsole.history() })));
app.post('/api/admin/minecraft/commands', asyncRoute(async (request, response) => {
  await requireMinecraftReady();
  const { command } = commandSchema.parse(request.body);
  response.status(201).json(await rconConsole.execute(command, request.actor));
}));
app.post('/api/admin/backups', asyncRoute(async (_request, response) => response.status(201).json(await management.backup())));
app.patch('/api/admin/minecraft/settings', asyncRoute(async (request, response) => {
  const status = await orchestrator.status();
  if (status.active === 'minecraft') {
    const error = new Error('Minecraft is running. Enter Maintenance first, save the settings, then start Minecraft again.');
    error.status = 409;
    throw error;
  }
  response.json(await management.updateSettings(request.body || {}));
}));
app.post('/api/admin/world/reset', asyncRoute(async (request, response) => {
  const status = await orchestrator.status();
  if (status.active === 'minecraft') {
    const error = new Error('Switch Minecraft to Offline before creating a new world');
    error.status = 409;
    throw error;
  }
  response.status(201).json(await management.resetWorld(worldSchema.parse(request.body)));
}));
app.get('/api/admin/files', asyncRoute(async (request, response) => response.json(await explorer.list(String(request.query.scope || ''), String(request.query.path || '')))));
app.get('/api/admin/files/text', asyncRoute(async (request, response) => response.json(await explorer.readText(String(request.query.scope || ''), String(request.query.path || '')))));
app.get('/api/admin/files/download', asyncRoute(async (request, response) => {
  const file = await explorer.download(String(request.query.scope || ''), String(request.query.path || ''));
  response.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/[\r\n"]/g, '')}"`);
  response.setHeader('Content-Length', String(file.size));
  file.stream.pipe(response);
}));
app.put('/api/admin/files/text', asyncRoute(async (request, response) => {
  await requireMinecraftStopped();
  response.json(await explorer.saveText(String(request.query.scope || ''), String(request.query.path || ''), String(request.body?.content ?? '')));
}));
app.post('/api/admin/files/upload', upload.single('file'), asyncRoute(async (request, response) => {
  await requireMinecraftStopped();
  if (!request.file) throw new Error('A file is required');
  try {
    response.status(201).json(await explorer.upload(String(request.query.scope || ''), String(request.query.path || ''), request.file));
  } catch (error) {
    await rm(request.file.path, { force: true });
    throw error;
  }
}));
app.post('/api/admin/files/directory', asyncRoute(async (request, response) => {
  await requireMinecraftStopped();
  const { path: relative } = directorySchema.parse(request.body);
  response.status(201).json(await explorer.createDirectory(String(request.query.scope || ''), relative));
}));
app.delete('/api/admin/files', asyncRoute(async (request, response) => {
  await requireMinecraftStopped();
  response.json(await explorer.remove(String(request.query.scope || ''), String(request.query.path || '')));
}));

app.use((error, request, response, _next) => {
  console.error(`${request.method} ${request.path}:`, error);
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Invalid request', details: error.issues });
    return;
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    response.status(413).json({ error: `Upload exceeds ${config.maxUploadBytes / 1024 / 1024} MiB` });
    return;
  }
  response.status(error.status || 500).json({ error: error.message || 'Unexpected control service error', ...(error.code ? { code: error.code } : {}), ...(error.conflict ? { conflict: error.conflict } : {}) });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Dapex game control listening on http://${config.host}:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
