import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const extensionPath = fileURLToPath(new URL('..', import.meta.url));
const outputPath = path.join(extensionPath, 'artifacts', 'ui');

function loadPlaywright() {
  const candidates = [
    process.env.AIB_PLAYWRIGHT_PATH,
    path.join(extensionPath, 'node_modules', 'playwright'),
    'C:/code/brgod/node_modules/playwright'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install it locally or set AIB_PLAYWRIGHT_PATH.');
}

const { chromium } = loadPlaywright();
const browserExecutable = [
  process.env.AIB_CHROME_PATH,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find(existsSync);

if (!browserExecutable) throw new Error('Chrome or Playwright Chromium executable not found.');

await rm(outputPath, { recursive: true, force: true });
await mkdir(outputPath, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
const context = await browser.newContext();
await context.route(/^https:\/\//, route => route.fulfill({
  status: 200,
  contentType: 'text/html',
  body: `<!doctype html><html><head><style>
    html,body{height:100%;margin:0;background:#f5f6f8;color:#202124;font:14px system-ui}
    main{height:100%;display:flex;flex-direction:column}
    header{height:52px;display:flex;align-items:center;padding:0 18px;border-bottom:1px solid #d8dbe1;background:#fff;font-weight:650}
    section{flex:1;padding:22px;background:linear-gradient(#fafbfc,#f1f3f6)}
    .turn{max-width:520px;padding:14px 16px;border-radius:8px;background:#fff;border:1px solid #dfe2e7}
    textarea{box-sizing:border-box;width:calc(100% - 32px);height:68px;margin:16px;padding:12px;border:1px solid #c5c9d0;border-radius:8px;resize:none}
  </style></head><body><main><header>Provider workspace</header><section><div class="turn">Ready for a prompt</div></section><textarea aria-label="Message" placeholder="Message"></textarea></main></body></html>`
}));

const errors = [];

async function installChromeMocks(page) {
  await page.addInitScript(() => {
    const storage = {};
    const runtimeListeners = [];
    const storageListeners = [];

    function selection(keys) {
      if (keys == null) return { ...storage };
      if (typeof keys === 'string') return { [keys]: storage[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, storage[key]]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
        key,
        storage[key] === undefined ? fallback : storage[key]
      ]));
    }

    const local = {
      get(keys, callback) {
        const result = selection(keys);
        if (typeof callback === 'function') queueMicrotask(() => callback(result));
        return Promise.resolve(result);
      },
      set(values, callback) {
        Object.assign(storage, values || {});
        if (typeof callback === 'function') queueMicrotask(callback);
        return Promise.resolve();
      },
      remove(keys, callback) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        if (typeof callback === 'function') queueMicrotask(callback);
        return Promise.resolve();
      }
    };

    async function executeMessage(message) {
      const state = new URL(location.href).searchParams.get('preview') || 'verified';
      await new Promise(resolve => setTimeout(resolve, state === 'broadcasting' ? 2400 : 180));
      const attempts = message.panelAttempts || [];

      if (!attempts.length) {
        if (state === 'partial') return { outcome: 'partial', verified: 2, expected: 3 };
        if (state === 'unverified') return { outcome: 'unverified', verified: 0, expected: 3 };
        return { outcome: 'verified', verified: 3, expected: 3 };
      }

      return {
        panelResults: attempts.map((attempt, index) => {
          const failed = state === 'partial' && index === attempts.length - 1;
          const unverified = state === 'unverified';
          const outcome = failed ? 'failed' : unverified ? 'unverified' : 'verified';
          return {
            panelId: attempt.panelId,
            panelEpoch: attempt.panelEpoch,
            attempt: {
              ...attempt,
              outcome,
              reason: failed ? 'no_input:composer missing' : unverified ? 'evidence_timeout' : 'verified',
              retry: { safe: failed }
            }
          };
        })
      };
    }

    globalThis.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
        async sendMessage(message) {
          if (message?.action === 'claimWorkspace') return { ok: true, tabId: 9001 };
          if (message?.action === 'prepareFrames') return { ok: true };
          if (message?.action === 'openWorkspace') return { ok: true, tabId: 9002 };
          if (message?.action === 'getTelemetry') {
            return { ok: true, ranking: [{ id: 'gemini', attempts: 12, smartScore: 94 }] };
          }
          if (message?.action === 'execute') return executeMessage(message);
          return { ok: true };
        },
        connectNative() {
          return {
            onMessage: { addListener() {} },
            onDisconnect: { addListener() {} },
            postMessage() {},
            disconnect() {}
          };
        }
      },
      storage: {
        local,
        onChanged: { addListener(listener) { storageListeners.push(listener); } }
      }
    };

    globalThis.__aibPreview = {
      storage,
      dispatch(message) {
        for (const listener of runtimeListeners) listener(message, {}, () => {});
      }
    };
  });
}

function observeErrors(page, name) {
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`${name}: ${String(error)}`));
}

async function readyWorkspace(page, count, preview = 'verified') {
  const url = new URL(pathToFileURL(path.join(extensionPath, 'workspace.html')));
  url.searchParams.set('id', `preview-${count}-${preview}`);
  url.searchParams.set('count', String(count));
  url.searchParams.set('preview', preview);
  await page.goto(url.href);
  await page.waitForFunction(expected => document.querySelectorAll('#grid .panel').length === expected, count);
  await page.waitForFunction(() => document.querySelector('#grid')?.getBoundingClientRect().height > 100);
  await page.evaluate(() => {
    for (const frame of document.querySelectorAll('#grid iframe')) {
      globalThis.__aibPreview.dispatch({ action: 'panelAlive', host: new URL(frame.src).hostname });
    }
  });
  await page.waitForTimeout(100);
}

async function workspaceGeometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const panelBoxes = [...document.querySelectorAll('.panel')].map(panel => {
      const box = panel.getBoundingClientRect();
      const head = panel.querySelector('.panel-head');
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        headOverflow: head.scrollWidth - head.clientWidth
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      header: rect('.workspace-bar'),
      grid: rect('#grid'),
      dock: rect('.dock'),
      composer: rect('.composer'),
      countControl: rect('#panelCount'),
      statusVisible: document.querySelector('#status').getClientRects().length > 0,
      panelBoxes
    };
  });
}

function overlaps(a, b) {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1
    && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1;
}

function assertWorkspaceGeometry(name, geometry) {
  const failures = [];
  if (geometry.documentWidth > geometry.viewport.width + 1) failures.push('horizontal document overflow');
  for (const [label, box] of [['header', geometry.header], ['dock', geometry.dock], ['composer', geometry.composer], ['panel count', geometry.countControl]]) {
    if (box.left < -1 || box.right > geometry.viewport.width + 1 || box.top < -1 || box.bottom > geometry.viewport.height + 1) {
      failures.push(`${label} outside viewport`);
    }
  }
  if (geometry.panelBoxes.some(panel => panel.width < 190 || panel.height < 150)) failures.push('panel below minimum size');
  if (geometry.panelBoxes.some(panel => panel.headOverflow > 2)) failures.push('panel header overflow');
  for (let left = 0; left < geometry.panelBoxes.length; left++) {
    for (let right = left + 1; right < geometry.panelBoxes.length; right++) {
      if (overlaps(geometry.panelBoxes[left], geometry.panelBoxes[right])) failures.push(`panels ${left + 1}/${right + 1} overlap`);
    }
  }
  if (failures.length) throw new Error(`${name}: ${failures.join(', ')}`);
}

const layoutScenarios = [
  ...[2, 3, 4, 5, 6].map(count => ({ name: `wide-${count}`, count, width: 1920, height: 1080 })),
  ...[4, 6].map(count => ({ name: `laptop-${count}`, count, width: 1366, height: 768 })),
  ...[4, 6].map(count => ({ name: `compact-${count}`, count, width: 900, height: 780 })),
  ...[2, 4, 6].map(count => ({ name: `narrow-${count}`, count, width: 430, height: 900 }))
];

const results = [];

try {
  for (const scenario of layoutScenarios) {
    const page = await context.newPage();
    observeErrors(page, scenario.name);
    await installChromeMocks(page);
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await readyWorkspace(page, scenario.count);
    const geometry = await workspaceGeometry(page);
    assertWorkspaceGeometry(scenario.name, geometry);
    const screenshotPath = path.join(outputPath, `${scenario.name}.png`);
    await page.screenshot({ path: screenshotPath });
    results.push({ ...scenario, screenshotPath, geometry });
    await page.close();
  }

  const stateScenarios = ['loading', 'empty', 'attachment', 'broadcasting', 'verified', 'partial', 'unverified'];
  for (const state of stateScenarios) {
    const page = await context.newPage();
    observeErrors(page, `state-${state}`);
    await installChromeMocks(page);
    await page.setViewportSize({ width: state === 'empty' ? 430 : 1366, height: state === 'empty' ? 900 : 768 });
    const preview = ['partial', 'unverified', 'broadcasting'].includes(state) ? state : 'verified';
    await readyWorkspace(page, 4, preview);

    if (state === 'loading') {
      await page.evaluate(() => document.querySelectorAll('.panel').forEach(panel => {
        const loading = document.createElement('div');
        loading.className = 'panel-loading';
        loading.innerHTML = '<div class="pl-spin"></div><div class="pl-text">Loading provider...</div>';
        panel.append(loading);
      }));
    } else if (state === 'empty') {
      await page.locator('#sendBtn').click();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Enter a prompt'));
      const visible = await page.locator('#status').isVisible();
      if (!visible) throw new Error('state-empty: status is hidden');
    } else if (state === 'attachment') {
      await page.locator('#imageInput').setInputFiles({
        name: 'reference.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      });
      await page.waitForFunction(() => document.querySelectorAll('#imageStrip .image-tile').length === 1);
    } else {
      await page.locator('#prompt').fill('Compare the strongest option and explain the tradeoffs.');
      const click = page.locator('#sendBtn').click();
      if (state === 'broadcasting') {
        await page.waitForFunction(() => document.querySelector('.composer')?.classList.contains('is-broadcasting'));
      } else {
        await click;
        await page.waitForFunction(expected => document.querySelector('#status')?.textContent.includes(expected),
          state === 'verified' ? 'Verified by all' : state === 'partial' ? 'verified. Failed panels' : 'could not be proven');
      }
    }

    const screenshotPath = path.join(outputPath, `state-${state}.png`);
    await page.screenshot({ path: screenshotPath });
    results.push({ name: `state-${state}`, screenshotPath });
    await page.close();
  }

  for (const state of ['empty', 'attachment', 'success', 'error']) {
    const page = await context.newPage();
    observeErrors(page, `popup-${state}`);
    await installChromeMocks(page);
    await page.setViewportSize({ width: 380, height: 620 });
    const url = new URL(pathToFileURL(path.join(extensionPath, 'popup.html')));
    if (state === 'error') url.searchParams.set('preview', 'unverified');
    await page.goto(url.href);
    await page.waitForSelector('#prompt');
    if (state === 'attachment') {
      await page.locator('#imageInput').setInputFiles({
        name: 'reference.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n%%EOF')
      });
      await page.waitForFunction(() => document.querySelectorAll('#imagePreview .image-tile').length === 1);
    } else if (state === 'success' || state === 'error') {
      await page.locator('#prompt').fill('Summarize this request.');
      await page.locator('#broadcastBtn').click();
      await page.waitForFunction(() => !document.querySelector('#broadcastBtn').disabled);
    }
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (bodyWidth > 380) throw new Error(`popup-${state}: horizontal overflow`);
    const screenshotPath = path.join(outputPath, `popup-${state}.png`);
    await page.screenshot({ path: screenshotPath });
    results.push({ name: `popup-${state}`, screenshotPath });
    await page.close();
  }

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ passed: true, outputPath, results }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
