---
name: verify
description: Launch the unpacked AI Broadcaster extension and verify workspace-to-provider submission without touching live accounts.
---

# Verify AI Broadcaster

## Controlled submit verification

From `C:\Code\ai-broadcaster`, run:

```bash
node tests/submit-smoke.mjs
```

The script launches the real unpacked MV3 extension in a new temporary Chromium profile, opens its workspace, and runs controlled image/PDF deliveries through intercepted provider fixtures:

- Verified delivery requires strong evidence such as a matching user turn; click and Enter paths each dispatch exactly once.
- A fully verified delivery clears its original prompt and attachment.
- A pre-dispatch provider failure preserves the draft and exposes a safe retry for only that panel; verified siblings must not receive the retry.
- Completing the targeted retry clears the now-fully-verified draft.
- An all-unverified post-dispatch delivery preserves the prompt and attachment and exposes no unsafe retry control.

A passing run prints `"passed": true`, zero console errors, per-panel delivery evidence, workspace summaries, and the screenshot path. Open that screenshot and confirm the three-panel workspace and retained failed draft are visibly rendered.

## Attachment matrix

Run:

```bash
node tests/attachment-smoke.mjs
```

This drives text-only, image-only with two images, and text-plus-image broadcasts through both contenteditable/button and textarea/Enter provider fixtures. A passing run proves exact per-provider attachment counts, attachment order, strong image-only evidence, and workspace cleanup after verification.

Playwright resolution order is `AIB_PLAYWRIGHT_PATH`, local `node_modules/playwright`, then this machine's existing `C:\code\brgod\node_modules\playwright`.

## Live-provider boundary

The controlled verifier proves extension bootstrap, iframe registration, workspace broadcast, image/PDF injection, exactly-once submit routing, strong-evidence classification, safe targeted retry, and draft recovery. It does **not** prove current external selectors, authentication, cookies, anti-bot behavior, live-provider attachment controls, or response quality.

Those require the user's normal Chrome profile: reload the unpacked extension, open a two-panel workspace, broadcast a unique nonce, and verify a real user turn plus response start in each panel. Never copy, attach automation to, or launch against the active Chrome profile; preserve existing sessions.
