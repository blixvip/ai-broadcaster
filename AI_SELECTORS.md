# AI Broadcaster — Selector Reference

Every AI the extension supports is listed here: its URL, which DOM element is the chat input, which element is the send button, and which dispatch group it belongs to.

**Dispatch groups** control how long the extension waits per AI and run as three parallel sequences:
- **Group A** — fast, reliable AIs with stable selectors (input timeout 4 s, submit timeout 3 s)
- **Group B** — search/specialist AIs (input timeout 7 s, submit timeout 5 s)
- **Group C** — complex/shadow-DOM AIs that need more time (input timeout 10 s, submit timeout 7 s)

---

## Group A — Foundation AIs

### ChatGPT
| Field | Value |
|---|---|
| URL | `https://chatgpt.com/` |
| Domain | `chatgpt.com` |
| Input | `#prompt-textarea` → fallback: `div[contenteditable="true"][aria-label]` |
| Submit | `button[data-testid="send-button"]` → `button[aria-label="Send prompt"]` |
| Input type | contenteditable |
| Notes | `#prompt-textarea` is a contenteditable div, not a real textarea |

### Claude
| Field | Value |
|---|---|
| URL | `https://claude.ai/new` |
| Domain | `claude.ai` |
| Input | `.ProseMirror[contenteditable="true"]` → `div[contenteditable="true"][data-placeholder]` |
| Submit | `button[aria-label="Send message"]` → `button[data-testid="send-button"]` |
| Input type | contenteditable |

### Gemini
| Field | Value |
|---|---|
| URL | `https://gemini.google.com/app` |
| Domain | `gemini.google.com` |
| Input | `.ql-editor[contenteditable="true"]` → `rich-textarea div[contenteditable="true"]` |
| Submit | `button.send-button` → `button[aria-label*="Send" i]` |
| Input type | contenteditable (Quill editor) |

### DeepSeek
| Field | Value |
|---|---|
| URL | `https://chat.deepseek.com/` |
| Domain | `chat.deepseek.com` |
| Input | `textarea#chat-input` |
| Submit | `div[role="button"][aria-label*="Send" i]` (a div, not a button!) |
| Input type | textarea |
| Notes | Send button is a `div[role="button"]`, not a `<button>` |

### Le Chat (Mistral)
| Field | Value |
|---|---|
| URL | `https://chat.mistral.ai/` |
| Domain | `chat.mistral.ai` |
| Input | `textarea[data-testid="chat-input"]` → `textarea[placeholder*="Ask" i]` |
| Submit | `button[data-testid="send-button"]` → `button[type="submit"]` |
| Input type | textarea |

### Grok
| Field | Value |
|---|---|
| URL | `https://grok.com/` |
| Domain | `grok.com` |
| Input | `textarea[data-testid="userInput"]` → `textarea[placeholder*="Ask" i]` |
| Submit | `button[data-testid="send-button"]` → `button[aria-label*="Send" i]` |
| Input type | textarea |

---

## Group B — Search & Specialist AIs

### Perplexity
| Field | Value |
|---|---|
| URL | `https://www.perplexity.ai/` |
| Domains | `perplexity.ai`, `www.perplexity.ai` |
| Input | `#ask-input[contenteditable="true"]` → `div[contenteditable="true"][data-lexical-editor="true"]` → `textarea[placeholder*="Ask"]` |
| Submit | `button[aria-label="Submit"]` (exact match) → `button[data-testid="submit-button"]` |
| Input type | auto (Lexical editor — contenteditable) |
| Notes | Perplexity switched to a Lexical contenteditable `#ask-input`; textarea fallback kept for older paths |

### You.com
| Field | Value |
|---|---|
| URL | `https://you.com/search` |
| Domains | `you.com`, `www.you.com` |
| Input | `textarea#search-input-textarea` → `textarea[data-testid="search-input"]` |
| Submit | `button[aria-label="Submit query"]` → `button[data-testid="submit-button"]` |
| Input type | auto |

### Duck.ai
| Field | Value |
|---|---|
| URL | `https://duck.ai/` |
| Domain | `duck.ai` |
| Input | `textarea[data-testid*="message" i]` → `textarea[placeholder*="Ask" i]` |
| Submit | `button[data-testid*="send" i]` → `button[aria-label*="Send" i]` |
| Input type | auto |

### HuggingChat
| Field | Value |
|---|---|
| URL | `https://huggingface.co/chat/` |
| Domain | `huggingface.co` |
| Input | `div[contenteditable="true"][aria-label*="message" i]` → `textarea[placeholder]` |
| Submit | `button[data-testid="send-btn"]` → `button[aria-label*="Send" i]` |
| Input type | auto |

### Poe
| Field | Value |
|---|---|
| URL | `https://poe.com/` |
| Domain | `poe.com` |
| Input | `textarea[class*="GrowingTextArea" i]` → `textarea[placeholder*="Talk" i]` |
| Submit | `button[class*="SendButton" i]` → `button[data-testid*="send" i]` |
| Input type | textarea |

### Venice
| Field | Value |
|---|---|
| URL | `https://venice.ai/chat/agent` |
| Domain | `venice.ai` |
| Input | `textarea[aria-label*="Chat message" i]` → `textarea[name="prompt-textarea"]` |
| Submit | `button[data-testid="minds-chat-send-button"]` → `button[aria-label*="Send" i]` |
| Input type | textarea |

### LMArena / Arena
| Field | Value |
|---|---|
| URL | `https://arena.ai/` |
| Domains | `arena.ai`, `lmarena.ai` |
| Input | `textarea[name="message"]` → `textarea[data-testid="textbox"]` |
| Submit | `button[aria-label="Send"]` → `button[data-testid*="send" i]` |
| Input type | auto |
| Notes | Formerly chatbot arena (lmarena.ai), now arena.ai; both domains supported |

### AI Studio (Google)
| Field | Value |
|---|---|
| URL | `https://aistudio.google.com/prompts/new_chat` |
| Domain | `aistudio.google.com` |
| Input | `textarea[aria-label*="prompt" i]` → `ms-prompt-input-wrapper textarea` → `rich-textarea textarea` |
| Submit | `button[aria-label*="Run" i]` → `button[mattooltip*="Run" i]` → `run-button button` |
| Input type | auto |
| Notes | Uses Angular Material components; submit button says "Run", not "Send" |

---

## Group C — Complex / Shadow-DOM AIs

### Copilot (Microsoft)
| Field | Value |
|---|---|
| URL | `https://copilot.microsoft.com/` |
| Domain | `copilot.microsoft.com` |
| Input | `textarea#userInput` → `textarea[data-testid="composer-input"]` → `cib-text-input textarea` (shadow DOM) → `div[contenteditable="true"][aria-label*="Ask" i]` |
| Submit | `button[data-testid="submit-button"]` → `button[aria-label="Submit message"]` → `button[aria-label="Submit"]` → `cib-action-bar button[aria-label*="Submit" i]` |
| Input type | auto |
| preClick | YES — input must be clicked to activate before text injection |
| Notes | Heavy shadow-DOM via web components (`cib-text-input`, `cib-action-bar`). The `queryAllDeep` function pierces all shadow roots automatically. Click activation is required. |

### Qwen (Alibaba)
| Field | Value |
|---|---|
| URL | `https://chat.qwen.ai/` |
| Domains | `chat.qwen.ai`, `chat.qwenlm.ai` |
| Input | `.ql-editor[contenteditable="true"]` → `div[contenteditable="true"][data-placeholder]` → `div[contenteditable="true"][class*="input" i]` |
| Submit | `button[type="submit"]` → `button[aria-label*="Send" i]` → `button[class*="send" i]` |
| Input type | auto (Quill editor) |
| Notes | Uses Quill editor (`.ql-editor`). Both `chat.qwen.ai` and `chat.qwenlm.ai` supported. |

### Meta AI
| Field | Value |
|---|---|
| URL | `https://www.meta.ai/` |
| Domains | `meta.ai`, `www.meta.ai` |
| Input | `div[contenteditable="true"][aria-placeholder*="Ask" i]` → `div[aria-label*="Message Meta AI" i][contenteditable]` → `div[role="textbox"][contenteditable="true"]` |
| Submit | `div[aria-label*="Send" i][role="button"]` (a div, not a button!) → `button[aria-label*="Send" i]` |
| Input type | contenteditable |
| Notes | Send button is a `div[role="button"]`. Input is a contenteditable div with `aria-placeholder`. |

### Kimi (Moonshot AI)
| Field | Value |
|---|---|
| URL | `https://www.kimi.com/` |
| Domains | `kimi.com`, `www.kimi.com`, `kimi.ai`, `www.kimi.ai`, `kimi.moonshot.cn` |
| Input | `div[contenteditable="true"][data-lexical-editor="true"]` → `div[contenteditable="true"][class*="editor" i]` |
| Submit | `button[data-testid="send-button"]` → `button[aria-label*="Send" i]` → `button[class*="send" i]` |
| Input type | contenteditable (Lexical editor) |
| Notes | Uses Lexical editor. New primary domain is `kimi.com`; old `kimi.ai` and `kimi.moonshot.cn` still work. |

### Blackbox AI
| Field | Value |
|---|---|
| URL | `https://app.blackbox.ai/chat` |
| Domains | `app.blackbox.ai`, `www.blackbox.ai`, `blackbox.ai` |
| Input | `textarea#userInput` → `textarea[id*="Input" i]` → `textarea[placeholder*="Ask" i]` |
| Submit | `button#sendButton` → `button[id*="send" i]` → `button[aria-label*="Send" i]` |
| Input type | textarea |
| Notes | Uses stable element IDs (`#userInput`, `#sendButton`). Primary domain is now `app.blackbox.ai`. |

---

## Dispatch Architecture

```
broadcast()
  ├── Sequence A (Promise.all) — ChatGPT, Claude, Gemini, DeepSeek, Mistral, Grok
  │     payload: { group: 'A', inputTimeout: 4000, submitTimeout: 3000 }
  │
  ├── Sequence B (Promise.all) — Perplexity, You.com, Duck.ai, HuggingChat,
  │     Poe, Venice, LMArena/Arena, AI Studio
  │     payload: { group: 'B', inputTimeout: 7000, submitTimeout: 5000 }
  │
  └── Sequence C (Promise.all) — Copilot, Qwen, Meta AI, Kimi, Blackbox
        payload: { group: 'C', inputTimeout: 10000, submitTimeout: 7000 }
```

All three sequences fire simultaneously via a top-level `Promise.all`. Each AI tab/frame receives its message at the same instant and runs its injection independently. The group label tells the content script how long to wait, so fast AIs aren't held back by slow ones.

## Adding a New AI

1. Add the provider to `providers.js` with a `group` field (`'A'`, `'B'`, or `'C'`).
2. Add its hostname(s) to `manifest.json` under both `host_permissions` and both `content_scripts[].matches` arrays.
3. Add the same hostname(s) to both `requestDomains` arrays in `rules/ai_frame_rules.json`.
4. Add a platform config to `content.js` `PLATFORMS` with precise `inputSels`, `submitSels`, `type`, `group`, and optionally `preClick: true`.
