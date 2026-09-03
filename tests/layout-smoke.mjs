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
const runDir = await mkdtemp(path.join(os.tmpdir(), 'aib-layout-smoke-'));
const profilePath = path.join(runDir, 'profile');
const browserExecutable = [
  process.env.AIB_CHROME_PATH,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find(existsSync);

if (!browserExecutable) throw new Error('Chrome or Playwright Chromium executable not found.');

const context = await chromium.launchPersistentContext(profilePath, {
  headless: process.env.AIB_HEADLESS === '1',
  executablePath: browserExecutable,
  viewport: { width: 1600, height: 1000 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--window-position=-32000,-32000',
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

function instrumentShaderDraws(page) {
  return page.addInitScript(() => {
    window.__shaderDraws = 0;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getInstrumentedContext(type, ...args) {
      const context = originalGetContext.call(this, type, ...args);
      if (type === 'webgl2' && context && !context.__aibInstrumented) {
        const originalDrawArrays = context.drawArrays.bind(context);
        context.drawArrays = (...drawArgs) => {
          window.__shaderDraws += 1;
          return originalDrawArrays(...drawArgs);
        };
        context.__aibInstrumented = true;
      }
      return context;
    };
  });
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
    ...[2, 4, 6].map(count => ({ name: `compact-${count}`, count, width: 900, height: 780 })),
    ...[2, 4, 6].map(count => ({ name: `narrow-${count}`, count, width: 720, height: 760 }))
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

  const splitXHandle = splitPage.locator('#splitHandleX');
  await splitXHandle.focus();
  await splitPage.keyboard.press('End');
  const splitAtEnd = Number(await splitXHandle.getAttribute('aria-valuenow'));
  await splitPage.keyboard.press('Shift+ArrowLeft');
  const splitAfterLargeStep = Number(await splitXHandle.getAttribute('aria-valuenow'));
  await splitPage.keyboard.press('Home');
  const splitAtHome = Number(await splitXHandle.getAttribute('aria-valuenow'));
  const splitKeyboard = {
    splitAtEnd,
    splitAfterLargeStep,
    splitAtHome,
    orientation: await splitXHandle.getAttribute('aria-orientation'),
    passed: splitAtEnd === 72
      && splitAfterLargeStep === 67
      && splitAtHome === 28
      && await splitXHandle.getAttribute('aria-orientation') === 'vertical'
  };

  await splitPage.locator('#focusModeBtn').focus();
  await splitPage.evaluate(() => {
    void pickWarpPane([
      { id: 'pane-a', label: 'Pane A', detail: 'First', app: 'Warp', active: true },
      { id: 'pane-b', label: 'Pane B', detail: 'Second', app: 'Warp', active: false }
    ]).then(value => { window.__warpPickerResult = value; });
  });
  const warpDialog = splitPage.locator('.warp-modal[role="dialog"][aria-modal="true"]');
  await warpDialog.waitFor();
  const warpLabelledBy = await warpDialog.getAttribute('aria-labelledby');
  const warpInitialFocus = await splitPage.evaluate(() => document.activeElement?.value || '');
  await splitPage.keyboard.press('Shift+Tab');
  const warpWrappedBackward = await splitPage.evaluate(() => document.activeElement?.textContent?.trim() || '');
  await splitPage.keyboard.press('Tab');
  const warpWrappedForward = await splitPage.evaluate(() => document.activeElement?.value || '');
  await splitPage.keyboard.press('Escape');
  await warpDialog.waitFor({ state: 'detached' });
  const warpPicker = {
    labelled: !!warpLabelledBy,
    initialFocus: warpInitialFocus,
    wrappedBackward: warpWrappedBackward,
    wrappedForward: warpWrappedForward,
    result: await splitPage.evaluate(() => window.__warpPickerResult),
    restoredFocus: await splitPage.evaluate(() => document.activeElement?.id || ''),
    passed: !!warpLabelledBy
      && warpInitialFocus === 'pane-a'
      && warpWrappedBackward === 'Paste only'
      && warpWrappedForward === 'pane-a'
      && await splitPage.evaluate(() => window.__warpPickerResult) === null
      && await splitPage.evaluate(() => document.activeElement?.id) === 'focusModeBtn'
  };

  await splitPage.setViewportSize({ width: 720, height: 700 });
  await splitPage.locator('#focusModeBtn').click();
  await splitPage.locator('.panel').nth(2).locator('iframe').focus();
  await splitPage.waitForTimeout(900);
  const focusMode = await splitPage.evaluate(() => {
    const panels = [...document.querySelectorAll('#grid .panel')];
    return {
      enabled: document.documentElement.classList.contains('focus-mode'),
      focused: panels.filter(panel => panel.classList.contains('is-focused')).map(panel => panel.dataset.id),
      opacities: panels.map(panel => Number(getComputedStyle(panel).opacity))
    };
  });
  focusMode.passed = focusMode.enabled
    && focusMode.focused.length === 1
    && focusMode.focused[0] === '2'
    && focusMode.opacities[2] >= 0.99
    && focusMode.opacities.filter((_, index) => index !== 2).every(value => value <= 0.3);

  const firstSoloButton = splitPage.locator('.panel-solo').first();
  await firstSoloButton.click();
  await splitPage.waitForFunction(() => document.querySelector('#gridShell')?.classList.contains('has-solo-panel'));
  const soloVisiblePanels = await splitPage.locator('#grid .panel:visible').count();
  const soloButtonTitle = await firstSoloButton.getAttribute('title');
  const soloGeometry = await splitPage.evaluate(() => {
    const grid = document.querySelector('#grid').getBoundingClientRect();
    const panel = document.querySelector('#grid .panel.is-solo').getBoundingClientRect();
    return {
      grid: { left: grid.left, top: grid.top, right: grid.right, bottom: grid.bottom },
      panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
      horizontalScroll: document.documentElement.scrollWidth - innerWidth,
      verticalScroll: document.documentElement.scrollHeight - innerHeight
    };
  });
  await firstSoloButton.click();
  await splitPage.waitForFunction(() => !document.querySelector('#gridShell')?.classList.contains('has-solo-panel'));
  const restoredVisiblePanels = await splitPage.locator('#grid .panel:visible').count();
  const splitScreenshotPath = path.join(runDir, 'split-persisted.png');
  await splitPage.screenshot({ path: splitScreenshotPath, fullPage: true });
  await splitPage.close();

  const splitPersistence = {
    draggedSplit,
    restoredSplit,
    screenshotPath: splitScreenshotPath,
    passed: Math.abs(draggedSplit - 0.64) < 0.04 && Math.abs(restoredSplit - draggedSplit) < 0.01
  };
  const soloPanel = {
    soloVisiblePanels,
    soloButtonTitle,
    soloGeometry,
    restoredVisiblePanels,
    passed: soloVisiblePanels === 1
      && soloButtonTitle === 'Restore grid'
      && restoredVisiblePanels === 4
      && Math.abs(soloGeometry.grid.left - soloGeometry.panel.left) <= 2
      && Math.abs(soloGeometry.grid.top - soloGeometry.panel.top) <= 2
      && Math.abs(soloGeometry.grid.right - soloGeometry.panel.right) <= 2
      && Math.abs(soloGeometry.grid.bottom - soloGeometry.panel.bottom) <= 2
      && soloGeometry.horizontalScroll <= 1
      && soloGeometry.verticalScroll <= 1
  };

  const retentionPage = await context.newPage();
  retentionPage.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`count-retention: ${message.text()}`);
  });
  retentionPage.on('pageerror', error => consoleErrors.push(`count-retention: ${String(error)}`));
  await retentionPage.setViewportSize({ width: 1600, height: 1000 });
  await retentionPage.goto(`chrome-extension://${extensionId}/workspace.html?id=layout-count-retention&count=4`);
  await retentionPage.waitForFunction(() => document.querySelectorAll('#grid .panel').length === 4);
  await Promise.all(retentionPage.frames()
    .filter(frame => frame.parentFrame() === retentionPage.mainFrame())
    .map(frame => frame.waitForLoadState('load')));
  const initialEpochs = await retentionPage.evaluate(() =>
    [...document.querySelectorAll('#grid .panel')].map(panel => {
      const frame = panel.querySelector('iframe');
      frame.dataset.retentionProbe = panel.dataset.id;
      frame.dataset.probeLoads = '0';
      frame.addEventListener('load', () => {
        frame.dataset.probeLoads = String(Number(frame.dataset.probeLoads || 0) + 1);
      });
      return panel.dataset.panelEpoch;
    })
  );

  await retentionPage.locator('#panelCount button[data-count="6"]').click();
  await retentionPage.waitForFunction(() => document.querySelectorAll('#grid .panel').length === 6);
  await Promise.all(retentionPage.frames()
    .filter(frame => frame.parentFrame() === retentionPage.mainFrame())
    .map(frame => frame.waitForLoadState('load')));
  const grownRetention = await retentionPage.evaluate(expectedEpochs =>
    [...document.querySelectorAll('#grid .panel')].slice(0, 4).map((panel, id) => {
      const frame = panel.querySelector('iframe');
      return {
        id,
        sameNode: frame.dataset.retentionProbe === String(id),
        reloads: Number(frame.dataset.probeLoads || 0),
        sameEpoch: panel.dataset.panelEpoch === expectedEpochs[id]
      };
    }), initialEpochs);

  await retentionPage.locator('#panelCount button[data-count="2"]').click();
  await retentionPage.waitForFunction(() => document.querySelectorAll('#grid .panel').length === 2);
  await retentionPage.waitForTimeout(200);
  const shrunkRetention = await retentionPage.evaluate(expectedEpochs =>
    [...document.querySelectorAll('#grid .panel')].map((panel, id) => {
      const frame = panel.querySelector('iframe');
      return {
        id,
        sameNode: frame.dataset.retentionProbe === String(id),
        reloads: Number(frame.dataset.probeLoads || 0),
        sameEpoch: panel.dataset.panelEpoch === expectedEpochs[id]
      };
    }), initialEpochs);

  await retentionPage.waitForFunction(async () => {
    const tab = await chrome.tabs.getCurrent();
    const { reg = {} } = await chrome.storage.session.get('reg');
    return Object.values(reg).filter(frame => frame.tabId === tab.id && frame.panelId).length === 2;
  });
  const registryAfterShrink = await retentionPage.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    const { reg = {} } = await chrome.storage.session.get('reg');
    return Object.values(reg)
      .filter(frame => frame.tabId === tab.id && frame.panelId)
      .map(frame => ({ panelId: frame.panelId, panelEpoch: frame.panelEpoch }))
      .sort((a, b) => a.panelId.localeCompare(b.panelId));
  });

  await retentionPage.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__restoreSendMessage = () => { chrome.runtime.sendMessage = original; };
    chrome.runtime.sendMessage = (message, ...args) => message?.action === 'prepareFrames'
      ? Promise.resolve({ ok: false, reason: 'Synthetic preparation failure' })
      : original(message, ...args);
  });
  await retentionPage.locator('#panelCount button[data-count="6"]').click();
  await retentionPage.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('Synthetic preparation failure')
  );
  const preparationRollback = await retentionPage.evaluate(async () => {
    const state = await chrome.storage.local.get('aib_workspace_state_layout-count-retention');
    return {
      panelCount: document.querySelectorAll('#grid .panel').length,
      twoSelected: document.querySelector('#panelCount button[data-count="2"]')?.getAttribute('aria-pressed'),
      sixSelected: document.querySelector('#panelCount button[data-count="6"]')?.getAttribute('aria-pressed'),
      savedCount: state.aib_workspace_state_layout_count_retention?.count
        ?? state['aib_workspace_state_layout-count-retention']?.count
        ?? null,
      status: document.querySelector('#status')?.textContent || ''
    };
  });
  await retentionPage.evaluate(() => window.__restoreSendMessage?.());
  preparationRollback.passed = preparationRollback.panelCount === 2
    && preparationRollback.twoSelected === 'true'
    && preparationRollback.sixSelected === 'false'
    && preparationRollback.savedCount === 2
    && preparationRollback.status.includes('Synthetic preparation failure');
  await retentionPage.close();

  const shaderPage = await context.newPage();
  shaderPage.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`shader-idle: ${message.text()}`);
  });
  shaderPage.on('pageerror', error => consoleErrors.push(`shader-idle: ${String(error)}`));
  await instrumentShaderDraws(shaderPage);
  await shaderPage.setViewportSize({ width: 1200, height: 800 });
  await shaderPage.goto(`chrome-extension://${extensionId}/workspace.html?id=layout-shader-idle&count=2`);
  await shaderPage.waitForFunction(() => window.__shaderDraws > 0);
  await shaderPage.locator('#composer').hover();
  await shaderPage.waitForTimeout(1400);
  const hoverSettled = await shaderPage.evaluate(() => window.__shaderDraws);
  await shaderPage.waitForTimeout(500);
  const hoverIdle = await shaderPage.evaluate(() => window.__shaderDraws);
  await shaderPage.locator('#composer').evaluate(element => element.classList.add('is-broadcasting'));
  await shaderPage.waitForTimeout(350);
  const broadcastingStart = await shaderPage.evaluate(() => window.__shaderDraws);
  await shaderPage.waitForTimeout(350);
  const broadcastingEnd = await shaderPage.evaluate(() => window.__shaderDraws);
  await shaderPage.locator('#composer').evaluate(element => element.classList.remove('is-broadcasting'));
  await shaderPage.waitForTimeout(1500);
  const postBroadcastSettled = await shaderPage.evaluate(() => window.__shaderDraws);
  await shaderPage.waitForTimeout(500);
  const postBroadcastIdle = await shaderPage.evaluate(() => window.__shaderDraws);
  const shaderIdle = {
    hoverSettled,
    hoverIdle,
    broadcastingStart,
    broadcastingEnd,
    postBroadcastSettled,
    postBroadcastIdle,
    passed: hoverIdle === hoverSettled
      && broadcastingEnd > broadcastingStart + 2
      && postBroadcastIdle === postBroadcastSettled
  };
  await shaderPage.close();

  const reducedShaderPage = await context.newPage();
  reducedShaderPage.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`shader-reduced-motion: ${message.text()}`);
  });
  reducedShaderPage.on('pageerror', error => consoleErrors.push(`shader-reduced-motion: ${String(error)}`));
  await reducedShaderPage.emulateMedia({ reducedMotion: 'reduce' });
  await instrumentShaderDraws(reducedShaderPage);
  await reducedShaderPage.setViewportSize({ width: 1200, height: 800 });
  await reducedShaderPage.goto(`chrome-extension://${extensionId}/workspace.html?id=layout-shader-reduced&count=2`);
  await reducedShaderPage.waitForFunction(() => window.__shaderDraws > 0);
  await reducedShaderPage.locator('#composer').hover();
  await reducedShaderPage.waitForTimeout(120);
  const reducedHoverDraws = await reducedShaderPage.evaluate(() => window.__shaderDraws);
  await reducedShaderPage.waitForTimeout(450);
  const reducedHoverIdle = await reducedShaderPage.evaluate(() => window.__shaderDraws);
  await reducedShaderPage.locator('#composer').evaluate(element => element.classList.add('is-broadcasting'));
  await reducedShaderPage.waitForTimeout(120);
  const reducedBroadcastDraws = await reducedShaderPage.evaluate(() => window.__shaderDraws);
  await reducedShaderPage.waitForTimeout(450);
  const reducedBroadcastIdle = await reducedShaderPage.evaluate(() => window.__shaderDraws);
  const reducedShader = {
    mediaMatches: await reducedShaderPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    reducedHoverDraws,
    reducedHoverIdle,
    reducedBroadcastDraws,
    reducedBroadcastIdle,
    passed: await reducedShaderPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
      && reducedHoverIdle === reducedHoverDraws
      && reducedBroadcastDraws > reducedHoverDraws
      && reducedBroadcastIdle === reducedBroadcastDraws
  };
  await reducedShaderPage.close();

  const countRetention = {
    grownRetention,
    shrunkRetention,
    registryAfterShrink,
    passed: [...grownRetention, ...shrunkRetention].every(panel =>
      panel.sameNode && panel.reloads === 0 && panel.sameEpoch)
      && registryAfterShrink.length === 2
      && registryAfterShrink.every((frame, id) => frame.panelId.endsWith(`:${id}`))
  };
  const passed = results.every(result => Object.values(result.checks).every(Boolean))
    && splitPersistence.passed
    && splitKeyboard.passed
    && warpPicker.passed
    && focusMode.passed
    && soloPanel.passed
    && countRetention.passed
    && preparationRollback.passed
    && shaderIdle.passed
    && reducedShader.passed
    && consoleErrors.length === 0;

  console.log(JSON.stringify({
    passed,
    extensionId,
    results,
    splitPersistence,
    splitKeyboard,
    warpPicker,
    focusMode,
    soloPanel,
    countRetention,
    preparationRollback,
    shaderIdle,
    reducedShader,
    consoleErrors,
    runDir
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true }).catch(() => {});
}
