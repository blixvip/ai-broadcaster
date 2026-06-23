'use strict';
(function patchFrameGlobals() {
  // Only patch when actually inside an iframe — leave normal tabs untouched.
  let isIframe = false;
  try { isIframe = window.self !== window.top; } catch { isIframe = true; }
  if (!isIframe) return;

  function define(prop, val) {
    try {
      Object.defineProperty(window, prop, { get: () => val, configurable: true });
    } catch {}
  }

  // Make the site believe it is the top-level window.
  define('top', window);
  define('parent', window);
  define('frameElement', null);

  // Clear referrer so the site can't see it came from a chrome-extension:// page.
  try {
    Object.defineProperty(document, 'referrer', { get: () => '', configurable: true });
  } catch {}
})();
