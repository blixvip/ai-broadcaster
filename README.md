# AI Broadcaster

Run named workspaces that broadcast prompts and images to free-tier AI chats — one message, many providers, at once.

AI Broadcaster is a Manifest V3 Chrome extension. It embeds supported AI chat sites as live panels inside a workspace tab, then injects one prompt (text and/or images) into every registered panel and verifies delivery in each one independently.

## Table of Contents

- [Features](#features)
- [Registered Providers](#registered-providers)
- [Install (Unpacked)](#install-unpacked)
- [Usage](#usage)
- [Permissions](#permissions)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Testing](#testing)
- [Automated Maintenance (Sandcastle)](#automated-maintenance-sandcastle)
- [Optional: Screenshot Hotkey (Windows)](#optional-screenshot-hotkey-windows)
- [Privacy](#privacy)
- [Known Limitations](#known-limitations)
- [License](#license)

## Features

- **One prompt, many models** — type or paste once in the workspace composer; the extension delivers it to every provider panel currently registered in that workspace.
- **Provider panels embedded in a workspace tab** (`workspace.html`), plus a lightweight popup (`popup.html`) for quick single-shot prompts.
- **Image and PDF attachments** — up to 8 files per broadcast, 20 MB per file, 48 MB combined; validated locally before dispatch (`content.js`).
- **Clipboard grab hotkeys** — `Alt+Shift+V` pastes clipboard image/text into the composer, `Alt+Shift+G` pastes and immediately broadcasts (`manifest.json` commands, `grab.js`, `offscreen.js`).
- **No window control** — the extension never focuses, minimizes, maximizes, resizes, or moves Chrome windows. Explicitly opening a workspace creates one tab; background grabs create an inactive tab only when needed.
- **Delivery verification per panel**, not just "clicked submit" — each panel is confirmed via evidence such as a new user-message wrapper, a stop-generation control appearing, or new assistant activity before the shared draft is cleared (`delivery-protocol.js`).
- **Concurrent per-provider timeout tiers** (A/B/C) so slower or shadow-DOM-heavy providers get more time without slowing down faster ones — see [`PROVIDER_AUTOMATION.md`](PROVIDER_AUTOMATION.md).
- **Local-only telemetry** — attempt/verified/failed counters kept in `chrome.storage` for diagnosing delivery issues, never transmitted off-device (`telemetry.js`).

## Registered Providers

Full detail, including timeout tiers and hostnames, is in [`PROVIDER_AUTOMATION.md`](PROVIDER_AUTOMATION.md). As of `manifest.json` v1.5.3:

Gemini, DeepSeek, Le Chat (Mistral), Grok (x.com/grok.com), Perplexity, You.com, Duck.ai, HuggingChat, Poe, Venice, Arena/LMArena, Google AI Studio, Microsoft Copilot, Qwen, Meta AI, Kimi, Blackbox AI.

> ChatGPT and Claude are not registered providers in the current extension.
>
> Provider sites change without notice — support is not continuously audited and should be verified in a real Chrome profile before relying on it.

## Install (Unpacked)

There is no packaged/store release. Load it as an unpacked extension:

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder.
5. Pin the AI Broadcaster icon from the extensions toolbar menu.

**Prerequisites:** a Chromium-based browser (Manifest V3 support). The extension itself has no build step or runtime dependencies. Optional developer automation uses the dev-only packages in `package.json`.

## Usage

- Click the toolbar icon for the quick **popup** composer, or open the full **workspace** (`workspace.html`) to arrange multiple provider panels side by side.
- Type a prompt (and optionally attach images/PDFs), then send — it broadcasts to every panel registered in that workspace.
- `Alt+Shift+V` — paste clipboard image/text into the composer.
- `Alt+Shift+G` — paste clipboard image/text into the composer **and** broadcast immediately.
- Providers that require login will report `login_required` for that panel rather than silently failing.

## Permissions

Declared in `manifest.json`:

| Permission | Why |
| --- | --- |
| `tabs`, `webNavigation` | Detect and register provider frames inside a workspace tab. |
| `declarativeNetRequest` | Apply static iframe/header rules (`rules/ai_frame_rules.json`) so providers can be embedded as frames. |
| `storage` | Persist workspace state and local telemetry. |
| `clipboardRead`, `offscreen` | Read clipboard image/text via an offscreen document for the grab hotkeys (`offscreen.js`) — a service worker can't read the clipboard directly. |
| `browsingData` | Clear selected provider caches before iframe navigation when preparing embedded panels. |
| `nativeMessaging` | Send a selected panel response to the optional `com.ai_broadcaster.warp` native host. |

Host permissions and content scripts are scoped to the registered provider domains listed above, plus a broad `http(s)://*/*` match for `grab.js` (the hover-to-grab content script, no `all_frames`).

## Project Structure

```
.
├── manifest.json                  # MV3 manifest: permissions, hosts, content scripts
├── background.js                  # Service worker: frame registration, dynamic rules, broadcast routing
├── content.js                     # Composer discovery, text/attachment injection, submit + verification
├── providers.js                   # Provider identity, URLs, hostnames, timeout tier
├── delivery-protocol.js           # Evidence rules for verifying a delivered/failed broadcast
├── frame-bypass.js                # MAIN-world script injected at document_start on provider frames
├── grab.js                        # Global content script: hover-grab image/text under cursor
├── offscreen.html / offscreen.js  # Offscreen document for clipboard reads (service workers can't read clipboard)
├── popup.html / popup.js / popup.css      # Toolbar popup composer
├── workspace.html / workspace.js / workspace.css  # Multi-panel workspace UI
├── provider-marks.js               # TODO: purpose not covered in PROVIDER_AUTOMATION.md — confirm before relying on it
├── telemetry.js                    # Local-only attempt/verified/failed counters in chrome.storage
├── rules/ai_frame_rules.json       # Static declarativeNetRequest rules for embedding provider frames
├── icons/                          # Extension + brand icons
├── tests/                          # node:test suites (see Testing)
├── screenshot-to-broadcaster.ahk   # Optional Windows AutoHotkey v2 companion script
└── PROVIDER_AUTOMATION.md          # Source-of-truth doc for provider wiring and injection behavior
```

## Architecture

See [`PROVIDER_AUTOMATION.md`](PROVIDER_AUTOMATION.md) for the full, authoritative description. Summary:

1. **Embedding** — `rules/ai_frame_rules.json` (static) and `background.js` (dynamic) rewrite frame-blocking headers so provider sites can load inside the workspace tab.
2. **Registration** — `background.js` accepts a provider frame as a broadcast target only if it has a real tab/frame ID, a hostname registered in `providers.js`, belongs to an AI Broadcaster workspace tab, and is a direct child frame (`parentFrameId === 0`), confirmed via `chrome.webNavigation.getFrame()`.
3. **Injection** — `content.js` locates the composer (provider-specific selectors first, semantic fallback after 1.8s, including open shadow roots), then inserts text via the native value setter + React `_valueTracker` rewind, or rich-text strategies (`execCommand('insertText')` → synthetic paste → direct mutation) for ProseMirror/Lexical/Slate/Quill/contenteditables.
4. **Submission** — clicks the highest-scoring enabled submit control, or falls back to one Enter keypress; duplicate attempts are suppressed via cached attempt IDs.
5. **Verification** — `delivery-protocol.js` requires strong evidence (new user-message wrapper, new attachment turn, a stop-generation control appearing, or new assistant activity) before the shared workspace draft is cleared. Weak evidence (composer clearing, route change, etc.) never clears the draft.

## Testing

Tests use Node's built-in test runner (`node:test`) with no test framework dependency:

```bash
npm test
npm run ui:shot

# Or run an individual verifier:
node tests/delivery-protocol.test.mjs
node tests/input-regressions.test.mjs
node tests/telemetry.test.mjs
node tests/attachment-smoke.mjs
node tests/layout-smoke.mjs
node tests/submit-smoke.mjs
```

For an end-to-end check against the real unpacked extension (no live provider accounts touched), see `.claude/skills/verify/SKILL.md`:

```bash
node tests/submit-smoke.mjs
```

## Automated Maintenance (Sandcastle)

Issues labelled `Sandcastle` can be implemented and reviewed by two Claude Code agents in an isolated Docker worktree. Each run processes at most one issue and leaves closure and merge decisions to a human.

```bash
npm install
npm run sandcastle
```

Configuration lives in `.sandcastle/`. Docker Desktop must be running. Authentication uses the blank declarations in `.sandcastle/.env` with fallback to the user's `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` environment variables.

## Optional: Screenshot Hotkey (Windows)

`screenshot-to-broadcaster.ahk` (AutoHotkey v2) adds a system-wide `Ctrl+Alt+Shift+V` hotkey that screenshots the monitor under your mouse and leaves the image on the clipboard. It never activates Chrome or sends keystrokes; paste the image into the broadcaster when ready. The script is optional.

## Privacy

- `telemetry.js` stores only local counters (attempts/verified/unverified/failed, versioned under `aib_telemetry_v1`) in `chrome.storage` — nothing is sent off-device.
- The only outbound `fetch` in the codebase is in `grab.js`, converting an already-visible hovered image's URL into a data URL for the composer (`credentials: 'omit'`) — not telemetry or exfiltration.
- No backend, analytics, or third-party service is included in this repository.

## Known Limitations

- Provider selectors and detection logic are inherently fragile to upstream UI changes; see the "no current live-provider audit is implied" note in `PROVIDER_AUTOMATION.md`. **TODO:** run the authenticated live-provider matrix after loading this checkout into the user's normal Chrome profile; automated fixture and UI-shell checks do not prove current third-party DOM compatibility.
- Closed shadow roots cannot be traversed for composer discovery.
- No CI workflow is configured in this repository.

## License

TODO: no `LICENSE` file is present in this repository. Add one before treating this as open source.
