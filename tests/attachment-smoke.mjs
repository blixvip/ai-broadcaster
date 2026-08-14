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
    'C:/code/brgod/node_modules/playwright'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install it locally or set AIB_PLAYWRIGHT_PATH.');
}

const { chromium } = loadPlaywright();
const runDir = await mkdtemp(path.join(os.tmpdir(), 'aib-attachment-smoke-'));
const profilePath = path.join(runDir, 'profile');
const screenshotPath = path.join(runDir, 'workspace.png');
const browserExecutable = [
  process.env.AIB_CHROME_PATH,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find(existsSync);
if (!browserExecutable) throw new Error('Chrome or Playwright Chromium executable not found.');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function providerFixture({ contenteditable, withButton }) {
  const input = contenteditable
    ? '<div class="ql-editor" contenteditable="true" aria-label="Enter a prompt"></div>'
    : '<textarea id="chat-input" placeholder="Message"></textarea>';
  const button = withButton ? '<button type="submit" aria-label="Send">Send</button>' : '';
  const inputSelector = contenteditable ? '.ql-editor' : '#chat-input';
  return `<!doctype html><html><head><style>
    html,body{height:100%;margin:0;font:16px system-ui;background:#f5f5f5}
    main{height:100%;display:grid;grid-template-rows:auto 1fr;gap:18px;padding:28px;box-sizing:border-box}
    .composer{display:grid;gap:10px}.ql-editor,textarea{min-height:80px;padding:12px;background:#fff;border:1px solid #999}
    button{width:120px;height:42px}.draft-attachment,[data-testid="attachment"]{display:inline-grid;place-items:center;width:46px;height:46px;margin:4px;background:#ccd;font-size:9px}
    [data-testid="user-message"]{padding:10px;border:1px solid #aaa;background:#fff}
  </style></head><body><main>
    <div class="composer">${input}${button}</div><div id="history"></div>
  </main><script>
    window.__submitCount=0; window.__enterCount=0; window.__clickCount=0;
    const composer=document.querySelector('.composer');
    const input=document.querySelector(${JSON.stringify(inputSelector)});
    const inputText=()=>('value' in input?input.value:input.innerText||'');
    const clearInput=()=>{if('value' in input)input.value='';else input.textContent=''};
    input.addEventListener('paste',event=>{
      for(const file of event.clipboardData?.files||[]){
        const attachment=document.createElement('div');
        attachment.className='draft-attachment';
        attachment.dataset.testid='attachment';
        attachment.dataset.name=file.name;
        attachment.dataset.type=file.type;
        attachment.textContent=file.name;
        composer.appendChild(attachment);
      }
    });
    const submit=()=>{
      window.__submitCount++;
      const attachments=[...composer.querySelectorAll('.draft-attachment')];
      const turn=document.createElement('div');
      turn.dataset.testid='user-message';
      const text=document.createElement('span');
      text.textContent=inputText()||'[attachment-only]';
      turn.appendChild(text);
      for(const attachment of attachments){attachment.classList.remove('draft-attachment');turn.appendChild(attachment)}
      document.querySelector('#history').appendChild(turn);
      clearInput();
    };
    input.addEventListener('keydown',event=>{
      if(event.key!=='Enter')return;
      window.__enterCount++;
      ${withButton ? '' : 'submit();'}
    });
    const button=document.querySelector('button');
    if(button)button.addEventListener('click',()=>{window.__clickCount++;submit()});
  </script></body></html>`;
}

const context = await chromium.launchPersistentContext(profilePath, {
  headless: process.env.AIB_HEADLESS === '1',
  executablePath: browserExecutable,
  viewport: { width: 1500, height: 950 },
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
    body: providerFixture({ contenteditable: true, withButton: true })
  }));
  await context.route('https://chat.deepseek.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: providerFixture({ contenteditable: false, withButton: false })
  }));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(String(error)));

  await page.goto(`chrome-extension://${extensionId}/workspace.html?id=attachment-smoke&count=2`);
  await page.waitForSelector('#prompt');
  await page.waitForFunction(() => document.querySelectorAll('#grid iframe').length === 2);

  const waitForFrame = async prefix => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const frame = page.frames().find(candidate => candidate.url().startsWith(prefix));
      if (frame) return frame;
      await page.waitForTimeout(100);
    }
    throw new Error(`Provider fixture frame missing: ${prefix}`);
  };
  const frames = {
    gemini: await waitForFrame('https://gemini.google.com/'),
    deepseek: await waitForFrame('https://chat.deepseek.com/')
  };

  const cases = [
    { id: 'text-only', text: `AIB-TEXT-${Date.now()}`, files: [] },
    {
      id: 'image-only-multi',
      text: '',
      files: [
        { name: 'first.png', mimeType: 'image/png', buffer: png },
        { name: 'second.png', mimeType: 'image/png', buffer: png }
      ]
    },
    {
      id: 'text-plus-image',
      text: `AIB-MIXED-${Date.now()}`,
      files: [{ name: 'single.png', mimeType: 'image/png', buffer: png }]
    }
  ];

  const results = [];
  for (const testCase of cases) {
    if (testCase.text) await page.locator('#prompt').fill(testCase.text);
    if (testCase.files.length) {
      await page.locator('#imageInput').setInputFiles(testCase.files);
      await page.waitForFunction(
        expected => document.querySelectorAll('#imageStrip .image-tile').length === expected,
        testCase.files.length
      );
    }

    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelector('#sendBtn').disabled);
    await page.waitForFunction(
      () => !document.querySelector('#sendBtn').disabled
        && document.querySelector('#status')?.textContent.includes('Verified by all 2 panels'),
      null,
      { timeout: 30000 }
    );

    const providerResults = {};
    for (const [name, frame] of Object.entries(frames)) {
      providerResults[name] = await frame.evaluate(() => {
        const turns = [...document.querySelectorAll('[data-testid="user-message"]')];
        const turn = turns.at(-1);
        return {
          text: turn?.querySelector('span')?.textContent || '',
          attachmentCount: turn?.querySelectorAll('[data-testid="attachment"]').length || 0,
          attachmentNames: [...(turn?.querySelectorAll('[data-testid="attachment"]') || [])]
            .map(node => node.dataset.name),
          submitCount: window.__submitCount,
          clickCount: window.__clickCount,
          enterCount: window.__enterCount
        };
      });
    }

    results.push({
      id: testCase.id,
      expectedText: testCase.text || '[attachment-only]',
      expectedAttachments: testCase.files.length,
      providerResults,
      workspace: {
        prompt: await page.locator('#prompt').inputValue(),
        attachmentTiles: await page.locator('#imageStrip .image-tile').count(),
        status: (await page.locator('#status').textContent())?.trim() || ''
      }
    });
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const passed = results.every(result =>
    result.workspace.prompt === ''
    && result.workspace.attachmentTiles === 0
    && result.workspace.status.includes('Verified by all 2 panels')
    && Object.values(result.providerResults).every(provider =>
      provider.text === result.expectedText
      && provider.attachmentCount === result.expectedAttachments
    )
  )
    && results.at(-1).providerResults.gemini.clickCount === cases.length
    && results.at(-1).providerResults.gemini.enterCount === 0
    && results.at(-1).providerResults.deepseek.clickCount === 0
    && results.at(-1).providerResults.deepseek.enterCount === cases.length
    && consoleErrors.length === 0;

  console.log(JSON.stringify({ passed, extensionId, results, consoleErrors, screenshotPath, runDir }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await context.close();
  await rm(profilePath, { recursive: true, force: true }).catch(() => {});
}
