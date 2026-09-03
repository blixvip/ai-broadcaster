'use strict';

// ---------------------------------------------------------------------------
// AI Broadcaster workspace — iframe architecture.
// Embeds 2–6 real AI chat sites as <iframe> panels in ONE page, tiled in a
// grid, with a shared composer at the bottom that broadcasts a single prompt
// into every panel at once. Header-stripping (background.js DNR) + frame-bypass
// let the sites embed; content.js (all_frames) self-registers each panel and
// receives the inject payload from background.broadcast().
// ---------------------------------------------------------------------------

const DELIVERY = globalThis.AIBDeliveryProtocol;
const ATTACHMENT_LIMITS = DELIVERY.ATTACHMENT_LIMITS;
const PROVIDERS = globalThis.AIB_PROVIDERS || [];
const DEFAULT_PANEL_URLS = globalThis.AIB_DEFAULT_PANEL_URLS || [];
const PANEL_COUNTS = [2, 3, 4, 5, 6];
const DEFAULT_COUNT = 4;
const EMBED_TIMEOUT_MS = 26000;   // includes passive composer discovery on slow provider SPAs
const WORKSPACE_PARAMS = new URLSearchParams(location.search);
const WORKSPACE_INSTANCE_ID = WORKSPACE_PARAMS.get('id') || (() => {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  history.replaceState(null, '', url.href);
  return id;
})();
const WORKSPACE_TITLE_KEY = `aib_workspace_title_${WORKSPACE_INSTANCE_ID}`;
const WORKSPACE_LAYOUT_KEY = `aib_workspace_layout_${WORKSPACE_INSTANCE_ID}`;
const WORKSPACE_STATE_KEY = `aib_workspace_state_${WORKSPACE_INSTANCE_ID}`;

// Each panel registers a connectivity/readiness monitor. background.js forwards
// trusted content-script `panelAlive` and semantic `panelReadiness` messages.
let panelMonitors = [];

// Providers that land on a usable chat without a signup/landing wall.
const CLEAN_KEYS = new Set(['gemini', 'mistral', 'grok', 'perplexity', 'you', 'duckai', 'venice', 'deepseek']);

const el = {
  grid:       document.getElementById('grid'),
  gridShell:  document.getElementById('gridShell'),
  splitX:     document.getElementById('splitHandleX'),
  splitY:     document.getElementById('splitHandleY'),
  splitNode:  document.getElementById('splitNode'),
  dashboard:  document.getElementById('dashboardBtn'),
  focusMode:  document.getElementById('focusModeBtn'),
  title:      document.getElementById('workspaceTitle'),
  newWorkspace: document.getElementById('newWorkspaceBtn'),
  panelCount: document.getElementById('panelCount'),
  composer:   document.getElementById('composer'),
  prompt:     document.getElementById('prompt'),
  attachBtn:  document.getElementById('attachBtn'),
  imageInput: document.getElementById('imageInput'),
  imageStrip: document.getElementById('imageStrip'),
  sendBtn:    document.getElementById('sendBtn'),
  status:     document.getElementById('status'),
  readiness:  document.getElementById('readiness'),
  readinessLabel: document.getElementById('readinessLabel')
};

let count = DEFAULT_COUNT;
let selectedKeys = [];            // provider key per panel slot (index = panel id)
let attachedImages = [];
let nextImageId = 1;
let pendingAttachmentLoads = 0;
let attachmentLoadQueue = Promise.resolve();
let workspaceTabId = null;
let focusModeEnabled = false;
let focusedPanelId = 0;
let splitX = 0.5;
let splitY = 0.5;
let splitRenderFrame = null;
let draftRevision = 0;
let activeDelivery = null;
const panelControllers = new Map();
const panelEpochCounters = new Map();

function createId(prefix) {
  const value = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function markDraftChanged() {
  draftRevision += 1;
}

function sendWorkspaceMessage(message) {
  return chrome.runtime.sendMessage({
    ...message,
    workspaceTabId
  });
}

function setFocusedPanel(id) {
  focusedPanelId = Number(id) || 0;
  for (const panel of el.grid.querySelectorAll('.panel')) {
    panel.classList.toggle('is-focused', Number(panel.dataset.id) === focusedPanelId);
  }
}

function renderFocusMode() {
  document.documentElement.classList.toggle('focus-mode', focusModeEnabled);
  el.focusMode.classList.toggle('active', focusModeEnabled);
  el.focusMode.setAttribute('aria-pressed', String(focusModeEnabled));
  setFocusedPanel(focusedPanelId < count ? focusedPanelId : 0);
}

function writeGridSplit() {
  const xPercent = splitX * 100;
  const yPercent = splitY * 100;
  el.gridShell.style.setProperty('--split-x', `${xPercent.toFixed(2)}%`);
  el.gridShell.style.setProperty('--split-y', `${yPercent.toFixed(2)}%`);
  el.splitX.setAttribute('aria-valuenow', String(Math.round(xPercent)));
  el.splitX.setAttribute('aria-valuetext', `${Math.round(xPercent)} percent from the left`);
  el.splitY.setAttribute('aria-valuenow', String(Math.round(yPercent)));
  el.splitY.setAttribute('aria-valuetext', `${Math.round(yPercent)} percent from the top`);
}

function applyGridSplit() {
  if (splitRenderFrame != null) return;
  splitRenderFrame = requestAnimationFrame(() => {
    splitRenderFrame = null;
    writeGridSplit();
  });
}

function flushGridSplit() {
  if (splitRenderFrame != null) cancelAnimationFrame(splitRenderFrame);
  splitRenderFrame = null;
  writeGridSplit();
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------
function providerByKey(key) { return PROVIDERS.find(p => p.key === key) || PROVIDERS[0]; }
function urlForKey(key) { return providerByKey(key)?.url; }

function originsForKey(key) {
  const provider = providerByKey(key);
  return (provider.domains || [provider.domain]).filter(Boolean).map(domain => `https://${domain}`);
}

const PROVIDER_ACCENTS = {
  gemini: '#72a7ff', deepseek: '#6b8cff', mistral: '#ff9d66', grok: '#f4f6fb',
  perplexity: '#5eead4', you: '#b78cff', duckai: '#ffb454', huggingchat: '#ffd166',
  poe: '#8b7cff', venice: '#53e6c2', lmarena: '#69d2ff', 'ai-studio': '#78a8ff',
  copilot: '#67e8f9', qwen: '#9b87ff', meta: '#5b8cff', kimi: '#64f0c8', blackbox: '#e7e9ee'
};

function providerAccent(key) {
  return PROVIDER_ACCENTS[key] || '#66fcf1';
}

function providerMark(key) {
  return globalThis.AIB_PROVIDER_MARK?.(key) || '';
}

function makePanelButton(className, title, svg) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = svg;
  return button;
}

// Ensure frame rules are active and cached anti-embed responses are removed.
// Do not race this request: loading while cache cleanup is still running can put
// the exact blocked response back into the new iframe.
async function prepareFrames(origins = []) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'prepareFrames',
      origins: [...new Set(origins)]
    });
    if (response?.ok !== true) throw new Error(response?.reason || 'Panel preparation failed');
    return true;
  } catch (error) {
    showStatus(error?.message || 'Panel preparation failed.', 'error');
    return false;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function providerAcceptsHost(providerKey, host) {
  const provider = providerByKey(providerKey);
  return !!host && (provider?.domains || [provider?.domain]).includes(host);
}

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
  el.status.title = message;
  el.status.className = `status ${type}`.trim();
}

function updateReadiness() {
  const controllers = [...panelControllers.values()];
  const ready = controllers.filter(controller => ['ready', 'verified'].includes(controller.state)).length;
  const failed = controllers.filter(controller => ['failed', 'unverified', 'login_required', 'not_ready'].includes(controller.state)).length;
  const busy = controllers.filter(controller => ['checking', 'preparing', 'injecting', 'uploading', 'verifying'].includes(controller.state)).length;
  const total = controllers.length || count;
  const mode = failed ? 'attention' : busy ? 'busy' : ready === total ? 'ready' : 'idle';
  el.readiness.dataset.state = mode;
  el.readinessLabel.textContent = failed
    ? `${ready}/${total} READY · ${failed} CHECK`
    : busy
      ? `${ready}/${total} READY · ${busy} LOADING`
      : `${ready}/${total} READY`;
  el.readiness.title = failed
    ? 'One or more panels need attention before a full broadcast.'
    : `${ready} of ${total} panels are ready.`;
}

function applyWorkspaceTitle(value, syncInput = true) {
  const title = String(value || '').trim().slice(0, 80);
  if (syncInput) el.title.value = title;
  document.title = title ? `${title} — AI Broadcaster` : 'AI Broadcaster — Untitled';
}

async function saveWorkspaceTitle() {
  const title = el.title.value.trim().slice(0, 80);
  applyWorkspaceTitle(title);
  if (title) await chrome.storage.local.set({ [WORKSPACE_TITLE_KEY]: title });
  else await chrome.storage.local.remove(WORKSPACE_TITLE_KEY);
}

async function loadWorkspaceTitle() {
  try {
    const stored = await chrome.storage.local.get(WORKSPACE_TITLE_KEY);
    applyWorkspaceTitle(stored[WORKSPACE_TITLE_KEY] || '');
  } catch {
    applyWorkspaceTitle('');
  }
}

async function loadWorkspaceLayout() {
  try {
    const stored = await chrome.storage.local.get(WORKSPACE_LAYOUT_KEY);
    const layout = stored[WORKSPACE_LAYOUT_KEY];
    if (Number.isFinite(layout?.x)) splitX = Math.min(0.72, Math.max(0.28, layout.x));
    if (Number.isFinite(layout?.y)) splitY = Math.min(0.72, Math.max(0.28, layout.y));
  } catch {}
  flushGridSplit();
}

function saveWorkspaceLayout() {
  return chrome.storage.local.set({ [WORKSPACE_LAYOUT_KEY]: { x: splitX, y: splitY } });
}

function saveWorkspaceState() {
  return chrome.storage.local.set({
    [WORKSPACE_STATE_KEY]: {
      count,
      selectedKeys: selectedKeys.slice(0, count)
    }
  });
}

async function loadWorkspaceState() {
  try {
    const stored = await chrome.storage.local.get(WORKSPACE_STATE_KEY);
    const state = stored[WORKSPACE_STATE_KEY];
    if (!state || !Array.isArray(state.selectedKeys)) return false;
    const validKeys = state.selectedKeys.filter(key => PROVIDERS.some(provider => provider.key === key));
    if (!validKeys.length) return false;
    count = PANEL_COUNTS.includes(state.count) ? state.count : Math.min(Math.max(validKeys.length, 2), 6);
    selectedKeys = validKeys.slice(0, count);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// "→ Warp": capture a panel's latest response and paste it into Warp.
// Chrome launches the registered native host on demand, so there is no local
// server to start and no localhost endpoint exposed to ordinary web pages.
// ---------------------------------------------------------------------------
const WARP_NATIVE_HOST = 'com.ai_broadcaster.warp';
let captureSeq = 0;
const pendingCaptures = new Map();   // reqId -> { resolve, timer }
let warpTransferBusy = false;

// content.js in a panel frame replies to our capture-req with this.
window.addEventListener('message', event => {
  const d = event.data;
  if (!d || d.__aib !== 'capture-res') return;
  const pending = pendingCaptures.get(d.reqId);
  if (!pending) return;
  if (event.source !== pending.source) return;
  clearTimeout(pending.timer);
  pendingCaptures.delete(d.reqId);
  pending.resolve({ text: d.text || '' });
});

// Ask an embedded panel iframe for only its newest assistant response.
function captureFromFrame(frame, timeoutMs = 1000) {
  return new Promise(resolve => {
    const reqId = `cap-${Date.now()}-${captureSeq++}`;
    const timer = setTimeout(() => {
      pendingCaptures.delete(reqId);
      resolve({ text: '' });
    }, timeoutMs);
    pendingCaptures.set(reqId, { resolve, timer, source: frame.contentWindow });
    try {
      frame.contentWindow.postMessage({ __aib: 'capture-req', reqId }, '*');
    } catch {
      clearTimeout(timer);
      pendingCaptures.delete(reqId);
      resolve({ text: '' });
    }
  });
}

// Keep one native connection warm. The helper is started while the workspace
// loads, so button clicks do not pay process-startup cost.
let warpNativePort = null;
let warpNativeSeq = 0;
const pendingNativeMessages = new Map();

function connectWarpNative() {
  if (warpNativePort) return warpNativePort;
  const port = chrome.runtime.connectNative(WARP_NATIVE_HOST);
  warpNativePort = port;

  port.onMessage.addListener(response => {
    let requestId = response?.requestId;
    // Compatibility with a one-shot helper during extension upgrades.
    if (!requestId && pendingNativeMessages.size === 1) {
      requestId = pendingNativeMessages.keys().next().value;
    }
    const pending = pendingNativeMessages.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingNativeMessages.delete(requestId);
    pending.resolve(response);
  });

  port.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message || 'Warp helper disconnected';
    if (warpNativePort === port) warpNativePort = null;
    for (const pending of pendingNativeMessages.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    pendingNativeMessages.clear();
  });
  return port;
}

function sendWarpNativeMessage(message, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const requestId = `native-${Date.now()}-${warpNativeSeq++}`;
    const timer = setTimeout(() => {
      pendingNativeMessages.delete(requestId);
      reject(new Error('Warp helper timed out'));
    }, timeoutMs);
    pendingNativeMessages.set(requestId, { resolve, reject, timer });
    try {
      connectWarpNative().postMessage({ ...message, requestId });
    } catch (err) {
      clearTimeout(timer);
      pendingNativeMessages.delete(requestId);
      reject(err);
    }
  });
}

// Start the helper before the first click. Failures remain silent here and are
// reported normally if the user actually presses the Warp button.
try { connectWarpNative(); } catch {}

function latestAssistantText(capture) {
  return String(capture?.text || '').trim();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Modal: pick which Warp pane receives the paste. Resolves to a paneId or null.
function pickWarpPane(panes) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'warp-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'warp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('div');
    title.className = 'warp-modal-title';
    title.id = createId('warp-pane-title');
    title.textContent = 'Send to which Warp pane?';
    modal.setAttribute('aria-labelledby', title.id);

    const list = document.createElement('div');
    list.className = 'warp-modal-list';
    const activeId = (panes.find(p => p.active) || panes[0])?.id;
    let activeRadio = null;
    for (const p of panes) {
      const row = document.createElement('label');
      row.className = 'warp-pane-row';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'warp-pane';
      radio.value = p.id;
      if (p.id === activeId) {
        radio.checked = true;
        activeRadio = radio;
      }
      const text = document.createElement('span');
      text.innerHTML = `<b>${escapeHtml(p.label)}</b><br><small>${escapeHtml(p.detail || p.app)}</small>`;
      row.append(radio, text);
      list.append(row);
    }

    const btns = document.createElement('div');
    btns.className = 'warp-modal-btns';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'warp-btn-secondary'; cancel.textContent = 'Cancel';
    const send = document.createElement('button');
    send.type = 'button'; send.className = 'warp-btn-primary'; send.textContent = 'Paste only';
    btns.append(cancel, send);

    modal.append(title, list, btns);
    overlay.append(modal);
    document.body.append(overlay);

    let settled = false;
    const focusable = () => [...modal.querySelectorAll('input:not([disabled]), button:not([disabled])')];
    const close = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      previousFocus?.focus?.();
      resolve(value);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    cancel.addEventListener('click', () => close(null));
    overlay.addEventListener('click', event => { if (event.target === overlay) close(null); });
    send.addEventListener('click', () => {
      const chosen = modal.querySelector('input[name="warp-pane"]:checked');
      close(chosen ? chosen.value : null);
    });
    (activeRadio || cancel).focus();
  });
}

async function sendPanelToWarp(frame, labelText, choosePane = false) {
  if (warpTransferBusy) {
    showStatus('A Warp transfer is already in progress…');
    return;
  }
  warpTransferBusy = true;
  showStatus(`Capturing ${labelText}…`);
  try {
    const capture = await captureFromFrame(frame);
    const response = latestAssistantText(capture);
    if (!response) {
      showStatus(`Nothing to capture from ${labelText}`, 'error');
      return;
    }

    let j;
    if (!choosePane) {
      // Fast path: one already-running native request, no pane screenshot or
      // picker. Warp preserves keyboard focus in its last-used pane.
      j = await sendWarpNativeMessage({
        action: 'injectActive',
        text: response,
        submit: false
      });
    } else {
      const paneResult = await sendWarpNativeMessage({ action: 'panes' });
      const panes = paneResult?.panes || [];
      if (!paneResult?.ok) {
        showStatus(`Could not read Warp panes: ${paneResult?.error || 'unknown error'}`, 'error');
        return;
      }
      if (!panes.length) {
        showStatus('No Warp panes found — open Warp first', 'error');
        return;
      }
      const paneId = await pickWarpPane(panes);
      if (!paneId) {
        showStatus('');
        return;
      }
      j = await sendWarpNativeMessage({
        action: 'inject',
        text: response,
        paneId,
        focusPane: true,
        submit: false
      });
    }

    if (j.ok) showStatus(`Sent latest response → ${j.target || 'Warp'} ✓`, 'success');
    else showStatus(`Warp inject failed: ${j.error || 'unknown'}`, 'error');
  } catch (err) {
    showStatus(`Warp inject failed: ${err.message || 'helper unreachable'}`, 'error');
  } finally {
    warpTransferBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Grid / panel rendering
// ---------------------------------------------------------------------------
const PANEL_STATE_LABELS = {
  idle: 'IDLE',
  ready: 'READY',
  checking: 'CHECKING',
  preparing: 'PREPARING',
  injecting: 'INJECTING',
  uploading: 'UPLOADING',
  verifying: 'VERIFYING',
  verified: 'VERIFIED',
  unverified: 'CHECK',
  failed: 'ERROR',
  login_required: 'SIGN IN',
  not_ready: 'NOT READY'
};

function deliveryReasonLabel(reason = '') {
  const value = String(reason).replace(/^no_input:/, 'Input not found · ').replace(/_/g, ' ');
  const friendly = {
    login_required: 'Sign in required',
    text_not_inserted: 'Input rejected text',
    attachment_not_ready: 'Attachment not ready',
    generation_did_not_stop: 'Could not stop current response',
    evidence_timeout: 'Sent; acceptance unconfirmed',
    weak_evidence_only: 'Sent; verify in panel',
    frame_busy: 'Panel is busy'
  }[reason];
  return friendly || value;
}

function deliveryStateForLifecycle(state) {
  if (['received', 'preparing'].includes(state)) return 'preparing';
  if (['input_ready', 'injecting_text', 'text_ready'].includes(state)) return 'injecting';
  if (['attaching', 'images_ready'].includes(state)) return 'uploading';
  if (['action_ready', 'verifying', 'action_dispatched'].includes(state)) return 'verifying';
  if (state === 'verified') return 'verified';
  if (state === 'unverified') return 'unverified';
  if (state === 'failed') return 'failed';
  return null;
}

function setPanelDeliveryState(panelId, state, details = {}) {
  const controller = panelControllers.get(panelId);
  if (!controller) return;
  if (Number.isInteger(details.panelEpoch) && details.panelEpoch !== controller.panelEpoch) return;

  const next = PANEL_STATE_LABELS[state] ? state : 'idle';
  controller.state = next;
  controller.panel.dataset.deliveryState = next;
  controller.liveState.textContent = PANEL_STATE_LABELS[next];
  const reason = details.reason || details.title || '';
  controller.liveState.title = reason || PANEL_STATE_LABELS[next];
  controller.stateDetail.textContent = ['failed', 'unverified', 'login_required', 'not_ready'].includes(next)
    ? deliveryReasonLabel(reason)
    : '';
  controller.stateDetail.hidden = !controller.stateDetail.textContent;
  controller.retryButton.hidden = !details.retry?.safe;
  controller.retryButton.disabled = false;
  controller.retryButton.title = details.retry?.safe
    ? `Retry this panel: ${details.reason || 'delivery failed before submission'}`
    : 'Retry is unavailable because the previous action may already have submitted';
  controller.panel.setAttribute('aria-busy', String(['checking', 'preparing', 'injecting', 'uploading', 'verifying'].includes(next)));
  controller.panel.setAttribute('aria-label', `Panel ${controller.id + 1}: ${PANEL_STATE_LABELS[next].toLowerCase()}`);
  if (details.result) controller.lastResult = details.result;
  updateReadiness();
}

function guardDeliverySensitiveChange(actionLabel) {
  if (activeDelivery?.inFlight) {
    showStatus(`Wait for the active delivery before ${actionLabel}.`, 'error');
    return true;
  }
  if (activeDelivery && activeDelivery.draftRevision === draftRevision && !deliveryIsFullyVerified(activeDelivery)) {
    showStatus('This draft still has unresolved panels. Use the safe retry, or edit the draft before changing the workspace.', 'error');
    return true;
  }
  if (activeDelivery?.draftRevision !== draftRevision) activeDelivery = null;
  return false;
}

function restoreUnresolvedPanelState(panelId) {
  const result = activeDelivery?.results.get(panelId);
  const outcome = result?.attempt?.outcome || result?.outcome;
  if (!result || outcome === 'verified') return false;
  setPanelDeliveryState(panelId, outcome || 'failed', {
    panelEpoch: panelControllers.get(panelId)?.panelEpoch,
    reason: result.attempt?.reason || result.reason,
    retry: result.attempt?.retry || result.retry,
    result
  });
  return true;
}

function buildPanel(id, key) {
  const provider = providerByKey(key);
  const panelId = `${WORKSPACE_INSTANCE_ID}:${id}`;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.dataset.id = String(id);
  panel.dataset.panelId = panelId;
  panel.dataset.provider = key;
  panel.style.setProperty('--panel-accent', providerAccent(key));

  const head = document.createElement('div');
  head.className = 'panel-head';

  const brand = document.createElement('div');
  brand.className = 'panel-brand';
  const logo = document.createElement('span');
  logo.className = 'panel-logo';
  logo.innerHTML = providerMark(key);
  const liveDot = document.createElement('span');
  liveDot.className = 'panel-live-dot';

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

  const liveState = document.createElement('span');
  liveState.className = 'panel-live-state';
  liveState.textContent = 'IDLE';
  const stateDetail = document.createElement('span');
  stateDetail.className = 'panel-state-detail';
  stateDetail.hidden = true;
  brand.append(logo, liveDot, select, liveState);

  const urlInput = document.createElement('input');
  urlInput.className = 'panel-url';
  urlInput.type = 'text';
  urlInput.spellcheck = false;
  urlInput.value = provider.url;

  const goBtn = makePanelButton('panel-btn panel-go', 'Open URL',
    '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>');
  const reloadBtn = makePanelButton('panel-btn panel-reload', 'Reload panel',
    '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></svg>');
  const soloBtn = makePanelButton('panel-btn panel-solo', 'Focus panel',
    '<svg viewBox="0 0 24 24"><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4"/></svg>');
  soloBtn.setAttribute('aria-pressed', 'false');
  const warpBtn = makePanelButton('panel-btn panel-btn-warp', 'Send latest response to Warp (Shift+click to choose)',
    '<span>WARP</span><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>');
  const retryBtn = makePanelButton('panel-btn panel-retry', 'Retry this panel',
    '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></svg>');
  retryBtn.hidden = true;
  const panelActions = document.createElement('div');
  panelActions.className = 'panel-actions';
  panelActions.append(goBtn, reloadBtn, retryBtn, soloBtn, warpBtn);

  const frame = document.createElement('iframe');
  frame.className = 'panel-frame';
  frame.src = provider.url;
  frame.lang = provider.locale || 'en-US';
  frame.title = `${provider.label} chat panel`;
  frame.setAttribute('allow', 'clipboard-write; clipboard-read; microphone; camera; autoplay');

  // — per-panel state —
  let loadingEl = null;
  let readinessResolved = false;
  let watchTimer = null;
  let panelEpoch = (panelEpochCounters.get(panelId) || 0) + 1;
  panelEpochCounters.set(panelId, panelEpoch);
  panel.dataset.panelEpoch = String(panelEpoch);
  const bindingTimers = new Set();
  const controller = {
    id,
    panelId,
    panelEpoch,
    providerKey: key,
    panel,
    frame,
    liveState,
    stateDetail,
    retryButton: retryBtn,
    state: 'idle',
    readinessState: 'checking',
    readinessReason: '',
    lastResult: null
  };
  panelControllers.set(panelId, controller);
  const label = () => providerByKey(selectedKeys[id])?.label || 'AI';

  function clearBindingTimers() {
    for (const timer of bindingTimers) clearTimeout(timer);
    bindingTimers.clear();
  }

  function postPanelBinding() {
    try {
      frame.contentWindow?.postMessage({
        __aib: 'panel-binding',
        protocolVersion: DELIVERY.VERSION,
        panelId,
        panelEpoch,
        providerKey: selectedKeys[id]
      }, '*');
    } catch {}
  }

  function schedulePanelBinding() {
    clearBindingTimers();
    postPanelBinding();
    for (const delay of [100, 500, 1500]) {
      const timer = setTimeout(() => {
        bindingTimers.delete(timer);
        postPanelBinding();
      }, delay);
      bindingTimers.add(timer);
    }
  }

  function navigateFrame(url) {
    panelEpoch += 1;
    panelEpochCounters.set(panelId, panelEpoch);
    controller.panelEpoch = panelEpoch;
    panel.dataset.panelEpoch = String(panelEpoch);
    controller.providerKey = selectedKeys[id];
    controller.lastResult = null;
    controller.readinessState = 'checking';
    controller.readinessReason = '';
    setPanelDeliveryState(panelId, 'checking');
    frame.src = url;
    startEmbedWatch();
  }
  controller.navigate = navigateFrame;

  function updatePanelIdentity(nextProvider) {
    panel.dataset.provider = nextProvider.key;
    panel.style.setProperty('--panel-accent', providerAccent(nextProvider.key));
    logo.innerHTML = providerMark(nextProvider.key);
    frame.lang = nextProvider.locale || 'en-US';
    frame.title = `${nextProvider.label} chat panel`;
  }

  // Keep the provider mounted while its content script registers. A late
  // registration changes the state to uncertain without destroying the frame.
  function showLoading() {
    removeLoading();
    loadingEl = document.createElement('div');
    loadingEl.className = 'panel-loading';
    loadingEl.innerHTML = `
      <div class="pl-orbit" aria-hidden="true"><span></span><i></i></div>
      <div class="pl-text">CONNECTING TO ${escapeHtml(label().toUpperCase())}</div>
      <div class="pl-progress" aria-hidden="true"><span></span></div>`;
    panel.append(loadingEl);
  }
  function removeLoading() { loadingEl?.remove(); loadingEl = null; }

  function startEmbedWatch() {
    readinessResolved = false;
    clearTimeout(watchTimer);
    showLoading();
    watchTimer = setTimeout(() => {
      if (readinessResolved) return;
      removeLoading();
      controller.readinessState = 'not_ready';
      controller.readinessReason = 'Composer readiness could not be confirmed in time';
      // Never unload a provider just because its readiness probe was late. The
      // frame stays mounted and a later semantic readiness update can recover it.
      if (activeDelivery?.inFlight) return;
      if (!restoreUnresolvedPanelState(panelId)) {
        setPanelDeliveryState(panelId, 'not_ready', { reason: controller.readinessReason });
      }
    }, EMBED_TIMEOUT_MS);
  }

  function messageMatchesPanel(message, exactBinding = false) {
    const host = message?.host || '';
    if (!providerAcceptsHost(controller.providerKey, host)) return false;
    if (exactBinding && message?.panelId !== panelId) return false;
    if (message?.panelId && message.panelId !== panelId) return false;
    if (exactBinding && message?.panelEpoch !== panelEpoch) return false;
    if (Number.isInteger(message?.panelEpoch) && message.panelEpoch !== panelEpoch) return false;
    return true;
  }

  function notifyAlive(message) {
    if (!messageMatchesPanel(message)) return;
    controller.frameId = Number.isInteger(message?.frameId) ? message.frameId : controller.frameId;
    removeLoading();
    if (activeDelivery?.inFlight) return;
    if (!restoreUnresolvedPanelState(panelId)) setPanelDeliveryState(panelId, 'checking');
  }

  function notifyReadiness(message) {
    // Readiness is authoritative only after the child frame accepted this panel's
    // stable binding. Host-only announcements can belong to another same-provider panel.
    if (!messageMatchesPanel(message, true)) return;
    const state = ['checking', 'ready', 'login_required', 'not_ready'].includes(message?.state)
      ? message.state
      : 'not_ready';
    const reason = String(message?.reason || '').slice(0, 240);
    controller.frameId = Number.isInteger(message?.frameId) ? message.frameId : controller.frameId;
    controller.readinessState = state;
    controller.readinessReason = reason;
    if (state !== 'checking') {
      readinessResolved = true;
      clearTimeout(watchTimer);
    }
    removeLoading();
    if (activeDelivery?.inFlight) return;
    if (restoreUnresolvedPanelState(panelId)) return;
    setPanelDeliveryState(panelId, state, {
      panelEpoch,
      reason: state === 'login_required' ? (reason || 'Sign in required') : reason
    });
  }

  panelMonitors.push({
    panelId,
    notifyAlive,
    notifyReadiness,
    dispose() {
      clearTimeout(watchTimer);
      clearBindingTimers();
      watchTimer = null;
    }
  });

  // A cross-origin iframe emits load on its owning element. Bind its new document
  // to this stable panel identity, then wait for content-script readiness.
  frame.addEventListener('load', () => {
    schedulePanelBinding();
  });

  // — wiring —
  select.addEventListener('change', async () => {
    if (guardDeliverySensitiveChange('changing a provider')) {
      select.value = selectedKeys[id];
      return;
    }
    const previousKey = selectedKeys[id];
    const nextKey = select.value;
    const p2 = providerByKey(nextKey);
    showStatus(`Loading ${p2.label}…`);
    if (!await prepareFrames(originsForKey(nextKey))) {
      select.value = previousKey;
      return;
    }
    selectedKeys[id] = nextKey;
    updatePanelIdentity(p2);
    urlInput.value = p2.url;
    saveWorkspaceState().catch(() => {});
    navigateFrame(p2.url);
    showStatus(`Panel ${id + 1} → ${p2.label}.`, 'success');
  });

  const navigate = async () => {
    if (guardDeliverySensitiveChange('navigating a panel')) return;
    const url = normalizeUrl(urlInput.value);
    if (!url) return;
    const matchedKey = keyFromUrl(url);
    const nextKey = matchedKey || selectedKeys[id];
    if (!await prepareFrames([`https://${hostOf(url)}`, ...originsForKey(nextKey)])) return;
    urlInput.value = url;
    if (matchedKey) {
      selectedKeys[id] = matchedKey;
      select.value = matchedKey;
      updatePanelIdentity(providerByKey(matchedKey));
      saveWorkspaceState().catch(() => {});
    }
    navigateFrame(url);
  };
  goBtn.addEventListener('click', navigate);
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(); }
  });

  reloadBtn.addEventListener('click', async () => {
    if (activeDelivery?.inFlight) {
      showStatus('Wait for the active delivery before reloading a panel.', 'error');
      return;
    }
    showStatus(`Reloading panel ${id + 1}…`);
    if (!await prepareFrames([`https://${hostOf(frame.src)}`, ...originsForKey(selectedKeys[id])])) return;
    navigateFrame(frame.src);
    showStatus('');
  });

  retryBtn.addEventListener('click', () => retryPanel(panelId));

  warpBtn.addEventListener('click', event => {
    sendPanelToWarp(frame, label(), event.shiftKey);
  });

  soloBtn.addEventListener('click', () => {
    const soloing = !panel.classList.contains('is-solo');
    for (const other of el.grid.querySelectorAll('.panel')) other.classList.remove('is-solo');
    for (const button of el.grid.querySelectorAll('.panel-solo')) {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
      button.title = 'Focus panel';
      button.setAttribute('aria-label', button.title);
    }
    panel.classList.toggle('is-solo', soloing);
    el.gridShell.classList.toggle('has-solo-panel', soloing);
    soloBtn.classList.toggle('active', soloing);
    soloBtn.setAttribute('aria-pressed', String(soloing));
    soloBtn.title = soloing ? 'Restore grid' : 'Focus panel';
    soloBtn.setAttribute('aria-label', soloBtn.title);
  });

  panel.addEventListener('pointerenter', () => {
    if (focusModeEnabled) setFocusedPanel(id);
  });
  panel.addEventListener('focusin', () => setFocusedPanel(id));
  frame.addEventListener('focus', () => setFocusedPanel(id));
  head.addEventListener('pointerdown', () => setFocusedPanel(id));

  head.append(brand, stateDetail, urlInput, panelActions);
  panel.append(head, frame);

  setPanelDeliveryState(panelId, 'checking');
  startEmbedWatch();
  return panel;
}

function retirePanel(panelId) {
  const controller = panelControllers.get(panelId);
  controller?.panel.remove();
  panelControllers.delete(panelId);
  panelMonitors = panelMonitors.filter(monitor => {
    if (monitor.panelId !== panelId) return true;
    monitor.dispose?.();
    return false;
  });
}

async function reconcilePanelRegistry() {
  const panels = [...panelControllers.values()].map(controller => ({
    panelId: controller.panelId,
    panelEpoch: controller.panelEpoch
  }));
  const response = await sendWorkspaceMessage({ action: 'reconcilePanels', panels }).catch(() => null);
  if (response?.ok === true) return true;
  showStatus(response?.reason || 'Could not synchronize panel targets. Reload before broadcasting.', 'error');
  return false;
}

async function renderGrid() {
  const desiredPanelIds = new Set(
    Array.from({ length: count }, (_, id) => `${WORKSPACE_INSTANCE_ID}:${id}`)
  );

  // Keep retained iframe nodes exactly where they are. Removing/reinserting an
  // iframe destroys its browsing context in Chrome, which would erase the chat
  // merely because the user changed the panel count.
  for (const [panelId, controller] of [...panelControllers]) {
    const expectedKey = selectedKeys[controller.id];
    const canRetain = desiredPanelIds.has(panelId)
      && controller.providerKey === expectedKey
      && controller.panel.parentElement === el.grid;
    if (!canRetain) retirePanel(panelId);
  }

  const isQuad = count === 4;
  el.gridShell.classList.toggle('is-resizable', isQuad);
  el.grid.className = `grid grid-${count}`;
  if (isQuad) {
    el.grid.style.gridTemplateColumns = 'minmax(0, calc(var(--split-x) - 3px)) minmax(0, calc(100% - var(--split-x) - 3px))';
    el.grid.style.gridTemplateRows = 'minmax(0, calc(var(--split-y) - 3px)) minmax(0, calc(100% - var(--split-y) - 3px))';
  } else {
    el.grid.style.removeProperty('grid-template-columns');
    el.grid.style.removeProperty('grid-template-rows');
  }

  for (let id = 0; id < count; id += 1) {
    const panelId = `${WORKSPACE_INSTANCE_ID}:${id}`;
    if (!panelControllers.has(panelId)) el.grid.appendChild(buildPanel(id, selectedKeys[id]));
  }

  el.gridShell.classList.remove('has-solo-panel');
  for (const panel of el.grid.querySelectorAll('.panel')) {
    panel.classList.remove('is-solo');
    const soloButton = panel.querySelector('.panel-solo');
    soloButton?.classList.remove('active');
    soloButton?.setAttribute('aria-pressed', 'false');
    if (soloButton) {
      soloButton.title = 'Focus panel';
      soloButton.setAttribute('aria-label', soloButton.title);
    }
  }
  applyGridSplit();
  renderFocusMode();
  updateReadiness();
  return reconcilePanelRegistry();
}

function renderCountButtons() {
  for (const btn of el.panelCount.querySelectorAll('button')) {
    const selected = Number(btn.dataset.count) === count;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
    btn.setAttribute('aria-label', `${btn.dataset.count} panels`);
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
// background.js resets a direct panel when it attempts an external auth flow
// that cannot complete reliably inside an embedded third-party context.
// ---------------------------------------------------------------------------
async function resetPanelFromAuth(message) {
  const direct = message?.panelId ? panelControllers.get(message.panelId) : null;
  if (direct && (!Number.isInteger(message.panelEpoch) || message.panelEpoch === direct.panelEpoch)) {
    const url = message.url || direct.frame.src;
    if (await prepareFrames([`https://${hostOf(url)}`, ...originsForKey(direct.providerKey)])) {
      direct.navigate?.(url);
    }
    return;
  }

  // Compatibility fallback for a service worker that has not yet learned the
  // binding. Match only one provider-registry identity, never a registrable domain.
  const candidate = [...panelControllers.values()].find(controller =>
    controller.providerKey === message?.providerKey
      || providerAcceptsHost(controller.providerKey, message?.host));
  if (!candidate) return;
  const url = message.url || candidate.frame.src;
  if (await prepareFrames([`https://${hostOf(url)}`, ...originsForKey(candidate.providerKey)])) {
    candidate.navigate?.(url);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.action) return false;
  if (msg.action === 'panelAlive') {
    for (const monitor of panelMonitors) monitor.notifyAlive(msg);
    return false;
  }
  if (msg.action === 'panelReadiness') {
    for (const monitor of panelMonitors) monitor.notifyReadiness(msg);
    return false;
  }
  if (msg.action === 'deliveryLifecycle') {
    if (!activeDelivery || msg.deliveryId !== activeDelivery.deliveryId) return false;
    const state = deliveryStateForLifecycle(msg.state);
    if (state && msg.panelId) {
      setPanelDeliveryState(msg.panelId, state, {
        panelEpoch: Number(msg.panelEpoch),
        reason: msg.details?.reason || msg.state
      });
    }
    return false;
  }
  if (msg.action === 'authResetPanel') {
    resetPanelFromAuth(msg);
    return false;
  }
  if (msg.action === 'compose-add') {
    sendResponse(addToComposer(msg.text, msg.images, msg.broadcast));
    return true;
  }
  return false;
});

// Validate and start through one path so hotkey acknowledgements mean the
// delivery was synchronously accepted, not merely that a submit was requested.
function validateComposerSubmission() {
  if (el.sendBtn.disabled || activeDelivery?.inFlight) {
    return {
      ok: false,
      reason: 'delivery_in_progress',
      message: 'Wait for the active delivery before sending again.'
    };
  }
  if (pendingAttachmentLoads) {
    return {
      ok: false,
      reason: 'attachment_loading',
      message: 'Wait for attachments to finish loading before sending.'
    };
  }
  if (activeDelivery && activeDelivery.draftRevision === draftRevision) {
    return {
      ok: false,
      reason: 'unresolved_delivery',
      message: 'This preserved draft already has unresolved panels. Use a safe panel retry or edit the draft to start a new delivery.'
    };
  }

  const promptSnapshot = el.prompt.value;
  const text = promptSnapshot.trim();
  const imageIds = attachedImages.map(image => image.id);
  const images = broadcastImages();
  if (!text && !images.length) {
    return { ok: false, reason: 'empty_draft', message: 'Enter a prompt or attach a file first.' };
  }

  const fanoutValidation = DELIVERY.validateAttachmentFanout(images, panelControllers.size);
  if (!fanoutValidation.ok) {
    return {
      ok: false,
      reason: fanoutValidation.reason,
      message: attachmentErrorMessage(fanoutValidation.reason)
    };
  }

  return { ok: true, text, images, promptSnapshot, imageIds };
}

function beginComposerDelivery() {
  const candidate = validateComposerSubmission();
  if (!candidate.ok) {
    showStatus(candidate.message, 'error');
    return { accepted: false, reason: candidate.reason, message: candidate.message };
  }

  const { delivery, controllers } = createDelivery(
    candidate.text,
    candidate.images,
    candidate.promptSnapshot,
    candidate.imageIds
  );
  activeDelivery = delivery;
  el.sendBtn.disabled = true;
  el.composer.classList.add('is-broadcasting');
  showStatus('Preparing verified delivery…');

  void (async () => {
    try {
      await dispatchDelivery(delivery, controllers);
    } catch (error) {
      delivery.inFlight = false;
      showStatus(error?.message ? `Error: ${error.message}` : 'Broadcast failed. Your draft was preserved.', 'error');
    } finally {
      el.sendBtn.disabled = false;
      el.composer.classList.remove('is-broadcasting');
      el.prompt.focus();
    }
  })();

  return { accepted: true, reason: '', message: '' };
}

// Fill the composer from the grab hotkey (background handleGrabCommand).
// broadcast=false → just fill the box; broadcast=true → fill AND send now.
function addToComposer(text, images, broadcast = false) {
  let added = false;
  let rejectionReason = '';

  const trimmed = (text || '').trim();
  if (trimmed) {
    el.prompt.value = el.prompt.value
      ? `${el.prompt.value.replace(/\s+$/, '')}\n\n${trimmed}`
      : trimmed;
    el.prompt.style.height = 'auto';
    el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 120)}px`;
    added = true;
  }

  const incomingAttachments = (images || [])
    .filter(image => image?.base64)
    .map(image => ({
      id: nextImageId++,
      base64: image.base64,
      name: image.name || (image.type === 'application/pdf' ? 'document.pdf' : 'grab.png'),
      type: image.type || 'image/png',
      size: Number(image.size) || DELIVERY.estimatedDataUrlBytes(image.base64)
    }));
  if (incomingAttachments.length) {
    const validation = DELIVERY.validateAttachments([...attachedImages, ...incomingAttachments]);
    if (!validation.ok) {
      rejectionReason = attachmentErrorMessage(validation.reason);
      showStatus(rejectionReason, 'error');
    } else {
      attachedImages.push(...incomingAttachments);
      renderImages();
      added = true;
    }
  }

  if (!added) {
    return { added: false, broadcasted: false, reason: rejectionReason || 'Nothing usable was added.' };
  }
  markDraftChanged();

  if (broadcast) {
    const submission = beginComposerDelivery();
    if (submission.accepted) {
      return { added: true, broadcasted: true, reason: '', message: '' };
    }
    el.prompt.focus();
    return {
      added: true,
      broadcasted: false,
      reason: submission.reason,
      message: submission.message
    };
  }

  el.prompt.focus();
  showStatus('Pasted — press SEND to broadcast.', 'success');
  return { added: true, broadcasted: false, reason: '', message: '' };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
function attachmentErrorMessage(reason) {
  return {
    too_many_attachments: `Attach no more than ${ATTACHMENT_LIMITS.maxCount} files.`,
    attachment_too_large: 'Each attachment must be 20 MB or smaller.',
    attachment_batch_too_large: 'The combined attachment payload must be 48 MB or smaller.',
    attachment_fanout_too_large: 'This attachment set is too large to send safely to every panel. Remove or compress one or more files.',
    unsupported_attachment_type: 'Only images and PDF files are supported.',
    invalid_attachment_data: 'One attachment could not be read safely.'
  }[reason] || 'Could not attach that file.';
}

function readAttachmentFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve({
      id: nextImageId++,
      base64: event.target.result,
      name: file.name || (file.type === 'application/pdf' ? 'document.pdf' : 'image.png'),
      type: file.type || 'application/octet-stream',
      size: file.size || 0
    });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function attachmentFilesFromList(files) {
  return Array.from(files || []).filter(file =>
    file?.type === 'application/pdf' || file?.type?.startsWith('image/'));
}

function renderImages() {
  el.imageStrip.innerHTML = '';
  for (const image of attachedImages) {
    el.imageStrip.append(globalThis.AIBAttachmentUI.createChip(image));
  }
  el.composer.classList.toggle('has-attachments', attachedImages.length > 0);
}

async function loadImageFiles(files) {
  const sourceFiles = Array.from(files || []);
  if (!sourceFiles.length) return;
  const candidates = attachmentFilesFromList(sourceFiles);
  if (candidates.length !== sourceFiles.length) {
    showStatus('Only images and PDF files are supported. No files from this batch were added.', 'error');
    return;
  }

  if (attachedImages.length + candidates.length > ATTACHMENT_LIMITS.maxCount) {
    showStatus(attachmentErrorMessage('too_many_attachments'), 'error');
    return;
  }
  if (candidates.some(file => file.size > ATTACHMENT_LIMITS.maxFileBytes)) {
    showStatus(attachmentErrorMessage('attachment_too_large'), 'error');
    return;
  }
  const currentBytes = attachedImages.reduce((total, file) =>
    total + (file.size || DELIVERY.estimatedDataUrlBytes(file.base64)), 0);
  const incomingBytes = candidates.reduce((total, file) => total + (file.size || 0), 0);
  if (currentBytes + incomingBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
    showStatus(attachmentErrorMessage('attachment_batch_too_large'), 'error');
    return;
  }

  showStatus(`Loading ${candidates.length} attachment${candidates.length === 1 ? '' : 's'}…`);
  const attachments = await Promise.all(candidates.map(readAttachmentFile));
  const validation = DELIVERY.validateAttachments([...attachedImages, ...attachments]);
  if (!validation.ok) {
    showStatus(attachmentErrorMessage(validation.reason), 'error');
    return;
  }
  attachedImages.push(...attachments);
  markDraftChanged();
  el.imageInput.value = '';
  renderImages();
  const totalBytes = attachedImages.reduce((sum, image) => sum + (image.size || 0), 0);
  showStatus(`${attachedImages.length} attachment${attachedImages.length === 1 ? '' : 's'} ready · ${globalThis.AIBAttachmentUI.formatBytes(totalBytes)}.`, 'success');
}

function enqueueAttachmentFiles(files) {
  const snapshot = Array.from(files || []);
  pendingAttachmentLoads += 1;
  el.composer.setAttribute('aria-busy', 'true');
  const task = attachmentLoadQueue.then(() => loadImageFiles(snapshot));
  attachmentLoadQueue = task.catch(() => {});
  return task.finally(() => {
    pendingAttachmentLoads = Math.max(0, pendingAttachmentLoads - 1);
    if (!pendingAttachmentLoads) {
      el.composer.removeAttribute('aria-busy');
      el.imageInput.value = '';
    }
  });
}

function broadcastImages() {
  return attachedImages.map(({ base64, name, type, size }) => ({ base64, name, type, size }));
}

// ---------------------------------------------------------------------------
// Verified delivery
// ---------------------------------------------------------------------------
function panelAttempt(delivery, controller) {
  const attemptNumber = (delivery.attemptNumbers.get(controller.panelId) || 0) + 1;
  delivery.attemptNumbers.set(controller.panelId, attemptNumber);
  return {
    panelId: controller.panelId,
    panelEpoch: controller.panelEpoch,
    providerKey: controller.providerKey,
    hostname: hostOf(controller.frame.src),
    attemptId: `${delivery.deliveryId}:${controller.panelId}:${attemptNumber}`,
    isRetry: attemptNumber > 1
  };
}

function deliveryResults(delivery) {
  return delivery.expectedPanelIds
    .map(panelId => delivery.results.get(panelId))
    .filter(Boolean);
}

function deliveryIsFullyVerified(delivery) {
  return delivery.expectedPanelIds.length > 0
    && delivery.expectedPanelIds.every(panelId =>
      delivery.results.get(panelId)?.attempt?.outcome === 'verified');
}

function showDeliverySummary(delivery) {
  const results = deliveryResults(delivery);
  const expected = delivery.expectedPanelIds.map(panelId => ({ panelId }));
  const summary = DELIVERY.summarizeDelivery(results, expected);
  delivery.summary = summary;

  if (summary.outcome === 'verified') {
    showStatus(`Verified by all ${summary.verified} panels.`, 'success');
  } else if (summary.outcome === 'partial') {
    showStatus(
      `${summary.verified}/${summary.expected} verified. Failed panels remain retryable when safe.`,
      'error'
    );
  } else if (summary.outcome === 'unverified') {
    showStatus('Submission was dispatched, but provider acceptance could not be proven. Check the marked panels.', 'error');
  } else if (summary.outcome === 'no_targets') {
    showStatus('No ready panel frames were registered. Your draft was preserved.', 'error');
  } else {
    showStatus('Delivery failed before verification. Your draft was preserved.', 'error');
  }
  return summary;
}

function applyPanelResults(delivery, results) {
  for (const result of results || []) {
    if (!result?.panelId || !delivery.expectedPanelIds.includes(result.panelId)) continue;
    delivery.results.set(result.panelId, result);
    const outcome = result.attempt?.outcome || result.outcome || 'failed';
    setPanelDeliveryState(result.panelId, outcome, {
      panelEpoch: Number(result.panelEpoch),
      reason: result.attempt?.reason || result.reason,
      retry: result.attempt?.retry || result.retry,
      result
    });
  }
}

function clearDeliveredDraft(delivery) {
  if (draftRevision !== delivery.draftRevision) return false;
  if (el.prompt.value !== delivery.promptSnapshot) return false;

  el.prompt.value = '';
  el.prompt.style.height = 'auto';
  const deliveredImageIds = new Set(delivery.imageIds);
  attachedImages = attachedImages.filter(image => !deliveredImageIds.has(image.id));
  renderImages();
  markDraftChanged();
  return true;
}

async function dispatchDelivery(delivery, controllers) {
  const panelAttempts = controllers.map(controller => panelAttempt(delivery, controller));
  for (const controller of controllers) {
    setPanelDeliveryState(controller.panelId, 'preparing', { panelEpoch: controller.panelEpoch });
  }

  delivery.inFlight = true;
  let response;
  try {
    response = await sendWorkspaceMessage({
      action: 'execute',
      deliveryId: delivery.deliveryId,
      panelAttempts,
      text: delivery.text,
      images: delivery.images,
      imageBase64: delivery.images[0]?.base64 || null,
      imageName: delivery.images[0]?.name || null,
      imageType: delivery.images[0]?.type || null
    });
  } finally {
    delivery.inFlight = false;
  }

  applyPanelResults(delivery, response?.panelResults || response?.results || []);
  showDeliverySummary(delivery);
  if (deliveryIsFullyVerified(delivery)) {
    clearDeliveredDraft(delivery);
    if (activeDelivery === delivery) activeDelivery = null;
  }
  return response;
}

async function retryPanel(panelId) {
  const delivery = activeDelivery;
  const controller = panelControllers.get(panelId);
  const prior = delivery?.results.get(panelId);
  const retry = prior?.attempt?.retry || prior?.retry;
  if (!delivery || !controller || !retry?.safe || delivery.inFlight) return;

  controller.retryButton.disabled = true;
  try {
    await dispatchDelivery(delivery, [controller]);
  } catch (error) {
    setPanelDeliveryState(panelId, 'failed', {
      reason: error?.message || 'retry_failed',
      retry: { safe: false }
    });
    showStatus(`Retry failed: ${error?.message || 'unknown error'}`, 'error');
  } finally {
    controller.retryButton.disabled = false;
  }
}

function createDelivery(text, images, promptSnapshot, imageIds) {
  const controllers = [...panelControllers.values()];
  const delivery = {
    deliveryId: createId('delivery'),
    text,
    images,
    promptSnapshot,
    imageIds,
    draftRevision,
    expectedPanelIds: controllers.map(controller => controller.panelId),
    attemptNumbers: new Map(),
    results: new Map(),
    inFlight: false,
    summary: null
  };
  return { delivery, controllers };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
el.dashboard.addEventListener('click', async () => {
  el.dashboard.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getTelemetry' });
    if (!response?.ok) throw new Error(response?.reason || 'Insights unavailable');
    const ranked = (response.ranking || []).filter(item => item.attempts > 0).slice(0, 3);
    if (!ranked.length) {
      showStatus('Insights will rank providers after verified broadcasts.');
      return;
    }
    const summary = ranked.map((item, index) =>
      `${index + 1}. ${providerByKey(item.id)?.label || item.id} ${item.smartScore}`
    ).join('  ·  ');
    showStatus(`Smart rank · ${summary}`, 'success');
  } catch (error) {
    showStatus(error?.message || 'Could not load Insights.', 'error');
  } finally {
    el.dashboard.disabled = false;
  }
});

el.focusMode.addEventListener('click', () => {
  focusModeEnabled = !focusModeEnabled;
  renderFocusMode();
});

function snapSplit(value) {
  const clamped = Math.min(0.72, Math.max(0.28, value));
  for (const point of [1 / 3, 0.5, 2 / 3]) {
    if (Math.abs(clamped - point) <= 0.035) return point;
  }
  return clamped;
}

function startSplitDrag(axis, event) {
  if (count !== 4 || event.button !== 0) return;
  event.preventDefault();
  const handle = axis === 'x' ? el.splitX : axis === 'y' ? el.splitY : el.splitNode;
  handle.setPointerCapture?.(event.pointerId);
  document.documentElement.classList.add('is-resizing');

  const move = moveEvent => {
    const rect = el.gridShell.getBoundingClientRect();
    if (axis !== 'y') splitX = Math.min(0.72, Math.max(0.28, (moveEvent.clientX - rect.left) / rect.width));
    if (axis !== 'x') splitY = Math.min(0.72, Math.max(0.28, (moveEvent.clientY - rect.top) / rect.height));
    applyGridSplit();
  };
  const end = endEvent => {
    handle.releasePointerCapture?.(endEvent.pointerId);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    document.documentElement.classList.remove('is-resizing');
    if (axis !== 'y') splitX = snapSplit(splitX);
    if (axis !== 'x') splitY = snapSplit(splitY);
    flushGridSplit();
    saveWorkspaceLayout().catch(() => {});
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function adjustSplitFromKeyboard(axis, event) {
  if (count !== 4) return;
  const direction = axis === 'x'
    ? { ArrowLeft: -1, ArrowRight: 1 }
    : { ArrowUp: -1, ArrowDown: 1 };
  let next = axis === 'x' ? splitX : splitY;
  if (event.key === 'Home') next = 0.28;
  else if (event.key === 'End') next = 0.72;
  else if (direction[event.key]) next += direction[event.key] * (event.shiftKey ? 0.05 : 0.02);
  else return;

  event.preventDefault();
  next = Math.min(0.72, Math.max(0.28, next));
  if (axis === 'x') splitX = next;
  else splitY = next;
  flushGridSplit();
  saveWorkspaceLayout().catch(() => {});
}

el.splitX.addEventListener('pointerdown', event => startSplitDrag('x', event));
el.splitY.addEventListener('pointerdown', event => startSplitDrag('y', event));
el.splitNode.addEventListener('pointerdown', event => startSplitDrag('both', event));
el.splitX.addEventListener('keydown', event => adjustSplitFromKeyboard('x', event));
el.splitY.addEventListener('keydown', event => adjustSplitFromKeyboard('y', event));
el.splitNode.addEventListener('dblclick', () => {
  splitX = 0.5;
  splitY = 0.5;
  flushGridSplit();
  saveWorkspaceLayout().catch(() => {});
});

let titleSaveTimer = null;
el.title.addEventListener('input', () => {
  applyWorkspaceTitle(el.title.value, false);
  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(() => saveWorkspaceTitle().catch(() => {}), 300);
});
el.title.addEventListener('change', () => saveWorkspaceTitle().catch(() => {}));
el.title.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveWorkspaceTitle().catch(() => {});
    el.title.blur();
  }
});

el.newWorkspace.addEventListener('click', async () => {
  el.newWorkspace.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'openWorkspace', count });
    if (!response?.ok) throw new Error(response?.reason || 'Could not open workspace');
    showStatus('Opened another independent workspace.', 'success');
  } catch (err) {
    showStatus(`Could not open workspace: ${err?.message || 'unknown error'}`, 'error');
  } finally {
    el.newWorkspace.disabled = false;
  }
});

el.panelCount.addEventListener('click', async event => {
  const btn = event.target.closest('button[data-count]');
  if (!btn) return;
  const next = Number(btn.dataset.count);
  if (next === count) return;
  if (guardDeliverySensitiveChange('changing the grid')) return;
  const previousCount = count;
  const previousKeys = [...selectedKeys];
  setCount(next);
  showStatus('Preparing panels…');
  if (!await prepareFrames(selectedKeys.slice(0, count).flatMap(originsForKey))) {
    count = previousCount;
    selectedKeys = previousKeys;
    renderCountButtons();
    return;
  }
  saveWorkspaceState().catch(() => {});
  if (await renderGrid()) showStatus('');
});

el.attachBtn.addEventListener('click', () => el.imageInput.click());

let composerDragDepth = 0;
el.composer.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  composerDragDepth += 1;
  el.composer.classList.add('is-dragover');
});
el.composer.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
el.composer.addEventListener('dragleave', () => {
  composerDragDepth = Math.max(0, composerDragDepth - 1);
  if (!composerDragDepth) el.composer.classList.remove('is-dragover');
});
el.composer.addEventListener('drop', event => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  composerDragDepth = 0;
  el.composer.classList.remove('is-dragover');
  enqueueAttachmentFiles(event.dataTransfer.files).catch(() => showStatus('Could not load attachment.', 'error'));
});

el.imageInput.addEventListener('change', e => {
  enqueueAttachmentFiles(e.target.files).catch(() => showStatus('Could not load attachment.', 'error'));
});

document.addEventListener('paste', e => {
  if (!e.clipboardData?.files?.length) return;
  enqueueAttachmentFiles(e.clipboardData.files).catch(() => {});
});

el.imageStrip.addEventListener('click', event => {
  const btn = event.target.closest('button[data-image-id]');
  if (!btn) return;
  attachedImages = attachedImages.filter(img => img.id !== Number(btn.dataset.imageId));
  markDraftChanged();
  renderImages();
});

el.prompt.addEventListener('input', () => {
  markDraftChanged();
  el.prompt.style.height = 'auto';
  el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 120)}px`;
});

el.prompt.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  el.composer.requestSubmit();
});

el.composer.addEventListener('submit', event => {
  event.preventDefault();
  beginComposerDelivery();
});

// ---------------------------------------------------------------------------
// Init — seed panels from the popup's selection, else defaults.
// ---------------------------------------------------------------------------
async function init() {
  const claim = await chrome.runtime.sendMessage({ action: 'claimWorkspace' }).catch(() => null);
  workspaceTabId = Number.isInteger(claim?.tabId) ? claim.tabId : null;
  await loadWorkspaceTitle();
  await loadWorkspaceLayout();
  const hasSavedState = await loadWorkspaceState();

  let seed = null;
  try {
    const stored = await chrome.storage.local.get('aib_workspace_seed');
    seed = stored?.aib_workspace_seed || null;
  } catch {}

  if (!hasSavedState && seed && Array.isArray(seed.panels) && seed.panels.length) {
    count = PANEL_COUNTS.includes(seed.count) ? seed.count : Math.min(Math.max(seed.panels.length, 2), 6);
    selectedKeys = seed.panels.map(p => keyFromUrl(typeof p === 'string' ? p : p?.url)).filter(Boolean);
  }

  const requestedCount = Number(WORKSPACE_PARAMS.get('count'));
  if (!hasSavedState && PANEL_COUNTS.includes(requestedCount)) count = requestedCount;

  if (selectedKeys.length < count) {
    const seedKeys = DEFAULT_PANEL_URLS.map(keyFromUrl).filter(Boolean);
    const filler = seedKeys.length >= count ? seedKeys : randomKeys(count);
    while (selectedKeys.length < count) selectedKeys.push(filler[selectedKeys.length] || randomKeys(1)[0]);
  }
  selectedKeys = selectedKeys.slice(0, count);

  // Arm frame rules and clear selected-provider caches before iframe navigation.
  renderCountButtons();
  showStatus('Preparing panels…');
  if (!await prepareFrames(selectedKeys.slice(0, count).flatMap(originsForKey))) {
    el.prompt.focus();
    return;
  }
  saveWorkspaceState().catch(() => {});
  if (await renderGrid()) showStatus('');
  el.prompt.focus();
}

init();
