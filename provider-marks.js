'use strict';

(function initProviderMarks(global) {
  const marks = {
    gemini: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.7c.55 5.65 4.95 10.05 10.6 10.6-5.65.55-10.05 4.95-10.6 10.6C11.45 17.25 7.05 12.85 1.4 12.3 7.05 11.75 11.45 7.35 12 1.7Z" fill="currentColor" stroke="none"/></svg>',
    deepseek: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13.2c2.2 1.1 4.2 1.35 6 .75 2.4-.8 3.75-2.9 6.5-3.2 2.15-.25 4.1.65 5.5 2.2-1.25 4.5-4.75 7.05-9.35 7.05C7 20 3.8 17.65 3 13.2Z"/><path d="M15.2 10.8c.2-2.6 1.55-4.55 4.05-5.85-.15 2.7-1.45 4.65-3.9 5.9M6.4 12.6c.65-2.35 2.2-3.75 4.65-4.2"/><circle cx="15.8" cy="14.3" r=".8" fill="currentColor" stroke="none"/></svg>',
    mistral: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h4v4h2V4h6v4h2V4h4v16h-4v-8h-2v4H9v-4H7v8H3V4Z" fill="currentColor" stroke="none"/></svg>',
    grok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 19.8 19.8 4.2M7.5 4.5h7.2a4.8 4.8 0 0 1 4.8 4.8v7.2M4.5 14.7V9.3a4.8 4.8 0 0 1 4.8-4.8"/></svg>',
    perplexity: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M4 7.5h16M4 16.5h16M4 7.5l8 9 8-9M4 16.5l8-9 8 9M4 7.5v9M20 7.5v9"/></svg>',
    you: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 8 4 4 4-4M12 12v5"/></svg>',
    duckai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 18.5c-2.5-1.2-4-3.5-4-6.2C4 7.7 7.5 4 12 4c3.3 0 6.1 2 7.4 4.8l2.1 1.2-2.2 1.4c-.55 4.8-3.3 7.1-7.3 7.1H8Z"/><circle cx="14.5" cy="8.5" r=".8" fill="currentColor" stroke="none"/><path d="M4.5 14.5c2.2.2 3.9-.35 5.1-1.65"/></svg>',
    huggingchat: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="7.5"/><path d="M8.5 10h.01M15.5 10h.01M8.7 13.3c1.8 1.8 4.8 1.8 6.6 0M5.2 16.2 2.5 19M18.8 16.2l2.7 2.8"/></svg>',
    poe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M9 8.2h4.1a2.6 2.6 0 0 1 0 5.2H9V8.2Z"/></svg>',
    venice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4.5 10.2 20h3.6L21 4.5h-4.6L12 15 7.6 4.5H3Z" fill="currentColor" stroke="none"/></svg>',
    lmarena: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5"/></svg>',
    'ai-studio': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c.45 4.2 3.8 7.55 8 8-4.2.45-7.55 3.8-8 8-.45-4.2-3.8-7.55-8-8 4.2-.45 7.55-3.8 8-8Z"/><path d="M19 16.5c.15 1.45 1.3 2.6 2.75 2.75-1.45.15-2.6 1.3-2.75 2.75-.15-1.45-1.3-2.6-2.75-2.75 1.45-.15 2.6-1.3 2.75-2.75Z"/></svg>',
    copilot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 5.2 5 7.6a4.4 4.4 0 0 0 0 7.6l4.2 2.4M14.8 5.2 19 7.6a4.4 4.4 0 0 1 0 7.6l-4.2 2.4M8 8.2h8v7.6H8z"/></svg>',
    qwen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c2.2 0 3 2.35 1.75 4.1 2.1-.75 4 .9 3.35 3.05 2.15.2 2.8 2.65 1.05 3.9.9 2-1.05 3.95-3.05 3.15-.05 2.15-2.45 3-3.8 1.3-1.9 1.05-4-.75-3.35-2.85-2.1-.1-2.95-2.45-1.35-3.85-1.1-1.9.65-4 2.75-3.45C9 5.7 9.8 2.5 12 2.5Z"/><circle cx="12" cy="11.5" r="2.6"/></svg>',
    meta: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 15.8C4.1 9.4 6.2 6.2 8.7 6.2c3.75 0 5.7 11.6 8.6 11.6 1.75 0 3.15-2.1 4.2-6.2-1.6-3.6-3.2-5.4-4.8-5.4-3.7 0-5.75 11.6-8.7 11.6-2.15 0-4-2.45-5.5-7.3"/></svg>',
    kimi: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.8 16.2A8.5 8.5 0 0 1 7.8 5.2 8.5 8.5 0 1 0 18.8 16.2Z" fill="currentColor" stroke="none"/></svg>',
    blackbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z"/><path d="m4 7.4 8 4.6 8-4.6M12 12v9.2"/></svg>'
  };

  const fallback = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 15V9l4 6 4-6v6"/></svg>';
  global.AIB_PROVIDER_MARKS = Object.freeze(marks);
  global.AIB_PROVIDER_MARK = key => marks[key] || fallback;
})(globalThis);
