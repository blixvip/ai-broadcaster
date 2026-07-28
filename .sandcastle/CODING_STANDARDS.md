# Coding Standards

- Use plain JavaScript and existing browser APIs; this extension has no build step or runtime dependencies.
- Keep modules focused and reuse existing provider, delivery, and telemetry helpers.
- Treat content-script/page data, messages, URLs, and attachments as untrusted input.
- Preserve Manifest V3 service-worker constraints and explicit message validation.
- Do not widen permissions or host matches without documented necessity.
- Use `node:test`; add the smallest regression test that proves changed behavior.
- Controlled fixture tests may launch temporary browser profiles. Never automate live accounts or the active Chrome profile.
