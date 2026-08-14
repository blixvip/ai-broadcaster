import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../workspace.js', import.meta.url), 'utf8');
const providerSource = fs.readFileSync(new URL('../providers.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

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
