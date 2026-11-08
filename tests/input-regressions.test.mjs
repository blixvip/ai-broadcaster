import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../workspace.js', import.meta.url), 'utf8');
const providerSource = fs.readFileSync(new URL('../providers.js', import.meta.url), 'utf8');
const promptPolicySource = fs.readFileSync(new URL('../prompt-policy.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

function loadPromptPolicy() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(promptPolicySource, sandbox, { filename: 'prompt-policy.js' });
  return sandbox.AIBPromptPolicy;
}

function platformBlock(host) {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`'${escaped}': \\{([\\s\\S]*?)\\n  \\},`));
  assert.ok(match, `missing platform block for ${host}`);
  return match[1];
}

test('Kimi textarea fallbacks use automatic input dispatch', () => {
  for (const host of ['kimi.ai', 'www.kimi.ai', 'kimi.moonshot.cn']) {
    const block = platformBlock(host);
    assert.match(block, /textarea/);
    assert.match(block, /type: 'auto'/);
  }
});

test('input scoring treats plain text inputs as editable', () => {
  const helper = content.match(/function isEditableType\(el\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(helper, /el\.tagName === 'INPUT'/);
  assert.match(helper, /'text', 'search', ''/);
});

test('unusable input filter rejects readonly controls', () => {
  const helper = content.match(/function isUsable\(el\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(helper, /!el\.readOnly/);
  assert.match(helper, /aria-readonly/);
});

test('pre-click activation reuses ranked safe input selection', () => {
  const helper = content.match(/async function preClickActivate\(config\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(helper, /findBestInput/);
  assert.doesNotMatch(helper, /queryAllDeep/);
});

test('DeepSeek receives a persistent English response-language requirement', () => {
  const policy = loadPromptPolicy();
  const original = 'Compare the strongest options.';
  const transformed = policy.applyProviderPromptPolicy('chat.deepseek.com', original);

  assert.ok(transformed.startsWith(original));
  assert.match(transformed, /Reply in English/);
  assert.match(transformed, /unless this request explicitly asks for Chinese output/);
  assert.equal(
    policy.applyProviderPromptPolicy('chat.deepseek.com', transformed),
    transformed,
    'retries must not duplicate the language requirement'
  );
});

test('DeepSeek image-only prompts still request English and other providers are unchanged', () => {
  const policy = loadPromptPolicy();

  assert.match(policy.applyProviderPromptPolicy('chat.deepseek.com', ''), /Reply in English/);
  assert.equal(policy.applyProviderPromptPolicy('gemini.google.com', '  Keep spacing  '), '  Keep spacing  ');
});

test('workspace panel selection persists per workspace instance', () => {
  assert.match(workspace, /WORKSPACE_STATE_KEY/);
  assert.match(workspace, /async function loadWorkspaceState/);
  assert.match(workspace, /selectedKeys: selectedKeys\.slice\(0, count\)/);
});

function assertHostSetMatches(label, actualHosts, expectedHosts) {
  const actual = new Set(actualHosts);
  const expected = new Set(expectedHosts);
  const missing = [...expected].filter(host => !actual.has(host)).sort();
  const extra = [...actual].filter(host => !expected.has(host)).sort();

  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${label} host list mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`
  );
}

function hostsFromMatchPatterns(patterns) {
  return patterns.map(pattern => new URL(pattern.replace(/\*$/, '')).hostname);
}

function configuredContentHosts(source) {
  const objectStart = source.indexOf('const PLATFORMS = {');
  const aliasStart = source.indexOf('// X Premium/Premium+ accounts access Grok', objectStart);
  assert.notEqual(objectStart, -1, 'content.js is missing the PLATFORMS map');
  assert.notEqual(aliasStart, -1, 'content.js is missing the platform alias section');

  const platformSource = source.slice(objectStart, aliasStart);
  const hosts = [...platformSource.matchAll(/^  '([^']+)': \{/gm)].map(match => match[1]);
  const aliasEnd = source.indexOf('const COMMON_INPUT_SELS', aliasStart);
  const aliasesSource = source.slice(aliasStart, aliasEnd);
  for (const match of aliasesSource.matchAll(/for \(const host of \[([^\]]+)\]\) \{\s*PLATFORMS\[host\]/g)) {
    hosts.push(...[...match[1].matchAll(/'([^']+)'/g)].map(alias => alias[1]));
  }
  return hosts;
}

test('provider hosts exactly match host permissions', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(providerSource, sandbox, { filename: 'providers.js' });
  assertHostSetMatches(
    'manifest.host_permissions',
    hostsFromMatchPatterns(manifest.host_permissions),
    sandbox.AIB_AI_HOSTS
  );
});

test('provider hosts exactly match both content script match lists', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(providerSource, sandbox, { filename: 'providers.js' });
  for (const [index, script] of manifest.content_scripts.entries()) {
    if (index === 2) continue;
    assertHostSetMatches(
      `manifest.content_scripts[${index}].matches`,
      hostsFromMatchPatterns(script.matches),
      sandbox.AIB_AI_HOSTS
    );
  }
});

test('provider hosts exactly match both declarative net request domain lists', () => {
  const rules = JSON.parse(fs.readFileSync(new URL('../rules/ai_frame_rules.json', import.meta.url), 'utf8'));
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(providerSource, sandbox, { filename: 'providers.js' });
  for (const rule of rules) {
    assertHostSetMatches(
      `rules/ai_frame_rules.json rule ${rule.id} requestDomains`,
      rule.condition.requestDomains,
      sandbox.AIB_AI_HOSTS
    );
  }
});

test('every registered provider host has an exact content automation entry or alias', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(providerSource, sandbox, { filename: 'providers.js' });
  assertHostSetMatches('content.js PLATFORMS', configuredContentHosts(content), sandbox.AIB_AI_HOSTS);
});
