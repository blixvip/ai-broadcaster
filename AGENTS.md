# AGENTS.md

## Project

Manifest V3 Chrome extension that broadcasts one prompt or attachment set to multiple embedded AI providers.
The extension has no production build step; root JavaScript, HTML, CSS, manifest, and rules are shipping files.

## Commands

- Install developer tools: `npm install`
- Test: `npm test`
- Layout smoke: `npm run smoke:layout`
- Attachment smoke: `npm run smoke:attachments`
- Submit/retry smoke: `npm run smoke:submit`
- Live readiness smoke: `npm run smoke:live`
- Render UI smoke shots: `npm run ui:shot`
- Run Sandcastle maintenance: `npm run sandcastle`

## Structure

- `manifest.json` — permissions, commands, content scripts, and provider hosts.
- `background.js` — frame registration, routing, dynamic rules, and workspace ownership.
- `content.js` — composer discovery, attachment injection, submit, and delivery verification.
- `providers.js` — provider names, URLs, hostnames, and timeout tiers.
- `delivery-protocol.js` — evidence required before a broadcast counts as delivered.
- `workspace.*` / `popup.*` — full workspace and toolbar surfaces.
- `tests/` — Node tests and Playwright visual smoke checks.
- `PROVIDER_AUTOMATION.md` — authoritative provider behavior and maintenance notes.

## Rules

- Read `C:\code\UI-PLAYBOOK.md` before UI work; inspect narrow and wide screenshots.
- Preserve Manifest V3 and the no-window-control boundary.
- Keep provider hostnames and timeout policy centralized in `providers.js`.
- A cleared composer or route change is not delivery proof; update `delivery-protocol.js` and tests together.
- Preserve per-panel isolation, duplicate-attempt suppression, attachment limits, and local-only telemetry.
- Document every permission or host change in the README and provider guide.
- Verify provider DOM changes in a real signed-in Chrome profile; mocks cannot prove live delivery.

## Before finishing

- Run `npm test`.
- For UI/provider work, run `npm run ui:shot` and inspect the images.
- Reload the unpacked extension and verify affected providers manually.
