'use strict';

importScripts('providers.js');

const AI_HOSTS = new Set(globalThis.AIB_AI_HOSTS || []);
const WORKSPACE_URL = chrome.runtime.getURL('workspace.html');
const WORKSPACE_TAB_KEY = 'aib_workspace_tab_id';
const STATIC_FRAME_RULESET_ID = 'ai_frame_rules';
const FRAME_RULE_IDS = [9101, 9102];
const FRAME_DOMAINS = [...AI_HOSTS];
const FRAME_ORIGINS = FRAME_DOMAINS.map(domain => `https://${domain}`);

let workspaceTabId = null;

// Build hostname → group map from providers (A / B / C).
// Each group runs as its own parallel sequence with group-specific timeouts
// passed in the payload so content.js knows how long to wait.
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

async function ensureFrameRules() {
  if (!FRAME_DOMAINS.length) return;
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

async function clearFrameCaches() {
  if (!FRAME_ORIGINS.length) return;
  await chrome.browsingData.remove(
    { origins: FRAME_ORIGINS },
    { cache: true, cacheStorage: true, serviceWorkers: true }
  );
}

async function repairFrameEmbedding() {
  await ensureStaticFrameRuleset();
  await ensureFrameRules();
  await clearFrameCaches();
}

ensureFrameRules().catch(() => {});

function isWorkspaceUrl(value) {
  try {
    return new URL(value).href === WORKSPACE_URL;
  } catch {
    return value === WORKSPACE_URL;
  }
}

async function openWorkspaceWindow(options = {}) {
  // The workspace is a single full-page tab embedding every AI panel as an
  // iframe. Reuse an already-open workspace tab if there is one; otherwise
  // open a fresh one.
  const existing = await findWorkspaceTabId();
  if (Number.isInteger(existing)) {
    try {
      const tab = await chrome.tabs.get(existing);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { windowId: tab.windowId, tabId: tab.id, reused: true };
    } catch {
      await forgetWorkspaceTab(existing);
    }
  }

  const tab = await chrome.tabs.create({ url: WORKSPACE_URL, active: true });
  if (Number.isInteger(tab.id)) await rememberWorkspaceTab(tab.id);
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  return { windowId: tab.windowId, tabId: tab.id, reused: false };
}

async function rememberWorkspaceTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  workspaceTabId = tabId;
  await chrome.storage.session.set({ [WORKSPACE_TAB_KEY]: tabId });
}

async function forgetWorkspaceTab(tabId = null) {
  if (tabId != null) {
    const currentTabId = Number.isInteger(workspaceTabId)
      ? workspaceTabId
      : (await chrome.storage.session.get(WORKSPACE_TAB_KEY))[WORKSPACE_TAB_KEY];
    if (currentTabId !== tabId) return;
  }
  workspaceTabId = null;
  await chrome.storage.session.remove(WORKSPACE_TAB_KEY);
}

async function claimWorkspaceTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const tab = await chrome.tabs.get(tabId);
  if (!isWorkspaceUrl(tab.url || tab.pendingUrl || '')) return null;
  await rememberWorkspaceTab(tab.id);
  return { windowId: tab.windowId, tabId: tab.id };
}

async function saveFrame(tabId, frameId, hostname, topLevelFrame = true) {
  const { reg = {} } = await chrome.storage.session.get('reg');
  reg[`${tabId}:${frameId}`] = { tabId, frameId, hostname, topLevelFrame };
  await chrome.storage.session.set({ reg });
}

async function dropTab(tabId) {
  const { reg = {} } = await chrome.storage.session.get('reg');
  for (const k of Object.keys(reg)) {
    if (reg[k].tabId === tabId) delete reg[k];
  }
  await chrome.storage.session.set({ reg });
}

async function dropFrame(tabId, frameId) {
  const { reg = {} } = await chrome.storage.session.get('reg');
  delete reg[`${tabId}:${frameId}`];
  await chrome.storage.session.set({ reg });
}

async function allFrames() {
  const { reg = {} } = await chrome.storage.session.get('reg');
  return Object.values(reg);
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  dropTab(tabId);

  // If the user closes the login tab themselves, reload the panel anyway so it
  // picks up the session if they did sign in.
  const watch = pendingLogins.get(tabId);
  if (watch) {
    pendingLogins.delete(tabId);
    messageWorkspaceTop(watch.workspaceTabId, { action: 'authReloadPanel', host: watch.aiHost, url: watch.aiUrl });
  }

  for (const key of panelFrameHost.keys()) {
    if (key.startsWith(`${tabId}:`)) panelFrameHost.delete(key);
  }
  forgetWorkspaceTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isWorkspaceUrl(changeInfo.url || tab?.url || tab?.pendingUrl || '')) return;
  claimWorkspaceTab(tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// Auth Gateway — logins and OAuth cannot complete inside a cross-origin panel
// iframe (X-Frame-Options on auth pages, partitioned 3rd-party cookies, OAuth
// popups). So we detect an auth navigation *inside a direct panel frame*, pop
// the real login into a top-level focused tab, and reset the panel back to its
// AI home (aborting the broken in-frame auth load — no error box). Once the
// login tab returns to the AI's own domain, the first-party session cookie is
// set; we close the tab and reload the panel, now authenticated.
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

const panelFrameHost = new Map();   // `${tabId}:${frameId}` -> hostname (current panel origin)
const pendingLogins  = new Map();   // loginTabId -> { aiHost, aiUrl, workspaceTabId }

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function registrableDomain(host) {
  return String(host || '').split('.').slice(-2).join('.');
}

function hostMatchesAi(host, aiHost) {
  if (!host || !aiHost) return false;
  return host === aiHost || registrableDomain(host) === registrableDomain(aiHost);
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

async function resolveWorkspaceTabId() {
  return Number.isInteger(workspaceTabId) ? workspaceTabId : await findWorkspaceTabId();
}

async function openAuthGateway({ tabId, panelHost, authUrl }) {
  const aiUrl = providerUrlForHost(panelHost) || (panelHost ? `https://${panelHost}/` : authUrl);

  // Reset the panel to its AI home — this aborts the broken in-frame auth load.
  messageWorkspaceTop(tabId, { action: 'authResetPanel', host: panelHost, url: aiUrl });

  // Open the AI's OWN home page (first-party) — NOT the intercepted mid-flow
  // auth URL. Auth vendors like Clerk/Auth0 pre-create the sign-in attempt in
  // the iframe's storage partition; deep-linking that URL into a fresh tab
  // fails ("authorization_invalid"). Instead the user signs in cleanly here,
  // and we wait until they've actually passed through an auth step before
  // reloading the panel.
  const loginTab = await chrome.tabs.create({ url: aiUrl, active: true }).catch(() => null);
  if (loginTab && Number.isInteger(loginTab.id)) {
    pendingLogins.set(loginTab.id, { aiHost: panelHost, aiUrl, workspaceTabId: tabId, sawAuth: false });
  }
}

function checkLoginTab(tabId, url) {
  const watch = pendingLogins.get(tabId);
  if (!watch) return;
  const host = hostOf(url);
  if (!host) return;

  if (isAuthUrl(url, watch.aiHost)) {                // user has entered the auth flow
    watch.sawAuth = true;
    return;
  }
  if (!watch.sawAuth) return;                        // still on the home page, not logged in yet
  if (!hostMatchesAi(host, watch.aiHost)) return;    // wandered elsewhere — keep waiting

  // Returned to the AI's own domain after authenticating → first-party session set.
  pendingLogins.delete(tabId);
  messageWorkspaceTop(watch.workspaceTabId, { action: 'authReloadPanel', host: watch.aiHost, url: watch.aiUrl });
  setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 700);
}

chrome.webNavigation.onCommitted.addListener(details => {
  const { tabId, frameId, parentFrameId, url } = details;

  // Track the live origin of each direct panel frame in the workspace tab.
  if (frameId !== 0 && parentFrameId === 0 && tabId === workspaceTabId) {
    panelFrameHost.set(`${tabId}:${frameId}`, hostOf(url));
  }

  // A login tab landing back on the AI domain = success.
  if (frameId === 0) checkLoginTab(tabId, url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId === 0) checkLoginTab(details.tabId, details.url);
});

chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  const { tabId, frameId, parentFrameId, url } = details;
  if (frameId === 0 || parentFrameId !== 0) return;  // only direct panel frames

  const wsTabId = await resolveWorkspaceTabId();
  if (!Number.isInteger(wsTabId) || tabId !== wsTabId) return;

  const panelHost = panelFrameHost.get(`${tabId}:${frameId}`) || '';
  if (!isAuthUrl(url, panelHost)) return;

  openAuthGateway({ tabId, panelHost, authUrl: url });
});

// ---------------------------------------------------------------------------
// Tiled real-window panels — each AI opens as its OWN first-party popup window
// (normal cookies, normal login, no iframe/3rd-party-cookie wall). Broadcasts
// target these real tabs directly. content.js runs in them unchanged.
// ---------------------------------------------------------------------------

let panelTabs = [];   // [{ id, windowId, tabId, url, group }]  — id = stable slot index

function groupForUrl(url) {
  return groupForHostname(hostOf(url));
}

async function closeAllPanels() {
  const windowIds = panelTabs.map(p => p.windowId).filter(Number.isInteger);
  panelTabs = [];
  for (const windowId of windowIds) {
    try { await chrome.windows.remove(windowId); } catch {}
  }
}

async function createPanelWindow(spec) {
  const opts = { url: spec.url, type: 'popup', focused: spec.focused === true };
  if (spec.cell) {
    opts.left = Math.round(spec.cell.left);
    opts.top = Math.round(spec.cell.top);
    opts.width = Math.round(spec.cell.width);
    opts.height = Math.round(spec.cell.height);
  }
  const win = await chrome.windows.create(opts);
  const tab = win.tabs && win.tabs[0];
  return {
    id: spec.id,
    windowId: win.id,
    tabId: tab?.id ?? null,
    url: spec.url,
    group: spec.group || groupForUrl(spec.url)
  };
}

async function launchPanels(specs) {
  await closeAllPanels();
  const created = [];
  for (const spec of specs) {
    try { created.push(await createPanelWindow(spec)); } catch {}
  }
  panelTabs = created;
  return panelSummary();
}

async function navigatePanel(id, url) {
  const panel = panelTabs.find(p => p.id === id);
  if (!panel || !Number.isInteger(panel.tabId)) return panelSummary();
  panel.url = url;
  panel.group = groupForUrl(url);
  try { await chrome.tabs.update(panel.tabId, { url }); } catch {}
  return panelSummary();
}

function panelSummary() {
  return panelTabs.map(p => ({ id: p.id, url: p.url, windowId: p.windowId, tabId: p.tabId }));
}

async function focusPanels() {
  for (const p of panelTabs) {
    try { await chrome.windows.update(p.windowId, { focused: true, drawAttention: true }); } catch {}
  }
}

// Hybrid escape hatch: pop ONE panel slot out into its own real first-party
// window (normal logged-in cookies, no iframe partition). Reused for login-gated
// sites that Chrome won't keep authed inside an embedded frame. Broadcasts target
// these windows via broadcastToPanels() alongside the iframe panels.
async function openPanelWindow(id, url) {
  const existing = panelTabs.find(p => p.id === id);
  if (existing) {
    try {
      if (url && existing.url !== url && Number.isInteger(existing.tabId)) {
        await chrome.tabs.update(existing.tabId, { url });
        existing.url = url;
        existing.group = groupForUrl(url);
      }
      await chrome.windows.update(existing.windowId, { focused: true, drawAttention: true });
      return panelSummary();
    } catch {
      panelTabs = panelTabs.filter(p => p.id !== id);
    }
  }
  const created = await createPanelWindow({ id, url, focused: true });
  panelTabs.push(created);
  return panelSummary();
}

async function closePanelWindow(id) {
  const existing = panelTabs.find(p => p.id === id);
  if (!existing) return panelSummary();
  panelTabs = panelTabs.filter(p => p.id !== id);
  try { await chrome.windows.remove(existing.windowId); } catch {}
  return panelSummary();
}

async function broadcastToPanels(text, images) {
  const ts = Date.now();
  const legacy = firstImageFields(images);
  const results = await Promise.all(panelTabs.map(async panel => {
    const hostname = hostOf(panel.url);
    if (!Number.isInteger(panel.tabId)) return { hostname, ok: false, reason: 'no_tab' };
    const payload = { action: 'inject', timestamp: ts, text, images, group: panel.group, ...legacy };
    try {
      const resp = await chrome.tabs.sendMessage(panel.tabId, payload);
      return { hostname: resp?.hostname || hostname, ok: !!resp?.ok, reason: resp?.reason || '' };
    } catch (err) {
      return { hostname, ok: false, reason: err?.message || 'unreachable' };
    }
  }));
  return { count: results.filter(r => r.ok).length, sent: true, frames: panelTabs.length, results };
}

chrome.windows.onRemoved.addListener(windowId => {
  panelTabs = panelTabs.filter(p => p.windowId !== windowId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'launchPanels') {
    launchPanels(msg.specs || [])
      .then(panels => sendResponse({ ok: true, panels }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'launch_failed' }));
    return true;
  }

  if (msg.action === 'navigatePanel') {
    navigatePanel(msg.id, msg.url)
      .then(panels => sendResponse({ ok: true, panels }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'navigate_failed' }));
    return true;
  }

  if (msg.action === 'getPanels') {
    sendResponse({ ok: true, panels: panelSummary() });
    return false;
  }

  if (msg.action === 'focusPanels') {
    focusPanels().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'openPanelWindow') {
    openPanelWindow(msg.id, msg.url)
      .then(panels => sendResponse({ ok: true, panels }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'open_window_failed' }));
    return true;
  }

  if (msg.action === 'closePanelWindow') {
    closePanelWindow(msg.id)
      .then(panels => sendResponse({ ok: true, panels }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'close_window_failed' }));
    return true;
  }

  if (msg.action === 'closePanels') {
    closeAllPanels().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'register') {
    const frameId = sender.frameId ?? 0;
    const tabId = sender.tab?.id;
    if (tabId != null && AI_HOSTS.has(msg.hostname)) {
      saveFrame(tabId, frameId, msg.hostname, msg.topLevelFrame !== false).catch(() => {});
    }
    return false;
  }

  if (msg.action === 'ensureFrameRules') {
    repairFrameEmbedding()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'frame_rules_failed' }));
    return true;
  }

  // Prepare panel frames before they load: (re)arm the header-stripping rules
  // AND purge cache + cacheStorage + service workers for the given origins.
  // The cache purge is ESSENTIAL: an authed AI site (e.g. Venice) serves its
  // document from a service worker / HTTP cache, which bypasses DNR, so the
  // original un-stripped frame-ancestors CSP survives and blocks embedding.
  // Forcing a network fetch lets DNR strip the CSP. Does NOT touch cookies →
  // logins persist.
  if (msg.action === 'prepareFrames') {
    (async () => {
      await ensureStaticFrameRuleset();
      await ensureFrameRules();
      const origins = Array.isArray(msg.origins) ? msg.origins.filter(Boolean) : [];
      if (origins.length) {
        try {
          await chrome.browsingData.remove(
            { origins },
            { cache: true, cacheStorage: true, serviceWorkers: true }
          );
        } catch {}
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'prepare_failed' }));
    return true;
  }

  if (msg.action === 'openWorkspace') {
    openWorkspaceWindow()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'workspace_open_failed' }));
    return true;
  }

  if (msg.action === 'claimWorkspace') {
    claimWorkspaceTab(msg.tabId)
      .then(result => sendResponse({ ok: !!result, ...result }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || 'workspace_claim_failed' }));
    return true;
  }

  if (msg.action !== 'execute') return false;
  const { text, imageBase64, imageName, imageType } = msg;
  const images = normalizeImages(msg.images, imageBase64, imageName, imageType);
  // Inject into BOTH the iframe panels (registered in the workspace tab) AND any
  // popped-out real windows (login-gated sites). broadcastToPanels() is a no-op
  // when no panel has been popped out.
  Promise.all([broadcast(text, images), broadcastToPanels(text, images)])
    .then(([frameRes, winRes]) => sendResponse({
      count: (frameRes.count || 0) + (winRes.count || 0),
      sent: true,
      frames: (frameRes.frames || 0) + (winRes.frames || 0),
      results: [...(frameRes.results || []), ...(winRes.results || [])]
    }))
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
  if (Array.isArray(images)) {
    return images
      .filter(image => image?.base64)
      .map(image => ({
        base64: image.base64,
        name: image.name || 'image.png',
        type: image.type || 'image/png'
      }));
  }

  return imageBase64
    ? [{ base64: imageBase64, name: imageName || 'image.png', type: imageType || 'image/png' }]
    : [];
}

function firstImageFields(images) {
  const first = images[0] || {};
  return {
    imageBase64: first.base64 || null,
    imageName: first.name || null,
    imageType: first.type || null
  };
}

function addTarget(targets, target) {
  if (!Number.isInteger(target?.tabId) || !Number.isInteger(target?.frameId) || !target.hostname) {
    return;
  }
  targets.set(`${target.tabId}:${target.frameId}`, {
    tabId: target.tabId,
    frameId: target.frameId,
    hostname: target.hostname
  });
}

async function registeredFrameTargets(scopedTabId) {
  return (await allFrames())
    .filter(frame => scopedTabId == null || frame.tabId === scopedTabId)
    .filter(frame => frame.topLevelFrame !== false)
    .filter(frame => AI_HOSTS.has(frame.hostname));
}

async function discoverTargets(scopedTabId) {
  if (!Number.isInteger(scopedTabId)) return [];
  const targets = new Map();
  for (const target of await registeredFrameTargets(scopedTabId)) addTarget(targets, target);
  return [...targets.values()].sort((a, b) => a.tabId - b.tabId || a.frameId - b.frameId);
}

async function findWorkspaceTabId() {
  if (Number.isInteger(workspaceTabId)) return workspaceTabId;
  const stored = await chrome.storage.session.get(WORKSPACE_TAB_KEY);
  const tabId = stored[WORKSPACE_TAB_KEY];
  if (Number.isInteger(tabId)) workspaceTabId = tabId;
  return Number.isInteger(tabId) ? tabId : null;
}

async function sendToTarget(target, payload) {
  try {
    const resp = await chrome.tabs.sendMessage(target.tabId, payload, { frameId: target.frameId });
    return {
      ...target,
      hostname: resp?.hostname || target.hostname,
      ok: !!resp?.ok,
      reason: resp?.reason || ''
    };
  } catch (err) {
    await dropFrame(target.tabId, target.frameId);
    return {
      ...target,
      ok: false,
      reason: err?.message || 'unreachable'
    };
  }
}

// ---------------------------------------------------------------------------
// Broadcast — three parallel sequences (A, B, C) fired simultaneously.
// Each frame receives its group label so content.js can apply the right
// input/submit timeouts without guessing.
// ---------------------------------------------------------------------------

async function broadcast(text, images, targetTabId) {
  const ts = Date.now();
  const scopedTabId = Number.isInteger(targetTabId) ? targetTabId : await findWorkspaceTabId();
  const legacyImageFields = firstImageFields(images);
  const basePayload = { action: 'inject', timestamp: ts, text, images, ...legacyImageFields };

  if (!Number.isInteger(scopedTabId)) return { count: 0, sent: false, frames: 0, results: [], scoped: false };

  const frames = await discoverTargets(scopedTabId);

  // Partition into three named sequences
  const seqA = [];
  const seqB = [];
  const seqC = [];
  for (const frame of frames) {
    const g = groupForHostname(frame.hostname);
    if      (g === 'A') seqA.push(frame);
    else if (g === 'C') seqC.push(frame);
    else                seqB.push(frame);
  }

  // Fire all three sequences simultaneously — each frame gets its group tag
  const results = await Promise.all([
    ...seqA.map(frame => sendToTarget(frame, { ...basePayload, group: 'A' })),
    ...seqB.map(frame => sendToTarget(frame, { ...basePayload, group: 'B' })),
    ...seqC.map(frame => sendToTarget(frame, { ...basePayload, group: 'C' }))
  ]);

  const count = results.filter(result => result.ok).length;
  return { count, sent: true, frames: frames.length, results, scoped: scopedTabId != null };
}
