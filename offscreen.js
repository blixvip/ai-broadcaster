'use strict';

// ---------------------------------------------------------------------------
// Offscreen clipboard reader for the AI Broadcaster grab hotkey.
//
// A service worker can't read the clipboard. An offscreen document (an extension
// page) can, via document.execCommand('paste') into a contenteditable with the
// clipboardRead permission — no user gesture or window focus required. The paste
// event's clipboardData then yields the image File or plain text.
// ---------------------------------------------------------------------------

const sink = document.getElementById('sink');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.action !== 'read-clipboard') return;
  readClipboard().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
  return true;   // async response
});

function readClipboard() {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      sink.removeEventListener('paste', onPaste);
      resolve(value || {});
    };

    const onPaste = async e => {
      e.preventDefault();
      const dt = e.clipboardData;
      if (!dt) { finish({}); return; }

      // Image wins over text (matches the hover grab's priority).
      for (const item of dt.items || []) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { finish({ image: await blobToDataURL(file), type: item.type }); return; }
        }
      }
      finish({ text: dt.getData('text/plain') || '' });
    };

    sink.addEventListener('paste', onPaste);
    sink.focus();

    let ok = false;
    try { ok = document.execCommand('paste'); } catch { ok = false; }
    // If execCommand didn't dispatch a paste (empty/blocked clipboard), bail out.
    if (!ok) setTimeout(() => finish({}), 60);
    setTimeout(() => finish({}), 500);   // hard safety timeout
  });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
