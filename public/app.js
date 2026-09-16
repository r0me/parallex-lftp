'use strict';

/* Parallex LFTP frontend: API calls, pane rendering, WebSocket handling. */

const state = {
  authed: false,
  authMode: 'login',
  ws: null,
  sessionId: null,
  site: null, // { id, name }
  localPath: '/',
  remotePath: '/',
  localEntries: [],
  remoteEntries: [],
  localSelected: null, // entry
  remoteSelected: null,
  sites: [],
  settings: null,
  jobs: new Map(),
};

const $ = (id) => document.getElementById(id);

// ---- API helper ----------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && data && data.code === 'AUTH_REQUIRED') {
      showAuthOverlay('login');
    }
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.detail = data && data.detail;
    throw err;
  }
  return data;
}

function setStatus(text, isError = false) {
  const el = $('status-text');
  el.textContent = text;
  el.className = isError ? 'err' : '';
}

function setConnState(mode, label) {
  const led = $('conn-led');
  led.className = 'led' + (mode ? ` ${mode}` : '');
  $('conn-label').textContent = label;
}

const fmtSize = (n) => {
  if (n == null || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
};

const joinPath = (base, name) => (base === '/' ? `/${name}` : `${base}/${name}`);
const parentPath = (p) => {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
};

// ---- pane rendering ------------------------------------------------------

function renderBreadcrumb(el, path, onNavigate) {
  el.innerHTML = '';
  const parts = path.split('/').filter(Boolean);
  const root = document.createElement('a');
  root.href = '#';
  root.textContent = '/';
  root.onclick = (e) => { e.preventDefault(); onNavigate('/'); };
  el.appendChild(root);
  let acc = '';
  parts.forEach((part, i) => {
    acc += '/' + part;
    const target = acc;
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = part;
    a.onclick = (e) => { e.preventDefault(); onNavigate(target); };
    el.appendChild(a);
    if (i < parts.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      el.appendChild(sep);
    }
  });
}

function renderList(tbodyId, emptyId, entries, path, opts) {
  const tbody = $(tbodyId);
  tbody.innerHTML = '';
  const empty = $(emptyId);
  empty.hidden = entries.length > 0 || path !== '/';

  if (path !== '/') {
    const tr = document.createElement('tr');
    tr.className = 'is-dir';
    tr.innerHTML = `<td class="name"><span class="icon">&#8617;</span>..</td><td class="col-size"></td><td class="col-date"></td>`;
    tr.ondblclick = () => opts.onOpenDir(parentPath(path));
    tbody.appendChild(tr);
  }

  empty.hidden = entries.length > 0;
  if (entries.length === 0) empty.textContent = 'empty directory';

  for (const entry of entries) {
    const tr = document.createElement('tr');
    tr.className = entry.type === 'dir' ? 'is-dir' : entry.type === 'link' ? 'is-link' : '';
    const icon = entry.type === 'dir' ? '&#9646;' : entry.type === 'link' ? '&#8618;' : '&#9642;';
    tr.innerHTML =
      `<td class="name"><span class="icon">${icon}</span>${escapeHtml(entry.name)}</td>` +
      `<td class="col-size">${entry.type === 'dir' ? '' : fmtSize(entry.size)}</td>` +
      `<td class="col-date">${entry.mtime || ''}</td>`;
    tr.onclick = () => {
      tbody.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
      opts.onSelect(entry);
    };
    tr.ondblclick = () => {
      if (entry.type === 'dir') opts.onOpenDir(joinPath(path, entry.name));
    };
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- local pane ----------------------------------------------------------

async function loadLocal(path = state.localPath) {
  try {
    const data = await api(`/local/list?path=${encodeURIComponent(path)}`);
    state.localPath = data.path;
    state.localEntries = data.entries;
    state.localSelected = null;
    updateTransferButtons();
    renderBreadcrumb($('local-breadcrumb'), data.path, loadLocal);
    renderList('local-list', 'local-empty', data.entries, data.path, {
      onSelect: (e) => { state.localSelected = e; updateTransferButtons(); },
      onOpenDir: loadLocal,
    });
  } catch (err) {
    setStatus(`local: ${err.message}`, true);
  }
}

// ---- remote pane ---------------------------------------------------------

function setRemoteToolsEnabled(enabled) {
  document.querySelectorAll('#pane-remote [data-act]').forEach((b) => (b.disabled = !enabled));
  $('btn-disconnect').disabled = !enabled;
}

async function loadRemote(path) {
  if (!state.sessionId) return;
  try {
    setConnState('busy', `${state.site.name} — listing…`);
    const data = path != null
      ? await api('/remote/cd', { method: 'POST', body: { sessionId: state.sessionId, path } })
      : await api(`/remote/list?sessionId=${encodeURIComponent(state.sessionId)}&path=.`);
    state.remotePath = data.path;
    state.remoteEntries = data.entries;
    state.remoteSelected = null;
    updateTransferButtons();
    renderBreadcrumb($('remote-breadcrumb'), data.path, (p) => loadRemote(p));
    renderList('remote-list', 'remote-empty', data.entries, data.path, {
      onSelect: (e) => { state.remoteSelected = e; updateTransferButtons(); },
      onOpenDir: (p) => loadRemote(p),
    });
    setConnState('on', `${state.site.name} — ${data.path}`);
  } catch (err) {
    if (err.status === 410) return handleSessionLost();
    setConnState('err', `${state.site.name} — error`);
    setStatus(`remote: ${err.message}${err.detail ? ` — ${err.detail}` : ''}`, true);
  }
}

function handleSessionLost() {
  state.sessionId = null;
  state.site = null;
  setConnState('', 'NOT CONNECTED');
  setRemoteToolsEnabled(false);
  $('remote-hint').textContent = 'no session';
  $('remote-list').innerHTML = '';
  const empty = $('remote-empty');
  empty.hidden = false;
  empty.textContent = 'session lost — reconnect';
  updateTransferButtons();
}

async function connectSite(site) {
  try {
    setConnState('busy', `connecting to ${site.name}…`);
    setStatus(`connecting to ${site.name}…`);
    const data = await api('/remote/connect', { method: 'POST', body: { siteId: site.id } });
    state.sessionId = data.sessionId;
    state.site = data.site;
    $('remote-hint').textContent = site.host;
    setRemoteToolsEnabled(true);
    closeModal('modal-sites');
    if (site.localDir && site.localDir !== '/') await loadLocal(site.localDir);
    await loadRemote();
    setStatus(`connected to ${site.name}`);
  } catch (err) {
    setConnState('err', 'CONNECT FAILED');
    setStatus(`connect failed: ${err.message}${err.detail ? ` — ${err.detail}` : ''}`, true);
  }
}

async function disconnect() {
  if (!state.sessionId) return;
  try {
    await api('/remote/disconnect', { method: 'POST', body: { sessionId: state.sessionId } });
  } catch (_) { /* session may already be gone */ }
  handleSessionLost();
  $('remote-empty').textContent = 'not connected';
  setStatus('disconnected');
}

// ---- transfers -----------------------------------------------------------

const transferable = (e) => e && (e.type === 'file' || e.type === 'dir');

function updateTransferButtons() {
  $('btn-download').disabled = !(state.sessionId && transferable(state.remoteSelected));
  $('btn-upload').disabled = !(state.sessionId && transferable(state.localSelected));
}

async function startTransfer(direction) {
  const sel = direction === 'download' ? state.remoteSelected : state.localSelected;
  if (!sel || !state.site) return;
  const remotePath = direction === 'download'
    ? joinPath(state.remotePath, sel.name)
    : joinPath(state.remotePath, sel.name);
  const localPath = direction === 'download'
    ? joinPath(state.localPath, sel.name)
    : joinPath(state.localPath, sel.name);
  const isDir = sel.type === 'dir';
  try {
    await api('/transfers', {
      method: 'POST',
      body: { direction, siteId: state.site.id, remotePath, localPath, size: isDir ? 0 : sel.size, isDir },
    });
    setStatus(`${direction} queued: ${sel.name}${isDir ? '/' : ''}`);
  } catch (err) {
    setStatus(`transfer: ${err.message}`, true);
  }
}

function renderJob(job) {
  let el = document.querySelector(`[data-job="${job.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.job = job.id;
    $('queue-list').prepend(el);
  }
  el.className = `job ${job.status}`;
  const arrow = job.direction === 'download' ? '&#8595;' : '&#8593;';
  const segs = Math.max(1, job.segments);
  // Per-segment fill from pget's status file when available (shows real
  // parallel chunk progress); otherwise map overall percent across cells.
  const perSeg = Array.isArray(job.segmentProgress) && job.segmentProgress.length === segs
    ? job.segmentProgress
    : null;
  let segHtml = '';
  for (let i = 0; i < segs; i++) {
    let fill;
    if (perSeg) {
      fill = perSeg[i];
    } else {
      const lo = (i / segs) * 100;
      const hi = ((i + 1) / segs) * 100;
      fill = (job.percent - lo) / (hi - lo);
    }
    fill = Math.max(0, Math.min(1, fill));
    segHtml += `<div class="seg"><div class="fill" style="transform:scaleX(${fill.toFixed(3)})"></div></div>`;
  }
  // a folder job with no known total yet has nothing to show as a percent
  const pct = job.isDir && job.percent === 0 && job.status === 'running' ? '···' : `${job.percent}%`;
  const nameLabel = escapeHtml(job.name) + (job.isDir ? '/' : '');
  el.innerHTML =
    `<span class="dir-arrow">${arrow}${job.isDir ? '&#128193;' : ''}</span>` +
    `<span class="job-name" title="${escapeHtml(job.remotePath)}">${nameLabel}</span>` +
    `<div class="segbar">${segHtml}</div>` +
    `<span class="job-pct">${pct}</span>` +
    `<span class="job-speed">${job.speed || ''}</span>` +
    `<span class="job-eta">${job.eta ? 'eta ' + job.eta : ''}</span>` +
    (['queued', 'running'].includes(job.status)
      ? `<button class="btn-cancel" title="Cancel">&#10005;</button>`
      : `<span class="job-status ${job.status}">${job.status.toUpperCase()}</span>`) +
    (job.error ? `<div class="job-error-text">${escapeHtml(job.error)}</div>` : '');
  const cancel = el.querySelector('.btn-cancel');
  if (cancel) cancel.onclick = () => api(`/transfers/${job.id}/cancel`, { method: 'POST' }).catch(() => {});

  const prev = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  // Refresh the receiving pane when a job completes.
  if (prev && prev.status !== 'done' && job.status === 'done') {
    if (job.direction === 'download') loadLocal();
    else if (state.sessionId) loadRemote();
  }
}

// ---- WebSocket -----------------------------------------------------------

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'transfers') {
        $('queue-list').innerHTML = '';
        state.jobs.clear();
        for (const job of msg.jobs) renderJob(job);
      } else if (msg.type === 'transfer') {
        renderJob(msg.job);
      }
    } catch (_) { /* ignore malformed frames */ }
  };
  ws.onclose = (ev) => {
    state.ws = null;
    if (ev.code === 4401) {
      showAuthOverlay('login'); // session expired — don't reconnect-loop
      return;
    }
    if (state.authed) setTimeout(connectWs, 2000);
  };
}

// ---- auth ----------------------------------------------------------------

function showAuthOverlay(mode) {
  state.authed = false;
  state.authMode = mode; // 'setup' | 'login'
  $('btn-logout').hidden = true;
  $('auth-title').textContent = mode === 'setup' ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('auth-submit').textContent = mode === 'setup' ? 'CREATE' : 'SIGN IN';
  $('auth-hint').textContent =
    mode === 'setup'
      ? 'First run: choose a username and password (min 8 characters) for this instance. Locked out later? Delete config/auth.json and restart.'
      : '';
  $('auth-error').hidden = true;
  $('auth-overlay').hidden = false;
  $('auth-username').focus();
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const body = { username: $('auth-username').value.trim(), password: $('auth-password').value };
  try {
    await api(state.authMode === 'setup' ? '/auth/setup' : '/auth/login', { method: 'POST', body });
    $('auth-overlay').hidden = true;
    $('auth-password').value = '';
    startApp(body.username);
  } catch (err) {
    const el = $('auth-error');
    el.textContent = err.message;
    el.hidden = false;
  }
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) { /* cookie cleared anyway */ }
  if (state.ws) state.ws.close();
  if (state.sessionId) handleSessionLost();
  showAuthOverlay('login');
}

function startApp(username) {
  state.authed = true;
  $('btn-logout').hidden = false;
  setStatus(username ? `signed in as ${username}` : 'ready');
  loadLocal('/');
  connectWs();
  loadSettings().catch(() => {}); // sync theme from server (covers a new browser)
}

async function initAuth() {
  try {
    const s = await api('/auth/status');
    if (!s.configured) return showAuthOverlay('setup');
    if (!s.authenticated) return showAuthOverlay('login');
    $('auth-overlay').hidden = true;
    startApp(s.username);
  } catch (err) {
    setStatus(`auth check failed: ${err.message}`, true);
    setTimeout(initAuth, 3000);
  }
}

// ---- Site Manager --------------------------------------------------------

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

async function loadSites(selectedId) {
  state.sites = await api('/sites');
  const ul = $('site-list');
  ul.innerHTML = '';
  if (state.sites.length === 0) {
    ul.innerHTML = '<div class="site-list-empty">no saved sites yet</div>';
  }
  for (const site of state.sites) {
    const li = document.createElement('li');
    li.innerHTML = `${escapeHtml(site.name)}<span class="site-proto">${site.protocol.toUpperCase()}</span>`;
    li.onclick = () => fillSiteForm(site);
    if (site.id === selectedId) li.classList.add('selected');
    ul.appendChild(li);
  }
}

function fillSiteForm(site) {
  // Re-render the list so selection (and a just-saved new site) shows up —
  // this is where the "new site never revealed Connect/Delete" bug lived.
  document.querySelectorAll('#site-list li').forEach((li, i) => {
    li.classList.toggle('selected', state.sites[i] && state.sites[i].id === (site && site.id));
  });
  $('sf-id').value = site ? site.id : '';
  $('sf-name').value = site ? site.name : '';
  $('sf-host').value = site ? site.host : '';
  $('sf-port').value = site && site.port ? site.port : '';
  $('sf-protocol').value = site ? site.protocol : 'ftp';
  $('sf-username').value = site ? site.username : '';
  $('sf-password').value = '';
  $('sf-password').placeholder = site && site.hasPassword ? '(unchanged)' : '';
  $('sf-authType').value = site ? site.authType : 'password';
  $('sf-remoteDir').value = site ? site.remoteDir : '';
  $('sf-localDir').value = site ? site.localDir : '';
  $('sf-threads').value = site && site.threads ? site.threads : '';
  $('sf-segments').value = site && site.segments ? site.segments : '';
  $('btn-site-connect').hidden = !site;
  $('btn-site-delete').hidden = !site;
}

async function saveSite(e) {
  e.preventDefault();
  const id = $('sf-id').value;
  const body = {
    name: $('sf-name').value.trim(),
    host: $('sf-host').value.trim(),
    port: $('sf-port').value ? Number($('sf-port').value) : null,
    protocol: $('sf-protocol').value,
    username: $('sf-username').value.trim(),
    password: $('sf-password').value || null,
    authType: $('sf-authType').value,
    remoteDir: $('sf-remoteDir').value.trim() || '/',
    localDir: $('sf-localDir').value.trim() || '/',
    threads: $('sf-threads').value ? Number($('sf-threads').value) : null,
    segments: $('sf-segments').value ? Number($('sf-segments').value) : null,
  };
  try {
    const saved = id
      ? await api(`/sites/${id}`, { method: 'PUT', body })
      : await api('/sites', { method: 'POST', body });
    await loadSites(saved.id);
    fillSiteForm(saved); // re-render post-save so Connect/Delete appear
    setStatus(`site "${saved.name}" saved`);
  } catch (err) {
    setStatus(`site save: ${err.message}`, true);
  }
}

async function deleteSite() {
  const id = $('sf-id').value;
  if (!id) return;
  if (!confirm('Delete this site?')) return;
  await api(`/sites/${id}`, { method: 'DELETE' });
  await loadSites();
  fillSiteForm(null);
}

// ---- Settings ------------------------------------------------------------

// Theme is applied via a data attribute; 'amber' is the tokens' default so
// it clears the attribute. localStorage mirrors the choice per-browser so
// the page paints correctly before auth/settings are fetched.
function applyTheme(theme) {
  const t = ['green', 'blue'].includes(theme) ? theme : 'amber';
  if (t === 'amber') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('plxTheme', t); } catch (_) { /* private mode etc. */ }
}

async function loadSettings() {
  state.settings = await api('/settings');
  applyTheme(state.settings.theme);
  $('st-theme').value = ['green', 'blue'].includes(state.settings.theme) ? state.settings.theme : 'amber';
  $('st-threads').value = state.settings.threads;
  $('st-segments').value = state.settings.segments;
  $('st-segmentMin').value = (state.settings.segmentMinBytes / (1024 * 1024)).toString();
  $('st-bandwidth').value = state.settings.bandwidthLimitKBps;
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    state.settings = await api('/settings', {
      method: 'PUT',
      body: {
        theme: $('st-theme').value,
        threads: Number($('st-threads').value),
        segments: Number($('st-segments').value),
        segmentMinBytes: Math.round(Number($('st-segmentMin').value) * 1024 * 1024),
        bandwidthLimitKBps: Number($('st-bandwidth').value),
      },
    });
    applyTheme(state.settings.theme);
    closeModal('modal-settings');
    setStatus('settings saved');
  } catch (err) {
    setStatus(`settings: ${err.message}`, true);
  }
}

// ---- pane tool actions ---------------------------------------------------

async function paneAction(act) {
  try {
    switch (act) {
      case 'local-refresh': return loadLocal();
      case 'local-mkdir': {
        const name = prompt('New local folder name:');
        if (!name) return;
        await api('/local/mkdir', { method: 'POST', body: { path: joinPath(state.localPath, name) } });
        return loadLocal();
      }
      case 'local-rename': {
        if (!state.localSelected) return setStatus('select a local entry first', true);
        const name = prompt('Rename to:', state.localSelected.name);
        if (!name || name === state.localSelected.name) return;
        await api('/local/rename', {
          method: 'POST',
          body: { from: joinPath(state.localPath, state.localSelected.name), to: joinPath(state.localPath, name) },
        });
        return loadLocal();
      }
      case 'local-delete': {
        if (!state.localSelected) return setStatus('select a local entry first', true);
        if (!confirm(`Delete ${state.localSelected.name}?`)) return;
        await api('/local/delete', { method: 'POST', body: { path: joinPath(state.localPath, state.localSelected.name) } });
        return loadLocal();
      }
      case 'remote-refresh': return loadRemote();
      case 'remote-mkdir': {
        const name = prompt('New remote folder name:');
        if (!name) return;
        await api('/remote/mkdir', { method: 'POST', body: { sessionId: state.sessionId, path: name } });
        return loadRemote();
      }
      case 'remote-rename': {
        if (!state.remoteSelected) return setStatus('select a remote entry first', true);
        const name = prompt('Rename to:', state.remoteSelected.name);
        if (!name || name === state.remoteSelected.name) return;
        await api('/remote/rename', {
          method: 'POST',
          body: { sessionId: state.sessionId, from: state.remoteSelected.name, to: name },
        });
        return loadRemote();
      }
      case 'remote-delete': {
        if (!state.remoteSelected) return setStatus('select a remote entry first', true);
        if (!confirm(`Delete ${state.remoteSelected.name} from the server?`)) return;
        await api('/remote/delete', {
          method: 'POST',
          body: { sessionId: state.sessionId, path: state.remoteSelected.name, isDir: state.remoteSelected.type === 'dir' },
        });
        return loadRemote();
      }
    }
  } catch (err) {
    if (err.status === 410) return handleSessionLost();
    setStatus(err.message, true);
  }
}

// ---- wire-up -------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => paneAction(b.dataset.act)));
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal-backdrop:not(.auth-overlay)').forEach((bd) => {
    bd.addEventListener('mousedown', (e) => { if (e.target === bd) bd.hidden = true; });
  });

  $('btn-sites').onclick = async () => { await loadSites(); fillSiteForm(null); openModal('modal-sites'); };
  $('btn-settings').onclick = async () => { await loadSettings(); openModal('modal-settings'); };
  $('btn-new-site').onclick = () => fillSiteForm(null);
  $('site-form').onsubmit = saveSite;
  $('btn-site-delete').onclick = deleteSite;
  $('btn-site-connect').onclick = () => {
    const site = state.sites.find((s) => s.id === $('sf-id').value);
    if (site) connectSite(site);
  };
  $('settings-form').onsubmit = saveSettings;
  $('btn-disconnect').onclick = disconnect;
  $('btn-download').onclick = () => startTransfer('download');
  $('btn-upload').onclick = () => startTransfer('upload');
  $('btn-clear-finished').onclick = async () => {
    await api('/transfers/clear-finished', { method: 'POST' });
    for (const [id, job] of state.jobs) {
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        const el = document.querySelector(`[data-job="${id}"]`);
        if (el) el.remove();
        state.jobs.delete(id);
      }
    }
  };

  $('auth-form').onsubmit = handleAuthSubmit;
  $('btn-logout').onclick = logout;

  $('remote-empty').hidden = false;
  try { applyTheme(localStorage.getItem('plxTheme')); } catch (_) { /* default theme */ }
  initAuth();
});
