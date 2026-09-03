import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const extensionPath = fileURLToPath(new URL('..', import.meta.url));

function loadPlaywright() {
  const candidates = [
    process.env.AIB_PLAYWRIGHT_PATH,
    path.join(extensionPath, 'node_modules', 'playwright'),
    'C:/live/brgod/node_modules/playwright'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install it locally or set AIB_PLAYWRIGHT_PATH.');
}

const { chromium } = loadPlaywright();
const runDir = await mkdtemp(path.join(os.tmpdir(), 'aib-live-readiness-'));
const profilePath = path.join(runDir, 'profile');
const screenshotPath = path.join(runDir, 'workspace.png');
const browserExecutable = [
  process.env.AIB_CHROME_PATH,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find(existsSync);

if (!browserExecutable) throw new Error('Chrome or Playwright Chromium executable not found.');

const context = await chromium.launchPersistentContext(profilePath, {
  headless: process.env.AIB_HEADLESS !== '0',
  executablePath: browserExecutable,
  viewport: { width: 1500, height: 950 },
  locale: 'en-US',
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--lang=en-US',
    '--window-position=-32000,-32000',
    '--no-first-run',
    '--no-default-browser-check'
  ]
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const workspaceErrors = [];
  page.on('pageerror', error => workspaceErrors.push(String(error)));

  await page.goto(`chrome-extension://${extensionId}/workspace.html?id=live-readiness&count=4`);
  await page.waitForFunction(() => document.querySelectorAll('#grid iframe').length === 4);

  let timedOut = false;
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('#grid .panel')]
        .every(panel => ['ready', 'login_required', 'not_ready'].includes(panel.dataset.deliveryState)),
      null,
      { timeout: 45000 }
    );
  } catch {
    timedOut = true;
  }

  const panels = await page.locator('#grid .panel').evaluateAll(nodes => nodes.map(panel => {
    const frame = panel.querySelector('iframe');
    return {
      provider: panel.dataset.provider || '',
      state: panel.dataset.deliveryState || '',
      detail: panel.querySelector('.panel-state-detail')?.textContent?.trim() || '',
      url: frame?.src || '',
      title: frame?.title || '',
      language: frame?.lang || '',
      loading: !!panel.querySelector('.panel-loading')
    };
  }));

  const blockedPattern = /\b403 error\b|request blocked|access denied|security verification|verify you are human|checking your browser|cloudflare ray id|just a moment|unsupported region|not available (?:in|for) your (?:country|region)/i;
  const frameDiagnostics = [];
  for (let index = 0; index < panels.length; index += 1) {
    const iframe = page.locator('#grid .panel iframe').nth(index);
    const iframeHandle = await iframe.elementHandle();
    const contentFrame = await iframeHandle?.contentFrame();
    let pageTitle = '';
    let bodyText = '';
    try {
      pageTitle = await contentFrame.title();
      bodyText = (await contentFrame.locator('body').innerText({ timeout: 3000 })).slice(0, 12000);
    } catch {}
    const blocked = blockedPattern.test(`${pageTitle}\n${bodyText}`);
    frameDiagnostics.push({ pageTitle, blocked, bodySample: bodyText.slice(0, 320) });
    panels[index].blocked = blocked;
  }

  const readiness = {
    state: await page.locator('#readiness').getAttribute('data-state'),
    label: (await page.locator('#readinessLabel').textContent())?.trim() || ''
  };
  await page.screenshot({ path: screenshotPath });

  const readyCount = panels.filter(panel => panel.state === 'ready').length;
  const attentionCount = panels.length - readyCount;
  const falseReady = panels.some(panel => panel.state === 'ready' && panel.blocked);
  const settled = panels.every(panel => ['ready', 'login_required', 'not_ready'].includes(panel.state));
  const aggregateCorrect = readiness.state === (attentionCount ? 'attention' : 'ready')
    && readiness.label.startsWith(`${readyCount}/${panels.length} READY`);
  const passed = !timedOut
    && panels.length === 4
    && settled
    && !falseReady
    && aggregateCorrect
    && panels.every(panel => panel.title.endsWith('chat panel') && panel.language === 'en-US' && !panel.loading)
    && workspaceErrors.length === 0;

  console.log(JSON.stringify({
    passed,
    timedOut,
    falseReady,
    aggregateCorrect,
    extensionId,
    readiness,
    panels,
    frameDiagnostics,
    workspaceErrors,
    screenshotPath,
    runDir
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true }).catch(() => {});
}
