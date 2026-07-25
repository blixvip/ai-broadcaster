'use strict';

importScripts('delivery-protocol.js', 'telemetry.js', 'providers.js');

const AI_HOSTS = new Set(globalThis.AIB_AI_HOSTS || []);
const WORKSPACE_URL = chrome.runtime.getURL('workspace.html');
const WORKSPACE_TABS_KEY = 'aib_workspace_tab_ids';
const LEGACY_WORKSPACE_TAB_KEY = 'aib_workspace_tab_id';
const STATIC_FRAME_RULESET_ID = 'ai_frame_rules';
const FRAME_RULE_IDS = [9101, 9102];
const FRAME_DOMAINS = [...AI_HOSTS];

const workspaceTabIds = new Set();
let lastWorkspaceTabId = null;

const workspacesReady = chrome.storage.session
  .get([WORKSPACE_TABS_KEY, LEGACY_WORKSPACE_TAB_KEY])
  .then(stored => {
    const saved = stored[WORKSPACE_TABS_KEY];
    if (Array.isArray(saved)) {
      for (const tabId of saved) if (Number.isInteger(tabId)) workspaceTabIds.add(tabId);
    }
    const legacy = stored[LEGACY_WORKSPACE_TAB_KEY];
    if (Number.isInteger(legacy)) workspaceTabIds.add(legacy);
    lastWorkspaceTabId = [...workspaceTabIds].at(-1) ?? null;
  })
  .catch(() => {});
let workspaceRegistryQueue = Promise.resolve();
let telemetryQueue = Promise.resolve();

function mutateTelemetry(mutator) {
  const task = telemetryQueue.catch(() => {}).then(async () => {
    const key = globalThis.AIBTelemetry.STORAGE_KEY;
    const stored = await chrome.storage.local.get(key);
    const initial = globalThis.AIBTelemetry.normalizeSnapshot(stored[key]);
    const result = mutator(initial) || { snapshot: initial, recorded: false };
    if (result.recorded !== false) await chrome.storage.local.set({ [key]: result.snapshot });
    return result;
  });
  telemetryQueue = task;
  return task;
}

function recordAttemptTelemetry(panelResults) {
  return mutateTelemetry(initial => {
    let snapshot = initial;
    let recorded = false;
    for (const result of panelResults || []) {
      const attempt = result?.attempt || result || {};
      const diagnostics = attempt.diagnostics || {};
      const applied = globalThis.AIBTelemetry.applyAttempt(snapshot, {
        attemptId: attempt.attemptId,
        providerKey: result?.frame?.providerKey || attempt.providerKey || result?.providerKey,
        hostname: attempt.hostname || result?.hostname,
        outcome: attempt.outcome || result?.outcome,
        reason: attempt.reason || result?.reason,
        actionKind: attempt.action?.kind || 'none',
        isRetry: attempt.isRetry === true,
        acceptanceMs: attempt.timings?.totalMs,
        inputReadyMs: attempt.timings?.inputReadyMs,
        inputSelector: diagnostics.inputSelection?.selector,
        submitSelector: diagnostics.submitSelection?.selector,
        recordedAt: Date.now()
      });
      snapshot = applied.snapshot;
      recorded = recorded || applied.recorded;
    }
    return { snapshot, recorded };
  });
}

function recordResponseTelemetry(event) {
  return mutateTelemetry(snapshot => globalThis.AIBTelemetry.applyResponseComplete(snapshot, event));
}

// Build the hostname → timeout-tier map from the provider registry. Broadcasts
// remain concurrent; the tier tells content.js how long a provider may need.
const HOST_GROUP = new Map();
for (const provider of globalThis.AIB_PROVIDERS || []) {
  const group = provider.group || 'B';
  for (const host of provider.domains || [provider.domain]) {
    HOST_GROUP.set(host, group);
  }
}

function groupForHostname(hostname) {
  return HOST_GROUP.get(hostname) || 'B';
}

async function ensureStaticFrameRuleset() {
  if (!chrome.declarativeNetRequest.updateEnabledRulesets) return;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [STATIC_FRAME_RULESET_ID]
    });
  } catch {}
}

let frameRulesPromise = null;

async function installFrameRules() {
  if (!FRAME_DOMAINS.length) return;

  // Do not tear down working global rules every time another workspace opens.
  // Removing and re-adding them creates a brief gap where a second workspace's
  // subframes can receive their original anti-embed headers.
  if (chrome.declarativeNetRequest.getDynamicRules) {
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      if (FRAME_RULE_IDS.every(id => existing.some(rule => rule.id === id))) return;
    } catch {}
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: FRAME_RULE_IDS
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id: FRAME_RULE_IDS[0],
        priority: 100,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
            { header: 'content-security-policy-report-only', operation: 'remove' },
            { header: 'cross-origin-opener-policy', operation: 'remove' },
            { header: 'cross-origin-embedder-policy', operation: 'remove' },
            { header: 'cross-origin-resource-policy', operation: 'remove' }
          ]
        },
        condition: {
          requestDomains: FRAME_DOMAINS,
          resourceTypes: ['sub_frame']
        }
      }
    ]
  });

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: FRAME_RULE_IDS[1],
          priority: 100,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Sec-Fetch-Dest', operation: 'remove' },
              { header: 'Sec-Fetch-Mode', operation: 'remove' },
              { header: 'Sec-Fetch-Site', operation: 'remove' }
            ]
          },
          condition: {
            requestDomains: FRAME_DOMAINS,
            resourceTypes: ['sub_frame']
          }
        }
      ]
    });
  } catch {}
}

async function ensureFrameRules() {
  if (frameRulesPromise) return frameRulesPromise;
  const task = installFrameRules();
  frameRulesPromise = task;
  try {
    await task;
  } finally {
    if (frameRulesPromise === task) frameRulesPromise = null;
  }
}

async function repairFrameEmbedding() {
  await ensureStaticFrameRuleset();
  await ensureFrameRules();
}

let framePreparationQueue = Promise.resolve();

function prepareFrames(origins = []) {
  const task = framePreparationQueue.catch(() => {}).then(async () => {
    await ensureStaticFrameRuleset();
    await ensureFrameRules();
    if (origins.length) {
      await chrome.browsingData.remove(
        { origins: [...new Set(origins)] },
        { cache: true, cacheStorage: true, serviceWorkers: true }
      );
    }
  });
  framePreparationQueue = task;
  return task;
}

ensureFrameRules().catch(() => {});

function isWorkspaceUrl(value) {
  try {
    const candidate = new URL(value);
    const workspace = new URL(WORKSPACE_URL);
    return candidate.origin === workspace.origin && candidate.pathname === workspace.pathname;
  } catch {
    return String(value || '').startsWith(WORKSPACE_URL);
  }
}

async function openWorkspaceTab(options = {}) {
  // Every request creates a distinct workspace. The instance id keeps its title
  // stable across reloads/browser restore without coupling it to a Chrome tab id.
  const instanceId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = new URL(WORKSPACE_URL);
  url.searchParams.set('id', instanceId);
  const panelCount = Number(options.count);
  if ([2, 3, 4, 5, 6].includes(panelCount)) url.searchParams.set('count', String(panelCount));

  const tab = await chrome.tabs.create({ url: url.href, active: options.active !== false });
  if (Number.isInteger(tab.id)) await rememberWorkspaceTab(tab.id);
  if (options.active !== false) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  }
  return { windowId: tab.windowId, tabId: tab.id, instanceId, reused: false };
}

// Resolve the workspace tab, opening one in the BACKGROUND (no focus steal) if
// none exists. Used by the hotkey grab so pressing it always has a destination.
async function ensureWorkspaceTabId() {
  const existing = await findWorkspaceTabId();
  if (Number.isInteger(existing)) {
    try { await chrome.tabs.get(existing); return existing; }
    catch { await forgetWorkspaceTab(existing); }
  }
  const created = await openWorkspaceTab({ active: false });
  return created.tabId;
}

// Deliver a composer payload to the workspace's top frame, retrying while a
// freshly-opened workspace boots up its scripts.
async function pushToWorkspace(payload, broadcast = false) {
  const tabId = await ensureWorkspaceTabId();
  if (!Number.isInteger(tabId)) throw new Error('no_workspace');
  let lastErr = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const resp = await chrome.tabs.sendMessage(
        tabId, { action: 'compose-add', broadcast, ...payload }, { frameId: 0 });
      return { tabId, added: resp?.added ?? true };
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error('workspace_unreachable');
}

// ---------------------------------------------------------------------------
// Grab hotkey — a browser-level chrome.commands shortcut that fires regardless
// of focused frame. Clipboard data wins; when it is empty, grab.js supplies a
// hovered image, selection, or nearby semantic text block from the active page.
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) {
    try { return await chrome.offscreen.hasDocument(); } catch {}
  }
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  } catch { return false; }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['CLIPBOARD'],
    justification: 'Read an image or text from the clipboard for the grab hotkey.'
  });
  try { await creatingOffscreen; } catch {} finally { creatingOffscreen = null; }
}

async function readClipboardViaOffscreen() {
  try {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ target: 'offscreen', action: 'read-clipboard' });
  } catch { return null; }
}

function clipboardToImage(dataUrl) {
  const type = (/^data:([^;,]+)/.exec(dataUrl)?.[1]) || 'image/png';
  const ext = (type.split('/')[1] || 'png').split('+')[0];
  return { base64: dataUrl, name: `clipboard.${ext}`, type };
}

function toastActiveTab(tabId, msg, isErr = false) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, { action: 'toast', msg, isErr }, { frameId: 0 }).catch(() => {});
}

async function handleGrabCommand(broadcast) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = tab?.id;

  let payload = null;
  let kind = '';

  // 1) Clipboard first — this is a "paste": whatever you copied wins. Works from
  //    anywhere, including Google Slides/Docs (offscreen execCommand paste).
  const cb = await readClipboardViaOffscreen();
  if (cb?.image) { payload = { images: [clipboardToImage(cb.image)] }; kind = 'Image'; }
  else if (cb?.text && cb.text.trim()) { payload = { text: cb.text.trim().slice(0, 8000) }; kind = 'Text'; }

  // 2) Fallback when the clipboard is empty — hovered image / selection / block.
  if (!payload && Number.isInteger(tabId)) {
    let hover = {};
    try { hover = await chrome.tabs.sendMessage(tabId, { action: 'grab-hover' }, { frameId: 0 }) || {}; }
    catch { hover = {}; }
    if (hover.images?.length) { payload = { images: hover.images }; kind = 'Image'; }
    else if (hover.selection) { payload = { text: hover.selection }; kind = 'Text'; }
    else if (hover.block) { payload = { text: hover.block }; kind = 'Text'; }
  }

  if (!payload) { toastActiveTab(tabId, 'Nothing to paste — copy something first', true); return; }

  try {
    await pushToWorkspace(payload, broadcast);
    toastActiveTab(tabId, broadcast ? `${kind} → broadcasting ✓` : `${kind} → composer ✓`);
  } catch (err) {
    toastActiveTab(tabId, 'Broadcaster not reachable', true);
  }
}

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(command => {
    if (command === 'grab-to-composer') handleGrabCommand(false).catch(() => {});
    else if (command === 'grab-and-broadcast') handleGrabCommand(true).catch(() => {});
  });
}

async function rememberWorkspaceTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await workspacesReady;
  const task = workspaceRegistryQueue.catch(() => {}).then(async () => {
    workspaceTabIds.add(tabId);
    lastWorkspaceTabId = tabId;
    await chrome.storage.session.set({
      [WORKSPACE_TABS_KEY]: [...workspaceTabIds]
    });
  });
  workspaceRegistryQueue = task;
  await task;
}

async function forgetWorkspaceTab(tabId = null) {
  await workspacesReady;
  const task = workspaceRegistryQueue.catch(() => {}).then(async () => {
    if (Number.isInteger(tabId)) workspaceTabIds.delete(tabId);
    else workspaceTabIds.clear();
    if (lastWorkspaceTabId === tabId || !workspaceTabIds.has(lastWorkspaceTabId)) {
      lastWorkspaceTabId = [...workspaceTabIds].at(-1) ?? null;
    }
    await chrome.storage.session.set({ [WORKSPACE_TABS_KEY]: [...workspaceTabIds] });
    await chrome.storage.session.remove(LEGACY_WORKSPACE_TAB_KEY);
  });
  workspaceRegistryQueue = task;
  await task;
}

async function claimWorkspaceTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const tab = await chrome.tabs.get(tabId);
  if (!isWorkspaceUrl(tab.url || tab.pendingUrl || '')) return null;
  await rememberWorkspaceTab(tab.id);
  return { windowId: tab.windowId, tabId: tab.id };
}

async function isWorkspaceTabId(tabId) {
  if (!Number.isInteger(tabId)) return false;
  await workspacesReady;
  if (workspaceTabIds.has(tabId)) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isWorkspaceUrl(tab.url || tab.pendingUrl || '')) return false;
    await rememberWorkspaceTab(tabId);
    return true;
  } catch {
    return false;
  }
}

let frameRegistryQueue = Promise.resolve();

function mutateFrameRegistry(mutator) {
  const task = frameRegistryQueue.catch(() => {}).then(async () => {
    const { reg = {} } = await chrome.storage.session.get('reg');
    mutator(reg);
    await chrome.storage.session.set({ reg });
  });
  frameRegistryQueue = task;
  return task;
}

function saveFrame(frame) {
  return mutateFrameRegistry(reg => {
    const key = `${frame.tabId}:${frame.frameId}`;
    const previous = reg[key] || {};
    reg[key] = {
      ...previous,
      ...frame,
      panelId: frame.panelId || previous.panelId || null,
      panelEpoch: frame.panelEpoch || previous.panelEpoch || null,
      providerKey: frame.providerKey || previous.providerKey || null,
      registeredAt: Date.now()
    };
  });
}

function dropTab(tabId) {
  return mutateFrameRegistry(reg => {
    for (const k of Object.keys(reg)) {
      if (reg[k].tabId === tabId) delete reg[k];
    }
  });
}

function dropFrame(tabId, frameId) {
  return mutateFrameRegistry(reg => {
    delete reg[`${tabId}:${frameId}`];
  });
}

async function allFrames() {
  await frameRegistryQueue.catch(() => {});
  const { reg = {} } = await chrome.storage.session.get('reg');
  return Object.values(reg);
}

async function directWorkspaceFrame(sender, message) {
  const hostname = message?.hostname;
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (!Number.isInteger(tabId) || frameId === 0 || !AI_HOSTS.has(hostname)) return null;
  if (!await isWorkspaceTabId(tabId)) return null;

  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (!frame || frame.parentFrameId !== 0) return null;
    const panelId = typeof message.panelId === 'string' && message.panelId
      ? message.panelId.slice(0, 160)
      : null;
    const panelEpoch = Number(message.panelEpoch);
    const providerKey = typeof message.providerKey === 'string' && message.providerKey
      ? message.providerKey.slice(0, 80)
      : null;
    return {
      tabId,
      frameId,
      documentId: sender.documentId || null,
      hostname,
      panelId,
      panelEpoch: Number.isInteger(panelEpoch) && panelEpoch > 0 ? panelEpoch : null,
      providerKey
    };
  } catch {
    return null;
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  dropTab(tabId).catch(() => {});
  for (const key of panelFrameHost.keys()) {
    if (key.startsWith(`${tabId}:`)) panelFrameHost.delete(key);
  }
  forgetWorkspaceTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isWorkspaceUrl(changeInfo.url || tab?.url || tab?.pendingUrl || '')) return;
  claimWorkspaceTab(tabId).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  isWorkspaceTabId(tabId).then(isWorkspace => {
    if (isWorkspace) rememberWorkspaceTab(tabId).catch(() => {});
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Embedded-auth guard — direct panel frames cannot reliably complete many OAuth
// flows. When one leaves its provider for an auth host, reset that panel to its
// provider home instead of leaving a permanently blocked login frame.
// ---------------------------------------------------------------------------

const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)login\.microsoft\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)workos\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)clerk\.[a-z.]+$/i,
  /(^|\.)auth\.[a-z0-9-]+\.[a-z.]+$/i,
  /(^|\.)oauth\.[a-z0-9-]+\.[a-z.]+$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i
];

const AUTH_PATH_PATTERN = /\/(login|signin|sign-in|signup|sign-up|register|oauth|oauth2|authorize|sso|saml)(\/|\?|#|$)/i;

const panelFrameHost = new Map(); // `${tabId}:${frameId}` -> current provider hostname

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isAuthUrl(url, panelHost) {
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname;
  if (AUTH_HOST_PATTERNS.some(re => re.test(host))) {
    // Same-host "auth" (in-app route on the AI's own domain) is left in-frame.
    return host !== panelHost;
  }
  return AUTH_PATH_PATTERN.test(u.pathname);
}

function providerUrlForHost(host) {
  for (const provider of globalThis.AIB_PROVIDERS || []) {
    if ((provider.domains || [provider.domain]).includes(host)) return provider.url;
  }
  return host ? `https://${host}/` : null;
}

function messageWorkspaceTop(tabId, payload) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }).catch(() => {});
}

function resetAuthNavigation(tabId, panelHost, authUrl) {
  const providerUrl = providerUrlForHost(panelHost) || authUrl;
  messageWorkspaceTop(tabId, {
    action: 'authResetPanel',
    host: panelHost,
    url: providerUrl
  });
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, parentFrameId, url }) => {
  if (frameId === 0 || parentFrameId !== 0) return;
  isWorkspaceTabId(tabId).then(isWorkspace => {
    if (!isWorkspace) return;
    const hostname = hostOf(url);
    panelFrameHost.set(`${tabId}:${frameId}`, hostname);
    if (!AI_HOSTS.has(hostname)) dropFrame(tabId, frameId).catch(() => {});
  }).catch(() => {});
});

chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  const { tabId, frameId, parentFrameId, url } = details;
  if (frameId === 0 || parentFrameId !== 0) return;  // only direct panel frames

  if (!await isWorkspaceTabId(tabId)) return;

  const panelHost = panelFrameHost.get(`${tabId}:${frameId}`) || '';
  if (!isAuthUrl(url, panelHost)) return;

  resetAuthNavigation(tabId, panelHost, url);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderWorkspaceId = isWorkspaceUrl(sender.tab?.url || sender.tab?.pendingUrl || '')
    ? sender.tab.id
    : null;
  const requestedWorkspaceId = Number.isInteger(msg.workspaceTabId) ? msg.workspaceTabId : null;
  const scopedWorkspaceId = senderWorkspaceId || requestedWorkspaceId;

  if (msg.action === 'register') {
    directWorkspaceFrame(sender, msg)
      .then(async frame => {
        if (!frame) return false;
        await saveFrame(frame);
        return true;
      })
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'panelAlive') {
    directWorkspaceFrame(sender, msg)
      .then(frame => {
        if (!frame) return false;
        messageWorkspaceTop(frame.tabId, {
          action: 'panelAlive',
          host: frame.hostname,
          frameId: frame.frameId,
          panelId: frame.panelId,
          panelEpoch: frame.panelEpoch,
          providerKey: frame.providerKey
        });
        return true;
      })
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'deliveryLifecycle') {
    directWorkspaceFrame(sender, msg)
      .then(frame => {
        if (!frame) return false;
        messageWorkspaceTop(frame.tabId, {
          action: 'deliveryLifecycle',
          protocolVersion: globalThis.AIBDeliveryProtocol.VERSION,
          deliveryId: String(msg.deliveryId || ''),
          attemptId: String(msg.attemptId || ''),
          panelId: frame.panelId || String(msg.panelId || ''),
          panelEpoch: frame.panelEpoch || Number(msg.panelEpoch) || null,
          hostname: frame.hostname,
          state: String(msg.state || ''),
          atMs: Number(msg.atMs) || 0,
          details: msg.details && typeof msg.details === 'object' ? msg.details : {}
        });
        return true;
      })
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'telemetryResponseComplete') {
    directWorkspaceFrame(sender, msg)
      .then(frame => {
        if (!frame) return { recorded: false };
        return recordResponseTelemetry({
          attemptId: String(msg.attemptId || ''),
          providerKey: frame.providerKey || String(msg.providerKey || ''),
          hostname: frame.hostname,
          responseMs: Number(msg.responseMs) || 0
        });
      })
      .then(result => sendResponse({ ok: !!result?.recorded }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'getTelemetry') {
    telemetryQueue.catch(() => {}).then(async () => {
      const key = globalThis.AIBTelemetry.STORAGE_KEY;
      const stored = await chrome.storage.local.get(key);
      const snapshot = globalThis.AIBTelemetry.normalizeSnapshot(stored[key]);
      sendResponse({
        ok: true,
        snapshot: globalThis.AIBTelemetry.publicSnapshot(snapshot),
        ranking: globalThis.AIBTelemetry.rankProviders(snapshot)
      });
    }).catch(error => sendResponse({ ok: false, reason: error?.message || 'telemetry_read_failed' }));
    return true;
  }

  if (msg.action === 'resetTelemetry') {
    const snapshot = globalThis.AIBTelemetry.emptySnapshot();
    const key = globalThis.AIBTelemetry.STORAGE_KEY;
    const task = telemetryQueue.catch(() => {}).then(() => chrome.storage.local.set({ [key]: snapshot }));
    telemetryQueue = task;
    task.then(() => sendResponse({ ok: true })).catch(error =>
      sendResponse({ ok: false, reason: error?.message || 'telemetry_reset_failed' }));
    return true;
  }

  if (msg.action === 'ensureFrameRules') {
    repairFrameEmbedding()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'frame_rules_failed' }));
    return true;
  }

  if (msg.action === 'prepareFrames') {
    prepareFrames(Array.isArray(msg.origins) ? msg.origins.filter(Boolean) : [])
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'prepare_failed' }));
    return true;
  }

  if (msg.action === 'openWorkspace') {
    openWorkspaceTab({ count: msg.count })
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'workspace_open_failed' }));
    return true;
  }

  if (msg.action === 'claimWorkspace') {
    claimWorkspaceTab(senderWorkspaceId || msg.tabId)
      .then(result => sendResponse({ ok: !!result, ...result }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'workspace_claim_failed' }));
    return true;
  }

  if (msg.action !== 'execute') return false;
  const { text, imageBase64, imageName, imageType } = msg;
  let images;
  try {
    images = normalizeImages(msg.images, imageBase64, imageName, imageType);
  } catch (error) {
    sendResponse({
      protocolVersion: globalThis.AIBDeliveryProtocol.VERSION,
      outcome: 'failed',
      count: 0,
      sent: false,
      frames: 0,
      results: [],
      panelResults: [],
      reason: error?.message || 'invalid_attachment_payload'
    });
    return false;
  }
  (async () => {
    const targetWorkspaceId = scopedWorkspaceId || await findWorkspaceTabId();
    return broadcast(text, images, targetWorkspaceId, {
      deliveryId: msg.deliveryId,
      panelAttempts: msg.panelAttempts
    });
  })()
    .then(sendResponse)
    .catch(err => sendResponse({
      count: 0,
      sent: false,
      frames: 0,
      results: [],
      reason: err?.message || 'broadcast_failed'
    }));
  return true;
});

function normalizeImages(images, imageBase64, imageName, imageType) {
  const normalized = Array.isArray(images)
    ? images
      .filter(image => image?.base64)
      .map(image => ({
        base64: image.base64,
        name: image.name || (image.type === 'application/pdf' ? 'document.pdf' : 'image.png'),
        type: image.type || 'image/png',
        size: Number(image.size) || globalThis.AIBDeliveryProtocol.estimatedDataUrlBytes(image.base64)
      }))
    : imageBase64
      ? [{
        base64: imageBase64,
        name: imageName || (imageType === 'application/pdf' ? 'document.pdf' : 'image.png'),
        type: imageType || 'image/png',
        size: globalThis.AIBDeliveryProtocol.estimatedDataUrlBytes(imageBase64)
      }]
      : [];

  const validation = globalThis.AIBDeliveryProtocol.validateAttachments(normalized);
  if (!validation.ok) throw new Error(validation.reason);
  return normalized;
}

function firstImageFields(images) {
  const first = images[0] || {};
  return {
    imageBase64: first.base64 || null,
    imageName: first.name || null,
    imageType: first.type || null
  };
}

function sanitizePanelAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const panelId = typeof item?.panelId === 'string' ? item.panelId.slice(0, 160) : '';
    const panelEpoch = Number(item?.panelEpoch);
    const attemptId = typeof item?.attemptId === 'string' ? item.attemptId.slice(0, 220) : '';
    if (!panelId || !Number.isInteger(panelEpoch) || panelEpoch < 1 || !attemptId) return [];
    return [{
      panelId,
      panelEpoch,
      providerKey: typeof item.providerKey === 'string' ? item.providerKey.slice(0, 80) : '',
      hostname: typeof item.hostname === 'string' ? item.hostname.slice(0, 255) : '',
      attemptId,
      isRetry: item.isRetry === true
    }];
  });
}

function createDeliveryId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function addTarget(targets, target) {
  if (!Number.isInteger(target?.tabId) || !Number.isInteger(target?.frameId) || !target.hostname) {
    return;
  }
  targets.set(`${target.tabId}:${target.frameId}`, {
    tabId: target.tabId,
    frameId: target.frameId,
    documentId: target.documentId || null,
    hostname: target.hostname,
    panelId: target.panelId || null,
    panelEpoch: target.panelEpoch || null,
    providerKey: target.providerKey || null
  });
}

async function registeredFrameTargets(scopedTabId) {
  return (await allFrames())
    .filter(frame => scopedTabId == null || frame.tabId === scopedTabId)
    .filter(frame => AI_HOSTS.has(frame.hostname));
}

async function discoverTargets(scopedTabId) {
  if (!Number.isInteger(scopedTabId)) return [];
  const targets = new Map();
  for (const target of await registeredFrameTargets(scopedTabId)) addTarget(targets, target);
  return [...targets.values()].sort((a, b) => a.tabId - b.tabId || a.frameId - b.frameId);
}

async function findWorkspaceTabId() {
  await workspacesReady;

  // Prefer the most recently focused workspace, then any other live one.
  const candidates = [lastWorkspaceTabId, ...[...workspaceTabIds].reverse()]
    .filter((tabId, index, all) => Number.isInteger(tabId) && all.indexOf(tabId) === index);
  for (const tabId of candidates) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isWorkspaceUrl(tab.url || tab.pendingUrl || '')) {
        await rememberWorkspaceTab(tabId);
        return tabId;
      }
    } catch {}
    workspaceTabIds.delete(tabId);
  }

  // Recover workspace tabs after service-worker/browser restoration even if
  // session bookkeeping was lost.
  try {
    const tabs = await chrome.tabs.query({});
    const live = tabs.filter(tab => Number.isInteger(tab.id) && isWorkspaceUrl(tab.url || tab.pendingUrl || ''));
    for (const tab of live) workspaceTabIds.add(tab.id);
    const picked = live.find(tab => tab.active)?.id ?? live.at(-1)?.id ?? null;
    if (Number.isInteger(picked)) {
      await rememberWorkspaceTab(picked);
      return picked;
    }
  } catch {}

  await chrome.storage.session.set({ [WORKSPACE_TABS_KEY]: [...workspaceTabIds] });
  lastWorkspaceTabId = null;
  return null;
}

async function sendToTarget(target, payload) {
  const startedAt = Date.now();
  try {
    const response = await chrome.tabs.sendMessage(target.tabId, payload, { frameId: target.frameId });
    const attempt = {
      protocolVersion: globalThis.AIBDeliveryProtocol.VERSION,
      deliveryId: payload.deliveryId,
      attemptId: payload.attemptId,
      panelId: payload.panelId || target.panelId || '',
      panelEpoch: payload.panelEpoch || target.panelEpoch || null,
      providerKey: payload.providerKey || target.providerKey || '',
      isRetry: payload.isRetry === true,
      hostname: response?.hostname || target.hostname,
      ...response
    };
    return {
      panelId: attempt.panelId,
      panelEpoch: attempt.panelEpoch,
      hostname: attempt.hostname,
      ok: attempt.outcome === 'verified',
      outcome: attempt.outcome || 'failed',
      reason: attempt.reason || '',
      retry: attempt.retry || { safe: false, reason: 'frame_state_unknown' },
      frame: { ...target },
      transport: {
        ok: true,
        durationMs: Date.now() - startedAt,
        error: null
      },
      attempt
    };
  } catch (error) {
    await dropFrame(target.tabId, target.frameId);
    const reason = error?.message || 'unreachable';
    const attempt = {
      protocolVersion: globalThis.AIBDeliveryProtocol.VERSION,
      deliveryId: payload.deliveryId,
      attemptId: payload.attemptId,
      panelId: payload.panelId || target.panelId || '',
      panelEpoch: payload.panelEpoch || target.panelEpoch || null,
      providerKey: payload.providerKey || target.providerKey || '',
      isRetry: payload.isRetry === true,
      hostname: target.hostname,
      ok: false,
      outcome: 'failed',
      confidence: 'none',
      reason,
      retry: { safe: false, reason: 'transport_lost_after_dispatch_unknown' }
    };
    return {
      panelId: attempt.panelId,
      panelEpoch: attempt.panelEpoch,
      hostname: target.hostname,
      ok: false,
      outcome: 'failed',
      reason,
      retry: attempt.retry,
      frame: { ...target },
      transport: {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: reason
      },
      attempt
    };
  }
}

function missingPanelResult(deliveryId, panel) {
  const attempt = {
    protocolVersion: globalThis.AIBDeliveryProtocol.VERSION,
    deliveryId,
    attemptId: panel.attemptId,
    isRetry: panel.isRetry === true,
    panelId: panel.panelId,
    panelEpoch: panel.panelEpoch,
    providerKey: panel.providerKey || '',
    hostname: panel.hostname || '',
    ok: false,
    outcome: 'failed',
    confidence: 'none',
    reason: 'no_registered_frame',
    action: { kind: null, dispatched: false, atMs: null, control: null },
    retry: { safe: true, reason: 'no_submit_action_dispatched' },
    evidence: [],
    lifecycle: [],
    timings: {}
  };
  return {
    panelId: panel.panelId,
    panelEpoch: panel.panelEpoch,
    providerKey: panel.providerKey || '',
    hostname: panel.hostname || '',
    ok: false,
    outcome: 'failed',
    reason: 'no_registered_frame',
    retry: attempt.retry,
    frame: null,
    transport: { ok: false, durationMs: 0, error: 'no_registered_frame' },
    attempt
  };
}

// Broadcast to each requested logical panel exactly once. Workspace requests use
// stable panel IDs; popup requests without panel metadata target every registered
// direct frame in the selected workspace.
async function broadcast(text, images, targetTabId, options = {}) {
  const scopedTabId = Number.isInteger(targetTabId) ? targetTabId : await findWorkspaceTabId();
  const deliveryId = typeof options.deliveryId === 'string' && options.deliveryId
    ? options.deliveryId.slice(0, 220)
    : createDeliveryId();
  const requestedPanels = sanitizePanelAttempts(options.panelAttempts);
  const legacyImageFields = firstImageFields(images);

  if (!Number.isInteger(scopedTabId)) {
    const panelResults = requestedPanels.map(panel => missingPanelResult(deliveryId, panel));
    const summary = globalThis.AIBDeliveryProtocol.summarizeDelivery(panelResults, requestedPanels);
    await recordAttemptTelemetry(panelResults).catch(() => {});
    return {
      ...summary,
      deliveryId,
      count: 0,
      sent: false,
      frames: 0,
      results: panelResults,
      panelResults,
      scoped: false
    };
  }

  const frames = await discoverTargets(scopedTabId);
  const dispatches = [];
  const missing = [];

  if (requestedPanels.length) {
    for (const panel of requestedPanels) {
      const frame = frames.find(candidate =>
        candidate.panelId === panel.panelId && candidate.panelEpoch === panel.panelEpoch);
      if (!frame) {
        missing.push(missingPanelResult(deliveryId, panel));
        continue;
      }
      dispatches.push({ frame, panel });
    }
  } else {
    for (const frame of frames) {
      const panelId = frame.panelId || `frame:${frame.frameId}`;
      dispatches.push({
        frame,
        panel: {
          panelId,
          panelEpoch: frame.panelEpoch || 1,
          providerKey: frame.providerKey || '',
          hostname: frame.hostname,
          attemptId: `${deliveryId}:${panelId}:1`,
          isRetry: false
        }
      });
    }
  }

  const dispatchedResults = await Promise.all(dispatches.map(({ frame, panel }) => sendToTarget(frame, {
    action: 'inject',
    deliveryId,
    attemptId: panel.attemptId,
    panelId: panel.panelId,
    panelEpoch: panel.panelEpoch,
    providerKey: panel.providerKey,
    isRetry: panel.isRetry,
    text,
    images,
    group: groupForHostname(frame.hostname),
    ...legacyImageFields
  })));

  const panelResults = requestedPanels.length
    ? requestedPanels.map(panel =>
      dispatchedResults.find(result => result.panelId === panel.panelId && result.panelEpoch === panel.panelEpoch)
        || missing.find(result => result.panelId === panel.panelId && result.panelEpoch === panel.panelEpoch))
    : dispatchedResults;
  const expectedPanels = requestedPanels.length ? requestedPanels : dispatches.map(item => item.panel);
  const summary = globalThis.AIBDeliveryProtocol.summarizeDelivery(panelResults, expectedPanels);
  await recordAttemptTelemetry(panelResults).catch(() => {});

  return {
    ...summary,
    deliveryId,
    count: summary.verified,
    sent: dispatches.length > 0,
    frames: dispatches.length,
    results: panelResults,
    panelResults,
    scoped: true
  };
}
