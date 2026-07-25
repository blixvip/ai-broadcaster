'use strict';

// ---------------------------------------------------------------------------
// AI Broadcaster — "grab to composer" page helper.
//
// This does NOT own the hotkey. The hotkey is a real Chrome command
// (chrome.commands, see manifest + background.js) so it fires at the BROWSER
// level regardless of which frame has focus — crucial on Google Slides/Docs,
// which swallow page keystrokes in a hidden input iframe.
//
// On the command, background.js asks this top-frame script for whatever is
// under the cursor (hovered image or selected/nearby text). Clipboard reading
// is done by the background's offscreen document, not here, because that path
// works even when a Google editor iframe has focus.
// ---------------------------------------------------------------------------

(() => {
  const MAX_TEXT = 8000;
  const TOAST_MS = 1700;

  // Track the cursor in the top frame. Mouse moves always reach the top frame
  // (they go to whatever is physically under the pointer), even while a Google
  // editor iframe holds keyboard focus — so this stays accurate on Slides.
  let lastX = Math.floor(innerWidth / 2);
  let lastY = Math.floor(innerHeight / 2);
  addEventListener('mousemove', e => { lastX = e.clientX; lastY = e.clientY; },
    { passive: true, capture: true });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.action === 'grab-hover') {
      grabHover().then(sendResponse).catch(() => sendResponse({}));
      return true;   // async response
    }
    if (msg.action === 'toast') {
      toast(msg.msg, msg.isErr);
    }
  });

  // Returns { images?, selection?, block? } — background picks priority:
  // hovered image → selection → (clipboard, done in background) → block text.
  async function grabHover() {
    const out = {};
    const el = document.elementFromPoint(lastX, lastY);

    const target = imageTargetFrom(el);
    if (target) {
      const dataUrl = await targetToDataURL(target);
      if (dataUrl) out.images = [toImage(dataUrl, 'hover')];
    }

    const sel = String(window.getSelection?.() || '').trim();
    if (sel) out.selection = clip(sel);

    const block = blockTextAt(el);
    if (block) out.block = clip(block);

    return out;
  }

  // -------------------------------------------------------------------------
  // Image resolution
  // -------------------------------------------------------------------------
  function imageTargetFrom(el) {
    if (!el) return null;
    if (el.tagName === 'IMG') return el;
    const img = el.closest?.('img');
    if (img) return img;
    if (el.tagName === 'CANVAS') return el;
    try {
      const bg = getComputedStyle(el).backgroundImage;
      const url = bg && bg !== 'none' && /url\(/.test(bg)
        ? bg.match(/url\(["']?(.*?)["']?\)/)?.[1]
        : null;
      if (url) return { __bg: true, url };
    } catch {}
    return null;
  }

  async function targetToDataURL(target) {
    try {
      if (target.__bg) return await urlToDataURL(target.url);
      if (target.tagName === 'CANVAS') {
        try { return target.toDataURL('image/png'); } catch { return null; }
      }
      if (target.tagName === 'IMG') {
        try {
          const w = target.naturalWidth || target.width;
          const h = target.naturalHeight || target.height;
          if (w && h) {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(target, 0, 0);
            return c.toDataURL('image/png');   // throws if the image tainted the canvas
          }
        } catch {}
        const src = target.currentSrc || target.src;
        if (src) return await urlToDataURL(src);
      }
    } catch {}
    return null;
  }

  async function urlToDataURL(url) {
    try {
      if (!url) return null;
      if (url.startsWith('data:')) return url;
      const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) return null;
      return await blobToDataURL(blob);
    } catch { return null; }
  }

  // -------------------------------------------------------------------------
  // Text under the cursor
  // -------------------------------------------------------------------------
  function blockTextAt(el) {
    if (!el) return '';
    const block = el.closest?.('p,li,td,th,blockquote,pre,h1,h2,h3,h4,h5,h6,figcaption,dd,dt');
    if (!block) return '';   // only grab a real text block, never a whole container
    return (block.innerText || block.textContent || '').trim();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function clip(t) {
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
  }

  function toImage(dataUrl, base) {
    const type = (/^data:([^;,]+)/.exec(dataUrl)?.[1]) || 'image/png';
    const ext = (type.split('/')[1] || 'png').split('+')[0];
    return { base64: dataUrl, name: `${base}.${ext}`, type };
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // -------------------------------------------------------------------------
  // Confirmation toast on the source page (workspace is usually elsewhere)
  // -------------------------------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg, isErr = false) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        Object.assign(toastEl.style, {
          position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
          font: '600 13px/1.3 system-ui, -apple-system, Segoe UI, sans-serif',
          padding: '9px 13px', borderRadius: '9px', color: '#fff',
          boxShadow: '0 6px 20px rgba(0,0,0,.28)', pointerEvents: 'none',
          maxWidth: '320px', whiteSpace: 'pre-wrap', letterSpacing: '.01em',
          transition: 'opacity .15s ease', opacity: '0'
        });
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.style.background = isErr ? '#b42318' : '#1a7f37';
      toastEl.textContent = msg;
      requestAnimationFrame(() => { if (toastEl) toastEl.style.opacity = '1'; });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (!toastEl) return;
        toastEl.style.opacity = '0';
        setTimeout(() => { toastEl?.remove(); toastEl = null; }, 200);
      }, TOAST_MS);
    } catch {}
  }
})();
