'use strict';

const DELIVERY = globalThis.AIBDeliveryProtocol;
const PROMPT_POLICY = globalThis.AIBPromptPolicy;
const AIB_HOSTS = new Set(globalThis.AIB_AI_HOSTS || []);
const ATTEMPT_CACHE_LIMIT = 64;
const ATTEMPT_CACHE_TTL_MS = 5 * 60 * 1000;
const attemptCache = new Map();
let activeAttemptId = null;
let panelBinding = { panelId: null, panelEpoch: null, providerKey: null };
let lastInputDiagnostic = null;
let lastSubmitDiagnostic = null;
let responseTrackerToken = 0;
let debugOverlaysEnabled = false;
chrome.storage.local.get('aib_debug_overlays')
  .then(value => { debugOverlaysEnabled = value.aib_debug_overlays === true; })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aib_debug_overlays) {
    debugOverlaysEnabled = changes.aib_debug_overlays.newValue === true;
  }
});

function isWorkspacePanelFrame() {
  try {
    if (window.self === window.top) return false;
    void window.parent.location.href;
    return false;
  } catch {
    return true;
  }
}

// Group-based timeouts (ms) — background tags each payload with its group.
// Group A = fast/reliable, B = search/specialist, C = complex/shadow-DOM.
const GROUP_TIMEOUTS = {
  A: { input: 4000,  submit: 3000, evidence: 12000 },
  B: { input: 7000,  submit: 5000, evidence: 20000 },
  C: { input: 10000, submit: 7000, evidence: 30000 }
};

// Platform configs — precise selectors per hostname.
// inputSels / submitSels are tried in order; first usable match wins.
// type: 'textarea' | 'contenteditable' | 'auto' controls text-injection path.
// preClick: true — click the input before injecting (needed for some shadow-DOM sites).
// ---------------------------------------------------------------------------
const PLATFORMS = {
  // ── Group A ──────────────────────────────────────────────────────────────
  'gemini.google.com': {
    responseSels: [
      'model-response message-content',
      'model-response .model-response-text',
      '.model-response-text',
      'message-content'
    ],
    inputSels: [
      '.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button.send-button',
      '.send-button',
      'button[aria-label*="Send" i]',
      'button[jsname]'
    ],
    type: 'contenteditable',
    group: 'A'
  },
  'chat.deepseek.com': {
    responseSels: [
      '.ds-markdown--block',
      '.ds-markdown',
      '[class*="assistant" i] [class*="markdown" i]'
    ],
    inputSels: [
      'textarea#chat-input',
      'textarea[placeholder]',
      'textarea'
    ],
    submitSels: [
      'div[role="button"][aria-label*="Send" i]',
      'div[role="button"][class*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'A'
  },
  'chat.mistral.ai': {
    responseSels: [
      '[data-message-author-role="assistant"]',
      '[data-testid="text-message-part"]'
    ],
    inputSels: [
      // Le Chat uses ProseMirror (contenteditable div) on homepage and in chat
      '.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-testid="chat-input"]',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[contenteditable="true"][aria-placeholder*="Ask" i]',
      'div[contenteditable="true"][aria-label*="Message" i]',
      // Textarea fallback (older / mobile versions)
      'textarea[data-testid="chat-input"]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B',
    submitEvidenceTimeoutMs: 30000,
    attachmentsRequireLogin: true,
    preClick: true
  },
  'grok.com': {
    responseSels: [
      '[data-message-author-role="assistant"]',
      '[data-testid*="grok-response" i]',
      '[data-testid*="assistant" i]',
      '[data-testid*="markdown" i]',
      '.response-content-markdown'
    ],
    userSels: [
      '[data-message-author-role="user"]',
      '[data-testid*="user-message" i]',
      '[data-testid*="grok-query" i]'
    ],
    inputSels: [
      'textarea[data-testid="userInput"]',
      'textarea[data-testid*="grok" i]',
      'div[contenteditable="true"][data-testid*="grok" i]',
      'textarea[placeholder*="know" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Grok" i]',
      'textarea[placeholder]',
      'textarea'
    ],
    submitSels: [
      'button[data-testid="chat-submit"]',
      'button[data-testid="send-button"]',
      'button[data-testid*="grok" i][data-testid*="send" i]',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    // Both grok.com and X's /i/grok surface can be slow to first paint.
    group: 'B'
  },

  // ── Group B ──────────────────────────────────────────────────────────────
  'perplexity.ai': {
    inputSels: [
      '#ask-input[contenteditable="true"]',
      '#ask-input[role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'textarea[placeholder*="Ask"]',
      'textarea[data-testid*="input" i]',
      'textarea[placeholder*="Search"]',
      'textarea[rows]',
      'textarea'
    ],
    submitSels: [
      'button[aria-label="Submit"]',
      'button[data-testid="submit-button"]',
      'button[aria-label*="Submit" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'www.perplexity.ai': {
    inputSels: [
      '#ask-input[contenteditable="true"]',
      '#ask-input[role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'textarea[placeholder*="Ask"]',
      'textarea[data-testid*="input" i]',
      'textarea[placeholder*="Search"]',
      'textarea[rows]',
      'textarea'
    ],
    submitSels: [
      'button[aria-label="Submit"]',
      'button[data-testid="submit-button"]',
      'button[aria-label*="Submit" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'you.com': {
    inputSels: [
      'textarea#search-input-textarea',
      'textarea[data-testid="search-input"]',
      'div[contenteditable="true"][data-lexical-editor]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button[aria-label="Submit query"]',
      'button[data-testid="submit-button"]',
      'button[aria-label*="Search" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'www.you.com': {
    inputSels: [
      'textarea#search-input-textarea',
      'textarea[data-testid="search-input"]',
      'div[contenteditable="true"][data-lexical-editor]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button[aria-label="Submit query"]',
      'button[data-testid="submit-button"]',
      'button[aria-label*="Search" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'duck.ai': {
    inputSels: [
      'textarea[name="user-prompt"]',
      'textarea[data-testid*="message" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      'button[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'huggingface.co': {
    inputSels: [
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"][aria-label*="chat" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button[data-testid="send-btn"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'poe.com': {
    inputSels: [
      'textarea[class*="GrowingTextArea" i]',
      'textarea[placeholder*="Talk" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"][class*="message" i]',
      'textarea[placeholder]',
      'textarea'
    ],
    submitSels: [
      'button[class*="SendButton" i]',
      'button[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'venice.ai': {
    responseSels: [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant" i]',
      '[class*="assistant" i] .prose',
      '.prose'
    ],
    inputSels: [
      'textarea[aria-label*="Chat message" i]',
      'textarea[name="prompt-textarea"]',
      'textarea[placeholder*="Send" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      'button[data-testid="minds-chat-send-button"]',
      'button[aria-label*="Send" i]',
      'button[data-testid*="send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B',
    imageFileSels: ['input[data-testid="minds-chat-file-input"][type="file"]']
  },
  'lmarena.ai': {
    inputSels: [
      'textarea[name="message"]',
      'textarea[data-testid="textbox"]',
      'textarea[placeholder*="Enter" i]',
      'textarea[placeholder*="Type" i]',
      'div[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea'
    ],
    submitSels: [
      'button[aria-label="Send"]',
      'button[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },
  'arena.ai': {
    inputSels: [
      'textarea[name="message"]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'textarea'
    ],
    submitSels: [
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[data-testid*="send" i]'
    ],
    type: 'auto',
    group: 'B'
  },
  'aistudio.google.com': {
    inputSels: [
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="Type" i]',
      'ms-prompt-input-wrapper textarea',
      'rich-textarea textarea',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button[aria-label*="Run" i]',
      'button[mattooltip*="Run" i]',
      'run-button button',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'B'
  },

  // ── Group C ──────────────────────────────────────────────────────────────
  'copilot.microsoft.com': {
    inputSels: [
      'textarea#userInput',
      'textarea[data-testid="composer-input"]',
      // Shadow DOM web component — queryAllDeep pierces these
      'cib-text-input textarea',
      'cib-serp-feedback textarea',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button[data-testid="submit-button"]',
      'button[aria-label="Submit message"]',
      'button[aria-label="Submit"]',
      'cib-action-bar button[aria-label*="Submit" i]',
      'button[aria-label*="Submit" i]',
      'button[data-testid*="submit" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C',
    preClick: true
  },
  'chat.qwen.ai': {
    inputSels: [
      'textarea.message-input-textarea',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][class*="input" i]',
      'div[contenteditable="true"][class*="editor" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button.send-button',
      '.send-button',
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[class*="send" i]',
      'div[role="button"][class*="send" i]'
    ],
    type: 'auto',
    group: 'C',
    imageFileSels: ['input#filesUpload[type="file"]']
  },
  'chat.qwenlm.ai': {
    inputSels: [
      'textarea.message-input-textarea',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][class*="input" i]',
      'div[contenteditable="true"][class*="editor" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button.send-button',
      '.send-button',
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[class*="send" i]',
      'div[role="button"][class*="send" i]'
    ],
    type: 'auto',
    group: 'C',
    imageFileSels: ['input#filesUpload[type="file"]']
  },
  'meta.ai': {
    inputSels: [
      'input[placeholder*="Ask Meta" i]',
      'input[placeholder*="Meta AI" i]',
      'input[type="text"][placeholder*="Ask" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"][aria-placeholder*="Ask" i]',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[aria-label*="Message Meta AI" i][contenteditable]',
      'div[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      'input[type="text"][placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      'div[aria-label*="Send" i][role="button"]',
      'div[aria-label="Send"][role="button"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    // Meta AI's composer is now a plain <input>, not a contenteditable — 'auto'
    // routes <input>/<textarea> through the native-setter path.
    type: 'auto',
    group: 'C'
  },
  'www.meta.ai': {
    inputSels: [
      'input[placeholder*="Ask Meta" i]',
      'input[placeholder*="Meta AI" i]',
      'input[type="text"][placeholder*="Ask" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"][aria-placeholder*="Ask" i]',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[aria-label*="Message Meta AI" i][contenteditable]',
      'div[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      'input[type="text"][placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      'div[aria-label*="Send" i][role="button"]',
      'div[aria-label="Send"][role="button"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    // Meta AI's composer is now a plain <input>, not a contenteditable — 'auto'
    // routes <input>/<textarea> through the native-setter path.
    type: 'auto',
    group: 'C'
  },
  'www.kimi.com': {
    inputSels: [
      '.chat-input-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      '.send-button-container',
      'button[aria-label*="Send" i]',
      'button[class*="send" i]',
      'button[type="submit"]'
    ],
    type: 'contenteditable',
    group: 'C'
  },
  'kimi.com': {
    inputSels: [
      '.chat-input-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      '.send-button-container',
      'button[aria-label*="Send" i]',
      'button[class*="send" i]',
      'button[type="submit"]'
    ],
    type: 'contenteditable',
    group: 'C'
  },
  'kimi.ai': {
    inputSels: [
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"][class*="editor" i]',
      'div[contenteditable="true"][class*="input" i]',
      'div[contenteditable="true"][class*="chat" i]',
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      '.send-button-container',
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[class*="send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C'
  },
  'www.kimi.ai': {
    inputSels: [
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"][class*="editor" i]',
      'div[contenteditable="true"][class*="input" i]',
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      '.send-button-container',
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[class*="send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C'
  },
  'kimi.moonshot.cn': {
    inputSels: [
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"][class*="editor" i]',
      'textarea[placeholder]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    submitSels: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C'
  },
  'www.blackbox.ai': {
    inputSels: [
      'textarea#userInput',
      'textarea[id*="Input" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button#sendButton',
      'button[id*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C'
  },
  'blackbox.ai': {
    inputSels: [
      'textarea#userInput',
      'textarea[id*="Input" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button#sendButton',
      'button[id*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C'
  },
  'app.blackbox.ai': {
    inputSels: [
      'textarea#chat-input-box',
      'textarea#userInput',
      'textarea[id*="Input" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitSels: [
      'button#prompt-form-send-button',
      'button[aria-label="Send message"]',
      'button#sendButton',
      'button[id*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    group: 'C'
  }
};

// X Premium/Premium+ accounts access Grok through X's authenticated surface.
// Twitter hostnames are retained because older links may redirect through them.
for (const host of ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']) {
  PLATFORMS[host] = PLATFORMS['grok.com'];
}
for (const host of ['www.venice.ai', 'chat.venice.ai']) {
  PLATFORMS[host] = PLATFORMS['venice.ai'];
}

const COMMON_INPUT_SELS = [
  // Rich-text editors (ProseMirror, Lexical, Quill) — checked first
  '.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][data-lexical-editor]',
  '.ql-editor[contenteditable="true"]',
  // Composer / prompt containers
  'form textarea',
  'form [contenteditable="true"]',
  '[data-testid*="composer" i] textarea',
  '[data-testid*="composer" i] [contenteditable="true"]',
  '[data-testid*="prompt" i]',
  '[data-testid*="chat-input" i]',
  '[data-testid*="message" i] textarea',
  '[data-testid*="message" i] [contenteditable="true"]',
  // Semantic labels
  '[aria-label*="message" i]',
  '[aria-label*="prompt" i]',
  '[aria-label*="ask" i]',
  '[placeholder*="message" i]',
  '[placeholder*="prompt" i]',
  '[placeholder*="ask" i]',
  // Generic editable
  'div[contenteditable="true"][aria-multiline="true"]',
  'textarea[aria-label]',
  'textarea[placeholder]',
  'textarea',
  'input[type="text"][placeholder]',
  'div[role="textbox"][contenteditable="true"]',
  '[role="textbox"]',
  '[contenteditable="true"][aria-label]',
  '[contenteditable="plaintext-only"]',
  '[contenteditable="true"]'
];

const COMMON_SUBMIT_SELS = [
  'button[data-testid*="send" i]',
  'button[data-testid*="submit" i]',
  'button[aria-label*="send" i]',
  'button[aria-label*="submit" i]',
  'button[title*="send" i]',
  'button[title*="submit" i]',
  '[role="button"][aria-label*="send" i]',
  '[role="button"][aria-label*="submit" i]',
  'button[type="submit"]'
];

// During generation most providers replace Send with a Stop control. Detecting
// that control is the safest cross-provider signal that an answer is active.
const COMMON_STOP_SELS = [
  'button[data-testid="stop-button"]',
  'button[data-testid*="stop" i]',
  'button[data-testid*="pause" i]',
  'button[aria-label*="stop generating" i]',
  'button[aria-label*="stop response" i]',
  'button[aria-label*="stop answer" i]',
  'button[aria-label*="pause generat" i]',
  'button[aria-label*="pause response" i]',
  'button[aria-label="Stop"]',
  'button[title*="stop generating" i]',
  'button[title*="stop response" i]',
  'button[title*="pause generat" i]',
  'button[title*="pause response" i]',
  '[role="button"][aria-label*="stop generating" i]',
  '[role="button"][aria-label*="stop response" i]',
  '[role="button"][aria-label*="pause generat" i]',
  '[role="button"][aria-label*="pause response" i]',
  '[role="button"][data-testid*="stop" i]'
];

// Selectors for the AI's *response* container, ordered specific → generic. Used
// by getResponseText() to grab the latest reply so it can be shipped to Warp.
// Per-site `responseSels` (in PLATFORMS) are tried first, then these fall backs.
// The reader tries each selector in order and, for the first that matches any
// visible element, returns the LAST match (= newest message in document order).
const COMMON_RESPONSE_SELS = [
  '[data-testid="assistant-message"]',
  '.model-response-text',                      // Gemini
  'message-content',                           // Gemini custom element
  '.markdown-main-panel',                      // Gemini
  '.response-content-markdown',                // Grok
  '.prose-response, .message-bubble--assistant',
  '[class*="assistant" i] [class*="markdown" i]',
  '[class*="message" i][class*="assistant" i]',
  '[class*="response" i][class*="content" i]',
  '.markdown',                                 // many Tailwind chat UIs
  '.prose',
  '[class*="markdown" i]'
];

// Strict user-message containers. These intentionally avoid broad selectors
// such as `.message` so capture never mistakes the entire conversation for the
// newest prompt.
const COMMON_USER_MESSAGE_SELS = [
  '[data-message-author-role="user"]',
  '[data-testid="user-message"]',
  '[data-author="user"]',
  '[data-role="user"]',
  'user-query .query-text',                     // Gemini
  'user-query',
  '[class*="user-message" i]',
  '[class*="message" i][class*="user" i]'
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GENERIC_PLATFORM = {
  inputSels: COMMON_INPUT_SELS,
  submitSels: COMMON_SUBMIT_SELS,
  type: 'auto'
};

function getConfig() {
  const config = PLATFORMS[location.hostname] || (AIB_HOSTS.has(location.hostname) ? GENERIC_PLATFORM : null);
  if (!config) return null;
  return {
    ...config,
    directInputSels: config.inputSels,
    directSubmitSels: config.submitSels,
    inputSels: uniqueList([...config.inputSels, ...COMMON_INPUT_SELS]),
    submitSels: uniqueList([...config.submitSels, ...COMMON_SUBMIT_SELS]),
    stopSels: uniqueList([...(config.stopSels || []), ...COMMON_STOP_SELS])
  };
}

function uniqueList(items) {
  return [...new Set(items)];
}

function queryAllDeep(selector, root = document) {
  const results = [];

  try {
    results.push(...root.querySelectorAll(selector));
  } catch {
    return results;
  }

  let nodes = [];
  try {
    nodes = [...root.querySelectorAll('*')];
  } catch {}

  for (const node of nodes) {
    if (node.shadowRoot) {
      results.push(...queryAllDeep(selector, node.shadowRoot));
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function shouldAvoidAutomationScroll() {
  return isWorkspacePanelFrame();
}

function focusElement(el) {
  try {
    el?.focus?.({ preventScroll: true });
  } catch {
    el?.focus?.();
  }
}

function isUsable(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0
    && rect.height > 0
    && style.visibility !== 'hidden'
    && style.display !== 'none'
    && style.pointerEvents !== 'none'
    && !el.disabled
    && !el.readOnly
    && el.getAttribute('aria-disabled') !== 'true'
    && el.getAttribute('aria-readonly') !== 'true'
    && el.getAttribute('data-disabled') !== 'true'
    && !el.closest?.('[inert],[aria-hidden="true"]');
}

function labelFor(el) {
  return [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('data-testid'),
    el.getAttribute?.('name'),
    el.textContent
  ].filter(Boolean).join(' ').toLowerCase();
}

function inputLabelFor(el) {
  return [
    labelFor(el),
    el.getAttribute?.('placeholder'),
    el.getAttribute?.('data-placeholder'),
    el.getAttribute?.('aria-placeholder'),
    el.closest?.('form')?.getAttribute?.('aria-label'),
    el.closest?.('[data-testid]')?.getAttribute?.('data-testid'),
    el.closest?.('[class]')?.className
  ].filter(Boolean).join(' ').toLowerCase();
}

function normalizeInputCandidate(el) {
  if (!el) return null;
  if (isEditableInput(el)) return el;
  const nested = queryAllDeep('textarea,input[type="text"],input[type="search"],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]', el)
    .find(isEditableInput);
  return nested || null;
}

function isEditableInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  const type = (el.getAttribute?.('type') || '').toLowerCase();
  return tag === 'TEXTAREA'
    || (tag === 'INPUT' && ['text', 'search', ''].includes(type))
    || el.isContentEditable
    || el.getAttribute?.('contenteditable') === 'true'
    || el.getAttribute?.('contenteditable') === 'plaintext-only'
    || el.getAttribute?.('role') === 'textbox';
}

function isBadInputCandidate(el) {
  const label = inputLabelFor(el);
  return /\b(email|password|username|phone|verification|code|search settings|filter|url|address|coupon|comment|feedback)\b/.test(label);
}

// Reject inputs that live in chrome: sidebars, nav rails, model/settings menus,
// and option lists — never the composer.
function isInExcludedRegion(el) {
  try {
    // Menus / option lists are never the composer — reject outright.
    if (el.closest?.('[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"]')) {
      return true;
    }
    // Sidebars / nav rails / settings panels. BUT modern UI kits (shadcn/ui) wrap
    // the WHOLE app in a full-width `group/sidebar-wrapper` div — matching that as a
    // "sidebar" wrongly rejects the composer (Grok, Meta AI, etc.). A real rail is
    // NARROW, so only exclude when the matched region is well under the frame width.
    const region = el.closest?.(
      'aside,nav,[role="navigation"],[data-sidebar],[class*="sidebar" i],' +
      '[class*="side-bar" i],[class*="settings" i],[data-testid*="sidebar" i],[data-testid*="settings" i]'
    );
    if (!region) return false;
    const regionWidth = region.getBoundingClientRect().width;
    const frameWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (frameWidth && regionWidth > frameWidth * 0.6) return false;  // full-width layout wrapper, not a rail
    return true;
  } catch {
    return false;
  }
}

function isEditableType(el) {
  const type = (el.getAttribute?.('type') || '').toLowerCase();
  return el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && ['text', 'search', ''].includes(type))
    || el.isContentEditable
    || el.getAttribute?.('contenteditable') === 'true'
    || el.getAttribute?.('contenteditable') === 'plaintext-only'
    || el.getAttribute?.('role') === 'textbox';
}

// Relative Visual Anchor: composers sit near the bottom-center of THIS frame's
// own viewport. Score by spatial distance to that anchor instead of a fixed
// "lower third" viewport cutoff (which mis-fires on centered/floating inputs).
function bottomCenterDistance(rect) {
  const anchorX = window.innerWidth / 2;
  const anchorY = window.innerHeight;
  const elX = rect.left + rect.width / 2;
  const elY = rect.bottom;
  return Math.hypot(elX - anchorX, elY - anchorY);
}

function scoreInputCandidate(el, selectorIndex) {
  const input = normalizeInputCandidate(el);
  if (!input || !isUsable(input) || isBadInputCandidate(input)) return -1;
  if (isInExcludedRegion(input)) return -1;

  const label = inputLabelFor(input);
  const rect = input.getBoundingClientRect();
  const editable = isEditableType(input);
  let score = Math.max(0, 120 - selectorIndex);

  if (/\b(message|prompt|ask|chat|question|reply|talk|type|anything)\b/.test(label)) score += 90;
  if (/\b(search|research)\b/.test(label)) score += 35;
  if (input.tagName === 'TEXTAREA') score += 35;
  if (input.isContentEditable || input.getAttribute?.('contenteditable')) score += 32;
  if (input.getAttribute?.('role') === 'textbox') score += 24;
  if (input.closest?.('form')) score += 24;
  try {
    if (input.closest?.('[data-testid*="composer" i],[class*="composer" i],[class*="chat" i],[class*="prompt" i]')) {
      score += 28;
    }
  } catch {}

  // Relative Visual Anchor scoring.
  const dist = bottomCenterDistance(rect);
  if (editable && dist <= 300) score += 150;
  else if (dist <= 150)        score += 130;
  else if (dist <= 300)        score += 95;
  else if (dist <= 520)        score += 55;
  else                          score += Math.max(0, 40 - (dist - 520) / 20);

  if (rect.width > 240) score += 16;
  if (rect.height > 32) score += 8;
  if (document.activeElement === input) score += 20;
  if (getInputText(input).length > 2000) score -= 120;

  return score;
}

function findBestInput(selectors) {
  const candidates = [];
  selectors.forEach((selector, selectorIndex) => {
    try {
      for (const el of queryAllDeep(selector)) {
        const input = normalizeInputCandidate(el);
        if (!input || candidates.some(candidate => candidate.el === input)) continue;
        const score = scoreInputCandidate(input, selectorIndex);
        if (score >= 0) candidates.push({ el: input, score, selector, selectorIndex });
      }
    } catch {}
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  lastInputDiagnostic = best ? {
    selector: best.selector,
    selectorIndex: best.selectorIndex,
    score: Math.round(best.score),
    candidateCount: candidates.length
  } : {
    selector: null,
    selectorIndex: null,
    score: null,
    candidateCount: 0
  };
  return best?.el || null;
}

function getInputText(el) {
  if (!el) return '';
  if ('value' in el) return el.value || '';
  return el.innerText || el.textContent || '';
}

// ── Response capture (for "→ Warp") ────────────────────────────────────────
// Read the AI's latest reply as plain text. Deliberately dumb: the user clicks
// the button once the answer is done, so no stream-completion detection.
function isVisibleWithText(el) {
  if (!el) return false;
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
  } catch { return false; }
  return (el.innerText || el.textContent || '').trim().length > 0;
}

function elPlainText(el) {
  return (el?.innerText || el?.textContent || '').trim();
}

// Does this element contain a distinct user-message turn? If so it's a
// conversation wrapper (spans the whole chat), not a single assistant reply.
function containsUserMessage(el) {
  return COMMON_USER_MESSAGE_SELS.some(sel => {
    try { return queryAllDeep(sel, el).some(isVisibleWithText); } catch { return false; }
  });
}

// Given a wrapper that holds the whole conversation, keep ONLY the final
// assistant turn: the visible text that comes after the last user message.
function textAfterLastUser(wrapper) {
  const users = COMMON_USER_MESSAGE_SELS.flatMap(sel => {
    try { return queryAllDeep(sel, wrapper).filter(isVisibleWithText); } catch { return []; }
  });
  if (!users.length) return elPlainText(wrapper);
  const lastUser = users[users.length - 1];

  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeValue && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const parts = [];
  let passedLastUser = false;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!passedLastUser) {
      const pos = lastUser.compareDocumentPosition(n);
      const following = pos & Node.DOCUMENT_POSITION_FOLLOWING;
      const contained = pos & Node.DOCUMENT_POSITION_CONTAINED_BY;
      if (following && !contained) passedLastUser = true;   // strictly after the user's subtree
      else continue;
    }
    parts.push(n.nodeValue.replace(/[ \t]+/g, ' ').trim());
  }
  return parts.filter(Boolean).join('\n').trim() || elPlainText(wrapper);
}

// Pick the newest single assistant reply. For the first selector that matches,
// drop elements that wrap OTHER matches (ancestors) and elements that contain a
// user turn (whole-chat wrappers), then take the last one left.
function pickLatestAssistant(selectors) {
  for (const sel of selectors) {
    let matches;
    try { matches = queryAllDeep(sel).filter(isVisibleWithText); } catch { continue; }
    if (!matches.length) continue;
    const leaves = matches.filter(el => !matches.some(o => o !== el && el.contains(o)));
    const pool = leaves.length ? leaves : matches;
    const singles = pool.filter(el => !containsUserMessage(el));
    const chosen = singles.length ? singles : pool;
    const el = chosen[chosen.length - 1];
    if (el && elPlainText(el)) return el;
  }
  return null;
}

function getResponseText() {
  const cfg = getConfig();
  const sels = uniqueList([...(cfg?.responseSels || []), ...COMMON_RESPONSE_SELS]);
  const el = pickLatestAssistant(sels);
  if (!el) return '';
  // Even the chosen element can be a whole-conversation container on some sites
  // (e.g. one big `.markdown`); narrow it to just the final turn.
  return containsUserMessage(el) ? textAfterLastUser(el) : elPlainText(el);
}

function getLatestAssistantResponse() {
  return {
    text: getResponseText()
  };
}

function normalizeComparableText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textWasFullyInserted(inputEl, expected) {
  const expectedText = normalizeComparableText(expected);
  if (!expectedText) return true;

  const actualText = normalizeComparableText(getInputText(inputEl));
  if (!actualText) return false;
  if (actualText.includes(expectedText)) return true;

  const head = expectedText.slice(0, Math.min(32, expectedText.length));
  const tail = expectedText.slice(Math.max(0, expectedText.length - 32));
  const expectedMinLength = Math.max(1, Math.floor(expectedText.length * 0.96));

  return actualText.length >= expectedMinLength
    && actualText.includes(head)
    && actualText.includes(tail);
}

function base64ToBlob(dataUrl, mimeType) {
  const parts = dataUrl.split(',');
  const raw = atob(parts[1] || parts[0]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// ---------------------------------------------------------------------------
// Text injection
// ---------------------------------------------------------------------------

// Native value setter — bypasses React/Vue's overridden `value` property so the
// framework's internal state tracker actually registers the change.
function setNativeValue(el, value) {
  const previous = el.value;
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;

  // React (and other frameworks) keep an internal value tracker to dedupe change
  // events. After a programmatic set, rewind the tracker to the OLD value so the
  // next 'input' event is seen as a real change and onChange fires — otherwise
  // controlled textareas (Arena, Duck.ai, etc.) silently revert to empty.
  try {
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') tracker.setValue(previous);
  } catch {}
}

function dispatchInput(el, text, inputType) {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data: text }));
}

// Textarea / <input> path — native setter + synthesized beforeinput/input/change.
function injectTextIntoTextarea(el, text) {
  focusElement(el);
  el.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true, composed: true, cancelable: true, inputType: 'insertFromPaste', data: text
  }));
  setNativeValue(el, text);
  el.setSelectionRange?.(text.length, text.length);
  dispatchInput(el, text, 'insertFromPaste');
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function selectAllInEditable(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

function editableHasText(el, text) {
  const head = normalizeComparableText(text).slice(0, 16);
  return !!head && normalizeComparableText(getInputText(el)).includes(head);
}

// Rich-text contenteditable path — ProseMirror, Lexical, Slate and draft-js each
// reconcile DOM edits through their own observers, so we try the methods they
// actually honor, in order, verifying after each:
//   1. execCommand('insertText') — the native path ProseMirror/Lexical accept
//      via beforeinput(inputType:"insertText").
//   2. synthetic paste with a real DataTransfer — Lexical/Slate honor paste.
//   3. direct textContent mutation — last resort for plain contenteditables.
function injectTextIntoContentEditable(el, text) {
  focusElement(el);
  selectAllInEditable(el);

  // Strategy 1 — native insertText (beforeinput emitted by execCommand itself).
  try { document.execCommand('insertText', false, text); } catch {}
  if (editableHasText(el, text)) {
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }

  // Strategy 2 — synthetic paste.
  try {
    selectAllInEditable(el);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    dt.setData('text/html', text.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, composed: true, cancelable: true, inputType: 'insertFromPaste', data: text
    }));
    el.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true, composed: true
    }));
  } catch {}
  if (editableHasText(el, text)) {
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }

  // Strategy 3 — direct mutation + synthesized input so the framework re-reads.
  try {
    selectAllInEditable(el);
    el.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
  dispatchInput(el, text, 'insertText');
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function injectText(el, text, type) {
  const t = type === 'auto'
    ? (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? 'textarea' : 'contenteditable')
    : type;
  if (t === 'textarea') injectTextIntoTextarea(el, text);
  else injectTextIntoContentEditable(el, text);
}

async function waitForInput(config, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const elapsed = Date.now() - started;
    const selectors = elapsed < 1800 ? config.directInputSels : config.inputSels;
    const input = findBestInput(selectors);
    if (input && isUsable(input)) return input;
    await sleep(100);
  }
  return findBestInput(config.inputSels);
}

async function injectTextViaPaste(input, text) {
  focusElement(input);
  if ('value' in input) {
    setNativeValue(input, '');
    dispatchInput(input, '', 'deleteContentBackward');
  } else {
    selectAllInEditable(input);
    try { document.execCommand('delete', false, null); } catch {}
  }

  try {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    clipboardData.setData('text/html', text.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
  } catch {}
  await sleep(180);
  return textWasFullyInserted(input, text);
}

async function injectTextReliably(input, text, type) {
  for (let attempt = 0; attempt < 3; attempt++) {
    injectText(input, text, type);
    await sleep(180);
    if (textWasFullyInserted(input, text)) return true;
  }

  return injectTextViaPaste(input, text);
}

// ---------------------------------------------------------------------------
// Image injection
// ---------------------------------------------------------------------------

function imagePayloadsFromData(data) {
  const source = Array.isArray(data.attachments) ? data.attachments : data.images;
  if (Array.isArray(source)) {
    return source
      .filter(attachment => attachment?.base64)
      .map(attachment => ({
        base64: attachment.base64,
        name: attachment.name || (attachment.type === 'application/pdf' ? 'document.pdf' : 'image.png'),
        type: attachment.type || 'image/png',
        size: Number(attachment.size) || DELIVERY.estimatedDataUrlBytes(attachment.base64)
      }));
  }

  return data.imageBase64
    ? [{
      base64: data.imageBase64,
      name: data.imageName || (data.imageType === 'application/pdf' ? 'document.pdf' : 'image.png'),
      type: data.imageType || 'image/png',
      size: DELIVERY.estimatedDataUrlBytes(data.imageBase64)
    }]
    : [];
}

function dataTransferWithFiles(files) {
  const dt = new DataTransfer();
  for (const file of files) dt.items.add(file);
  return dt;
}

function filesFromImages(images) {
  return images.map((image, index) => {
    const type = image.type || 'image/png';
    const blob = base64ToBlob(image.base64, type);
    return new File([blob], image.name || `image-${index + 1}.png`, { type });
  });
}

function findImageFileInput(config, inputEl) {
  for (const sel of config.imageFileSels || []) {
    try {
      const fileInput = queryAllDeepFromRoots(sel, candidateRoots(inputEl))
        .find(el => el.tagName === 'INPUT' && el.type === 'file' && !el.disabled);
      if (fileInput) return fileInput;
    } catch {}
  }
  return null;
}

function fileInputAcceptsFiles(fileInput, files) {
  if (!fileInput.multiple && files.length > 1) return false;
  const accept = String(fileInput.accept || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!accept.length) return true;
  return files.every(file => accept.some(rule =>
    rule === file.type.toLowerCase()
      || (rule.endsWith('/*') && file.type.toLowerCase().startsWith(rule.slice(0, -1)))
      || (rule.startsWith('.') && file.name.toLowerCase().endsWith(rule))));
}

function injectImagesIntoFileInput(fileInput, files) {
  if (!fileInputAcceptsFiles(fileInput, files)) return false;
  try {
    const dt = dataTransferWithFiles(files);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
  }
}

// Synthetic paste of image files (APPENDS to whatever is already attached).
function pasteImages(inputEl, images) {
  if (!images.length) return false;
  try {
    const dt = dataTransferWithFiles(filesFromImages(images));
    focusElement(inputEl);
    inputEl.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    return true;
  } catch {
    return false;
  }
}

// One-shot best-effort attach of ALL images (file-input path first, else paste).
async function injectImages(inputEl, images, config) {
  if (!images.length) return true;
  const files = filesFromImages(images);
  const fileInput = findImageFileInput(config, inputEl);
  if (fileInput && injectImagesIntoFileInput(fileInput, files)) return true;
  return pasteImages(inputEl, images);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

function isStopCandidate(el) {
  if (!isUsable(el)) return false;
  const label = labelFor(el);
  if (/\b(upload|attachment|file|image|photo|audio|voice|recording|sharing)\b/.test(label)) return false;
  const hasStop = /\bstop\b/.test(label);
  const hasPause = /\bpause\b/.test(label);
  const describesGeneration = /\b(generat|response|answer|message|run)\b/.test(label);
  return (hasStop || hasPause)
    && (describesGeneration || (hasStop && /(^|\s)stop($|\s)/.test(label)) || /stop-button/.test(label));
}

function scoreStopCandidate(el, inputEl) {
  if (!isStopCandidate(el)) return -1;
  const label = labelFor(el);
  let score = 50;
  if (/\b(generat|response|answer)\b/.test(label)) score += 80;
  if (/stop-button/.test(label)) score += 70;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 72 && rect.height <= 72) score += 12;
  if (inputEl) {
    const inputRect = inputEl.getBoundingClientRect();
    const distance = Math.hypot(
      (rect.left + rect.right - inputRect.left - inputRect.right) / 2,
      (rect.top + rect.bottom - inputRect.top - inputRect.bottom) / 2
    );
    score += Math.max(0, 80 - distance / 8);
  } else {
    score += Math.max(0, 30 - bottomCenterDistance(rect) / 20);
  }
  return score;
}

function findStopButton(config, inputEl) {
  const candidates = [];
  for (const sel of config.stopSels || COMMON_STOP_SELS) {
    try { candidates.push(...queryAllDeep(sel)); } catch {}
  }
  // Some providers expose only visible button text, with no useful attributes.
  try { candidates.push(...queryAllDeep('button,[role="button"]')); } catch {}
  return uniqueElements(candidates)
    .filter(el => scoreStopCandidate(el, inputEl) >= 0)
    .sort((a, b) => scoreStopCandidate(b, inputEl) - scoreStopCandidate(a, inputEl))[0] || null;
}

// Stop at most once, then wait for the provider to return to an idle composer.
// If it never settles, abort this broadcast instead of pasting into a busy chat.
async function stopActiveGeneration(config, inputEl) {
  const stop = findStopButton(config, inputEl);
  if (!stop) return true;

  flashHighlight(stop);
  clickElement(stop);

  const timeoutMs = config.stopTimeoutMs || 10000;
  const started = Date.now();
  let idleSince = 0;
  while (Date.now() - started < timeoutMs) {
    if (findStopButton(config, inputEl)) {
      idleSince = 0;
    } else if (!idleSince) {
      idleSince = Date.now();
    } else if (Date.now() - idleSince >= 300) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function isBadSubmitCandidate(el) {
  const label = labelFor(el);
  return /\b(stop|cancel|pause|attach|upload|file|image|photo|mic|voice|audio|deepthink|think|model|menu|more|tools|login|log in|sign up|upgrade)\b/.test(label);
}

function scoreSubmitCandidate(el, inputEl) {
  if (!isUsable(el) || isBadSubmitCandidate(el)) return -1;

  const label = labelFor(el);
  let score = 0;

  if (/\b(send|submit|search|arrow|prompt|run)\b/.test(label)) score += 80;
  if (el.tagName === 'BUTTON') score += 16;
  if (el.getAttribute('role') === 'button') score += 12;
  if (el.type === 'submit') score += 35;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 64 && rect.height <= 64) score += 10;

  if (inputEl) {
    const inputRect = inputEl.getBoundingClientRect();
    const verticallyNear = Math.abs((rect.top + rect.bottom) / 2 - (inputRect.top + inputRect.bottom) / 2) < 180;
    const toTheRight = rect.left > inputRect.left;
    if (verticallyNear) score += 12;
    if (toTheRight) score += 8;
  }

  return score;
}

function uniqueElements(elements) {
  return [...new Set(elements.filter(Boolean))];
}

function candidateRoots(inputEl) {
  return uniqueElements([
    inputEl?.closest?.('form'),
    inputEl?.closest?.('[role="form"]'),
    inputEl?.closest?.('[data-testid*="composer" i]'),
    inputEl?.closest?.('[class*="composer" i]'),
    inputEl?.closest?.('[class*="input" i]'),
    inputEl?.parentElement,
    inputEl?.parentElement?.parentElement,
    document.body
  ]);
}

function queryAllDeepFromRoots(selector, roots) {
  return uniqueElements(roots.flatMap(root => queryAllDeep(selector, root)));
}

function findSubmitButton(config, inputEl) {
  for (const sel of config.submitSels) {
    try {
      const buttons = queryAllDeep(sel);
      const usable = buttons
        .filter(el => scoreSubmitCandidate(el, inputEl) >= 0)
        .sort((a, b) => scoreSubmitCandidate(b, inputEl) - scoreSubmitCandidate(a, inputEl))[0];
      if (usable) {
        lastSubmitDiagnostic = {
          selector: sel,
          score: Math.round(scoreSubmitCandidate(usable, inputEl)),
          fallback: false
        };
        return usable;
      }
    } catch {}
  }

  const roots = candidateRoots(inputEl);
  const candidates = queryAllDeepFromRoots('button,[role="button"]', roots)
    .filter(el => scoreSubmitCandidate(el, inputEl) >= 18)
    .sort((a, b) => scoreSubmitCandidate(b, inputEl) - scoreSubmitCandidate(a, inputEl));

  const best = candidates[0] || null;
  lastSubmitDiagnostic = best ? {
    selector: 'button,[role="button"]',
    score: Math.round(scoreSubmitCandidate(best, inputEl)),
    fallback: true
  } : {
    selector: null,
    score: null,
    fallback: true
  };
  return best;
}

function uploadStillBusy(inputEl) {
  const busySelectors = [
    '[aria-label*="uploading" i]',
    '[aria-label*="upload" i][aria-busy="true"]',
    '[data-testid*="upload" i][aria-busy="true"]',
    '[data-testid*="attachment" i][aria-busy="true"]',
    '[class*="upload" i][aria-busy="true"]',
    '[role="progressbar"]',
    'progress'
  ];
  const roots = inputEl ? composerRoots(inputEl) : [document];

  return busySelectors.some(sel => {
    try {
      return queryAllDeepFromRoots(sel, roots).some(isUsable);
    } catch {
      return false;
    }
  });
}

async function waitForComposerUploadIdle(inputEl, timeoutMs) {
  const started = Date.now();
  let idleSince = 0;
  while (Date.now() - started < timeoutMs) {
    if (uploadStillBusy(inputEl)) {
      idleSince = 0;
    } else if (!idleSince) {
      idleSince = Date.now();
    } else if (Date.now() - idleSince >= 300) {
      return true;
    }
    await sleep(120);
  }
  return false;
}

// Tight composer-only roots (NOT document.body) so we count only the attachment
// thumbnail of the message being composed — never images from the chat history.
function composerRoots(inputEl) {
  return uniqueElements([
    inputEl?.closest?.('form'),
    inputEl?.closest?.('[role="form"]'),
    inputEl?.closest?.('[data-testid*="composer" i]'),
    inputEl?.closest?.('[class*="composer" i]'),
    inputEl?.closest?.('[class*="input" i]'),
    inputEl?.closest?.('.input-area'),
    inputEl?.closest?.('[class*="chat-input-card" i]'),
    inputEl?.closest?.('[data-testid*="dropzone" i]'),
    inputEl?.parentElement?.parentElement?.parentElement,
    inputEl?.parentElement?.parentElement,
    inputEl?.parentElement
  ]).filter(Boolean);
}

const ATTACHMENT_SELS = [
  'img[src^="blob:"]',
  'img[src^="data:image"]',
  'img[src]',
  'canvas',
  'video',
  '[data-testid*="attachment" i]',
  '[data-testid*="image-preview" i]',
  '[data-testid*="media-preview" i]',
  '[data-testid*="file-preview" i]',
  '[aria-label*="remove attachment" i]',
  '[aria-label*="remove file" i]',
  '[aria-label*="remove image" i]',
  '[class*="attachment" i] img',
  '[class*="thumbnail" i] img',
  '[class*="filePreview" i]',
  '[class*="file-preview" i]',
  '[class*="image-preview" i]'
];

function elVisible(el) {
  try {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  } catch { return false; }
}

function visibleAttachmentMedia(el) {
  if (!elVisible(el) || !/^(IMG|CANVAS|VIDEO)$/.test(el.tagName)) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 24 && r.height >= 24;
}

function attachmentMediaReady(el) {
  if (!visibleAttachmentMedia(el)) return false;
  if (el.tagName === 'IMG') return el.complete && el.naturalWidth > 0;
  if (el.tagName === 'VIDEO') return el.readyState >= 2;
  return true;
}

function leafElements(elements) {
  return elements.filter(el => !elements.some(other => other !== el && el.contains(other)));
}

// A provider often exposes one attachment as a wrapper, thumbnail and remove
// button. Combine distinct wrappers/media while avoiding those duplicate signals.
function attachmentState(config, inputEl) {
  const roots = composerRoots(inputEl);
  if (!roots.length) return { count: 0, readyCount: 0, removeControls: [] };
  const sels = config.imagePreviewSels?.length ? config.imagePreviewSels : ATTACHMENT_SELS;
  const matched = new Set();
  for (const sel of sels) {
    try {
      for (const el of queryAllDeepFromRoots(sel, roots)) {
        if (elVisible(el)) matched.add(el);
      }
    } catch {}
  }

  const media = new Set();
  const removeControls = new Set();
  const wrappers = new Set();
  for (const el of matched) {
    if (/^(IMG|CANVAS|VIDEO)$/.test(el.tagName)) media.add(el);
    for (const child of queryAllDeep('img,canvas,video', el)) media.add(child);
    if (/\bremove\b.*\b(attachment|file|image|photo)\b/.test(labelFor(el))) {
      removeControls.add(el);
    } else if (!/^(IMG|CANVAS|VIDEO)$/.test(el.tagName)) {
      wrappers.add(el);
    }
  }

  const visibleMedia = [...media].filter(visibleAttachmentMedia);
  const visibleControls = leafElements([...removeControls].filter(elVisible));
  const visibleWrappers = leafElements([...wrappers].filter(elVisible));
  const readyMedia = visibleMedia.filter(attachmentMediaReady);
  const readyWrappers = visibleWrappers.filter(el => {
    if (el.getAttribute?.('aria-busy') === 'true') return false;
    const nestedMedia = queryAllDeep('img,canvas,video', el);
    return !nestedMedia.length || nestedMedia.every(attachmentMediaReady);
  });
  const standaloneMedia = visibleMedia.filter(mediaElement =>
    !visibleWrappers.some(wrapper => wrapper.contains(mediaElement)));
  const readyStandaloneMedia = standaloneMedia.filter(attachmentMediaReady);
  const extraControlUnits = Math.max(0, visibleControls.length - visibleMedia.length);
  const groupedCount = visibleWrappers.length + standaloneMedia.length;
  const groupedReadyCount = readyWrappers.length + readyStandaloneMedia.length;

  const count = Math.max(
    visibleMedia.length,
    visibleControls.length,
    visibleWrappers.length,
    groupedCount
  );
  const readyCount = Math.min(count, Math.max(
    readyMedia.length + extraControlUnits,
    readyWrappers.length,
    groupedReadyCount
  ));
  return { count, readyCount, removeControls: visibleControls };
}

async function waitForImagesReady(config, inputEl, baseline, expected) {
  const timeoutMs = config.imageReadyTimeoutMs || Math.min(60000, 25000 + expected * 8000);
  const started = Date.now();
  let readySince = 0;
  while (Date.now() - started < timeoutMs) {
    const state = attachmentState(config, inputEl);
    const attached = Math.max(0, state.count - baseline.count);
    const loaded = Math.max(0, state.readyCount - baseline.readyCount);
    const ready = attached >= expected && loaded >= expected && !uploadStillBusy(inputEl);
    if (!ready) {
      readySince = 0;
    } else if (!readySince) {
      readySince = Date.now();
    } else if (Date.now() - readySince >= 500) {
      return true;
    }
    await sleep(120);
  }
  return false;
}

async function rollbackNewAttachments(config, inputEl, baseline, timeoutMs = 4000) {
  const baselineControls = new Set(baseline.removeControls || []);
  const current = attachmentState(config, inputEl);
  const newControls = (current.removeControls || [])
    .filter(control => !baselineControls.has(control) && control.isConnected);
  if (!newControls.length) return false;

  for (const control of newControls.reverse()) {
    try { clickElement(control); } catch {}
    await sleep(80);
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = attachmentState(config, inputEl);
    if (state.count <= baseline.count && !uploadStillBusy(inputEl)) return true;
    await sleep(120);
  }
  return false;
}

// Wait for an existing upload, attach the batch once, then only observe. A failed
// batch is rolled back only through remove controls that appeared after baseline.
async function ensureImagesAttached(inputEl, images, config) {
  const expected = images.length;
  if (!expected) return { ok: true, mutated: false, rolledBack: true };

  const idle = await waitForComposerUploadIdle(inputEl, config.imagePrePasteTimeoutMs || 30000);
  if (!idle) return { ok: false, mutated: false, rolledBack: true };
  const baseline = attachmentState(config, inputEl);
  const injected = await injectImages(inputEl, images, config);
  if (!injected) return { ok: false, mutated: false, rolledBack: true };

  const ready = await waitForImagesReady(config, inputEl, baseline, expected);
  if (ready) return { ok: true, mutated: true, rolledBack: false };
  const rolledBack = await rollbackNewAttachments(config, inputEl, baseline);
  return { ok: false, mutated: true, rolledBack };
}

// ---------------------------------------------------------------------------
// Visual debug overlay — pulse a neon-cyan outline around the targeted input
// and submit button so you can see exactly what the engine is interacting with.
// ---------------------------------------------------------------------------
function ensureHighlightStyle() {
  if (document.getElementById('aib-hl-style')) return;
  const style = document.createElement('style');
  style.id = 'aib-hl-style';
  style.textContent = `
    @keyframes aibPulse {
      0%   { outline-color: rgba(69,162,158,0.25); }
      50%  { outline-color: rgba(69,162,158,1); }
      100% { outline-color: rgba(69,162,158,0.25); }
    }
    .aib-target-highlight {
      outline: 2px solid #45A29E !important;
      outline-offset: 2px !important;
      border-radius: 6px;
      animation: aibPulse 0.4s ease-in-out 2 !important;
    }`;
  (document.head || document.documentElement).appendChild(style);
}

function flashHighlight(el) {
  if (!debugOverlaysEnabled || !el) return;
  try {
    ensureHighlightStyle();
    el.classList.add('aib-target-highlight');
    setTimeout(() => el.classList.remove('aib-target-highlight'), 800);
  } catch {}
}

// Short human-readable descriptor of the element the engine chose — surfaced in
// the debug badge so a single screenshot reveals what each panel targeted.
function describeEl(el) {
  if (!el) return 'none';
  const tag = el.tagName ? el.tagName.toLowerCase() : '?';
  const cls = (typeof el.className === 'string' && el.className.trim())
    ? '.' + el.className.trim().split(/\s+/)[0]
    : '';
  const ph = el.getAttribute?.('placeholder')
    || el.getAttribute?.('aria-placeholder')
    || el.getAttribute?.('data-placeholder') || '';
  return `${tag}${cls}${ph ? ` "${ph.slice(0, 20)}"` : ''}`;
}

// Tiny transient status badge inside each frame so broadcast outcomes are
// visible at a glance (and screenshot-able) instead of a silent black box.
function showDebugBadge(message, ok) {
  if (!debugOverlaysEnabled) return;
  try {
    let badge = document.getElementById('aib-debug-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'aib-debug-badge';
      badge.style.cssText = [
        'position:fixed', 'top:8px', 'left:8px', 'z-index:2147483647',
        'max-width:70vw', 'padding:6px 10px', 'border-radius:8px',
        'font:600 11px/1.4 system-ui,-apple-system,sans-serif', 'color:#fff',
        'pointer-events:none', 'white-space:pre-wrap', 'word-break:break-word',
        'box-shadow:0 4px 14px rgba(0,0,0,.45)'
      ].join(';');
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.style.background = ok ? 'rgba(34,150,90,.94)' : 'rgba(196,42,42,.95)';
    badge.textContent = 'AIB ▸ ' + message;
    clearTimeout(badge._aibTimer);
    badge._aibTimer = setTimeout(() => badge.remove(), 5000);
  } catch {}
}

function clickElement(el) {
  if (!shouldAvoidAutomationScroll()) {
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  focusElement(el);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  el.click();
}

function pressEnter(el) {
  focusElement(el);
  const target = el;
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true
  }));
  target.dispatchEvent(new KeyboardEvent('keypress', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    charCode: 13,
    bubbles: true,
    cancelable: true,
    composed: true
  }));
  target.dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true
  }));
}

function comparableTextContains(actual, expected) {
  const actualText = normalizeComparableText(actual);
  const expectedText = normalizeComparableText(expected);
  if (!expectedText) return false;
  if (actualText.includes(expectedText)) return true;

  const head = expectedText.slice(0, Math.min(32, expectedText.length));
  const tail = expectedText.slice(Math.max(0, expectedText.length - 32));
  return actualText.includes(head) && actualText.includes(tail);
}

function userTurnElements(config) {
  const selectors = uniqueList([...(config.userSels || []), ...COMMON_USER_MESSAGE_SELS]);
  return uniqueElements(selectors.flatMap(selector => {
    try { return queryAllDeep(selector); } catch { return []; }
  })).filter(elVisible);
}

const TURN_ATTACHMENT_SELECTOR = 'img,canvas,video,[data-testid*="attachment" i],[data-testid*="file" i],[data-testid*="image" i],[class*="attachment" i],[class*="file-preview" i]';

function turnHasAttachment(element) {
  try {
    return queryAllDeep(TURN_ATTACHMENT_SELECTOR, element).some(elVisible);
  } catch {
    return false;
  }
}

function imageBearingTurnCount(elements) {
  return elements.filter(turnHasAttachment).length;
}

function assistantState(config) {
  const selectors = uniqueList([...(config.responseSels || []), ...COMMON_RESPONSE_SELS]);
  const matches = uniqueElements(selectors.flatMap(selector => {
    try { return queryAllDeep(selector); } catch { return []; }
  })).filter(isVisibleWithText);
  const leaves = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));
  return {
    count: (leaves.length ? leaves : matches).length,
    text: normalizeComparableText(getResponseText())
  };
}

function captureSubmitSnapshot(config, inputEl, expectedText) {
  const users = userTurnElements(config);
  const matchingUsers = users.filter(element => comparableTextContains(elPlainText(element), expectedText));
  const assistant = assistantState(config);
  return {
    url: location.href,
    userTurns: users.length,
    matchingUserTurns: matchingUsers.length,
    imageUserTurns: imageBearingTurnCount(users),
    matchingAttachmentUserTurns: matchingUsers.filter(turnHasAttachment).length,
    assistantCount: assistant.count,
    assistantText: assistant.text,
    stopVisible: !!findStopButton(config, inputEl?.isConnected ? inputEl : null),
    composerConnected: !!inputEl?.isConnected,
    composerContainsText: comparableTextContains(getInputText(inputEl), expectedText),
    attachments: attachmentState(config, inputEl).count
  };
}

function evidenceChanges(baseline, current, payload) {
  return DELIVERY.diffEvidenceSnapshots(baseline, current, payload);
}

function openObservationRoots() {
  const roots = [document];
  const visit = root => {
    let elements = [];
    try { elements = root.querySelectorAll('*'); } catch {}
    for (const element of elements) {
      if (!element.shadowRoot || roots.includes(element.shadowRoot)) continue;
      roots.push(element.shadowRoot);
      visit(element.shadowRoot);
    }
  };
  visit(document);
  return roots;
}

function createMutationWatcher(onMutation) {
  const observers = new Map();
  let mutationCount = 0;

  const refresh = () => {
    for (const root of openObservationRoots()) {
      if (observers.has(root)) continue;
      const observer = new MutationObserver(records => {
        mutationCount += records.length;
        onMutation();
      });
      try {
        observer.observe(root, { subtree: true, childList: true, characterData: true });
        observers.set(root, observer);
      } catch {
        observer.disconnect();
      }
    }
  };

  refresh();
  return {
    refresh,
    disconnect() {
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
    },
    get mutationCount() { return mutationCount; },
    get rootCount() { return observers.size; }
  };
}

async function observeSubmitEvidence(config, inputEl, payload, baseline, timeoutMs, dispatchAction) {
  const started = Date.now();
  const recorded = new Map();
  const weakSince = new Map();
  let sampleCount = 0;
  let wake = null;
  let lastRootRefresh = 0;
  let lastSampleAt = 0;
  const watcher = createMutationWatcher(() => wake?.());

  const recordChanges = changes => {
    const now = Date.now();
    for (const change of changes) {
      if (recorded.has(change.type)) continue;
      if (change.strength === 'weak') {
        const firstSeen = weakSince.get(change.type) || now;
        weakSince.set(change.type, firstSeen);
        if (now - firstSeen < 250) continue;
      }
      recorded.set(change.type, {
        ...change,
        atMs: now - started
      });
    }
  };

  try {
    dispatchAction();
    while (Date.now() - started < timeoutMs) {
      const sinceLastSample = Date.now() - lastSampleAt;
      if (sinceLastSample < 180) await sleep(180 - sinceLastSample);
      lastSampleAt = Date.now();
      sampleCount += 1;
      const currentInput = inputEl?.isConnected ? inputEl : findBestInput(config.inputSels);
      const current = captureSubmitSnapshot(config, currentInput, payload.text);
      recordChanges(evidenceChanges(baseline, current, {
        hasText: !!normalizeComparableText(payload.text),
        hasAttachments: payload.imageCount > 0
      }));

      const classification = DELIVERY.classifyEvidence([...recorded.values()]);
      if (classification.outcome === 'verified') {
        return {
          ...classification,
          evidence: [...recorded.values()],
          samples: sampleCount,
          mutations: watcher.mutationCount,
          observedRoots: watcher.rootCount
        };
      }

      if (Date.now() - lastRootRefresh >= 1000) {
        watcher.refresh();
        lastRootRefresh = Date.now();
      }

      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        const timer = setTimeout(finish, 120);
        wake = finish;
      });
    }

    const classification = DELIVERY.classifyEvidence([...recorded.values()]);
    return {
      ...classification,
      evidence: [...recorded.values()],
      samples: sampleCount,
      mutations: watcher.mutationCount,
      observedRoots: watcher.rootCount
    };
  } finally {
    watcher.disconnect();
  }
}

async function prepareSubmitAction(config, inputEl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const button = findSubmitButton(config, inputEl);
    if (button && !uploadStillBusy(inputEl)) {
      return { kind: 'click', control: button };
    }
    await sleep(100);
  }
  return { kind: 'enter', control: null };
}

function dispatchSubmitAction(action, inputEl) {
  if (action.kind === 'click') {
    flashHighlight(action.control);
    clickElement(action.control);
  } else {
    pressEnter(inputEl);
  }
}

async function observeResponseCompletion(context, config, inputEl, baselineAssistantText) {
  const trackerToken = ++responseTrackerToken;
  const timeoutMs = config.responseCompletionTimeoutMs || 3 * 60 * 1000;
  const started = Date.now();
  let lastText = normalizeComparableText(baselineAssistantText);
  let stableSince = 0;
  let idleSince = 0;
  let sawActivity = context.evidence.some(entry =>
    ['generation_started', 'assistant_activity'].includes(entry.type));
  let sawStop = context.evidence.some(entry => entry.type === 'generation_started');

  while (trackerToken === responseTrackerToken && Date.now() - started < timeoutMs) {
    const currentInput = inputEl?.isConnected ? inputEl : findBestInput(config.inputSels);
    const stopVisible = !!findStopButton(config, currentInput);
    const responseText = normalizeComparableText(getResponseText());

    if (stopVisible) {
      sawActivity = true;
      sawStop = true;
      idleSince = 0;
    } else if (sawActivity && !idleSince) {
      idleSince = Date.now();
    }

    if (responseText && responseText !== lastText) {
      sawActivity = true;
      lastText = responseText;
      stableSince = Date.now();
    } else if (sawActivity && responseText && !stableSince) {
      stableSince = Date.now();
    }

    const textStable = stableSince && Date.now() - stableSince >= 1500;
    const generationIdle = idleSince && Date.now() - idleSince >= 1000;
    if (sawActivity && !stopVisible && generationIdle && (textStable || sawStop)) {
      chrome.runtime.sendMessage({
        action: 'telemetryResponseComplete',
        attemptId: context.attemptId,
        panelId: context.panelId,
        panelEpoch: context.panelEpoch,
        providerKey: context.providerKey,
        hostname: context.hostname,
        responseMs: Date.now() - context.startedAt
      }).catch(() => {});
      return true;
    }
    await sleep(400);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pre-click activation (Copilot and shadow-DOM sites that need focus first)
// ---------------------------------------------------------------------------

async function preClickActivate(config) {
  const input = findBestInput(config.inputSels.slice(0, 6));
  if (!input) return;
  clickElement(input);
  await sleep(200);
}

// ---------------------------------------------------------------------------
// Main injection orchestrator
// ---------------------------------------------------------------------------

function pageNeedsLogin() {
  // Only flag as login-required when there is no usable chat input AND the page
  // has a visible login/password form (not just header nav buttons like "Sign in").
  const hasPasswordInput = queryAllDeep('input[type="password"]').some(isUsable);
  if (hasPasswordInput) return true;

  const hasUsableInput = queryAllDeep(
    'textarea,div[contenteditable="true"],[role="textbox"],input[type="text"]'
  ).some(element => isUsable(element) && !isBadInputCandidate(element));
  if (hasUsableInput) return false;

  // Check for a real login form (has a password field or a dedicated sign-in form)
  const hasLoginForm = queryAllDeep('input[type="password"],form[action*="login" i],form[action*="signin" i]').length > 0;
  if (hasLoginForm) return true;

  // Fallback: page text strongly implies a login wall with no input available
  const text = document.body?.innerText?.toLowerCase() || '';
  return /\b(log in|sign in)\b/.test(text) && /\b(to continue|to access|required)\b/.test(text);
}

function pageOffersLogin() {
  return queryAllDeep('a,button,[role="button"]').some(element =>
    isUsable(element) && /\b(log in|sign in)\b/i.test(labelFor(element)));
}

function createAttemptContext(data) {
  const startedAt = Date.now();
  return {
    protocolVersion: DELIVERY.VERSION,
    deliveryId: String(data.deliveryId || `delivery-${startedAt}`),
    attemptId: String(data.attemptId || `attempt-${startedAt}`),
    panelId: String(data.panelId || panelBinding.panelId || ''),
    panelEpoch: Number.isInteger(data.panelEpoch) ? data.panelEpoch : panelBinding.panelEpoch,
    providerKey: String(data.providerKey || panelBinding.providerKey || ''),
    isRetry: data.isRetry === true,
    hostname: location.hostname,
    startedAt,
    lifecycle: [],
    evidence: [],
    action: {
      kind: null,
      dispatched: false,
      atMs: null,
      control: null
    },
    timings: {
      startedAt,
      inputReadyMs: null,
      textReadyMs: null,
      imagesReadyMs: null,
      actionDispatchedMs: null,
      firstEvidenceMs: null,
      terminalMs: null,
      totalMs: null
    },
    diagnostics: {
      hostname: location.hostname,
      input: '',
      submit: '',
      preexisting: {},
      observer: { samples: 0, mutations: 0, observedRoots: 0 }
    },
    attachmentsMutated: false
  };
}

function markLifecycle(context, state, details = {}) {
  const atMs = Date.now() - context.startedAt;
  context.lifecycle.push({ state, atMs });
  const timingField = {
    input_ready: 'inputReadyMs',
    text_ready: 'textReadyMs',
    images_ready: 'imagesReadyMs',
    action_dispatched: 'actionDispatchedMs'
  }[state];
  if (timingField && context.timings[timingField] == null) context.timings[timingField] = atMs;

  chrome.runtime.sendMessage({
    action: 'deliveryLifecycle',
    protocolVersion: DELIVERY.VERSION,
    deliveryId: context.deliveryId,
    attemptId: context.attemptId,
    panelId: context.panelId,
    panelEpoch: context.panelEpoch,
    providerKey: context.providerKey,
    isRetry: context.isRetry,
    hostname: context.hostname,
    state,
    atMs,
    details
  }).catch(() => {});
}

function finishAttempt(context, outcome, reason, options = {}) {
  const terminalMs = Date.now() - context.startedAt;
  context.evidence = options.evidence || context.evidence;
  context.timings.firstEvidenceMs = context.evidence[0]?.atMs ?? null;
  context.timings.terminalMs = terminalMs;
  context.timings.totalMs = terminalMs;
  if (options.observer) context.diagnostics.observer = options.observer;

  const confidence = options.confidence || (outcome === 'verified' ? 'strong' : 'none');
  const retry = DELIVERY.deriveRetrySafety({
    actionDispatched: context.action.dispatched,
    reason,
    attachmentsMutated: context.attachmentsMutated
  });
  markLifecycle(context, outcome, { reason, confidence });

  return {
    protocolVersion: DELIVERY.VERSION,
    deliveryId: context.deliveryId,
    attemptId: context.attemptId,
    panelId: context.panelId,
    panelEpoch: context.panelEpoch,
    providerKey: context.providerKey,
    isRetry: context.isRetry,
    hostname: context.hostname,
    ok: outcome === 'verified',
    outcome,
    confidence,
    reason,
    action: context.action,
    retry,
    evidence: context.evidence,
    lifecycle: context.lifecycle,
    timings: context.timings,
    diagnostics: context.diagnostics
  };
}

async function handleInject(data) {
  responseTrackerToken += 1;
  const context = createAttemptContext(data);
  const text = PROMPT_POLICY.applyProviderPromptPolicy(location.hostname, data.text);
  const images = imagePayloadsFromData(data);
  const config = getConfig();
  markLifecycle(context, 'received');

  const attachmentValidation = DELIVERY.validateAttachments(images);
  if (!attachmentValidation.ok) {
    return finishAttempt(context, 'failed', attachmentValidation.reason);
  }

  if (!config) {
    return finishAttempt(context, 'failed', `no_config:${location.hostname}`);
  }
  if (images.length && config.attachmentsRequireLogin && pageOffersLogin()) {
    return finishAttempt(context, 'failed', 'login_required');
  }

  const group = data.group || config.group || 'B';
  const timeouts = GROUP_TIMEOUTS[group] || GROUP_TIMEOUTS.B;
  const inputTimeout = timeouts.input;
  const submitTimeout = images.length
    ? timeouts.submit * 2 + images.length * 1000
    : timeouts.submit;
  const evidenceTimeout = (config.submitEvidenceTimeoutMs || timeouts.evidence)
    + Math.min(10000, images.length * 2000);

  try {
    markLifecycle(context, 'preparing');
    const generationStopped = await stopActiveGeneration(
      config,
      findBestInput(config.inputSels)
    );
    if (!generationStopped) {
      showDebugBadge(`${location.hostname}\nactive response did not stop — message not pasted`, false);
      return finishAttempt(context, 'failed', 'generation_did_not_stop');
    }

    if (config.preClick) await preClickActivate(config);

    const input = await waitForInput(config, inputTimeout);
    if (!input) {
      const reason = pageNeedsLogin() ? 'login_required' : `no_input:${location.hostname}`;
      showDebugBadge(`${location.hostname}\n${reason === 'login_required' ? 'needs login' : 'NO input box found'}`, false);
      return finishAttempt(context, 'failed', reason);
    }

    context.diagnostics.input = describeEl(input);
    context.diagnostics.inputSelection = lastInputDiagnostic ? { ...lastInputDiagnostic } : null;
    context.diagnostics.preexisting = {
      draftPresent: normalizeComparableText(getInputText(input)).length > 0,
      attachments: attachmentState(config, input).count,
      stopVisible: !!findStopButton(config, input)
    };
    markLifecycle(context, 'input_ready');
    flashHighlight(input);

    if (text) {
      markLifecycle(context, 'injecting_text');
      const inserted = await injectTextReliably(input, text, config.type);
      if (!inserted) {
        showDebugBadge(`${location.hostname}\nfound: ${describeEl(input)}\nbut TEXT DID NOT INSERT`, false);
        return finishAttempt(context, 'failed', 'text_not_inserted');
      }
      markLifecycle(context, 'text_ready');
    }

    if (images.length) {
      markLifecycle(context, 'attaching');
      const attachmentResult = await ensureImagesAttached(input, images, config);
      context.attachmentsMutated = attachmentResult.mutated && !attachmentResult.rolledBack;
      context.diagnostics.attachments = {
        requested: images.length,
        mutated: attachmentResult.mutated,
        rolledBack: attachmentResult.rolledBack
      };
      if (!attachmentResult.ok) {
        showDebugBadge(`${location.hostname}\nattachment did not become ready — message NOT sent`, false);
        return finishAttempt(context, 'failed', 'attachment_not_ready');
      }
      markLifecycle(context, 'images_ready');
    }

    const action = await prepareSubmitAction(config, input, submitTimeout);
    context.action.kind = action.kind;
    context.action.control = action.control ? describeEl(action.control) : 'composer Enter';
    context.diagnostics.submit = context.action.control;
    context.diagnostics.submitSelection = lastSubmitDiagnostic ? { ...lastSubmitDiagnostic } : null;
    markLifecycle(context, 'action_ready', { kind: action.kind });

    const baseline = captureSubmitSnapshot(config, input, text);
    markLifecycle(context, 'verifying');
    const observed = await observeSubmitEvidence(
      config,
      input,
      { text, imageCount: images.length },
      baseline,
      evidenceTimeout,
      () => {
        dispatchSubmitAction(action, input);
        context.action.dispatched = true;
        context.action.atMs = Date.now() - context.startedAt;
        markLifecycle(context, 'action_dispatched', { kind: action.kind });
      }
    );

    const observer = {
      samples: observed.samples,
      mutations: observed.mutations,
      observedRoots: observed.observedRoots
    };
    const result = finishAttempt(context, observed.outcome, observed.reason, {
      confidence: observed.confidence,
      evidence: observed.evidence,
      observer
    });

    showDebugBadge(
      `${location.hostname}\ninput: ${describeEl(input)}\n${result.outcome.toUpperCase()}: ${result.reason}`,
      result.outcome === 'verified'
    );
    if (result.outcome === 'verified') {
      observeResponseCompletion(context, config, input, baseline.assistantText).catch(() => {});
    }
    return result;
  } catch (error) {
    showDebugBadge(`${location.hostname}\nINTERNAL ERROR: ${error?.message || error}`, false);
    return finishAttempt(context, 'failed', 'internal_error', {
      confidence: 'none'
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point 1: Direct message from background (fast path)
// ---------------------------------------------------------------------------

function pruneAttemptCache(now = Date.now()) {
  for (const [attemptId, entry] of attemptCache) {
    if (attemptId !== activeAttemptId && now - entry.createdAt > ATTEMPT_CACHE_TTL_MS) {
      attemptCache.delete(attemptId);
    }
  }
  while (attemptCache.size > ATTEMPT_CACHE_LIMIT) {
    const oldest = [...attemptCache.keys()].find(attemptId => attemptId !== activeAttemptId);
    if (!oldest) break;
    attemptCache.delete(oldest);
  }
}

function runAttempt(message) {
  pruneAttemptCache();
  const attemptId = String(message.attemptId || `${message.deliveryId || 'delivery'}:${Date.now()}`);
  const cached = attemptCache.get(attemptId);
  if (cached) return cached.promise;

  if (activeAttemptId && activeAttemptId !== attemptId) {
    const context = createAttemptContext({ ...message, attemptId });
    markLifecycle(context, 'received');
    const promise = Promise.resolve(finishAttempt(context, 'failed', 'frame_busy'));
    attemptCache.set(attemptId, { createdAt: Date.now(), promise });
    return promise;
  }

  activeAttemptId = attemptId;
  const promise = handleInject({ ...message, attemptId })
    .finally(() => {
      if (activeAttemptId === attemptId) activeAttemptId = null;
      pruneAttemptCache();
    });
  attemptCache.set(attemptId, { createdAt: Date.now(), promise });
  return promise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'inject') return false;
  runAttempt(msg)
    .then(result => sendResponse(result))
    .catch(error => sendResponse({
      protocolVersion: DELIVERY.VERSION,
      deliveryId: msg.deliveryId || '',
      attemptId: msg.attemptId || '',
      panelId: msg.panelId || panelBinding.panelId || '',
      panelEpoch: msg.panelEpoch ?? panelBinding.panelEpoch,
      hostname: location.hostname,
      ok: false,
      outcome: 'failed',
      confidence: 'none',
      reason: error?.message || 'internal_error',
      retry: { safe: false, reason: 'frame_state_unknown' }
    }));
  return true;
});

// ---------------------------------------------------------------------------
// Self-register with background
// ---------------------------------------------------------------------------

// Register through the extension runtime so background.js receives authoritative
// tab/frame IDs. A workspace-provided binding adds stable panel identity after
// each iframe navigation.
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;

function bindingFields() {
  return {
    panelId: panelBinding.panelId,
    panelEpoch: panelBinding.panelEpoch,
    providerKey: panelBinding.providerKey
  };
}

function registerPanel() {
  return chrome.runtime.sendMessage({
    action: 'register',
    hostname: location.hostname,
    ...bindingFields()
  }).catch(() => null);
}

function announceAlive() {
  return chrome.runtime.sendMessage({
    action: 'panelAlive',
    hostname: location.hostname,
    ...bindingFields()
  }).catch(() => null);
}

const READINESS_TIMEOUT_MS = 20000;
const READINESS_RETRY_MS = 30000;
const READINESS_RECHECK_MS = 5000;
let readinessProbeGeneration = 0;
let readinessRetryTimer = null;
let lastReadinessAnnouncement = '';
let readinessAnnouncementQueue = Promise.resolve();

function readinessBlockReason() {
  const text = `${document.title || ''}\n${document.body?.textContent?.slice(0, 12000) || ''}`.toLowerCase();
  if (/\b403 error\b|request blocked|access denied/.test(text)) return 'Provider blocked the embedded request';
  if (/security verification|verify you are human|checking your browser|cloudflare ray id|just a moment/.test(text)) {
    return 'Provider security verification is blocking the composer';
  }
  if (/not available (?:in|for) your (?:country|region)|unsupported region/.test(text)) {
    return 'Provider is unavailable in this region';
  }
  return '';
}

function announceReadiness(state, reason = '') {
  const binding = bindingFields();
  const signature = [state, reason, binding.panelId, binding.panelEpoch].join('|');
  const payload = {
    action: 'panelReadiness',
    hostname: location.hostname,
    state,
    reason,
    ...binding
  };
  const task = readinessAnnouncementQueue.catch(() => null).then(async () => {
    if (signature === lastReadinessAnnouncement) return { ok: true, deduplicated: true };
    let response = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await chrome.runtime.sendMessage(payload).catch(() => null);
      if (response?.ok === true) {
        lastReadinessAnnouncement = signature;
        return response;
      }
      if (attempt < 2) await sleep(200 * (attempt + 1));
    }
    return response;
  });
  readinessAnnouncementQueue = task;
  return task;
}

function scheduleReadinessProbe(delay, recheck = false) {
  clearTimeout(readinessRetryTimer);
  readinessRetryTimer = setTimeout(() => startReadinessProbe(recheck), delay);
}

function startReadinessProbe(recheck = false) {
  clearTimeout(readinessRetryTimer);
  readinessRetryTimer = null;
  const generation = ++readinessProbeGeneration;
  const startedAt = Date.now();

  void (async () => {
    const config = getConfig();
    if (!config) {
      await announceReadiness('not_ready', 'Provider automation is not configured');
      return;
    }

    // A READY panel remains under passive supervision. Check the full selector
    // set before changing UI state so healthy panels never flicker to CHECKING.
    if (recheck) {
      const input = findBestInput(config.inputSels);
      if (input && isUsable(input)) {
        await announceReadiness('ready');
        if (generation === readinessProbeGeneration) {
          scheduleReadinessProbe(READINESS_RECHECK_MS, true);
        }
        return;
      }
    }

    await announceReadiness('checking');
    let failureReason = '';
    while (generation === readinessProbeGeneration && Date.now() - startedAt < READINESS_TIMEOUT_MS) {
      const elapsed = Date.now() - startedAt;
      const selectors = elapsed < 2500 ? config.directInputSels : config.inputSels;
      const input = findBestInput(selectors);
      if (input && isUsable(input)) {
        await announceReadiness('ready');
        if (generation === readinessProbeGeneration) {
          scheduleReadinessProbe(READINESS_RECHECK_MS, true);
        }
        return;
      }
      failureReason = readinessBlockReason() || (pageNeedsLogin() ? 'Sign in required' : failureReason);
      await sleep(750);
    }

    if (generation !== readinessProbeGeneration) return;
    const state = failureReason === 'Sign in required' ? 'login_required' : 'not_ready';
    await announceReadiness(state, failureReason || `Composer not found on ${location.hostname}`);
    if (generation === readinessProbeGeneration) {
      scheduleReadinessProbe(READINESS_RETRY_MS);
    }
  })();
}

registerPanel();
announceAlive();
startReadinessProbe();
window.addEventListener('load', () => {
  registerPanel();
  announceAlive();
  startReadinessProbe();
});
setTimeout(() => {
  registerPanel();
  announceAlive();
}, 1500);

window.addEventListener('message', event => {
    const data = event.data;
    if (!data || event.origin !== EXTENSION_ORIGIN) return;

    if (data.__aib === 'panel-binding') {
      const panelId = typeof data.panelId === 'string' ? data.panelId.slice(0, 160) : '';
      const panelEpoch = Number(data.panelEpoch);
      if (!panelId || !Number.isInteger(panelEpoch) || panelEpoch < 1) return;
      panelBinding = {
        panelId,
        panelEpoch,
        providerKey: typeof data.providerKey === 'string' ? data.providerKey.slice(0, 80) : null
      };
      registerPanel();
      announceAlive();
      startReadinessProbe();
      return;
    }

    if (data.__aib !== 'capture-req') return;
    let response = { text: '' };
    try { response = getLatestAssistantResponse(); } catch {}
    try {
      window.parent.postMessage(
        { __aib: 'capture-res', reqId: data.reqId, host: location.hostname, ...response },
        EXTENSION_ORIGIN
      );
    } catch {}
  });
// ---------------------------------------------------------------------------
