# AI Broadcaster Provider Automation

This document describes the executable provider architecture. The source of truth is:

- `providers.js` — provider identity, URL, hostnames, defaults, and timeout tier.
- `content.js` — input, submit, stop, response, and attachment selectors.
- `manifest.json` — host access and content-script matches.
- `rules/ai_frame_rules.json` — static iframe response-header rules.
- `background.js` — dynamic frame rules, direct-frame registration, and broadcast routing.

A provider change is incomplete until those files agree.

> No current live-provider audit is implied by this document. Provider websites change without notice; support must be verified in the real extension and browser profile.

## Concurrent timeout tiers

All registered direct panel frames receive a broadcast concurrently. The tier only controls how long `content.js` waits for the provider UI.

| Tier | Input timeout | Submit-control timeout | Intended use |
| --- | ---: | ---: | --- |
| A | 4 seconds | 3 seconds | Faster, relatively stable pages |
| B | 7 seconds | 5 seconds | Search, specialist, or slower pages |
| C | 10 seconds | 7 seconds | Complex or shadow-DOM pages |

Image broadcasts extend the submit-control timeout and have a separate preview/upload readiness timeout.

## Registered providers

| Provider | Primary URL | Registered hosts | Tier |
| --- | --- | --- | :---: |
| Gemini | `https://gemini.google.com/app` | `gemini.google.com` | A |
| DeepSeek | `https://chat.deepseek.com/` | `chat.deepseek.com` | A |
| Le Chat | `https://chat.mistral.ai/` | `chat.mistral.ai` | B |
| Grok | `https://x.com/i/grok` | `x.com`, `www.x.com`, `twitter.com`, `www.twitter.com`, `grok.com` | B |
| Perplexity | `https://www.perplexity.ai/` | `perplexity.ai`, `www.perplexity.ai` | B |
| You.com | `https://you.com/search` | `you.com`, `www.you.com` | B |
| Duck.ai | `https://duck.ai/` | `duck.ai` | B |
| HuggingChat | `https://huggingface.co/chat/` | `huggingface.co` | B |
| Poe | `https://poe.com/` | `poe.com` | B |
| Venice | `https://venice.ai/chat/agent` | `venice.ai`, `www.venice.ai`, `chat.venice.ai` | B |
| Arena | `https://arena.ai/` | `arena.ai`, `lmarena.ai` | B |
| Google AI Studio | `https://aistudio.google.com/prompts/new_chat` | `aistudio.google.com` | B |
| Microsoft Copilot | `https://copilot.microsoft.com/` | `copilot.microsoft.com` | C |
| Qwen | `https://chat.qwen.ai/` | `chat.qwen.ai`, `chat.qwenlm.ai` | C |
| Meta AI | `https://www.meta.ai/` | `meta.ai`, `www.meta.ai` | C |
| Kimi | `https://www.kimi.com/` | `www.kimi.com`, `kimi.com`, `kimi.ai`, `www.kimi.ai`, `kimi.moonshot.cn` | C |
| Blackbox AI | `https://app.blackbox.ai/chat` | `app.blackbox.ai`, `www.blackbox.ai`, `blackbox.ai` | C |

ChatGPT and Claude are not registered providers in the current extension.

## Direct-frame registration

`providers.js` and `content.js` execute on every matched provider frame. `background.js` accepts a registration only when all of the following are true:

1. The sender has a real tab and nonzero frame ID.
2. The hostname is registered in `providers.js`.
3. The sender belongs to an AI Broadcaster workspace tab.
4. `chrome.webNavigation.getFrame()` confirms that the provider is a direct child of the workspace (`parentFrameId === 0`).

Nested provider frames and normal top-level provider tabs are not broadcast targets.

## Composer discovery

`content.js` starts with ordered provider-specific selectors and expands to semantic fallbacks after 1.8 seconds. Candidate discovery traverses the document and open shadow roots.

Candidates are rejected when they are hidden, disabled, inert, authentication fields, menu/listbox controls, or inputs inside a narrow navigation/settings rail. Remaining candidates are scored using:

- Provider selector priority.
- Prompt/message/chat semantics.
- Editable element type.
- Form or composer ancestry.
- Element dimensions.
- Distance from the frame's bottom-center composer anchor.
- Current focus.

Closed shadow roots cannot be traversed.

## Text insertion

### Inputs and textareas

The injector uses the native prototype `value` setter, rewinds React's private `_valueTracker`, and dispatches `beforeinput`, `input`, and `change`. It then verifies that the intended text remains in the control.

### Rich-text editors

For ProseMirror, Lexical, Slate, Quill, and generic contenteditables, it tries:

1. `document.execCommand('insertText')`.
2. A synthetic clipboard paste.
3. Direct text mutation plus input/change events.

Each fallback is checked before the next strategy runs.

## Existing generation handling

Before altering a draft, the injector searches for a visible provider stop-generation control. It clicks at most once and waits for the control to remain absent. If the provider never becomes idle, the broadcast fails with `generation_did_not_stop` rather than editing a busy conversation.

## Attachments

The payload supports images and PDFs. Validation runs before dispatch with limits of eight files, 20 MB per file, and 48 MB combined. Unsupported, malformed, oversized, and excessive batches are rejected locally.

Qwen uses its known hidden file input when its `accept` and `multiple` constraints match the batch; all providers retain synthetic clipboard paste as the fallback.

The injector:

1. Waits for existing composer upload activity to settle.
2. Captures the current attachment-preview and remove-control baseline.
3. Injects the batch exactly once.
4. Waits for the expected number of new visible previews.
5. Requires previews to become ready and upload indicators to become idle.
6. Refuses to submit when readiness cannot be confirmed.
7. Attempts rollback using only remove controls that appeared after baseline.

A confirmed rollback permits safe targeted retry. An incomplete rollback remains non-retryable because files may still be attached. Current failure reason: `attachment_not_ready`.

## Submission and verification

The injector prefers the highest-scoring enabled provider submit control and clicks it once. If no usable control appears before the tier timeout, it dispatches one Enter fallback. Attempt IDs are cached so delivery of the same attempt message cannot dispatch a second action.

Before the action, the content script captures a provider-UI baseline. It then observes the document and open shadow roots while polling conservatively for post-baseline evidence. A panel is verified only after strong evidence appears:

- A new user-message wrapper containing the submitted text.
- A new attachment-bearing user turn for file-only delivery.
- A stop-generation control that was absent at baseline.
- New semantic assistant-response activity.

Composer clearing, attachment consumption, route changes, input replacement, and unmatched user turns remain weak evidence. Weak evidence never clears the shared workspace draft.

The workspace clears its exact text and attachment payload only when every expected panel is strongly verified. Partial, unverified, failed, and no-target deliveries retain the payload. Panel retry is offered only for failures known to occur before a submit action; evidence timeouts are intentionally not auto-retryable because the provider may already have accepted the message.

## Current result reasons

The content layer can return:

- `duplicate`
- `no_config:<host>`
- `generation_did_not_stop`
- `login_required`
- `no_input:<host>`
- `text_not_inserted`
- `attachment_not_ready`
- `frame_busy`
- `weak_evidence_only`
- `evidence_timeout`
- `no_registered_frame`
- `unreachable`
- `internal_error`

## Adding or changing a provider

1. Update `providers.js`.
2. Add every hostname to `manifest.json` host permissions and both provider content-script match lists.
3. Update static DNR domains in `rules/ai_frame_rules.json`.
4. Add or alias the provider configuration in `content.js`.
5. Validate JavaScript and JSON syntax.
6. Reload the unpacked extension.
7. Verify embedding, registration, text insertion, submission evidence, attachment readiness, authentication state, and response capture in the real Chrome profile.
