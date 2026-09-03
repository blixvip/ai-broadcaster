import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const extensionPath = fileURLToPath(new URL('..', import.meta.url));
const { applyProviderPromptPolicy } = require(path.join(extensionPath, 'prompt-policy.js'));

function loadPlaywright() {
  const candidates = [
    process.env.AIB_PLAYWRIGHT_PATH,
    path.join(extensionPath, 'node_modules', 'playwright'),
    'C:/live/brgod/node_modules/playwright'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }

  throw new Error(
    'Playwright not found. Install it locally or set AIB_PLAYWRIGHT_PATH to its package directory.'
  );
}

const { chromium } = loadPlaywright();
const runDir = await mkdtemp(path.join(os.tmpdir(), 'aib-submit-probe-'));
const profilePath = path.join(runDir, 'profile');
const screenshotPath = path.join(runDir, 'workspace.png');
const browserExecutable = [
  process.env.AIB_CHROME_PATH,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find(existsSync);
if (!browserExecutable) throw new Error('Chrome or Playwright Chromium executable not found.');

// These controlled provider pages exercise the real unpacked extension, iframe
// registry, workspace broadcast, content-script injection, and submit behavior
// without touching live providers or the user’s authenticated Chrome profile.
function buttonFixture() {
  return `<!doctype html><html><head><style>
    html,body{height:100%;margin:0;font:16px system-ui;background:#f5f5f5}
    main{height:100%;display:grid;place-content:center;gap:16px}
    .ql-editor{width:520px;min-height:90px;padding:12px;background:#fff;border:1px solid #999}
    button{width:120px;height:44px} #result{color:#064}
  </style></head><body><main>
    <div class="ql-editor" contenteditable="true" aria-label="Enter a prompt"></div>
    <button type="submit" aria-label="Send">Send</button><div id="result"></div>
  </main><script>
    window.__clickCount=0; window.__enterCount=0; window.__acceptSubmission=true;
    window.__stopCount=0; window.__insertedBeforeStop=false; window.__generationActive=true;
    const input=document.querySelector('.ql-editor');
    input.addEventListener('paste',event=>{
      const text=event.clipboardData?.getData('text/plain')||'';
      if(text)input.textContent=text;
    });
    const initialStop=document.createElement('button');
    initialStop.textContent='Stop generating';
    initialStop.addEventListener('click',()=>{
      window.__stopCount++;
      setTimeout(()=>{ window.__generationActive=false; initialStop.remove(); },120);
    });
    document.body.appendChild(initialStop);
    let revertInsertions=3;
    new MutationObserver(()=>{
      if(!input.textContent)return;
      if(window.__generationActive)window.__insertedBeforeStop=true;
      if(revertInsertions-->0)queueMicrotask(()=>{ input.textContent=''; });
    }).observe(input,{subtree:true,childList:true,characterData:true});
    input.addEventListener('paste',event=>{
      for(const file of event.clipboardData?.files||[]){
        const attachment=document.createElement('div');
        attachment.dataset.testid='attachment';
        attachment.style.cssText='width:40px;height:40px;background:#ccd';
        attachment.textContent=file.name;
        input.parentElement.appendChild(attachment);
      }
    });
    input.addEventListener('keydown',event=>{if(event.key==='Enter')window.__enterCount++});
    document.querySelector('button').addEventListener('click',()=>{
      window.__clickCount++;
      if(!window.__acceptSubmission)return;
      const value=input.innerText;
      const turn=document.createElement('div');
      turn.dataset.testid='user-message';
      turn.textContent=value;
      for(const attachment of input.parentElement.querySelectorAll(':scope > [data-testid="attachment"]'))turn.appendChild(attachment);
      input.parentElement.appendChild(turn);
      document.querySelector('#result').textContent=value;
      input.textContent='';
      const stop=document.createElement('button');
      stop.dataset.testid='stop-button'; stop.setAttribute('aria-label','Stop generating'); stop.textContent='Stop';
      document.body.appendChild(stop);
      setTimeout(()=>{
        const response=document.createElement('model-response');
        const body=document.createElement('message-content'); body.textContent='Mock response for '+value;
        response.appendChild(body); document.querySelector('main').appendChild(response);
        stop.remove();
      },500);
    });
  </script></body></html>`;
}

function enterFallbackFixture() {
  return `<!doctype html><html><head><style>
    html,body{height:100%;margin:0;font:16px system-ui;background:#f5f5f5}
    main{height:100%;display:grid;place-content:center;gap:16px}
    textarea{width:520px;min-height:90px;padding:12px;background:#fff;border:1px solid #999}
    #result{color:#064}
  </style></head><body><main>
    <textarea id="chat-input" placeholder="Message"></textarea><div id="result"></div>
  </main><script>
    window.__clickCount=0; window.__enterCount=0; window.__acceptSubmission=true;
    const input=document.querySelector('#chat-input');
    input.addEventListener('paste',event=>{
      for(const file of event.clipboardData?.files||[]){
        const attachment=document.createElement('div');
        attachment.dataset.testid='attachment';
        attachment.style.cssText='width:40px;height:40px;background:#ccd';
        attachment.textContent=file.name;
        input.parentElement.appendChild(attachment);
      }
    });
    input.addEventListener('keypress',event=>{
      if(event.key!=='Enter')return;
      window.__enterCount++;
      if(!window.__acceptSubmission)return;
      const value=input.value;
      const turn=document.createElement('div');
      turn.dataset.testid='user-message';
      turn.textContent=value;
      for(const attachment of input.parentElement.querySelectorAll(':scope > [data-testid="attachment"]'))turn.appendChild(attachment);
      input.parentElement.appendChild(turn);
      document.querySelector('#result').textContent=value;
      input.value='';
    });
  </script></body></html>`;
}

function unconfirmedButtonFixture() {
  return `<!doctype html><html><head><style>
    html,body{height:100%;margin:0;font:16px system-ui;background:#f5f5f5}
    main{height:100%;display:grid;place-content:center;gap:16px}
    textarea{width:520px;min-height:90px;padding:12px;background:#fff;border:1px solid #999}
    button{width:120px;height:44px}
  </style></head><body><main>
    <textarea name="prompt-textarea" placeholder="Message"></textarea>
    <button data-testid="minds-chat-send-button" type="button">Send</button>
    <div id="result"></div>
  </main><script>
    window.__clickCount=0; window.__enterCount=0; window.__acceptSubmission=true;
    const main=document.querySelector('main');
    const bindComposer=(input,button)=>{
      input.addEventListener('paste',event=>{
        for(const file of event.clipboardData?.files||[]){
          const attachment=document.createElement('div');
          attachment.dataset.testid='attachment';
          attachment.style.cssText='width:40px;height:40px;background:#ccd';
          attachment.textContent=file.name;
          input.parentElement.appendChild(attachment);
        }
      });
      input.addEventListener('keydown',event=>{if(event.key==='Enter')window.__enterCount++});
      button.addEventListener('click',()=>{
        window.__clickCount++;
        if(!window.__acceptSubmission)return;
        const value=input.value;
        const turn=document.createElement('div');
        turn.dataset.testid='user-message';
        turn.textContent=value;
        for(const attachment of input.parentElement.querySelectorAll(':scope > [data-testid="attachment"]'))turn.appendChild(attachment);
        input.parentElement.appendChild(turn);
        document.querySelector('#result').textContent=value;
        input.value='';
      });
    };
    window.__removeComposer=()=>{
      main.querySelector('textarea')?.remove();
      main.querySelector('button')?.remove();
    };
    window.__installComposer=()=>{
      if(main.querySelector('textarea'))return;
      const input=document.createElement('textarea');
      input.name='prompt-textarea'; input.placeholder='Message';
      const button=document.createElement('button');
      button.dataset.testid='minds-chat-send-button'; button.type='button'; button.textContent='Send';
      const result=document.querySelector('#result');
      main.insertBefore(input,result); main.insertBefore(button,result);
      bindComposer(input,button);
    };
    bindComposer(main.querySelector('textarea'),main.querySelector('button'));
  </script></body></html>`;
}

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

try {
  await context.route('https://gemini.google.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: buttonFixture()
  }));
  await context.route('https://chat.deepseek.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: enterFallbackFixture()
  }));
  await context.route('https://venice.ai/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: unconfirmedButtonFixture()
  }));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(String(error)));

  await page.goto(`chrome-extension://${extensionId}/workspace.html?id=submit-probe&count=3`);
  await page.waitForSelector('#prompt');
  await page.waitForFunction(() => document.querySelectorAll('#grid iframe').length === 3);

  const nonce = `AIB-SUBMIT-PROBE-${Date.now()}`;
  const deepseekExpected = applyProviderPromptPolicy('chat.deepseek.com', nonce);
  await page.locator('#prompt').fill(nonce);
  await page.locator('#imageInput').setInputFiles({
    name: 'success-probe.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  });
  await page.waitForFunction(() => document.querySelectorAll('#imageStrip .image-tile').length === 1);
  await page.locator('#sendBtn').click();

  const waitForProviderFrame = async prefix => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const frame = page.frames().find(candidate => candidate.url().startsWith(prefix));
      if (frame) return frame;
      await page.waitForTimeout(100);
    }
    throw new Error(`Provider fixture frame missing: ${prefix}`);
  };
  const gemini = await waitForProviderFrame('https://gemini.google.com/');
  const deepseek = await waitForProviderFrame('https://chat.deepseek.com/');
  const venice = await waitForProviderFrame('https://venice.ai/');

  await gemini.waitForFunction(
    expected => document.querySelector('#result')?.textContent === expected,
    nonce,
    { timeout: 15000 }
  );
  await deepseek.waitForFunction(
    expected => document.querySelector('#result')?.textContent === expected,
    deepseekExpected,
    { timeout: 15000 }
  );
  await venice.waitForFunction(
    expected => document.querySelector('#result')?.textContent === expected,
    nonce,
    { timeout: 15000 }
  );

  const buttonPath = await gemini.evaluate(() => ({
    clickCount: window.__clickCount,
    enterCount: window.__enterCount,
    stopCount: window.__stopCount,
    insertedBeforeStop: window.__insertedBeforeStop,
    result: document.querySelector('#result')?.textContent || '',
    badge: document.querySelector('#aib-debug-badge')?.textContent || ''
  }));
  const fallbackPath = await deepseek.evaluate(() => ({
    clickCount: window.__clickCount,
    enterCount: window.__enterCount,
    result: document.querySelector('#result')?.textContent || '',
    badge: document.querySelector('#aib-debug-badge')?.textContent || ''
  }));
  const thirdButtonPath = await venice.evaluate(() => ({
    clickCount: window.__clickCount,
    enterCount: window.__enterCount,
    result: document.querySelector('#result')?.textContent || '',
    badge: document.querySelector('#aib-debug-badge')?.textContent || ''
  }));

  const fullWorkspaceStatus = (await page.locator('#status').textContent())?.trim() || '';
  const successfulRecovery = {
    prompt: await page.locator('#prompt').inputValue(),
    attachmentTiles: await page.locator('#imageStrip .image-tile').count()
  };

  // The popup retains the same draft after a partial delivery and retries only
  // the panel that failed before any submit action.
  await venice.evaluate(() => { window.__removeComposer(); });
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on('console', message => { if (message.type() === 'error') popupErrors.push(message.text()); });
  popup.on('pageerror', error => popupErrors.push(String(error)));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupNonce = `AIB-POPUP-RETRY-${Date.now()}`;
  await popup.locator('#prompt').fill(popupNonce);
  await popup.locator('#imageInput').setInputFiles({
    name: 'popup-retry.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')
  });
  await popup.waitForFunction(() => document.querySelectorAll('#imagePreview .attachment-chip').length === 1);
  await popup.locator('#broadcastBtn').click();
  await popup.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('2/3 panels verified'),
    null,
    { timeout: 30000 }
  );
  const popupPartialCounts = {
    geminiClicks: await gemini.evaluate(() => window.__clickCount),
    deepseekEnters: await deepseek.evaluate(() => window.__enterCount),
    veniceClicks: await venice.evaluate(() => window.__clickCount)
  };
  const popupPartialRecovery = {
    prompt: await popup.locator('#prompt').inputValue(),
    attachmentChips: await popup.locator('#imagePreview .attachment-chip').count(),
    status: (await popup.locator('#status').textContent())?.trim() || '',
    button: (await popup.locator('#broadcastBtn').textContent())?.trim() || ''
  };
  await venice.evaluate(() => { window.__installComposer(); });
  await popup.locator('#broadcastBtn').click();
  await popup.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('Verified by all 3 panels'),
    null,
    { timeout: 30000 }
  );
  const popupRetryRecovery = {
    prompt: await popup.locator('#prompt').inputValue(),
    attachmentChips: await popup.locator('#imagePreview .attachment-chip').count(),
    status: (await popup.locator('#status').textContent())?.trim() || '',
    buttonDisabled: await popup.locator('#broadcastBtn').isDisabled(),
    counts: {
      geminiClicks: await gemini.evaluate(() => window.__clickCount),
      deepseekEnters: await deepseek.evaluate(() => window.__enterCount),
      veniceClicks: await venice.evaluate(() => window.__clickCount)
    }
  };
  await popup.close();

  // READY is continuously supervised: removing a composer must invalidate the
  // state, and restoring it must recover without reloading the iframe.
  await page.waitForFunction(
    () => ['ready', 'verified'].includes(document.querySelector('.panel[data-provider="venice"]')?.dataset.deliveryState),
    null,
    { timeout: 10000 }
  );
  await venice.evaluate(() => { window.__removeComposer(); });
  await page.waitForFunction(
    () => document.querySelector('.panel[data-provider="venice"]')?.dataset.deliveryState === 'checking',
    null,
    { timeout: 10000 }
  );
  const invalidatedReadiness = await page.locator('.panel[data-provider="venice"]').getAttribute('data-delivery-state');
  await venice.evaluate(() => { window.__installComposer(); });
  await page.waitForFunction(
    () => document.querySelector('.panel[data-provider="venice"]')?.dataset.deliveryState === 'ready',
    null,
    { timeout: 10000 }
  );
  const recoveredReadiness = await page.locator('.panel[data-provider="venice"]').getAttribute('data-delivery-state');

  // Probe a safe pre-dispatch failure: the third provider temporarily has no
  // composer, so only that panel may be retried after the first two verify.
  await venice.evaluate(() => { window.__removeComposer(); });
  const partialNonce = `AIB-PARTIAL-PROBE-${Date.now()}`;
  await page.locator('#prompt').fill(partialNonce);
  await page.locator('#imageInput').setInputFiles({
    name: 'partial-probe.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')
  });
  await page.waitForFunction(() => document.querySelectorAll('#imageStrip .image-tile').length === 1);
  await page.locator('#sendBtn').click();
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('2/3 verified'),
    null,
    { timeout: 30000 }
  );
  const venicePanel = page.locator('.panel[data-provider="venice"]');
  const partialRecovery = {
    prompt: await page.locator('#prompt').inputValue(),
    attachmentTiles: await page.locator('#imageStrip .image-tile').count(),
    workspaceStatus: (await page.locator('#status').textContent())?.trim() || '',
    retryVisible: await venicePanel.locator('.panel-retry').isVisible(),
    counts: {
      geminiClicks: await gemini.evaluate(() => window.__clickCount),
      deepseekEnters: await deepseek.evaluate(() => window.__enterCount),
      veniceClicks: await venice.evaluate(() => window.__clickCount)
    }
  };

  await venice.evaluate(() => { window.__installComposer(); });
  await venicePanel.locator('.panel-retry').click();
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('Verified by all 3 panels'),
    null,
    { timeout: 30000 }
  );
  const safeRetryRecovery = {
    prompt: await page.locator('#prompt').inputValue(),
    attachmentTiles: await page.locator('#imageStrip .image-tile').count(),
    workspaceStatus: (await page.locator('#status').textContent())?.trim() || '',
    counts: {
      geminiClicks: await gemini.evaluate(() => window.__clickCount),
      deepseekEnters: await deepseek.evaluate(() => window.__enterCount),
      veniceClicks: await venice.evaluate(() => window.__clickCount)
    }
  };

  // Probe an unsafe all-unverified delivery. Since every submit action was
  // dispatched, no automatic retry is offered and the draft remains untouched.
  await Promise.all([
    gemini.evaluate(() => { window.__acceptSubmission = false; }),
    deepseek.evaluate(() => { window.__acceptSubmission = false; }),
    venice.evaluate(() => { window.__acceptSubmission = false; })
  ]);
  const retryNonce = `AIB-RETRY-PROBE-${Date.now()}`;
  await page.locator('#prompt').fill(retryNonce);
  await page.locator('#imageInput').setInputFiles({
    name: 'retry-probe.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  });
  await page.waitForFunction(() => document.querySelectorAll('#imageStrip .image-tile').length === 1);
  await page.locator('#sendBtn').click();
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('provider acceptance could not be proven'),
    null,
    { timeout: 30000 }
  );

  const failedRecovery = {
    prompt: await page.locator('#prompt').inputValue(),
    attachmentTiles: await page.locator('#imageStrip .image-tile').count(),
    workspaceStatus: (await page.locator('#status').textContent())?.trim() || '',
    retryButtonsVisible: await page.locator('.panel-retry:visible').count()
  };

  // A changed draft may start a new delivery after an unresolved idle attempt.
  // A second command while that delivery is in flight, and a command blocked by
  // attachment loading, must never be acknowledged as broadcasting.
  await Promise.all([
    gemini.evaluate(() => { window.__acceptSubmission = true; }),
    deepseek.evaluate(() => { window.__acceptSubmission = true; }),
    venice.evaluate(() => { window.__acceptSubmission = true; })
  ]);
  const commandNonce = `AIB-COMMAND-PROBE-${Date.now()}`;
  const busyNonce = `AIB-BUSY-PROBE-${Date.now()}`;
  const commandExpected = `${retryNonce}\n\n${commandNonce}`;
  const commandOutcomes = await page.evaluate(({ commandNonce: next, busyNonce: busy }) => ({
    accepted: addToComposer(next, [], true),
    busy: addToComposer(busy, [], true)
  }), { commandNonce, busyNonce });
  await gemini.waitForFunction(
    () => window.__clickCount >= 4,
    null,
    { timeout: 15000 }
  );
  await page.waitForFunction(
    () => !document.querySelector('#sendBtn')?.disabled,
    null,
    { timeout: 30000 }
  );
  const commandProviderResult = await gemini.evaluate(() => document.querySelector('#result')?.textContent || '');
  const commandRecovery = {
    prompt: await page.locator('#prompt').inputValue(),
    attachmentTiles: await page.locator('#imageStrip .image-tile').count(),
    workspaceStatus: (await page.locator('#status').textContent())?.trim() || ''
  };
  const loadingNonce = `AIB-LOADING-GUARD-${Date.now()}`;
  const attachmentLoadingOutcome = await page.evaluate(next => {
    pendingAttachmentLoads += 1;
    try { return addToComposer(next, [], true); }
    finally { pendingAttachmentLoads -= 1; }
  }, loadingNonce);

  const telemetryBeforeReset = await page.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'getTelemetry' }));
  const telemetryReset = await page.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'resetTelemetry' }));
  const telemetryAfterReset = await page.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'getTelemetry' }));

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const passed = buttonPath.clickCount === 1
    && buttonPath.enterCount === 0
    && buttonPath.stopCount === 1
    && buttonPath.insertedBeforeStop === false
    && buttonPath.result === nonce
    && fallbackPath.clickCount === 0
    && fallbackPath.enterCount === 1
    && fallbackPath.result === deepseekExpected
    && thirdButtonPath.clickCount === 1
    && thirdButtonPath.enterCount === 0
    && thirdButtonPath.result === nonce
    && fullWorkspaceStatus.includes('Verified by all 3 panels')
    && successfulRecovery.prompt === ''
    && successfulRecovery.attachmentTiles === 0
    && popupPartialRecovery.prompt === popupNonce
    && popupPartialRecovery.attachmentChips === 1
    && popupPartialRecovery.status.includes('2/3 panels verified')
    && popupPartialRecovery.button === 'Retry 1 Safe Panel'
    && popupRetryRecovery.prompt === ''
    && popupRetryRecovery.attachmentChips === 0
    && popupRetryRecovery.status.includes('Verified by all 3 panels')
    && popupRetryRecovery.buttonDisabled === false
    && popupRetryRecovery.counts.geminiClicks === popupPartialCounts.geminiClicks
    && popupRetryRecovery.counts.deepseekEnters === popupPartialCounts.deepseekEnters
    && popupRetryRecovery.counts.veniceClicks === popupPartialCounts.veniceClicks + 1
    && popupErrors.length === 0
    && invalidatedReadiness === 'checking'
    && recoveredReadiness === 'ready'
    && partialRecovery.prompt === partialNonce
    && partialRecovery.attachmentTiles === 1
    && partialRecovery.workspaceStatus.includes('2/3 verified')
    && partialRecovery.retryVisible
    && safeRetryRecovery.prompt === ''
    && safeRetryRecovery.attachmentTiles === 0
    && safeRetryRecovery.workspaceStatus.includes('Verified by all 3 panels')
    && safeRetryRecovery.counts.geminiClicks === partialRecovery.counts.geminiClicks
    && safeRetryRecovery.counts.deepseekEnters === partialRecovery.counts.deepseekEnters
    && safeRetryRecovery.counts.veniceClicks === partialRecovery.counts.veniceClicks + 1
    && failedRecovery.prompt === retryNonce
    && failedRecovery.attachmentTiles === 1
    && failedRecovery.workspaceStatus.includes('provider acceptance could not be proven')
    && failedRecovery.retryButtonsVisible === 0
    && commandOutcomes.accepted?.added === true
    && commandOutcomes.accepted?.broadcasted === true
    && commandOutcomes.busy?.added === true
    && commandOutcomes.busy?.broadcasted === false
    && commandOutcomes.busy?.reason === 'delivery_in_progress'
    && commandProviderResult.replace(/\s+/g, ' ').trim() === commandExpected.replace(/\s+/g, ' ').trim()
    && commandRecovery.prompt === `${commandExpected}\n\n${busyNonce}`
    && commandRecovery.attachmentTiles === 1
    && commandRecovery.workspaceStatus.includes('Verified by all 3 panels')
    && attachmentLoadingOutcome?.added === true
    && attachmentLoadingOutcome?.broadcasted === false
    && attachmentLoadingOutcome?.reason === 'attachment_loading'
    && telemetryBeforeReset?.ok
    && telemetryBeforeReset.snapshot?.totals?.attempts === 17
    && telemetryBeforeReset.snapshot?.totals?.responseSamples >= 1
    && telemetryBeforeReset.snapshot?.providers?.gemini?.retries === 0
    && telemetryBeforeReset.snapshot?.providers?.deepseek?.retries === 0
    && telemetryBeforeReset.snapshot?.providers?.venice?.retries === 2
    && telemetryBeforeReset.ranking?.length === 3
    && telemetryReset?.ok
    && telemetryAfterReset.snapshot?.totals?.attempts === 0
    && consoleErrors.length === 0;

  console.log(JSON.stringify({
    passed,
    extensionId,
    nonce,
    buttonPath,
    fallbackPath,
    thirdButtonPath,
    fullWorkspaceStatus,
    successfulRecovery,
    popupNonce,
    popupPartialRecovery,
    popupPartialCounts,
    popupRetryRecovery,
    popupErrors,
    invalidatedReadiness,
    recoveredReadiness,
    partialNonce,
    partialRecovery,
    safeRetryRecovery,
    retryNonce,
    failedRecovery,
    commandNonce,
    busyNonce,
    commandOutcomes,
    commandProviderResult,
    commandRecovery,
    loadingNonce,
    attachmentLoadingOutcome,
    telemetryBeforeReset,
    telemetryReset,
    telemetryAfterReset,
    consoleErrors,
    screenshotPath,
    runDir
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true }).catch(() => {});
}
