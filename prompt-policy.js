'use strict';

(function exposePromptPolicy(root) {
  const DEEPSEEK_HOST = 'chat.deepseek.com';
  const DEEPSEEK_ENGLISH_DIRECTIVE =
    'Response language requirement: Reply in English. Do not use Chinese unless this request explicitly asks for Chinese output.';

  function applyProviderPromptPolicy(hostname, prompt) {
    const rawText = String(prompt || '');
    if (String(hostname || '').toLowerCase() !== DEEPSEEK_HOST) return rawText;
    const text = rawText.trim();
    if (text.includes(DEEPSEEK_ENGLISH_DIRECTIVE)) return text;
    return text
      ? `${text}\n\n${DEEPSEEK_ENGLISH_DIRECTIVE}`
      : DEEPSEEK_ENGLISH_DIRECTIVE;
  }

  const policy = Object.freeze({
    DEEPSEEK_ENGLISH_DIRECTIVE,
    applyProviderPromptPolicy
  });
  root.AIBPromptPolicy = policy;
  if (typeof module === 'object' && module.exports) module.exports = policy;
})(globalThis);
