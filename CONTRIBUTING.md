# Contributing to AI Broadcaster

> 💬 **Before you open a PR, join the [blix open source Discord](https://discord.gg/wJfHQXfEMM).** It's the home for contributors across every blixvip repo: ask questions, run ideas by us, and talk through your PR.

Thanks for helping! Questions and ideas are welcome in the **[Discord](https://discord.gg/wJfHQXfEMM)**, and bugs go in [GitHub issues](https://github.com/blixvip/ai-broadcaster/issues/new/choose).

## Finding something to work on

- [Good first issues](https://github.com/blixvip/ai-broadcaster/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and list the files to touch.
- [Help wanted](https://github.com/blixvip/ai-broadcaster/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are bigger.
- Comment on the issue to claim it so two people don't build the same thing. If you go quiet for a week, it opens up again.
- Have your own idea, such as a new provider? Raise it in the [Discord](https://discord.gg/wJfHQXfEMM) or open an issue before you build anything larger than a bug fix.

By contributing, you agree your work is released under the project's [MIT License](LICENSE).

## Setup

You need a **Chromium-based browser** (Chrome, Edge, Brave) and **Node.js 22+** for the tests. The extension has no build step and no runtime dependencies.

```sh
git clone https://github.com/<you>/ai-broadcaster.git
cd ai-broadcaster
npm test             # 30 node:test cases, no install needed
```

Load it: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the repo folder. After every edit, press the reload icon on the extension card, then reopen the popup or workspace tab. Provider panels only work for sites you are signed in to in that Chrome profile.

The Playwright smoke tests launch the real unpacked extension in a throwaway profile, against intercepted fake provider pages:

```sh
npm install
npx playwright install chromium
npm run smoke:submit      # also smoke:layout, smoke:attachments, ui:shot
```

`AIB_CHROME_PATH`, `AIB_PLAYWRIGHT_PATH` and `AIB_HEADLESS=1` override the browser, the Playwright location and headed mode. `npm run smoke:live` loads real provider sites.

## Before you open a pull request

- Run `npm test`. For UI work also run `npm run ui:shot` and look at the images, at narrow and wide sizes.
- Keep changes small and focused. One fix or feature per pull request.
- Add a screenshot or GIF for UI changes.
- If you touched `content.js` selectors or provider config, say which providers you checked by hand in a real signed-in profile. Fixtures can't prove that a live site still works.
- There is no linter or formatter. Match the file you are editing: 2-space indent, `'use strict'`, plain browser JavaScript, globals exposed from an IIFE (`globalThis.AIB...`).
- Don't add runtime dependencies or a build step.

Rules the code depends on:

- **No window control.** The extension never focuses, moves, resizes, or full-screens windows, and never calls `chrome.tabs.update/move/remove/reload`. `tests/browser-safety.test.mjs` enforces this.
- **Delivery proof stays strict.** A cleared composer or a route change is not proof of delivery. If you change what counts as evidence, update `delivery-protocol.js` and its tests together.
- **One home for providers.** Hostnames, URLs and timeout tiers belong in `providers.js`. The hostname list is also copied into `manifest.json` (three lists) and `rules/ai_frame_rules.json` (two lists), and all of them must match. Follow the checklist at the end of `PROVIDER_AUTOMATION.md`.
- **Permissions are documented.** Any new permission or host goes in the README Permissions table and `PROVIDER_AUTOMATION.md`, with the reason.
- **Telemetry stays local.** `telemetry.js` writes to `chrome.storage` only. Don't add network calls.
- **Tests never touch live accounts** or your everyday Chrome profile.

## Where things live

- `manifest.json`: MV3 permissions, the grab hotkeys, and content scripts for the 34 provider hosts
- `providers.js`: provider keys, labels, URLs, hostnames and the A/B/C timeout tiers
- `background.js`: the service worker. It installs frame-embedding rules, registers panel frames (direct children of a workspace tab only), routes broadcasts and retries, runs the embedded-auth guard, and handles the clipboard-grab hotkeys via the offscreen document
- `content.js`: runs inside each provider panel. Holds the per-site `PLATFORMS` selectors, composer discovery and scoring, text and attachment injection, submit, delivery evidence, and the passive readiness probe
- `delivery-protocol.js`: attachment limits and the strong/weak evidence rules that decide whether a panel is "verified"
- `workspace.html/js/css`: the multi-panel workspace (grid, composer, per-panel controls, retry, Warp hand-off). `popup.html/js/css` is the toolbar popup
- `grab.js`, `offscreen.js`: hover/selection grab on the active page, and clipboard reading for `Alt+Shift+V` / `Alt+Shift+G`
- `rules/ai_frame_rules.json`, `frame-bypass.js`: what lets provider sites load inside iframes
- `PROVIDER_AUTOMATION.md`: the detailed reference for all of the above
- `tests/`: `*.test.mjs` run under `node --test`, and `*-smoke.mjs` are Playwright scripts

Made something with it? Show it off in the [Discord](https://discord.gg/wJfHQXfEMM).
