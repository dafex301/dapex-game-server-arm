const state = { payload: null, management: null, busy: false, whitelist: [], files: { scope: 'config', path: '', listing: null, editing: null, tree: {} }, logs: { payload: null, commands: [], filter: 'all', follow: true, busy: false, commandBusy: false, suggestions: [], selectedSuggestion: 0 } };
let whitelistLoaded = false;
const $ = (selector) => document.querySelector(selector);
const commandCatalog = [
  ['list', 'Show online players'], ['say <message>', 'Broadcast a server message'], ['seed', 'Show the current world seed'],
  ['time set day', 'Set daytime'], ['time set night', 'Set nighttime'], ['weather clear', 'Clear the weather'], ['weather rain', 'Start rain'], ['weather thunder', 'Start a thunderstorm'],
  ['difficulty peaceful', 'Set peaceful difficulty'], ['difficulty easy', 'Set easy difficulty'], ['difficulty normal', 'Set normal difficulty'], ['difficulty hard', 'Set hard difficulty'],
  ['gamemode survival <player>', 'Set player to survival'], ['gamemode creative <player>', 'Set player to creative'], ['gamemode adventure <player>', 'Set player to adventure'], ['gamemode spectator <player>', 'Set player to spectator'],
  ['give <player> minecraft:<item> [count]', 'Give an item'], ['tp <player> <target|x y z>', 'Teleport a player'], ['effect give <player> minecraft:<effect> [seconds] [amplifier]', 'Apply an effect'], ['effect clear <player>', 'Clear player effects'],
  ['clear <player>', 'Clear inventory'], ['kill <player>', 'Kill a player'], ['kick <player> [reason]', 'Disconnect a player'], ['ban <player> [reason]', 'Ban a player'], ['pardon <player>', 'Remove a player ban'],
  ['op <player>', 'Grant operator access'], ['deop <player>', 'Remove operator access'], ['whitelist list', 'Show allowed players'], ['whitelist add <player>', 'Allow a player'], ['whitelist remove <player>', 'Remove an allowed player'],
  ['gamerule keepInventory true', 'Keep inventory after death'], ['gamerule keepInventory false', 'Drop inventory after death'], ['gamerule doDaylightCycle true', 'Enable day cycle'], ['gamerule doDaylightCycle false', 'Freeze day cycle'], ['gamerule mobGriefing true', 'Allow mob block changes'], ['gamerule mobGriefing false', 'Prevent mob block changes'],
  ['setworldspawn', 'Set world spawn here'], ['spawnpoint <player>', 'Set player spawn here'], ['experience add <player> <amount> points', 'Give experience points'], ['enchant <player> minecraft:<enchantment> [level]', 'Enchant held item'],
];
const fileScopes = [
  { name: 'config', label: 'config', group: 'MINECRAFT' },
  { name: 'datapacks', label: 'datapacks', group: 'MINECRAFT' },
  { name: 'resourcepacks', label: 'resourcepacks', group: 'MINECRAFT' },
  { name: 'world', label: 'world', group: 'READ ONLY', muted: true },
  { name: 'logs', label: 'logs', group: 'READ ONLY', muted: true },
  { name: 'crashes', label: 'crash-reports', group: 'READ ONLY', muted: true },
];

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message || 'The request could not be completed';
  node.classList.toggle('toast-error', error);
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 4000);
}

function modKey(mod) { return `${mod.source}:${mod.projectId || mod.sha256}`; }
function sideLabel(side) { return typeof side === 'object' && side ? `client:${side.client || '?'} / server:${side.server || '?'}` : String(side || 'unknown'); }
function bytes(value) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`; }
function filePath(name = '') { return [state.files.path, name].filter(Boolean).join('/'); }
function renderTreeChildren(scope, parent = '', depth = 0) {
  const children = state.files.tree[scope]?.[parent];
  if (!children?.length) return '';
  return `<div class="tree-branch">${children.map((name) => {
    const childPath = [parent, name].filter(Boolean).join('/');
    const onPath = state.files.scope === scope && (state.files.path === childPath || state.files.path.startsWith(`${childPath}/`));
    const loaded = Object.hasOwn(state.files.tree[scope] || {}, childPath);
    return `<button class="tree-node child${state.files.scope === scope && state.files.path === childPath ? ' active' : ''}" style="--tree-depth:${depth + 1}" data-tree-scope="${scope}" data-tree-path="${encodeURIComponent(childPath)}"><span>${onPath || loaded ? '▾' : '▸'}</span><i class="folder-icon${fileScopes.find((item) => item.name === scope)?.muted ? ' muted' : ''}"></i><em>${escapeHtml(name)}</em></button>${onPath || loaded ? renderTreeChildren(scope, childPath, depth + 1) : ''}`;
  }).join('')}</div>`;
}
function renderFileTree() {
  let group = '';
  $('#file-tree').innerHTML = fileScopes.map((scope) => {
    const heading = scope.group === group ? '' : `<div class="tree-heading${group ? ' secondary' : ''}">${scope.group}</div>`;
    group = scope.group;
    const selected = state.files.scope === scope.name;
    return `${heading}<button class="tree-node${selected && !state.files.path ? ' active' : ''}" data-tree-scope="${scope.name}" data-tree-path=""><span>${selected ? '▾' : '▸'}</span><i class="folder-icon${scope.muted ? ' muted' : ''}"></i><em>${scope.label}</em></button>${selected ? renderTreeChildren(scope.name) : ''}`;
  }).join('');
}
function fileTypeIcon(name) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'json' || extension === 'json5') return '<i class="file-type-icon json">{ }</i>';
  if (['properties', 'conf', 'cfg', 'toml'].includes(extension)) return '<i class="file-type-icon config">⚙</i>';
  if (['txt', 'md', 'log'].includes(extension)) return '<i class="file-type-icon text">≡</i>';
  return '<i class="file-type-icon generic">·</i>';
}

function render() {
  const { status, active, draft, compatibility } = state.payload;
  $('#active-game').textContent = status.active.toUpperCase();
  $('#desired').textContent = status.desired.toUpperCase();
  $('#cpu').textContent = status.stats?.cpu || 'IDLE';
  $('#memory').textContent = status.stats?.memory || '—';
  $('#interlock').textContent = status.invariantOk ? 'ARMED' : 'FAULT';
  $('#interlock').className = status.invariantOk ? 'good' : 'bad';
  $('#rail-status').textContent = `${status.active.toUpperCase()} ONLINE`;
  document.querySelectorAll('[data-game]').forEach((button) => button.classList.toggle('active', button.dataset.game === status.active));
  const commandReady = status.active === 'minecraft' && status.containers.minecraft.running && status.containers.minecraft.health === 'healthy';
  $('#command-input').disabled = !commandReady;
  $('#command-form button').disabled = !commandReady || state.logs.commandBusy;
  $('#command-input').placeholder = commandReady ? 'time set day, list, give D_Apex minecraft:diamond 64…' : 'Start Minecraft and wait until it is healthy';
  $('#release-badge').textContent = `v${active.release} active · draft`;
  $('#profile-name').textContent = draft.name;
  $('#minecraft-version').value = draft.minecraftVersion;
  $('#compatibility').innerHTML = compatibility.issues.length
    ? compatibility.issues.map((issue) => `<p class="${issue.level}"><b>${issue.mod}</b> ${issue.message}</p>`).join('')
    : '<p class="ok">✓ Draft passes current compatibility checks</p>';
  $('#mod-list').innerHTML = draft.mods.length ? draft.mods.map((mod) => `
    <article>
      <span class="source ${mod.source}">${mod.source}</span>
      <div><strong>${escapeHtml(mod.name)}</strong><small>${escapeHtml(mod.version || 'unresolved')} · ${escapeHtml(sideLabel(mod.side))}</small></div>
      <button data-remove="${encodeURIComponent(modKey(mod))}" aria-label="Remove ${escapeHtml(mod.name)}">REMOVE</button>
    </article>`).join('') : '<div class="empty-manifest">No mods staged yet. Fabric itself will still boot.</div>';
  if (status.active === 'minecraft' && !whitelistLoaded) {
    whitelistLoaded = true;
    refreshWhitelist();
  } else if (status.active !== 'minecraft') {
    whitelistLoaded = false;
    $('#whitelist-output').textContent = 'Start Minecraft to manage the whitelist.';
  }

  const management = state.management;
  if (management) {
    const usedPercent = Math.max(0, Math.min(100, ((management.disk.total - management.disk.free) / management.disk.total) * 100));
    $('#disk-free').textContent = bytes(management.disk.free);
    $('#disk-fill').style.width = `${usedPercent}%`;
    $('#disk-copy').textContent = `${usedPercent.toFixed(0)}% used · ${bytes(management.disk.reserve)} protected reserve`;
    $('#world-name').textContent = management.world.name;
    $('#world-seed').textContent = management.world.seed ? `seed ${management.world.seed}` : 'random seed';
    $('#backup-count').textContent = `${management.backups.length} / ${management.retention.count}`;
    $('#backup-list').innerHTML = management.backups.length ? management.backups.map((backup) => `<div class="backup-item"><div><b>${escapeHtml(backup.name)}</b><small>${new Date(backup.createdAt).toLocaleString()}</small></div><code>${bytes(backup.size)}</code></div>`).join('') : '<p class="empty">No local snapshots retained. R2 history is separate.</p>';
    for (const [key, value] of Object.entries(management.settings)) {
      const field = document.querySelector(`[name="${key}"]`);
      if (field && document.activeElement !== field) field.value = value;
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function refresh() {
  [state.payload, state.management] = await Promise.all([api('/api/admin/status'), api('/api/admin/management')]);
  render();
}

function renderLogs() {
  const payload = state.logs.payload;
  if (!payload) return;
  const counts = payload.entries.reduce((result, entry) => ({ ...result, [entry.kind]: (result[entry.kind] || 0) + 1 }), {});
  $('#log-error-count').innerHTML = `<b>${counts.error || 0}</b> errors`;
  $('#log-warn-count').innerHTML = `<b>${counts.warn || 0}</b> warnings`;
  $('#log-player-count').innerHTML = `<b>${counts.player || 0}</b> player events`;
  $('#log-updated').textContent = payload.modifiedAt ? `updated ${new Date(payload.modifiedAt).toLocaleTimeString()}` : 'waiting for server output';
  $('#crash-summary').innerHTML = payload.crashes.length ? payload.crashes.map((crash) => `<a href="/api/admin/files/download?scope=crashes&path=${encodeURIComponent(crash.name)}" title="Download crash report">⚠ ${escapeHtml(crash.name)}</a>`).join('') : '<span>✓ No crash reports</span>';
  const entries = payload.entries.filter((entry) => state.logs.filter === 'all' || entry.kind === state.logs.filter || (state.logs.filter === 'issues' && ['warn', 'error'].includes(entry.kind)));
  $('#log-lines').innerHTML = entries.length ? entries.map((entry) => `<div class="log-line ${entry.kind}"><time>${escapeHtml(entry.timestamp || '··:··:··')}</time><span class="log-level">${escapeHtml(entry.level)}</span><code>${escapeHtml(entry.message)}</code></div>`).join('') : '<div class="log-zero">No matching log entries.</div>';
  $('#log-visible-count').textContent = `${entries.length} / ${payload.entries.length} lines`;
  if (state.logs.follow) $('#log-lines').scrollTop = $('#log-lines').scrollHeight;
}

async function refreshLatestLog() {
  if (state.logs.busy) return;
  state.logs.busy = true;
  try { state.logs.payload = await api('/api/admin/logs/latest?lines=500'); renderLogs(); }
  catch (error) { $('#log-lines').innerHTML = `<div class="log-zero error">${escapeHtml(error.message)}</div>`; throw error; }
  finally { state.logs.busy = false; }
}

function renderCommandHistory() {
  const entries = state.logs.commands;
  $('#command-history').innerHTML = entries.length ? entries.map((entry) => `<article class="command-entry ${entry.ok ? 'success' : 'failed'}"><div><time>${new Date(entry.startedAt).toLocaleTimeString()}</time><code>&gt; ${escapeHtml(entry.command)}</code><small>${escapeHtml(entry.actor)}</small></div><pre>${escapeHtml(entry.output)}</pre></article>`).join('') : '<div class="command-empty">No web commands in recent history.</div>';
}

function availableCommandSuggestions() {
  const players = [...new Set([...state.whitelist, '@a', '@p'])];
  const catalog = commandCatalog.flatMap(([template, description]) => template.includes('<player>')
    ? players.map((player) => ({ value: template.replace('<player>', player), description }))
    : [{ value: template, description }]);
  const recent = state.logs.commands.map((entry) => ({ value: entry.command, description: 'Recent command' }));
  return [...new Map([...recent, ...catalog].map((item) => [item.value, item])).values()];
}

function renderCommandSuggestions() {
  const node = $('#command-suggestions');
  const input = $('#command-input').value.trim().replace(/^\/+/, '').toLowerCase();
  if (!input || $('#command-input').disabled) {
    node.hidden = true;
    state.logs.suggestions = [];
    return;
  }
  const lastToken = input.split(/\s+/).at(-1);
  const suggestions = availableCommandSuggestions().map((item) => {
    const value = item.value.toLowerCase();
    return { ...item, score: value.startsWith(input) ? 0 : value.split(/\s+/).some((token) => token.startsWith(lastToken)) ? 1 : 2 };
  }).filter((item) => item.score < 2).sort((left, right) => left.score - right.score || left.value.localeCompare(right.value)).slice(0, 8);
  state.logs.suggestions = suggestions;
  state.logs.selectedSuggestion = Math.min(state.logs.selectedSuggestion, Math.max(0, suggestions.length - 1));
  node.hidden = suggestions.length === 0;
  node.innerHTML = suggestions.map((item, index) => `<button type="button" class="${index === state.logs.selectedSuggestion ? 'active' : ''}" data-command-suggestion="${index}"><code>${escapeHtml(item.value)}</code><small>${escapeHtml(item.description)}</small></button>`).join('');
}

function applyCommandSuggestion(index = state.logs.selectedSuggestion) {
  const suggestion = state.logs.suggestions[index];
  if (!suggestion) return false;
  const input = $('#command-input');
  input.value = suggestion.value;
  $('#command-suggestions').hidden = true;
  const placeholder = input.value.indexOf('<');
  input.focus();
  if (placeholder >= 0) input.setSelectionRange(placeholder, input.value.indexOf('>', placeholder) + 1);
  else input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

async function refreshCommandHistory() {
  const payload = await api('/api/admin/minecraft/commands');
  state.logs.commands = payload.entries || [];
  renderCommandHistory();
}

async function waitForOperation(id) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const operation = await api(`/api/admin/operations/${encodeURIComponent(id)}`);
    if (operation.state === 'complete') return operation.result;
    if (operation.state === 'failed') throw new Error(operation.error || 'Game switch failed');
  }
}

document.querySelectorAll('[data-game]').forEach((button) => button.addEventListener('click', async () => {
  if (state.busy || button.classList.contains('active')) return;
  if (!confirm(`Switch the host to ${button.dataset.game}? The active game will stop gracefully.`)) return;
  state.busy = true;
  try { const operation = await api('/api/admin/switch', { method: 'POST', body: JSON.stringify({ target: button.dataset.game }) }); await waitForOperation(operation.id); await refresh(); toast(`Game slot switched to ${button.dataset.game}`); }
  catch (error) { toast(error.message, true); }
  finally { state.busy = false; }
}));

$('#search-button').addEventListener('click', async () => {
  const query = $('#mod-search').value.trim();
  if (query.length < 2) return toast('Enter at least two characters', true);
  const node = $('#search-results');
  node.className = 'search-results';
  node.textContent = 'Searching catalog…';
  try {
    const { results } = await api(`/api/admin/catalog?query=${encodeURIComponent(query)}&source=${$('#source').value}`);
    node.innerHTML = results.length ? results.map((item) => `<article>
      ${item.iconUrl ? `<img src="${escapeHtml(item.iconUrl)}" alt="">` : '<div class="result-icon">◇</div>'}
      <div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.summary)}</p></div>
      ${item.source === 'modrinth' ? `<button data-add='${escapeHtml(JSON.stringify(item))}'>ADD</button>` : '<small>Upload the CurseForge file to stage it</small>'}
    </article>`).join('') : '<p class="empty">No compatible results.</p>';
  } catch (error) { node.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
});

$('#search-results').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-add]');
  if (!button) return;
  try { await api('/api/admin/mods', { method: 'POST', body: button.dataset.add }); await refresh(); toast('Mod added to draft'); }
  catch (error) { toast(error.message, true); }
});

$('#mod-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button || !confirm('Remove this mod from the draft?')) return;
  try { await api(`/api/admin/mods/${button.dataset.remove}`, { method: 'DELETE' }); await refresh(); toast('Mod removed from draft'); }
  catch (error) { toast(error.message, true); }
});

const fileInput = $('#file-upload');
const uploadQueue = [];
let activeUploads = 0;
let uploadSequence = 0;
const uploadConcurrency = 2;
let conflictDialogs = Promise.resolve();
$('#browse-button').addEventListener('click', () => fileInput.click());
$('#drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
$('#drop-zone').addEventListener('dragleave', (event) => event.currentTarget.classList.remove('dragging'));
$('#drop-zone').addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); enqueueUploads(event.dataTransfer.files); });
fileInput.addEventListener('change', () => { enqueueUploads(fileInput.files); fileInput.value = ''; });
$('#upload-clear').addEventListener('click', () => {
  for (let index = uploadQueue.length - 1; index >= 0; index -= 1) {
    if (['complete', 'error'].includes(uploadQueue[index].status)) uploadQueue.splice(index, 1);
  }
  renderUploadQueue();
});

function enqueueUploads(files) {
  const incoming = Array.from(files || []);
  if (!incoming.length) return;
  for (const file of incoming) {
    const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
    uploadQueue.push({ id: ++uploadSequence, file, status: ['.jar', '.mrpack', '.zip'].includes(extension) ? 'queued' : 'error', progress: 0, error: ['.jar', '.mrpack', '.zip'].includes(extension) ? '' : 'Only JAR, MRPACK, and ZIP files are accepted' });
  }
  renderUploadQueue();
  pumpUploadQueue();
}

function renderUploadQueue() {
  const panel = $('#upload-queue');
  panel.hidden = uploadQueue.length === 0;
  if (!uploadQueue.length) return;
  const complete = uploadQueue.filter((item) => item.status === 'complete').length;
  const failed = uploadQueue.filter((item) => item.status === 'error').length;
  const pending = uploadQueue.length - complete - failed;
  $('#upload-summary').textContent = pending ? `${pending} processing · ${complete} staged${failed ? ` · ${failed} failed` : ''}` : `${complete} staged${failed ? ` · ${failed} failed` : ''}`;
  $('#upload-items').innerHTML = uploadQueue.map((item) => `<article class="upload-item ${item.status}">
    <span class="upload-state">${item.status === 'complete' ? '✓' : item.status === 'error' ? '!' : item.status === 'uploading' ? '↑' : '·'}</span>
    <div><strong>${escapeHtml(item.file.name)}</strong><small>${escapeHtml(item.error || `${bytes(item.file.size)} · ${item.status === 'queued' ? 'waiting' : item.status}`)}</small><i><span style="width:${item.progress}%"></span></i></div>
    <b>${item.status === 'uploading' ? `${item.progress}%` : item.status}</b>
  </article>`).join('');
}

function uploadQueuedFile(item, onConflict = 'reject') {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', item.file);
    const request = new XMLHttpRequest();
    request.open('POST', `/api/admin/upload${onConflict === 'replace' ? '?onConflict=replace' : ''}`);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.round((event.loaded / event.total) * 100);
      renderUploadQueue();
    });
    request.addEventListener('load', () => {
      let body = {};
      try { body = JSON.parse(request.responseText || '{}'); } catch {}
      if (request.status >= 200 && request.status < 300) resolve(body);
      else {
        const error = new Error(body.error || `Upload failed (${request.status})`);
        error.code = body.code; error.conflict = body.conflict;
        reject(error);
      }
    });
    request.addEventListener('error', () => reject(new Error('Network error while uploading')));
    request.send(form);
  });
}

function showConflictDialog(conflict) {
  const dialog = $('#mod-conflict-dialog');
  $('#conflict-mod-name').textContent = conflict.incoming.name;
  $('#conflict-existing-version').textContent = conflict.existing.version;
  $('#conflict-existing-source').textContent = conflict.existing.source;
  $('#conflict-incoming-version').textContent = conflict.incoming.version;
  $('#conflict-incoming-source').textContent = conflict.incoming.originalName;
  return new Promise((resolve) => {
    const finish = (choice) => { dialog.close(); resolve(choice); };
    $('#conflict-keep').onclick = () => finish('keep');
    $('#conflict-replace').onclick = () => finish('replace');
    dialog.oncancel = (event) => { event.preventDefault(); finish('keep'); };
    dialog.showModal();
  });
}

function askConflict(conflict) {
  const result = conflictDialogs.then(() => showConflictDialog(conflict));
  conflictDialogs = result.catch(() => {});
  return result;
}

function pumpUploadQueue() {
  while (activeUploads < uploadConcurrency) {
    const item = uploadQueue.find((candidate) => candidate.status === 'queued');
    if (!item) break;
    activeUploads += 1;
    item.status = 'uploading';
    renderUploadQueue();
    uploadQueuedFile(item).then((result) => {
      item.status = 'complete'; item.progress = 100;
      if (result.upload?.action === 'ignored') item.error = 'Already staged · duplicate ignored';
    }).catch(async (error) => {
      if (error.code === 'MOD_VERSION_CONFLICT' && error.conflict) {
        const choice = await askConflict(error.conflict);
        if (choice === 'keep') {
          item.status = 'complete'; item.progress = 100; item.error = `Kept staged version ${error.conflict.existing.version}`;
          return;
        }
        item.status = 'uploading'; item.progress = 0; item.error = '';
        renderUploadQueue();
        try {
          await uploadQueuedFile(item, 'replace');
          item.status = 'complete'; item.progress = 100; item.error = `Replaced ${error.conflict.existing.version} with ${error.conflict.incoming.version}`;
        } catch (replacementError) {
          item.status = 'error'; item.error = replacementError.message || 'Replacement upload failed';
        }
        return;
      }
      item.status = 'error'; item.error = error.message || 'Upload failed';
    }).finally(async () => {
      activeUploads -= 1;
      renderUploadQueue();
      pumpUploadQueue();
      if (activeUploads === 0 && !uploadQueue.some((candidate) => candidate.status === 'queued')) {
        try { await refresh(); } catch (error) { toast(error.message, true); }
        const failures = uploadQueue.filter((candidate) => candidate.status === 'error').length;
        toast(failures ? `Batch finished with ${failures} failed file${failures === 1 ? '' : 's'}` : 'All files inspected and staged', failures > 0);
      }
    });
  }
}

$('#minecraft-version').addEventListener('change', async (event) => {
  try { await api('/api/admin/version', { method: 'POST', body: JSON.stringify({ version: event.target.value }) }); await refresh(); toast('Target Minecraft version updated'); }
  catch (error) { toast(error.message, true); }
});

$('#publish-button').addEventListener('click', async () => {
  if (!confirm('Publish this draft as a new immutable Dapex Fabric release?')) return;
  try { const profile = await api('/api/admin/publish', { method: 'POST', body: '{}' }); await refresh(); toast(`${profile.releaseName} published`); }
  catch (error) { toast(error.message, true); }
});

async function refreshWhitelist() {
  try { const result = await api('/api/admin/minecraft/whitelist'); state.whitelist = result.players || []; $('#whitelist-output').textContent = result.message || state.whitelist.join(', ') || 'Whitelist is empty.'; }
  catch (error) { $('#whitelist-output').textContent = error.message; }
}

$('#whitelist-add').addEventListener('click', async () => {
  const username = $('#whitelist-name').value.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return toast('Use a valid Minecraft Java username', true);
  try {
    const result = await api('/api/admin/minecraft/whitelist', { method: 'POST', body: JSON.stringify({ username }) });
    $('#whitelist-name').value = ''; await refreshWhitelist(); toast(result.message || `${username} allowed`);
  } catch (error) { toast(error.message, true); }
});

$('#refresh-button').addEventListener('click', () => refresh().then(() => toast('Dashboard refreshed')).catch((error) => toast(error.message, true)));

$('#backup-button').addEventListener('click', async () => {
  if (state.busy || !confirm('Create a consistent Minecraft snapshot now? The server may pause briefly.')) return;
  state.busy = true;
  const button = $('#backup-button');
  button.disabled = true; button.textContent = 'Creating & verifying backup…';
  try { await api('/api/admin/backups', { method: 'POST', body: '{}' }); await refresh(); toast('Minecraft backup verified and retained safely'); }
  catch (error) { toast(error.message, true); }
  finally { state.busy = false; button.disabled = false; button.textContent = 'Create safe backup now'; }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = Object.fromEntries(new FormData(event.currentTarget));
  if (!confirm('Save these settings for the next Minecraft start?')) return;
  try { state.management = await api('/api/admin/minecraft/settings', { method: 'PATCH', body: JSON.stringify(settings) }); render(); toast('Settings saved for the next clean start'); }
  catch (error) { toast(error.message, true); }
});

$('#world-reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const current = state.management?.world?.name || 'world';
  if (!confirm(`Create "${values.name}" and replace the live world "${current}"? A verified backup is created first.`)) return;
  const confirmation = prompt(`Type the current world name (${current}) to continue:`);
  if (confirmation !== current) return toast('World name did not match; nothing changed', true);
  try {
    state.management = await api('/api/admin/world/reset', { method: 'POST', body: JSON.stringify(values) });
    form.reset(); render(); toast(`World ${values.name} is ready for the next Minecraft start`);
  } catch (error) { toast(error.message, true); }
});

async function refreshFiles() {
  const { scope, path } = state.files;
  $('#file-list').innerHTML = '<div class="file-loading"><span></span><p>Opening folder…</p></div>';
  try {
    const listing = await api(`/api/admin/files?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`);
    state.files.listing = listing;
    document.querySelectorAll('[data-file-scope]').forEach((node) => node.classList.toggle('active', node.dataset.fileScope === scope));
    const segments = path.split('/').filter(Boolean);
    $('#file-breadcrumb').innerHTML = [`<button data-crumb="">${escapeHtml(scope)}</button>`, ...segments.map((segment, index) => `<span>›</span><button data-crumb="${encodeURIComponent(segments.slice(0, index + 1).join('/'))}">${escapeHtml(segment)}</button>`)].join('');
    $('#file-scope-note').textContent = `${listing.description}${listing.writable ? ' · writable while Minecraft is offline' : ' · read-only'}`;
    $('#file-item-count').textContent = `${listing.entries.length} item${listing.entries.length === 1 ? '' : 's'}`;
    $('#file-upload-button').disabled = !listing.writable;
    $('#file-new-folder').disabled = !listing.writable;
    state.files.tree[scope] ||= {};
    state.files.tree[scope][path] = listing.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.name);
    renderFileTree();
    $('#file-list').innerHTML = listing.entries.length ? listing.entries.map((entry) => {
      const relative = filePath(entry.name);
      const download = `/api/admin/files/download?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(relative)}`;
      return `<div class="file-row" data-row-type="${entry.type}"><span class="file-kind ${entry.type}">${entry.type === 'directory' ? '<i class="folder-icon"></i>' : fileTypeIcon(entry.name)}</span><button class="file-open" data-file-open="${encodeURIComponent(entry.name)}" data-type="${entry.type}" data-editable="${entry.editable}">${escapeHtml(entry.name)}</button><small>${entry.type === 'file' ? bytes(entry.size) : 'File folder'}</small><small>${new Date(entry.modifiedAt).toLocaleString()}</small><span class="file-actions">${entry.type === 'file' ? `<a href="${download}" title="Download">↓</a>` : ''}${listing.writable ? `<button class="delete" data-file-delete="${encodeURIComponent(entry.name)}" title="Delete">×</button>` : ''}</span></div>`;
    }).join('') : '<div class="file-empty"><i class="folder-icon"></i><strong>This folder is empty</strong><p>Drop a file here or create a folder.</p></div>';
  } catch (error) {
    $('#file-list').innerHTML = `<div class="file-empty error"><strong>Could not open this folder</strong><p>${escapeHtml(error.message)}</p><button id="file-retry">Try again</button></div>`;
    $('#file-item-count').textContent = 'Unavailable';
    throw error;
  }
}

$('#file-tree').addEventListener('click', async (event) => {
  const node = event.target.closest('[data-tree-scope]'); if (!node) return;
  state.files.scope = node.dataset.treeScope;
  state.files.path = decodeURIComponent(node.dataset.treePath || '');
  state.files.editing = null; $('#file-editor').hidden = true;
  try { await refreshFiles(); } catch (error) { toast(error.message, true); }
});

$('#file-breadcrumb').addEventListener('click', async (event) => {
  const crumb = event.target.closest('[data-crumb]'); if (!crumb) return;
  state.files.path = decodeURIComponent(crumb.dataset.crumb); await refreshFiles().catch((error) => toast(error.message, true));
});

$('#file-up').addEventListener('click', async () => {
  state.files.path = state.files.path.split('/').slice(0, -1).join('/');
  try { await refreshFiles(); } catch (error) { toast(error.message, true); }
});
$('#file-refresh').addEventListener('click', () => refreshFiles().catch((error) => toast(error.message, true)));

$('#file-list').addEventListener('click', async (event) => {
  if (event.target.closest('#file-retry')) return refreshFiles().catch((error) => toast(error.message, true));
  const opener = event.target.closest('[data-file-open]');
  const remover = event.target.closest('[data-file-delete]');
  if (opener) {
    const name = decodeURIComponent(opener.dataset.fileOpen);
    if (opener.dataset.type === 'directory') { state.files.path = filePath(name); return refreshFiles().catch((error) => toast(error.message, true)); }
    if (opener.dataset.editable !== 'true') return;
    try {
      const relative = filePath(name);
      const document = await api(`/api/admin/files/text?scope=${encodeURIComponent(state.files.scope)}&path=${encodeURIComponent(relative)}`);
      state.files.editing = relative; $('#editor-name').textContent = relative; $('#editor-content').value = document.content; $('#editor-save').hidden = !document.writable; $('#file-editor').hidden = false; $('#file-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { toast(error.message, true); }
  }
  if (remover) {
    const name = decodeURIComponent(remover.dataset.fileDelete);
    const relative = filePath(name);
    if (!confirm(`Backup first, then permanently delete ${relative}?`)) return;
    try { await api(`/api/admin/files?scope=${encodeURIComponent(state.files.scope)}&path=${encodeURIComponent(relative)}`, { method: 'DELETE' }); await refreshFiles(); toast(`${name} deleted after a verified backup`); }
    catch (error) { toast(error.message, true); }
  }
});

$('#editor-close').addEventListener('click', () => { state.files.editing = null; $('#file-editor').hidden = true; });
$('#editor-save').addEventListener('click', async () => {
  if (!state.files.editing || !confirm(`Backup and save ${state.files.editing}?`)) return;
  try { await api(`/api/admin/files/text?scope=${encodeURIComponent(state.files.scope)}&path=${encodeURIComponent(state.files.editing)}`, { method: 'PUT', body: JSON.stringify({ content: $('#editor-content').value }) }); await refreshFiles(); toast('File saved after a verified backup'); }
  catch (error) { toast(error.message, true); }
});

const explorerUpload = $('#explorer-upload');
$('#file-new-folder').addEventListener('click', async () => {
  const name = prompt('New folder name (letters, numbers, spaces, dash, underscore):')?.trim();
  if (!name) return;
  const relative = filePath(name);
  try {
    await api(`/api/admin/files/directory?scope=${encodeURIComponent(state.files.scope)}`, { method: 'POST', body: JSON.stringify({ path: relative }) });
    await refreshFiles(); toast(`${name} created after a verified backup`);
  } catch (error) { toast(error.message, true); }
});
$('#file-upload-button').addEventListener('click', () => explorerUpload.click());
async function uploadExplorerFile(file) {
  if (!file || !state.files.listing?.writable) return toast('This folder is read-only', true);
  const form = new FormData(); form.append('file', file);
  try {
    const response = await fetch(`/api/admin/files/upload?scope=${encodeURIComponent(state.files.scope)}&path=${encodeURIComponent(state.files.path)}`, { method: 'POST', body: form });
    const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Upload failed');
    await refreshFiles(); toast(`${file.name} uploaded after a verified backup`);
  } catch (error) { toast(error.message, true); }
  finally { explorerUpload.value = ''; }
}
explorerUpload.addEventListener('change', () => uploadExplorerFile(explorerUpload.files[0]));

const dropSurface = $('#file-drop-surface');
for (const eventName of ['dragenter', 'dragover']) dropSurface.addEventListener(eventName, (event) => { event.preventDefault(); if (state.files.listing?.writable) dropSurface.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) dropSurface.addEventListener(eventName, (event) => { event.preventDefault(); dropSurface.classList.remove('dragging'); });
dropSurface.addEventListener('drop', (event) => uploadExplorerFile(event.dataTransfer.files[0]));

$('#log-filter').addEventListener('change', (event) => { state.logs.filter = event.target.value; renderLogs(); });
$('#log-refresh').addEventListener('click', () => refreshLatestLog().catch((error) => toast(error.message, true)));
$('#log-follow').addEventListener('click', (event) => {
  state.logs.follow = !state.logs.follow;
  event.currentTarget.classList.toggle('active', state.logs.follow);
  event.currentTarget.textContent = state.logs.follow ? '● Live' : '○ Paused';
  if (state.logs.follow) refreshLatestLog().catch((error) => toast(error.message, true));
});
$('#command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#command-input');
  const command = input.value.trim();
  if (!command || state.logs.commandBusy) return;
  state.logs.commandBusy = true;
  input.disabled = true;
  $('#command-form button').disabled = true;
  try {
    const result = await api('/api/admin/minecraft/commands', { method: 'POST', body: JSON.stringify({ command }) });
    input.value = '';
    state.logs.commands.unshift(result);
    state.logs.commands = state.logs.commands.slice(0, 30);
    renderCommandHistory();
    await refreshLatestLog();
    toast(result.output || 'Command completed');
  } catch (error) {
    await refreshCommandHistory().catch(() => {});
    toast(error.message, true);
  } finally {
    state.logs.commandBusy = false;
    render();
    if (!input.disabled) input.focus();
  }
});
$('#command-input').addEventListener('input', () => { state.logs.selectedSuggestion = 0; renderCommandSuggestions(); });
$('#command-input').addEventListener('focus', renderCommandSuggestions);
$('#command-input').addEventListener('keydown', (event) => {
  if (!state.logs.suggestions.length || $('#command-suggestions').hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    state.logs.selectedSuggestion = (state.logs.selectedSuggestion + delta + state.logs.suggestions.length) % state.logs.suggestions.length;
    renderCommandSuggestions();
    return;
  }
  if (event.key === 'Escape') {
    $('#command-suggestions').hidden = true;
    return;
  }
  if (event.key === 'Tab' || event.key === 'Enter') {
    const suggestion = state.logs.suggestions[state.logs.selectedSuggestion];
    const exactRunnable = event.key === 'Enter' && suggestion && !/[<\[]/.test(suggestion.value) && $('#command-input').value.trim().replace(/^\/+/, '') === suggestion.value;
    if (exactRunnable) {
      $('#command-suggestions').hidden = true;
      return;
    }
    event.preventDefault();
    applyCommandSuggestion();
  }
});
$('#command-suggestions').addEventListener('mousedown', (event) => {
  const button = event.target.closest('[data-command-suggestion]');
  if (!button) return;
  event.preventDefault();
  applyCommandSuggestion(Number(button.dataset.commandSuggestion));
});
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.command-console')) $('#command-suggestions').hidden = true;
});

const sections = [...document.querySelectorAll('.section-block')];
const navLinks = [...document.querySelectorAll('.sidebar nav a')];
const sectionObserver = new IntersectionObserver((entries) => {
  const visible = entries.find((entry) => entry.isIntersecting);
  if (!visible) return;
  navLinks.forEach((link) => link.classList.toggle('active', link.hash === `#${visible.target.id}`));
}, { rootMargin: '-35% 0px -55%' });
sections.forEach((section) => sectionObserver.observe(section));

Promise.allSettled([refresh(), refreshFiles(), refreshLatestLog(), refreshCommandHistory()]).then((results) => results.filter((result) => result.status === 'rejected').forEach((result) => toast(result.reason.message, true)));
setInterval(() => refresh().catch(() => {}), 30_000);
setInterval(() => { if (state.logs.follow) Promise.allSettled([refreshLatestLog(), refreshCommandHistory()]); }, 5_000);
