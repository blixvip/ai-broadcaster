'use strict';

(function initProviders(global) {
  const providers = [
    // ── Group A: Foundation AIs — fast, reliable, stable selectors ────────────
    { key: 'gemini',      label: 'Gemini',      url: 'https://gemini.google.com/app',                domain: 'gemini.google.com',    category: 'General',     aliases: ['google', 'bard'],                              group: 'A' },
    { key: 'deepseek',    label: 'DeepSeek',    url: 'https://chat.deepseek.com/',                   domain: 'chat.deepseek.com',    category: 'General',     aliases: ['r1', 'reasoning', 'coding'],                   group: 'A' },
    { key: 'mistral',     label: 'Le Chat',     url: 'https://chat.mistral.ai/',                     domain: 'chat.mistral.ai',      category: 'General',     aliases: ['mistral'],                                     group: 'B' },
    { key: 'grok',        label: 'Grok',        url: 'https://grok.com/',                            domain: 'grok.com',             category: 'General',     aliases: ['xai'],                                         group: 'B' },
    // ── Group B: Search & Specialist AIs ─────────────────────────────────────
    { key: 'perplexity',  label: 'Perplexity',  url: 'https://www.perplexity.ai/',                   domain: 'perplexity.ai',        domains: ['perplexity.ai', 'www.perplexity.ai'],            category: 'Search',      aliases: ['research', 'sources'],                         group: 'B' },
    { key: 'you',         label: 'You.com',     url: 'https://you.com/search',                       domain: 'you.com',              domains: ['you.com', 'www.you.com'],                        category: 'Search',      aliases: ['youchat', 'research'],                         group: 'B' },
    { key: 'duckai',      label: 'Duck.ai',     url: 'https://duck.ai/',                             domain: 'duck.ai',              category: 'Private',     aliases: ['duckduckgo', 'anonymous', 'search'],           group: 'B' },
    { key: 'huggingchat', label: 'HuggingChat', url: 'https://huggingface.co/chat/',                 domain: 'huggingface.co',       category: 'Open Source', aliases: ['hugging face', 'hf', 'llama', 'open models'],  group: 'B' },
    { key: 'poe',         label: 'Poe',         url: 'https://poe.com/',                             domain: 'poe.com',              category: 'Multi-model', aliases: ['quora', 'bots'],                               group: 'B' },
    { key: 'venice',      label: 'Venice',      url: 'https://venice.ai/chat/agent',                 domain: 'venice.ai',            domains: ['venice.ai', 'www.venice.ai', 'chat.venice.ai'], category: 'Private', aliases: ['private', 'web search', 'open source models'], group: 'B' },
    { key: 'lmarena',     label: 'Arena',       url: 'https://arena.ai/',                            domain: 'arena.ai',             domains: ['arena.ai', 'lmarena.ai'],                       category: 'Compare',     aliases: ['lmarena', 'chatbot arena', 'models'],          group: 'B' },
    { key: 'ai-studio',   label: 'AI Studio',   url: 'https://aistudio.google.com/prompts/new_chat', domain: 'aistudio.google.com',  category: 'Developer',   aliases: ['google ai studio', 'gemini api', 'prompt'],    group: 'B' },
    // ── Group C: Complex / Shadow-DOM AIs — need more time ────────────────────
    { key: 'copilot',     label: 'Copilot',     url: 'https://copilot.microsoft.com/',               domain: 'copilot.microsoft.com',category: 'General',     aliases: ['microsoft', 'bing'],                           group: 'C' },
    { key: 'qwen',        label: 'Qwen',        url: 'https://chat.qwen.ai/',                        domain: 'chat.qwen.ai',         domains: ['chat.qwen.ai', 'chat.qwenlm.ai'],                category: 'General',     aliases: ['alibaba', 'qwq'],                              group: 'C' },
    { key: 'meta',        label: 'Meta AI',     url: 'https://www.meta.ai/',                         domain: 'meta.ai',              domains: ['meta.ai', 'www.meta.ai'],                        category: 'General',     aliases: ['llama'],                                       group: 'C' },
    { key: 'kimi',        label: 'Kimi',        url: 'https://www.kimi.com/',                        domain: 'www.kimi.com',         domains: ['www.kimi.com', 'kimi.com', 'kimi.ai', 'www.kimi.ai', 'kimi.moonshot.cn'], category: 'General', aliases: ['moonshot', 'long context'], group: 'C' },
    { key: 'blackbox',    label: 'Blackbox AI', url: 'https://app.blackbox.ai/chat',                 domain: 'app.blackbox.ai',      domains: ['app.blackbox.ai', 'www.blackbox.ai', 'blackbox.ai'], category: 'Coding', aliases: ['code', 'developer', 'agents'],                 group: 'C' },
  ];

  const defaultPanelUrls = [
    'https://gemini.google.com/app',
    'https://chat.deepseek.com/',
    'https://venice.ai/chat/agent',
    'https://chat.mistral.ai/',
  ];

  const hostSet = new Set();
  for (const provider of providers) {
    for (const host of provider.domains || [provider.domain]) hostSet.add(host);
  }

  global.AIB_PROVIDERS          = providers;
  global.AIB_AI_HOSTS           = [...hostSet];
  global.AIB_DEFAULT_PANEL_URLS = defaultPanelUrls;
})(globalThis);
