'use strict';

// Timestamp guard prevents double-injection when both paths fire
if (!window._aibTs) window._aibTs = 0;
const AIB_HOSTS = new Set(globalThis.AIB_AI_HOSTS || []);

function isWorkspacePanelFrame() {
  try {
    if (window.self === window.top) return false;
    void window.parent.location.href;
    return false;
  } catch {
    return true;
  }
}

function cleanupLegacyWorkspaceMutation() {
  document.getElementById('aib-hide-input-style')?.remove();
  for (const el of document.querySelectorAll('[data-aib-hide]')) {
    delete el.dataset.aibHide;
  }
  delete document.documentElement.dataset.aibInjecting;
}

cleanupLegacyWorkspaceMutation();
document.addEventListener('DOMContentLoaded', cleanupLegacyWorkspaceMutation, { once: true });

// Group-based timeouts (ms) — background tags each payload with its group.
// Group A = fast/reliable, B = search/specialist, C = complex/shadow-DOM.
const GROUP_TIMEOUTS = {
  A: { input: 4000,  submit: 3000  },
  B: { input: 7000,  submit: 5000  },
  C: { input: 10000, submit: 7000  }
};

// Platform configs — precise selectors per hostname.
// inputSels / submitSels are tried in order; first usable match wins.
// type: 'textarea' | 'contenteditable' | 'auto' controls text-injection path.
// preClick: true — click the input before injecting (needed for some shadow-DOM sites).
// ---------------------------------------------------------------------------
const PLATFORMS = {
  // ── Group A ──────────────────────────────────────────────────────────────
  'gemini.google.com': {
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
    preClick: true
  },
  'grok.com': {
    inputSels: [
      'textarea[data-testid="userInput"]',
      'textarea[placeholder*="know" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Grok" i]',
      'textarea[placeholder]',
      'textarea'
    ],
    submitSels: [
      'button[data-testid="chat-submit"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    type: 'auto',
    // grok.com is fast once up but slow to FIRST paint inside a fresh iframe;
    // group B's longer input timeout avoids "no input box" on cold load.
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
    group: 'B'
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
    type: 'contenteditable',
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
    type: 'contenteditable',
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
    type: 'contenteditable',
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
    submitSels: uniqueList([...config.submitSels, ...COMMON_SUBMIT_SELS])
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
  try {
    return window.self !== window.top || document.documentElement.dataset.aibInjecting === '1';
  } catch {
    return true;
  }
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
    && el.getAttribute('aria-disabled') !== 'true'
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
  return el.tagName === 'TEXTAREA'
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
        if (score >= 0) candidates.push({ el: input, score });
      }
    } catch {}
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.el || null;
}

function getInputText(el) {
  if (!el) return '';
  if ('value' in el) return el.value || '';
  return el.innerText || el.textContent || '';
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

async function injectTextViaClipboardEvent(el, text) {
  focusElement(el);
  if ('value' in el) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  dt.setData('text/html', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
  await sleep(60);
}

async function injectTextReliably(input, text, type) {
  for (let attempt = 0; attempt < 3; attempt++) {
    injectText(input, text, type);
    await sleep(140);
    if (textWasFullyInserted(input, text)) return true;
  }

  // Last resort: the clear-then-paste path.
  await injectTextViaClipboardEvent(input, text);
  await sleep(120);
  return textWasFullyInserted(input, text);
}

// ---------------------------------------------------------------------------
// Image injection
// ---------------------------------------------------------------------------

function imagePayloadsFromData(data) {
  if (Array.isArray(data.images)) {
    return data.images
      .filter(image => image?.base64)
      .map(image => ({
        base64: image.base64,
        name: image.name || 'image.png',
        type: image.type || 'image/png'
      }));
  }

  return data.imageBase64
    ? [{ base64: data.imageBase64, name: data.imageName || 'image.png', type: data.imageType || 'image/png' }]
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

function injectImagesIntoFileInput(fileInput, files) {
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

async function injectImages(inputEl, images, config) {
  if (!images.length) return;

  const files = filesFromImages(images);
  const fileInput = findImageFileInput(config, inputEl);
  if (fileInput && injectImagesIntoFileInput(fileInput, files)) return;

  try {
    const dt = dataTransferWithFiles(files);
    focusElement(inputEl);
    inputEl.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
  } catch {}
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

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
      if (usable) return usable;
    } catch {}
  }

  const roots = candidateRoots(inputEl);
  const candidates = queryAllDeepFromRoots('button,[role="button"]', roots)
    .filter(el => scoreSubmitCandidate(el, inputEl) >= 18)
    .sort((a, b) => scoreSubmitCandidate(b, inputEl) - scoreSubmitCandidate(a, inputEl));

  return candidates[0] || null;
}

function uploadStillBusy() {
  const busySelectors = [
    '[aria-label*="uploading" i]',
    '[aria-label*="upload" i][aria-busy="true"]',
    '[data-testid*="upload" i][aria-busy="true"]',
    '[role="progressbar"]',
    'progress'
  ];

  return busySelectors.some(sel => {
    try {
      return queryAllDeep(sel).some(isUsable);
    } catch {
      return false;
    }
  });
}

async function waitForImagesReady(config, imageCount) {
  const settleMs = config.imageSettleMs || Math.min(1800, 650 + imageCount * 220);
  const timeoutMs = config.imageReadyTimeoutMs || Math.min(7000, 2600 + imageCount * 850);
  const started = Date.now();
  let idleSince = 0;

  await sleep(settleMs);
  while (Date.now() - started < timeoutMs) {
    if (uploadStillBusy()) {
      idleSince = 0;
    } else if (!idleSince) {
      idleSince = Date.now();
    } else if (Date.now() - idleSince >= 240) {
      return;
    }
    await sleep(120);
  }
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
  if (!el) return;
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
  for (const target of uniqueElements([el, document.activeElement, document.body])) {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
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
}

async function clickSubmit(config, inputEl, timeoutMs, text = '') {
  const started = Date.now();
  let btn = null;
  const needle = text ? text.slice(0, Math.min(24, text.length)) : '';

  while (Date.now() - started < timeoutMs) {
    btn = findSubmitButton(config, inputEl);
    if (btn && !uploadStillBusy()) {
      flashHighlight(btn);
      clickElement(btn);
      await sleep(300);
      if (needle && getInputText(inputEl).includes(needle)) pressEnter(inputEl);
      return true;
    }
    await sleep(100);
  }

  if (btn) {
    flashHighlight(btn);
    clickElement(btn);
    await sleep(300);
    if (needle && getInputText(inputEl).includes(needle)) pressEnter(inputEl);
    return true;
  }

  pressEnter(inputEl);
  await sleep(150);
  return true;
}

// ---------------------------------------------------------------------------
// Pre-click activation (Copilot and shadow-DOM sites that need focus first)
// ---------------------------------------------------------------------------

async function preClickActivate(config) {
  for (const sel of config.inputSels.slice(0, 6)) {
    try {
      const el = queryAllDeep(sel)[0];
      if (el && isUsable(el)) {
        clickElement(el);
        await sleep(200);
        return;
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main injection orchestrator
// ---------------------------------------------------------------------------

function pageNeedsLogin() {
  // Only flag as login-required when there is no usable chat input AND the page
  // has a visible login/password form (not just header nav buttons like "Sign in").
  const hasUsableInput = queryAllDeep(
    'textarea,div[contenteditable="true"],[role="textbox"],input[type="text"]'
  ).some(isUsable);
  if (hasUsableInput) return false;

  // Check for a real login form (has a password field or a dedicated sign-in form)
  const hasLoginForm = queryAllDeep('input[type="password"],form[action*="login" i],form[action*="signin" i]').length > 0;
  if (hasLoginForm) return true;

  // Fallback: page text strongly implies a login wall with no input available
  const text = document.body?.innerText?.toLowerCase() || '';
  return /\b(log in|sign in)\b/.test(text) && /\b(to continue|to access|required)\b/.test(text);
}

async function handleInject(data) {
  const { text } = data;
  const images = imagePayloadsFromData(data);
  const config = getConfig();
  if (!config) return { ok: false, hostname: location.hostname, reason: 'no_config:' + location.hostname };

  try {
    // Use group-specific timeouts; fall back to B if group is missing
    const group = data.group || config.group || 'B';
    const timeouts = GROUP_TIMEOUTS[group] || GROUP_TIMEOUTS['B'];
    const inputTimeout  = timeouts.input;
    const submitTimeout = images.length
      ? timeouts.submit * 2 + images.length * 1000
      : timeouts.submit;

    // Copilot and similar shadow-DOM sites need a click to activate the input area
    if (config.preClick) {
      await preClickActivate(config);
    }

    const input = await waitForInput(config, inputTimeout);
    if (!input) {
      const reason = pageNeedsLogin() ? 'login_required' : 'no_input';
      showDebugBadge(`${location.hostname}\n${reason === 'login_required' ? 'needs login' : 'NO input box found'}`, false);
      return {
        ok: false,
        hostname: location.hostname,
        reason: reason === 'login_required' ? 'login_required' : 'no_input:' + location.hostname
      };
    }
    flashHighlight(input);

    let inserted = true;
    if (text) {
      inserted = await injectTextReliably(input, text, config.type);
      if (!inserted) {
        showDebugBadge(`${location.hostname}\nfound: ${describeEl(input)}\nbut TEXT DID NOT INSERT`, false);
        return { ok: false, hostname: location.hostname, reason: 'text_not_inserted' };
      }
    }
    if (images.length) {
      await injectImages(input, images, config);
      await waitForImagesReady(config, images.length);
    }

    const submitted = await clickSubmit(config, input, submitTimeout, text || '');
    showDebugBadge(
      `${location.hostname}\ninput: ${describeEl(input)}\ntyped: ${inserted ? 'YES' : 'no'}  sent: ${submitted ? 'YES' : 'no'}`,
      submitted && inserted
    );
    return { ok: submitted, hostname: location.hostname, reason: submitted ? '' : 'submit_failed' };
  } finally {
    delete document.documentElement.dataset.aibInjecting;
  }
}

// ---------------------------------------------------------------------------
// Entry point 1: Direct message from background (fast path)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'inject') return false;
  const ts = msg.timestamp || Date.now();
  if (ts <= window._aibTs) {
    sendResponse({ ok: false, hostname: location.hostname, reason: 'duplicate' });
    return false;
  }
  window._aibTs = ts;
  handleInject(msg)
    .then(result => sendResponse(result))
    .catch(err   => sendResponse({ ok: false, hostname: location.hostname, reason: String(err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Entry point 2: Storage broadcast disabled. Popup broadcasts must not touch
// normal Chrome tabs; background sends direct messages to workspace panels only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-register with background
// ---------------------------------------------------------------------------

if (isWorkspacePanelFrame()) {
  chrome.runtime.sendMessage({
    action: 'register',
    hostname: location.hostname,
    topLevelFrame: true
  }).catch(() => {});

  // Tell the workspace (parent) this panel embedded successfully — content.js
  // only runs if the AI document actually loaded (a blocked frame never gets
  // here). The workspace uses this to auto-fall-back to a real window only when
  // a site genuinely refuses to embed. Post a few times: at script run, on full
  // load, and after a short settle, since SPA hosts hydrate late.
  const announceAlive = () => {
    try { window.parent.postMessage({ __aib: 'panel-alive', host: location.hostname }, '*'); } catch {}
  };
  announceAlive();
  window.addEventListener('load', announceAlive);
  setTimeout(announceAlive, 1500);
}
// ---------------------------------------------------------------------------
