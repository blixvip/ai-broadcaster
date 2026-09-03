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

test('every registered provider host has permissions and automation coverage', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(providerSource, sandbox, { filename: 'providers.js' });
  const permittedHosts = new Set(manifest.host_permissions.map(pattern => new URL(pattern.replace('*', '')).hostname));

  for (const host of sandbox.AIB_AI_HOSTS) {
    assert.ok(permittedHosts.has(host), `${host} missing host permission`);
    assert.ok(content.includes(host), `${host} missing content automation config`);
  }
});
