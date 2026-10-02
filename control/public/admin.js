const state = { payload: null, busy: false };
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

function render() {
  const { status, active, draft, compatibility } = state.payload;
  $('#active-game').textContent = status.active.toUpperCase();
  $('#desired').textContent = status.desired.toUpperCase();
  $('#cpu').textContent = status.stats?.cpu || 'IDLE';
  $('#memory').textContent = status.stats?.memory || '—';
  $('#interlock').textContent = status.invariantOk ? 'ARMED' : 'FAULT';
  $('#interlock').className = status.invariantOk ? 'good' : 'bad';
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
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function refresh() {
  state.payload = await api('/api/admin/status');
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

refresh().catch((error) => toast(error.message, true));
setInterval(() => refresh().catch(() => {}), 30_000);
