import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workspaceSource = fs.readFileSync(new URL('../workspace.js', import.meta.url), 'utf8');
const backgroundSource = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const providersSource = fs.readFileSync(new URL('../providers.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const match = source.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)
  );
  assert.ok(match, `source must define ${name}`);
  return match[0];
}

const providerSandbox = {};
providerSandbox.globalThis = providerSandbox;
vm.runInNewContext(providersSource, providerSandbox, { filename: 'providers.js' });
const PROVIDERS = providerSandbox.AIB_PROVIDERS;
const AI_HOSTS = new Set(providerSandbox.AIB_AI_HOSTS);

const providerByKey = key => PROVIDERS.find(provider => provider.key === key) || PROVIDERS[0];
const providerAcceptsHost = new vm.Script(`(${extractFunction(workspaceSource, 'providerAcceptsHost')})`)
  .runInNewContext({ providerByKey });

function makePanel(panelEpoch, providerKey, src) {
  return {
    panelEpoch,
    providerKey,
    frame: { src },
    navigations: [],
    navigate(url) { this.navigations.push(url); }
  };
}

function loadResetPanelFromAuth(panelControllers) {
  return new vm.Script(`(${extractFunction(workspaceSource, 'resetPanelFromAuth')})`).runInNewContext({
    panelControllers,
    prepareFrames: async () => true,
    hostOf: url => { try { return new URL(url).hostname; } catch { return ''; } },
    originsForKey: () => [],
    providerAcceptsHost
  });
}

const authHostPatternsSource = backgroundSource.match(/const AUTH_HOST_PATTERNS = \[[\s\S]*?\n\];/)[0];
const authPathPatternSource = backgroundSource.match(/const AUTH_PATH_PATTERN = .*;/)[0];

function loadIsAuthUrl() {
  return new vm.Script([
    authHostPatternsSource,
    authPathPatternSource,
    `(${extractFunction(backgroundSource, 'isAuthUrl')})`
  ].join('\n')).runInNewContext({ AI_HOSTS, URL });
}

test('a stale auth epoch does not reset another panel sharing the provider', async () => {
  const switched = makePanel(2, 'grok', 'https://x.com/i/grok');
  const sibling = makePanel(1, 'deepseek', 'https://chat.deepseek.com/');
  const controllers = new Map([['ws:0', switched], ['ws:1', sibling]]);
  const reset = loadResetPanelFromAuth(controllers);

  await reset({
    action: 'authResetPanel',
    panelId: 'ws:0',
    panelEpoch: 1,
    providerKey: 'deepseek',
    host: 'chat.deepseek.com',
    url: 'https://chat.deepseek.com/'
  });

  assert.deepEqual(switched.navigations, []);
  assert.deepEqual(sibling.navigations, []);
});

test('a stale provider identity on the same epoch does not navigate the panel', async () => {
  const switched = makePanel(2, 'grok', 'https://x.com/i/grok');
  const sibling = makePanel(1, 'deepseek', 'https://chat.deepseek.com/');
  const controllers = new Map([['ws:0', switched], ['ws:1', sibling]]);
  const reset = loadResetPanelFromAuth(controllers);

  await reset({
    action: 'authResetPanel',
    panelId: 'ws:0',
    panelEpoch: 2,
    providerKey: 'deepseek',
    host: 'chat.deepseek.com',
    url: 'https://chat.deepseek.com/'
  });

  assert.deepEqual(switched.navigations, []);
  assert.deepEqual(sibling.navigations, []);
});

test('a matching epoch still resets the panel that left for auth', async () => {
  const onAuth = makePanel(2, 'grok', 'https://accounts.google.com/');
  const sibling = makePanel(1, 'deepseek', 'https://chat.deepseek.com/');
  const controllers = new Map([['ws:0', onAuth], ['ws:1', sibling]]);
  const reset = loadResetPanelFromAuth(controllers);

  await reset({
    action: 'authResetPanel',
    panelId: 'ws:0',
    panelEpoch: 2,
    providerKey: 'grok',
    host: 'x.com',
    url: 'https://x.com/i/grok'
  });

  assert.deepEqual(onAuth.navigations, ['https://x.com/i/grok']);
  assert.deepEqual(sibling.navigations, []);
});

test('identity-less legacy reset messages still use the provider fallback', async () => {
  const grokPanel = makePanel(2, 'grok', 'https://x.com/i/grok');
  const deepseekPanel = makePanel(1, 'deepseek', 'https://chat.deepseek.com/');
  const controllers = new Map([['ws:0', grokPanel], ['ws:1', deepseekPanel]]);
  const reset = loadResetPanelFromAuth(controllers);

  await reset({
    action: 'authResetPanel',
    panelId: 'ws:stale',
    panelEpoch: null,
    providerKey: null,
    host: 'chat.deepseek.com',
    url: 'https://chat.deepseek.com/'
  });

  assert.deepEqual(grokPanel.navigations, []);
  assert.deepEqual(deepseekPanel.navigations, ['https://chat.deepseek.com/']);
});

test('provider-host navigation is only an auth redirect on an auth path', () => {
  const isAuthUrl = loadIsAuthUrl();

  assert.equal(isAuthUrl('https://x.com/i/grok', 'chat.deepseek.com'), false);
  assert.equal(isAuthUrl('https://www.twitter.com/i/grok', 'chat.deepseek.com'), false);
  assert.equal(isAuthUrl('https://x.com/i/grok', ''), false);
  assert.equal(isAuthUrl('https://x.com/oauth/authorize?client_id=1', 'chat.deepseek.com'), true);
  assert.equal(isAuthUrl('https://accounts.google.com/o/oauth2/auth', 'x.com'), true);
  assert.equal(isAuthUrl('https://chat.deepseek.com/signin', 'x.com'), true);
});
