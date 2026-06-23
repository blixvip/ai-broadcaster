'use strict';

// ---------------------------------------------------------------------------
// AI Broadcaster workspace — iframe architecture.
// Embeds 2–6 real AI chat sites as <iframe> panels in ONE page, tiled in a
// grid, with a shared composer at the bottom that broadcasts a single prompt
// into every panel at once. Header-stripping (background.js DNR) + frame-bypass
// let the sites embed; content.js (all_frames) self-registers each panel and
// receives the inject payload from background.broadcast().
// ---------------------------------------------------------------------------

const PROVIDERS = globalThis.AIB_PROVIDERS || [];
const DEFAULT_PANEL_URLS = globalThis.AIB_DEFAULT_PANEL_URLS || [];
const PANEL_COUNTS = [2, 3, 4, 5, 6];
const DEFAULT_COUNT = 3;
const EMBED_TIMEOUT_MS = 10000;   // how long to wait for a panel to load embedded before falling back to a real window

// Each panel registers a monitor here so the global 'panel-alive' listener can
// notify it when content.js confirms the site loaded inside its iframe.
let panelMonitors = [];

// Providers that land on a usable chat without a signup/landing wall.
const CLEAN_KEYS = new Set(['gemini', 'mistral', 'grok', 'perplexity', 'you', 'duckai', 'venice', 'deepseek']);

const el = {
  grid:       document.getElementById('grid'),
  fsBtn:      document.getElementById('fsBtn'),
  panelCount: document.getElementById('panelCount'),
  composer:   document.getElementById('composer'),
  prompt:     document.getElementById('prompt'),
  attachBtn:  document.getElementById('attachBtn'),
  imageInput: document.getElementById('imageInput'),
  imageStrip: document.getElementById('imageStrip'),
  sendBtn:    document.getElementById('sendBtn'),
  status:     document.getElementById('status')
};

let count = DEFAULT_COUNT;
let selectedKeys = [];            // provider key per panel slot (index = panel id)
let attachedImages = [];
let nextImageId = 1;

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------
function providerByKey(key) { return PROVIDERS.find(p => p.key === key) || PROVIDERS[0]; }
function urlForKey(key) { return providerByKey(key)?.url; }

function originsForKey(key) {
  const p = providerByKey(key);
  return (p.domains || [p.domain]).filter(Boolean).map(d => `https://${d}`);
}

// Purge the panel origins' cache + service worker (via background) BEFORE loading,
// then arm the DNR rules. Essential: authed AI sites (Venice) serve their document
// from a service worker / HTTP cache that bypasses DNR, so the un-stripped
// frame-ancestors CSP survives and blocks embedding. Forcing a network fetch lets
// DNR strip it. Cookies are untouched → logins persist.
async function prepareOrigins(origins) {
  try {
    await Promise.race([
      chrome.runtime.sendMessage({ action: 'prepareFrames', origins: [...new Set(origins)] }),
      new Promise(r => setTimeout(r, 6000))
    ]);
  } catch {}
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function hostMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const reg = h => h.split('.').slice(-2).join('.');
  return reg(a) === reg(b);
}

// content.js in a successfully-embedded panel posts {__aib:'panel-alive'} to us.
window.addEventListener('message', event => {
  const data = event.data;
  if (!data || data.__aib !== 'panel-alive' || !data.host) return;
  for (const monitor of panelMonitors) monitor.notifyAlive(data.host);
});

function keyFromUrl(url) {
  if (!url) return null;
  const exact = PROVIDERS.find(p => p.url === url);
  if (exact) return exact.key;
  const host = hostOf(url);
  const byHost = PROVIDERS.find(p => (p.domains || [p.domain]).includes(host));
  return byHost ? byHost.key : null;
}

function normalizeUrl(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomKeys(n) {
  const pool = PROVIDERS.filter(p => CLEAN_KEYS.has(p.key));
  const source = pool.length >= n ? pool : PROVIDERS;
  const shuffled = shuffle(source).map(p => p.key);
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(shuffled[i % shuffled.length]);
  return keys;
}

function showStatus(message, type = '') {
  el.status.textContent = message;
  el.status.className = `status ${type}`.trim();
}

// ---------------------------------------------------------------------------
// Grid / panel rendering
// ---------------------------------------------------------------------------
function gridColumns(n) {
  return n <= 3 ? n : Math.ceil(n / 2);
}

function buildPanel(id, key) {
  const provider = providerByKey(key);
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.dataset.id = String(id);

  const head = document.createElement('div');
  head.className = 'panel-head';

  const select = document.createElement('select');
  select.className = 'panel-select';
  select.title = `Panel ${id + 1}`;
  for (const p of PROVIDERS) {
    const option = document.createElement('option');
    option.value = p.key;
    option.textContent = p.label;
    if (p.key === key) option.selected = true;
    select.appendChild(option);
  }

  const urlInput = document.createElement('input');
  urlInput.className = 'panel-url';
  urlInput.type = 'text';
  urlInput.spellcheck = false;
  urlInput.value = provider.url;

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'panel-btn';
  goBtn.title = 'Go';
  goBtn.textContent = '→';

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'panel-btn';
  reloadBtn.title = 'Reload';
  reloadBtn.textContent = '⟳';

  const popBtn = document.createElement('button');
  popBtn.type = 'button';
  popBtn.className = 'panel-btn';
  popBtn.title = 'Open in a real logged-in window (for sites that require login)';
  popBtn.textContent = '⧉';

  const frame = document.createElement('iframe');
  frame.className = 'panel-frame';
  frame.src = provider.url;
  frame.setAttribute('allow', 'clipboard-write; clipboard-read; microphone; camera; autoplay');

  // — per-panel state —
  let windowed = false;          // true → running in a real popped-out window
  let placeholder = null;        // the "open window" card element
  let loadingEl = null;          // the "Loading…" veil over the frame
  let aliveResolved = false;     // panel-alive seen → embed succeeded
  let watchTimer = null;         // embed-failure fallback timer
  function currentUrl() { return normalizeUrl(urlInput.value) || provider.url; }
  const label = () => providerByKey(selectedKeys[id])?.label || 'AI';

  // — embed detection — show a loading veil over the frame; reveal it when
  //   content.js inside the panel posts 'panel-alive'. If the site never loads
  //   embedded within the timeout (XFO/CSP block, anti-embed), automatically
  //   fall back to a real logged-in window. This means EVERY site attempts to
  //   embed first, and only the ones that truly can't get the window card.
  function showLoading() {
    removeLoading();
    loadingEl = document.createElement('div');
    loadingEl.className = 'panel-loading';
    loadingEl.innerHTML = `<div class="pl-spin"></div><div class="pl-text">Loading ${label()}…</div>`;
    panel.append(loadingEl);
  }
  function removeLoading() { loadingEl?.remove(); loadingEl = null; }

  function startEmbedWatch() {
    if (windowed) return;
    aliveResolved = false;
    clearTimeout(watchTimer);
    showLoading();
    watchTimer = setTimeout(() => {
      if (aliveResolved || windowed) return;
      removeLoading();
      goWindowed({ openNow: false, blocked: true });   // site refused to embed
    }, EMBED_TIMEOUT_MS);
  }
  function notifyAlive(host) {
    if (aliveResolved || windowed) return;
    if (!hostMatch(host, hostOf(frame.src))) return;
    aliveResolved = true;
    clearTimeout(watchTimer);
    removeLoading();
  }
  panelMonitors.push({ notifyAlive });

  // — pop-out card —
  function showPlaceholder(blocked) {
    placeholder?.remove();
    placeholder = document.createElement('div');
    placeholder.className = 'panel-windowed';
    placeholder.innerHTML =
      `<div class="pw-icon">⧉</div>` +
      `<div class="pw-title">${label()}</div>` +
      `<div class="pw-sub">${blocked
        ? "This site won't load embedded (login / anti-embed).<br>Open it as a real logged-in window — broadcasts still reach it."
        : 'Running in a separate logged-in window.<br>Broadcasts still reach it.'}</div>`;
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'pw-btn'; open.textContent = 'Open logged-in window ↗';
    open.addEventListener('click', () => {
      showStatus(`Opening ${label()} in a logged-in window…`);
      chrome.runtime.sendMessage({ action: 'openPanelWindow', id, url: currentUrl() }).catch(() => {});
      setTimeout(() => showStatus(''), 1400);
    });
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'pw-btn ghost';
    back.textContent = blocked ? 'Try embedding again' : 'Bring back into panel';
    back.addEventListener('click', () => goFramed());
    placeholder.append(open, back);
    panel.append(placeholder);
  }

  async function goWindowed({ openNow, blocked = false }) {
    windowed = true;
    aliveResolved = true;
    clearTimeout(watchTimer);
    removeLoading();
    popBtn.classList.add('active');
    frame.style.display = 'none';
    frame.src = 'about:blank';            // unload the partitioned/blocked frame
    showPlaceholder(blocked);
    if (openNow) {
      showStatus(`Opening ${label()} in a logged-in window…`);
      await chrome.runtime.sendMessage({ action: 'openPanelWindow', id, url: currentUrl() }).catch(() => {});
      showStatus('');
    }
  }

  async function goFramed() {
    windowed = false;
    popBtn.classList.remove('active');
    await chrome.runtime.sendMessage({ action: 'closePanelWindow', id }).catch(() => {});
    placeholder?.remove();
    placeholder = null;
    frame.style.display = '';
    const url = currentUrl();
    await prepareOrigins([`https://${hostOf(url)}`, ...originsForKey(selectedKeys[id])]);
    frame.src = url;
    startEmbedWatch();
  }

  // — wiring —
  select.addEventListener('change', async () => {
    selectedKeys[id] = select.value;
    const p2 = providerByKey(select.value);
    urlInput.value = p2.url;
    showStatus(`Loading ${p2.label}…`);
    if (windowed) {
      await goFramed();          // re-embed the newly chosen site
    } else {
      await prepareOrigins(originsForKey(select.value));
      frame.src = p2.url;
      startEmbedWatch();
    }
    showStatus(`Panel ${id + 1} → ${p2.label}.`, 'success');
  });

  const navigate = async () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) return;
    urlInput.value = url;
    const matchedKey = keyFromUrl(url);
    if (matchedKey) {
      selectedKeys[id] = matchedKey;
      select.value = matchedKey;
    }
    if (windowed) {  // retarget the popped-out window
      chrome.runtime.sendMessage({ action: 'openPanelWindow', id, url }).catch(() => {});
      return;
    }
    await prepareOrigins([`https://${hostOf(url)}`, ...originsForKey(selectedKeys[id])]);
    frame.src = url;
    startEmbedWatch();
  };
  goBtn.addEventListener('click', navigate);
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(); }
  });

  reloadBtn.addEventListener('click', async () => {
    if (windowed) {  // when popped out, reload re-focuses the real window
      chrome.runtime.sendMessage({ action: 'openPanelWindow', id, url: currentUrl() }).catch(() => {});
      return;
    }
    showStatus(`Reloading panel ${id + 1}…`);
    await prepareOrigins([`https://${hostOf(frame.src)}`, ...originsForKey(selectedKeys[id])]);
    frame.src = frame.src; // eslint-disable-line no-self-assign
    startEmbedWatch();
    showStatus('');
  });

  popBtn.addEventListener('click', () => {
    if (windowed) goFramed();
    else goWindowed({ openNow: true });
  });

  head.append(select, urlInput, goBtn, reloadBtn, popBtn);
  panel.append(head, frame);

  startEmbedWatch();   // watch the initial embed; fall back to a window if blocked
  return panel;
}

function renderGrid() {
  el.grid.style.gridTemplateColumns = `repeat(${gridColumns(count)}, 1fr)`;
  el.grid.innerHTML = '';
  panelMonitors = [];   // drop monitors from the previous render
  selectedKeys.slice(0, count).forEach((key, id) => {
    el.grid.appendChild(buildPanel(id, key));
  });
}

function renderCountButtons() {
  for (const btn of el.panelCount.querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.count) === count);
  }
}

function setCount(next) {
  count = PANEL_COUNTS.includes(next) ? next : DEFAULT_COUNT;
  if (selectedKeys.length < count) {
    const filler = randomKeys(count);
    while (selectedKeys.length < count) selectedKeys.push(filler[selectedKeys.length]);
  } else {
    selectedKeys = selectedKeys.slice(0, count);
  }
  renderCountButtons();
}

// ---------------------------------------------------------------------------
// Auth-gateway messages from background (login can't finish inside an iframe).
// background pops a real first-party login tab, asks us to reset the panel to
// the AI home (abort broken in-frame auth), then reload it once authed.
// ---------------------------------------------------------------------------
function framesByHost(host) {
  return [...el.grid.querySelectorAll('iframe.panel-frame')]
    .filter(frame => hostOf(frame.src) === host
      || hostOf(frame.src).split('.').slice(-2).join('.') === String(host).split('.').slice(-2).join('.'));
}

function resetPanelsByHost(host, url) {
  for (const frame of framesByHost(host)) frame.src = url || frame.src;
}

function reloadPanelsByHost(host, url) {
  for (const frame of framesByHost(host)) frame.src = url || frame.src;
}

chrome.runtime.onMessage.addListener(msg => {
  if (!msg || !msg.action) return;
  if (msg.action === 'authResetPanel')  resetPanelsByHost(msg.host, msg.url);
  if (msg.action === 'authReloadPanel') reloadPanelsByHost(msg.host, msg.url);
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve({ id: nextImageId++, base64: e.target.result, name: file.name || 'image.png', type: file.type || 'image/png' });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageFilesFromList(files) {
  return Array.from(files || []).filter(f => f?.type?.startsWith('image/'));
}

function renderImages() {
  el.imageStrip.innerHTML = '';
  for (const image of attachedImages) {
    const tile = document.createElement('div');
    tile.className = 'image-tile';
    const img = document.createElement('img');
    img.src = image.base64; img.alt = image.name;
    const remove = document.createElement('button');
    remove.className = 'remove-btn'; remove.type = 'button';
    remove.textContent = '×'; remove.dataset.imageId = String(image.id);
    tile.append(img, remove);
    el.imageStrip.append(tile);
  }
}

async function loadImageFiles(files) {
  const imageFiles = imageFilesFromList(files);
  if (!imageFiles.length) return;
  const images = await Promise.all(imageFiles.map(readImageFile));
  attachedImages.push(...images);
  el.imageInput.value = '';
  renderImages();
}

function broadcastImages() {
  return attachedImages.map(({ base64, name, type }) => ({ base64, name, type }));
}

function clearImages() {
  attachedImages = [];
  el.imageInput.value = '';
  renderImages();
}

// ---------------------------------------------------------------------------
// Broadcast — background.broadcast() finds every registered panel frame in this
// (the workspace) tab and injects the prompt into each at once.
// ---------------------------------------------------------------------------
async function broadcast(text, images) {
  const response = await chrome.runtime.sendMessage({
    action: 'execute',
    text,
    images,
    imageBase64: images[0]?.base64 || null,
    imageName:   images[0]?.name   || null,
    imageType:   images[0]?.type   || null
  });

  const sent  = response?.count  ?? 0;
  const total = response?.frames ?? count;
  if (sent >= total && total > 0) {
    showStatus(`Sent to all ${sent} panels.`, 'success');
  } else if (sent > 0) {
    showStatus(`Sent to ${sent}/${total}. Some may need login.`, 'error');
  } else {
    showStatus('Reached panels — check the windows (some may need login).', '');
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
el.panelCount.addEventListener('click', async event => {
  const btn = event.target.closest('button[data-count]');
  if (!btn) return;
  const next = Number(btn.dataset.count);
  if (next === count) return;
  setCount(next);
  showStatus('Preparing panels…');
  await prepareOrigins(selectedKeys.slice(0, count).flatMap(originsForKey));
  showStatus('');
  renderGrid();
});

el.fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});

el.attachBtn.addEventListener('click', () => el.imageInput.click());

el.imageInput.addEventListener('change', e => {
  loadImageFiles(e.target.files).catch(() => showStatus('Could not load image.', 'error'));
});

document.addEventListener('paste', e => {
  loadImageFiles(e.clipboardData?.files).catch(() => {});
});

el.imageStrip.addEventListener('click', event => {
  const btn = event.target.closest('button[data-image-id]');
  if (!btn) return;
  attachedImages = attachedImages.filter(img => img.id !== Number(btn.dataset.imageId));
  renderImages();
});

el.prompt.addEventListener('input', () => {
  el.prompt.style.height = 'auto';
  el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 120)}px`;
});

el.prompt.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  el.composer.requestSubmit();
});

el.composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = el.prompt.value.trim();
  const images = broadcastImages();
  if (!text && !images.length) {
    showStatus('Enter a prompt or attach an image first.', 'error');
    return;
  }

  el.sendBtn.disabled = true;
  showStatus('Broadcasting…');
  el.prompt.value = '';
  el.prompt.style.height = 'auto';
  clearImages();

  try {
    await broadcast(text, images);
  } catch (err) {
    showStatus(err?.message ? `Error: ${err.message}` : 'Broadcast failed.', 'error');
  } finally {
    el.sendBtn.disabled = false;
    el.prompt.focus();
  }
});

// ---------------------------------------------------------------------------
// Init — seed panels from the popup's selection, else defaults.
// ---------------------------------------------------------------------------
async function init() {
  let seed = null;
  try {
    const stored = await chrome.storage.local.get('aib_workspace_seed');
    seed = stored?.aib_workspace_seed || null;
  } catch {}

  if (seed && Array.isArray(seed.panels) && seed.panels.length) {
    count = PANEL_COUNTS.includes(seed.count) ? seed.count : Math.min(Math.max(seed.panels.length, 2), 6);
    selectedKeys = seed.panels.map(p => keyFromUrl(typeof p === 'string' ? p : p?.url)).filter(Boolean);
  }

  if (selectedKeys.length < count) {
    const seedKeys = DEFAULT_PANEL_URLS.map(keyFromUrl).filter(Boolean);
    const filler = seedKeys.length >= count ? seedKeys : randomKeys(count);
    while (selectedKeys.length < count) selectedKeys.push(filler[selectedKeys.length] || randomKeys(1)[0]);
  }
  selectedKeys = selectedKeys.slice(0, count);

  // Arm DNR rules AND purge cache/SW for the selected origins BEFORE any iframe
  // loads — otherwise an authed site whose service worker serves the cached
  // document (Venice) loads with its un-stripped frame-ancestors CSP and the
  // frame is blocked. Forcing a fresh network fetch lets DNR strip the CSP.
  const initOrigins = selectedKeys.slice(0, count).flatMap(originsForKey);
  showStatus('Preparing panels…');
  await prepareOrigins(initOrigins);
  showStatus('');

  renderCountButtons();
  renderGrid();
  el.prompt.focus();
}

init();
