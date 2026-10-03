const state = { payload: null, management: null, busy: false, files: { scope: 'config', path: '', listing: null, editing: null } };
const $ = (selector) => document.querySelector(selector);

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 4000);
}

function modKey(mod) { return `${mod.source}:${mod.projectId || mod.sha256}`; }
function sideLabel(side) { return typeof side === 'object' && side ? `client:${side.client || '?'} / server:${side.server || '?'}` : String(side || 'unknown'); }
function bytes(value) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`; }
function filePath(name = '') { return [state.files.path, name].filter(Boolean).join('/'); }

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
  if (status.active === 'minecraft') refreshWhitelist();
  else $('#whitelist-output').textContent = 'Start Minecraft to manage the whitelist.';

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
$('#browse-button').addEventListener('click', () => fileInput.click());
$('#drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
$('#drop-zone').addEventListener('dragleave', (event) => event.currentTarget.classList.remove('dragging'));
$('#drop-zone').addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); uploadFile(event.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => uploadFile(fileInput.files[0]));

async function uploadFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const response = await fetch('/api/admin/upload', { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    await refresh(); toast(`${file.name} inspected and staged`);
  } catch (error) { toast(error.message, true); }
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
  try { const result = await api('/api/admin/minecraft/whitelist'); $('#whitelist-output').textContent = result.message || result.players?.join(', ') || 'Whitelist is empty.'; }
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
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const current = state.management?.world?.name || 'world';
  if (!confirm(`Create "${values.name}" and replace the live world "${current}"? A verified backup is created first.`)) return;
  const confirmation = prompt(`Type the current world name (${current}) to continue:`);
  if (confirmation !== current) return toast('World name did not match; nothing changed', true);
  try {
    state.management = await api('/api/admin/world/reset', { method: 'POST', body: JSON.stringify(values) });
    event.currentTarget.reset(); render(); toast(`World ${values.name} is ready for the next Minecraft start`);
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
    $('#file-tree-children').innerHTML = listing.entries.filter((entry) => entry.type === 'directory').map((entry) => `<button class="tree-node child" data-tree-folder="${encodeURIComponent(entry.name)}"><span>›</span><i class="folder-icon"></i>${escapeHtml(entry.name)}</button>`).join('');
    $('#file-list').innerHTML = listing.entries.length ? listing.entries.map((entry) => {
      const relative = filePath(entry.name);
      const download = `/api/admin/files/download?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(relative)}`;
      return `<div class="file-row" data-row-type="${entry.type}"><span class="file-kind ${entry.type}"><i class="${entry.type === 'directory' ? 'folder-icon' : 'document-icon'}"></i></span><button class="file-open" data-file-open="${encodeURIComponent(entry.name)}" data-type="${entry.type}" data-editable="${entry.editable}">${escapeHtml(entry.name)}</button><small>${entry.type === 'file' ? bytes(entry.size) : 'File folder'}</small><small>${new Date(entry.modifiedAt).toLocaleString()}</small><span class="file-actions">${entry.type === 'file' ? `<a href="${download}" title="Download">↓</a>` : ''}${listing.writable ? `<button class="delete" data-file-delete="${encodeURIComponent(entry.name)}" title="Delete">×</button>` : ''}</span></div>`;
    }).join('') : '<div class="file-empty"><i class="folder-icon"></i><strong>This folder is empty</strong><p>Drop a file here or create a folder.</p></div>';
  } catch (error) {
    $('#file-list').innerHTML = `<div class="file-empty error"><strong>Could not open this folder</strong><p>${escapeHtml(error.message)}</p><button id="file-retry">Try again</button></div>`;
    $('#file-item-count').textContent = 'Unavailable';
    throw error;
  }
}

document.querySelectorAll('[data-file-scope]').forEach((node) => node.addEventListener('click', async () => {
  state.files.scope = node.dataset.fileScope; state.files.path = ''; state.files.editing = null; $('#file-editor').hidden = true;
  try { await refreshFiles(); } catch (error) { toast(error.message, true); }
}));

$('#file-breadcrumb').addEventListener('click', async (event) => {
  const crumb = event.target.closest('[data-crumb]'); if (!crumb) return;
  state.files.path = decodeURIComponent(crumb.dataset.crumb); await refreshFiles().catch((error) => toast(error.message, true));
});

$('#file-tree-children').addEventListener('click', async (event) => {
  const folder = event.target.closest('[data-tree-folder]'); if (!folder) return;
  state.files.path = filePath(decodeURIComponent(folder.dataset.treeFolder)); await refreshFiles().catch((error) => toast(error.message, true));
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

const sections = [...document.querySelectorAll('.section-block')];
const navLinks = [...document.querySelectorAll('.sidebar nav a')];
const sectionObserver = new IntersectionObserver((entries) => {
  const visible = entries.find((entry) => entry.isIntersecting);
  if (!visible) return;
  navLinks.forEach((link) => link.classList.toggle('active', link.hash === `#${visible.target.id}`));
}, { rootMargin: '-35% 0px -55%' });
sections.forEach((section) => sectionObserver.observe(section));

Promise.allSettled([refresh(), refreshFiles()]).then((results) => results.filter((result) => result.status === 'rejected').forEach((result) => toast(result.reason.message, true)));
setInterval(() => refresh().catch(() => {}), 30_000);
