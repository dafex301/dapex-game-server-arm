const modrinthApi = 'https://api.modrinth.com/v2';
const curseForgeApi = 'https://api.curseforge.com/v1';

async function json(response) {
  if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
  return response.json();
}

export async function searchModrinth(query, minecraftVersion, limit = 20) {
  const facets = JSON.stringify([
    ['project_type:mod'],
    ['categories:fabric'],
    [`versions:${minecraftVersion}`],
  ]);
  const url = new URL(`${modrinthApi}/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('facets', facets);
  url.searchParams.set('limit', String(Math.min(limit, 50)));
  const body = await json(await fetch(url, { headers: { 'User-Agent': 'dapex-game-control/0.1 (admin panel)' } }));
  return body.hits.map((item) => ({
    source: 'modrinth',
    projectId: item.project_id,
    slug: item.slug,
    name: item.title,
    summary: item.description,
    iconUrl: item.icon_url,
    downloads: item.downloads,
    environment: item.environment,
    versions: item.versions,
  }));
}

export async function resolveModrinthVersion(projectId, minecraftVersion) {
  const url = new URL(`${modrinthApi}/project/${encodeURIComponent(projectId)}/version`);
  url.searchParams.set('loaders', JSON.stringify(['fabric']));
  url.searchParams.set('game_versions', JSON.stringify([minecraftVersion]));
  url.searchParams.set('featured', 'true');
  let versions = await json(await fetch(url, { headers: { 'User-Agent': 'dapex-game-control/0.1 (profile resolver)' } }));
  if (!versions.length) {
    url.searchParams.delete('featured');
    versions = await json(await fetch(url, { headers: { 'User-Agent': 'dapex-game-control/0.1 (profile resolver)' } }));
  }
  const version = versions.find((item) => item.version_type === 'release') || versions[0];
  if (!version) throw new Error(`No Fabric ${minecraftVersion} release found for ${projectId}`);
  const project = await json(await fetch(`${modrinthApi}/project/${encodeURIComponent(projectId)}`, { headers: { 'User-Agent': 'dapex-game-control/0.1 (profile resolver)' } }));
  return normalizedVersion(version, project);
}

export async function resolveModrinthVersionId(versionId, minecraftVersion) {
  const version = await json(await fetch(`${modrinthApi}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': 'dapex-game-control/0.1 (dependency resolver)' } }));
  if (!version.game_versions?.includes(minecraftVersion) || !version.loaders?.includes('fabric')) throw new Error(`Required dependency ${versionId} is not Fabric ${minecraftVersion} compatible`);
  const project = await json(await fetch(`${modrinthApi}/project/${encodeURIComponent(version.project_id)}`, { headers: { 'User-Agent': 'dapex-game-control/0.1 (dependency resolver)' } }));
  return normalizedVersion(version, project);
}

function normalizedVersion(version, project) {
  return {
    projectId: project.id,
    slug: project.slug,
    projectName: project.title,
    versionId: version.id,
    version: version.version_number,
    name: version.name,
    environment: { client: project.client_side, server: project.server_side },
    dependencies: version.dependencies || [],
    files: version.files.map((file) => ({ name: file.filename, primary: file.primary, hashes: file.hashes, url: file.url, size: file.size })),
  };
}

export async function searchCurseForge(query, minecraftVersion, apiKey, limit = 20) {
  if (!apiKey) throw new Error('CurseForge search is not configured; manual CurseForge uploads are still available');
  const url = new URL(`${curseForgeApi}/mods/search`);
  url.searchParams.set('gameId', '432');
  url.searchParams.set('classId', '6');
  url.searchParams.set('modLoaderType', '4');
  url.searchParams.set('gameVersion', minecraftVersion);
  url.searchParams.set('searchFilter', query);
  url.searchParams.set('pageSize', String(Math.min(limit, 50)));
  const body = await json(await fetch(url, { headers: { 'x-api-key': apiKey, Accept: 'application/json' } }));
  return body.data.map((item) => ({
    source: 'curseforge',
    projectId: String(item.id),
    slug: item.slug,
    name: item.name,
    summary: item.summary,
    iconUrl: item.logo?.thumbnailUrl || null,
    downloads: item.downloadCount,
    environment: ['unknown'],
    links: item.links,
  }));
}

export async function resolveCurseForgeFile(projectId, fileId, apiKey) {
  if (!apiKey) throw new Error('CURSEFORGE_API_KEY is required to import CurseForge pack files');
  const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
  const body = await json(await fetch(`${curseForgeApi}/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`, { headers }));
  const file = body.data;
  let url = file.downloadUrl;
  if (!url) {
    const download = await json(await fetch(`${curseForgeApi}/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download-url`, { headers }));
    url = download.data;
  }
  if (!url?.startsWith('https://')) throw new Error(`CurseForge file ${projectId}/${fileId} does not permit an API download`);
  const hashes = {};
  for (const hash of file.hashes || []) {
    if (hash.algo === 1) hashes.sha1 = hash.value.toLowerCase();
    if (hash.algo === 2) hashes.md5 = hash.value.toLowerCase();
  }
  return { name: file.fileName, url, size: file.fileLength, hashes, projectId: String(projectId), fileId: String(fileId) };
}
