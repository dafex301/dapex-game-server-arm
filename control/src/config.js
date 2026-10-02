import path from 'node:path';

function integer(name, fallback, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function boolean(name, fallback = false) {
  const raw = String(process.env[name] ?? fallback).toLowerCase();
  if (!['true', 'false'].includes(raw)) throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

function safeContainer(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value)) throw new Error(`${name} is not a safe container name`);
  return value;
}

export function loadConfig() {
  const deployDir = path.resolve(process.env.GAME_DEPLOY_DIR || path.join(import.meta.dirname, '..', '..'));
  return Object.freeze({
    host: process.env.CONTROL_HOST?.trim() || '127.0.0.1',
    port: integer('CONTROL_PORT', 8787),
    baseUrl: process.env.CONTROL_BASE_URL?.trim() || 'https://server.fahrelgibran.com',
    playerBaseUrl: process.env.PLAYER_BASE_URL?.trim() || 'https://play.server.fahrelgibran.com',
    minecraftAddress: process.env.MINECRAFT_ADDRESS?.trim() || 'mc.fahrelgibran.com',
    allowedEmails: new Set((process.env.CONTROL_ALLOWED_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)),
    internalToken: process.env.CONTROL_INTERNAL_TOKEN?.trim() || null,
    authDisabled: boolean('CONTROL_AUTH_DISABLED'),
    deployDir,
    stateDir: path.resolve(process.env.GAME_STATE_DIR || path.join(deployDir, 'runtime', 'control')),
    operationLock: path.resolve(process.env.GAME_OPERATION_LOCK || path.join(deployDir, '.game-operation.lock')),
    valheimContainer: safeContainer('VALHEIM_CONTAINER', 'valheim'),
    minecraftContainer: safeContainer('MINECRAFT_CONTAINER', 'minecraft'),
    minecraftVersion: process.env.MINECRAFT_VERSION?.trim() || '1.21.1',
    fabricLoaderVersion: process.env.FABRIC_LOADER_VERSION?.trim() || '0.16.10',
    profileName: process.env.MINECRAFT_PROFILE_NAME?.trim() || 'Dapex Fabric',
    curseForgeApiKey: process.env.CURSEFORGE_API_KEY?.trim() || null,
    maxUploadBytes: integer('MAX_UPLOAD_MIB', 512) * 1024 * 1024,
  });
}
