import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relativePath => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('extension never controls Chrome window state or page fullscreen', () => {
  const extensionSource = [
    'background.js',
    'content.js',
    'grab.js',
    'offscreen.js',
    'popup.js',
    'workspace.js'
  ].map(read).join('\n');

  assert.doesNotMatch(extensionSource, /chrome\.windows\./);
  assert.doesNotMatch(extensionSource, /(?:request|exit)Fullscreen\s*\(/);
  assert.doesNotMatch(extensionSource, /chrome\.tabs\.(?:update|move|remove|reload)\s*\(/);
});

test('Windows screenshot helper never activates Chrome or sends keystrokes', () => {
  const helper = read('screenshot-to-broadcaster.ahk');
  assert.doesNotMatch(helper, /\bWin(?:Activate|WaitActive|Move|Minimize|Maximize|Restore)\b/i);
  assert.doesNotMatch(helper, /^\s*Send(?:Event|Input|Play|Text)?\b/im);
  assert.doesNotMatch(helper, /chrome\.exe/i);
});
