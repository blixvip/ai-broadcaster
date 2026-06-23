# AI Broadcaster Provider Automation Map

Last live selector audit: 2026-05-21.

`providers.js` is the URL and hostname registry. `content.js` is the executable
selector registry. Keep both files in sync with `manifest.json` and
`rules/ai_frame_rules.json` when a provider redirects to a new host.

## Three broadcast sequences

`background.js` splits loaded chat frames into three parallel sequences. Every
payload carries the sequence group to the content script.

| Group | Use | Input timeout | Submit timeout |
| --- | --- | --- | --- |
| A | Stable general chats | 4 seconds | 3 seconds |
| B | Search and specialist chats | 7 seconds | 5 seconds |
| C | Complex, redirecting, or shadow-DOM chats | 10 seconds | 7 seconds |

## Provider map

The selector column shows the first provider-specific choices. `content.js`
keeps generic textarea, contenteditable, and nearby submit-button fallbacks
after these selectors.

| Provider | Open URL | Supported hosts | Group | Primary composer selectors | Primary send selectors |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | `https://chatgpt.com/` | `chatgpt.com` | A | `#prompt-textarea` | `button[data-testid="send-button"]`, `button[aria-label="Send prompt"]` |
| Claude | `https://claude.ai/new` | `claude.ai` | A | `.ProseMirror[contenteditable="true"]` | `button[aria-label="Send message"]`, `button[data-testid="send-button"]` |
| Gemini | `https://gemini.google.com/app` | `gemini.google.com` | A | `.ql-editor[contenteditable="true"]`, `rich-textarea div[contenteditable="true"]` | `.send-button` |
| DeepSeek | `https://chat.deepseek.com/` | `chat.deepseek.com` | A | `textarea#chat-input` | `div[role="button"][aria-label*="Send"]`, `button[type="submit"]` |
| Le Chat | `https://chat.mistral.ai/` | `chat.mistral.ai` | A | `textarea[data-testid="chat-input"]`, `textarea[placeholder]` | `button[data-testid="send-button"]`, `button[type="submit"]` |
| Grok | `https://grok.com/` | `grok.com` | A | `textarea[data-testid="userInput"]`, `textarea[placeholder]` | `button[data-testid="send-button"]`, `button[type="submit"]` |
| Perplexity | `https://www.perplexity.ai/` | `perplexity.ai`, `www.perplexity.ai` | B | `#ask-input[contenteditable="true"]`, `#ask-input[role="textbox"]` | `button[aria-label="Submit"]` |
| You.com | `https://you.com/search` | `you.com`, `www.you.com` | B | `#search-input-textarea` | `button[aria-label="Submit query"]`, `button[type="submit"]` |
| Duck.ai | `https://duck.ai/` | `duck.ai` | B | `textarea[placeholder*="Ask"]` | `button[aria-label*="Send"]` |
| HuggingChat | `https://huggingface.co/chat/` | `huggingface.co` | B | `textarea[placeholder*="Ask"]` | `button[aria-label*="Send"]` |
| Poe | `https://poe.com/` | `poe.com` | B | `textarea[class*="GrowingTextArea"]`, `textarea[placeholder]` | `button[class*="SendButton"]`, `button[type="submit"]` |
| Venice | `https://venice.ai/chat/agent` | `venice.ai` | B | `textarea[aria-label*="Chat message"]`, `textarea[name="prompt-textarea"]` | `button[data-testid="minds-chat-send-button"]`, `button[aria-label*="Send"]` |
| Arena | `https://arena.ai/` | `arena.ai`, `lmarena.ai` | B | `textarea[name="message"]` | `button[type="submit"]` |
| AI Studio | `https://aistudio.google.com/prompts/new_chat` | `aistudio.google.com` | B | `textarea[aria-label*="prompt"]`, `rich-textarea textarea` | `button[aria-label*="Run"]`, `run-button button` |
| Copilot | `https://copilot.microsoft.com/` | `copilot.microsoft.com` | C | `#userInput`, `textarea[data-testid="composer-input"]` | `button[data-testid="submit-button"]`, `button[aria-label="Submit message"]` |
| Qwen | `https://chat.qwen.ai/` | `chat.qwen.ai`, `chat.qwenlm.ai` | C | `textarea.message-input-textarea` | `button.send-button` |
| Meta AI | `https://www.meta.ai/` | `meta.ai`, `www.meta.ai` | C | `div[contenteditable="true"][aria-placeholder*="Ask"]` | `div[aria-label*="Send"][role="button"]`, `button[aria-label*="Send"]` |
| Kimi | `https://www.kimi.com/` | `www.kimi.com`, `kimi.com`, `kimi.ai`, `www.kimi.ai`, `kimi.moonshot.cn` | C | `.chat-input-editor[contenteditable="true"]` | `.send-button-container` |
| Blackbox AI | `https://app.blackbox.ai/chat` | `app.blackbox.ai`, `www.blackbox.ai`, `blackbox.ai` | C | `#chat-input-box` | `button[aria-label="Send message"]`, `#prompt-form-send-button` |

## Image path

The default image path pastes files onto the active composer. Qwen has a known
hidden file input at `#filesUpload`, so its config uses that input before the
paste fallback. After an image injection the content script waits for upload
activity to become idle instead of applying a fixed multi-second delay.

Providers may hide composers until login or after a cookie or consent step.
When no usable composer exists, the broadcaster reports `login_required` or
`no_input` rather than guessing at a navigation button.
