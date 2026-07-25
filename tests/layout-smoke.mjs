import { createRequire } from 'node:module';
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
    'C:/code/brgod/node_modules/playwright'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install it locally or set AIB_PLAYWRIGHT_PATH.');
}

const { chromium } = loadPlaywright();
const runDir = await mkdtemp(path.join(os.tmpdir(), 'aib-layout-smoke-'));
const profilePath = path.join(runDir, 'profile');

const context = await chromium.launchPersistentContext(profilePath, {
  headless: false,
  executablePath: chromium.executablePath(),
  viewport: { width: 1600, height: 1000 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]
});

function clusterCount(values, tolerance = 4) {
  const clusters = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const cluster = clusters.find(item => Math.abs(item - value) <= tolerance);
    if (cluster == null) clusters.push(value);
  }
  return clusters.length;
}

function maxItemsPerRow(panels, tolerance = 4) {
  const rows = [];
  for (const panel of [...panels].sort((a, b) => a.top - b.top || a.left - b.left)) {
    let row = rows.find(item => Math.abs(item.top - panel.top) <= tolerance);
    if (!row) {
      row = { top: panel.top, count: 0 };
      rows.push(row);
    }
    row.count += 1;
  }
  return Math.max(0, ...rows.map(row => row.count));
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

try {
  await context.route(/^https:\/\//, route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0;background:#f4f5f7;font:16px system-ui"><textarea style="position:absolute;left:10%;right:10%;bottom:10%;width:80%;height:70px" placeholder="Message"></textarea></body></html>'
  }));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    const panels = Array.from({ length: 6 }, () => ({ url: 'https://gemini.google.com/app' }));
    await chrome.storage.local.set({ aib_workspace_seed: { count: 6, panels } });
  });

  const scenarios = [
    ...[2, 3, 4, 5, 6].map(count => ({ name: `wide-${count}`, count, width: 1600, height: 1000 })),
    ...[2, 4, 6].map(count => ({ name: `compact-${count}`, count, width: 900, height: 780 }))
  ];
  const expectedShape = {
    2: { columns: 2, rows: 1 },
    3: { columns: 3, rows: 1 },
    4: { columns: 2, rows: 2 },
    5: { columns: 3, rows: 2 },
    6: { columns: 3, rows: 2 }
  };
  const results = [];
  const consoleErrors = [];

  for (const scenario of scenarios) {
    const page = await context.newPage();
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(`${scenario.name}: ${message.text()}`);
    });
    page.on('pageerror', error => consoleErrors.push(`${scenario.name}: ${String(error)}`));
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto(`chrome-extension://${extensionId}/workspace.html?id=layout-${scenario.name}&count=${scenario.count}`);
    await page.waitForFunction(expected => document.querySelectorAll('#grid .panel').length === expected, scenario.count);
    await page.waitForFunction(() => document.querySelector('#grid')?.getBoundingClientRect().height > 100);

    const geometry = await page.evaluate(() => {
      const rectObject = element => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      };
      const panels = [...document.querySelectorAll('#grid .panel')];
      return {
        viewport: { width: innerWidth, height: innerHeight },
        grid: rectObject(document.querySelector('#grid')),
        header: rectObject(document.querySelector('.workspace-bar')),
        dock: rectObject(document.querySelector('.dock')),
        panels: panels.map(panel => ({
          ...rectObject(panel),
          headOverflow: panel.querySelector('.panel-head').scrollWidth - panel.querySelector('.panel-head').clientWidth,
          frameWidth: panel.querySelector('iframe').getBoundingClientRect().width
        })),
        splitVisible: getComputedStyle(document.querySelector('#splitHandleX')).display !== 'none',
        horizontalScroll: document.documentElement.scrollWidth - innerWidth,
        verticalScroll: document.documentElement.scrollHeight - innerHeight
      };
    });

    const overlaps = [];
    for (let i = 0; i < geometry.panels.length; i++) {
      for (let j = i + 1; j < geometry.panels.length; j++) {
        const area = overlapArea(geometry.panels[i], geometry.panels[j]);
        if (area > 1) overlaps.push({ i, j, area });
      }
    }
    const columns = maxItemsPerRow(geometry.panels);
    const rows = clusterCount(geometry.panels.map(panel => panel.top));
    const withinGrid = geometry.panels.every(panel =>
      panel.left >= geometry.grid.left - 1
      && panel.top >= geometry.grid.top - 1
      && panel.right <= geometry.grid.right + 1
      && panel.bottom <= geometry.grid.bottom + 1
    );
    const panelSizesValid = geometry.panels.every(panel =>
      panel.width >= 190 && panel.height >= 150 && panel.frameWidth > 0
    );
    const headersFit = geometry.panels.every(panel => panel.headOverflow <= 2);
    const dockVisible = geometry.dock.left >= 0
      && geometry.dock.right <= geometry.viewport.width
      && geometry.dock.bottom <= geometry.viewport.height
      && geometry.dock.height > 40;
    const screenshotPath = path.join(runDir, `${scenario.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    results.push({
      ...scenario,
      screenshotPath,
      geometry,
      observed: { columns, rows },
      overlaps,
      checks: {
        panelCount: geometry.panels.length === scenario.count,
        shape: columns === expectedShape[scenario.count].columns && rows === expectedShape[scenario.count].rows,
        withinGrid,
        panelSizesValid,
        headersFit,
        dockVisible,
        splitVisibility: geometry.splitVisible === (scenario.count === 4),
        noHorizontalScroll: geometry.horizontalScroll <= 1,
        noVerticalScroll: geometry.verticalScroll <= 1
      }
    });
    await page.close();
  }

  const splitPage = await context.newPage();
  await splitPage.setViewportSize({ width: 1600, height: 1000 });
  const splitUrl = `chrome-extension://${extensionId}/workspace.html?id=layout-split-persistence&count=4`;
  await splitPage.goto(splitUrl);
  await splitPage.waitForFunction(() => document.querySelectorAll('#grid .panel').length === 4);
  const handle = await splitPage.locator('#splitHandleX').boundingBox();
  const stage = await splitPage.locator('#gridShell').boundingBox();
  if (!handle || !stage) throw new Error('Four-panel split handle unavailable.');
  await splitPage.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await splitPage.mouse.down();
  await splitPage.mouse.move(stage.x + stage.width * 0.64, handle.y + handle.height / 2, { steps: 8 });
  await splitPage.mouse.up();
  await splitPage.waitForTimeout(150);
  const draggedSplit = await splitPage.locator('#gridShell').evaluate(element =>
    parseFloat(getComputedStyle(element).getPropertyValue('--split-x')) / 100
  );
  await splitPage.waitForTimeout(150);
  await splitPage.reload();
  await splitPage.waitForFunction(() => document.querySelectorAll('#grid .panel').length === 4);
  const restoredSplit = await splitPage.locator('#gridShell').evaluate(element =>
    parseFloat(getComputedStyle(element).getPropertyValue('--split-x')) / 100
  );
  const splitScreenshotPath = path.join(runDir, 'split-persisted.png');
  await splitPage.screenshot({ path: splitScreenshotPath, fullPage: true });
  await splitPage.close();

  const splitPersistence = {
    draggedSplit,
    restoredSplit,
    screenshotPath: splitScreenshotPath,
    passed: Math.abs(draggedSplit - 0.64) < 0.04 && Math.abs(restoredSplit - draggedSplit) < 0.01
  };
  const passed = results.every(result => Object.values(result.checks).every(Boolean))
    && splitPersistence.passed
    && consoleErrors.length === 0;

  console.log(JSON.stringify({ passed, extensionId, results, splitPersistence, consoleErrors, runDir }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true }).catch(() => {});
}
