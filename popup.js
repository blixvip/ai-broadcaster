'use strict';

const promptEl = document.getElementById('prompt');
const voiceBtn = document.getElementById('voiceBtn');
const voiceStatus = document.getElementById('voiceStatus');
const dropZone = document.getElementById('dropZone');
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const broadcastBtn = document.getElementById('broadcastBtn');
const workspaceBtn = document.getElementById('workspaceBtn');
const workspacePanelCountEl = document.getElementById('workspacePanelCount');
const statusEl = document.getElementById('status');

let attachedImages = []; // { id, base64, name, type }
let nextImageId = 1;
let isListening = false;
let workspacePanelCount = 3;

const PANEL_COUNTS = [2, 3, 4, 5, 6];
const PROVIDERS = globalThis.AIB_PROVIDERS || [];
const AI_HOSTS = new Set(globalThis.AIB_AI_HOSTS || []);
const WORKSPACE_DEFAULTS = globalThis.AIB_DEFAULT_PANEL_URLS || [
  'https://gemini.google.com/app',
  'https://chat.deepseek.com/',
  'https://venice.ai/chat/agent',
  'https://chat.mistral.ai/'
];
const WORKSPACE_HOST_PRIORITY = PROVIDERS.flatMap(provider => provider.domains || [provider.domain]);

// Voice input
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  voiceBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  });

  recognition.onstart = () => {
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceStatus.classList.remove('hidden');
  };

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map(r => r[0].transcript)
      .join('');
    promptEl.value = transcript;
  };

  recognition.onend = () => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceStatus.classList.add('hidden');
  };

  recognition.onerror = (event) => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceStatus.classList.add('hidden');
    if (event.error !== 'aborted') {
      showStatus('Microphone error: ' + event.error, 'error');
    }
  };
} else {
  voiceBtn.title = 'Voice input not supported in this browser';
  voiceBtn.style.opacity = '0.4';
  voiceBtn.style.cursor = 'not-allowed';
}

// Image attachment
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      resolve({
        id: nextImageId++,
        base64: event.target.result,
        name: file.name || 'image.png',
        type: file.type || 'image/png'
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageFilesFromList(files) {
  return Array.from(files || []).filter(file => file?.type?.startsWith('image/'));
}

function imageFilesFromClipboard(clipboardData) {
  const files = imageFilesFromList(clipboardData?.files);
  if (files.length) return files;

  return Array.from(clipboardData?.items || [])
    .filter(item => item.type?.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(Boolean);
}

function renderAttachedImages() {
  imagePreview.innerHTML = '';
  const hasImages = attachedImages.length > 0;
  imagePreview.classList.toggle('hidden', !hasImages);
  document.querySelector('.textarea-wrap')?.classList.toggle('has-images', hasImages);

  for (const image of attachedImages) {
    const tile = document.createElement('div');
    tile.className = 'image-tile';

    const img = document.createElement('img');
    img.src = image.base64;
    img.alt = image.name;

    const remove = document.createElement('button');
    remove.className = 'remove-btn';
    remove.type = 'button';
    remove.title = `Remove ${image.name}`;
    remove.setAttribute('aria-label', `Remove ${image.name}`);
    remove.dataset.imageId = String(image.id);
    remove.textContent = '×';

    tile.append(img, remove);
    imagePreview.append(tile);
  }
}

async function loadImageFiles(files) {
  const imageFiles = imageFilesFromList(files);
  if (imageFiles.length === 0) return;

  const images = await Promise.all(imageFiles.map(readImageFile));
  attachedImages.push(...images);
  imageInput.value = '';
  renderAttachedImages();
}

function broadcastImages() {
  return attachedImages.map(({ base64, name, type }) => ({ base64, name, type }));
}

dropZone.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', (e) => {
  loadImageFiles(e.target.files).catch(() => {
    showStatus('Could not load one or more images.', 'error');
  });
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  loadImageFiles(e.dataTransfer.files).catch(() => {
    showStatus('Could not load one or more images.', 'error');
  });
});

// Also support pasting images directly into the popup
document.addEventListener('paste', (e) => {
  loadImageFiles(imageFilesFromClipboard(e.clipboardData)).catch(() => {
    showStatus('Could not load one or more pasted images.', 'error');
  });
});

imagePreview.addEventListener('click', event => {
  const remove = event.target.closest('button[data-image-id]');
  if (!remove) return;

  const imageId = Number(remove.dataset.imageId);
  attachedImages = attachedImages.filter(image => image.id !== imageId);
  renderAttachedImages();
});

// Status display
function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
}

function clampPanelCount(value) {
  const n = Number(value);
  return PANEL_COUNTS.includes(n) ? n : 3;
}

function renderWorkspacePanelCount() {
  for (const btn of workspacePanelCountEl.querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.count) === workspacePanelCount);
  }
  workspaceBtn.lastChild.textContent = ` Open ${workspacePanelCount}-Panel Workspace`;
}

function aiTabHost(tab) {
  try {
    const url = new URL(tab.url);
    return url.protocol === 'https:' && AI_HOSTS.has(url.hostname) ? url.hostname : '';
  } catch {
    return '';
  }
}

function pickWorkspacePanels(tabs, count) {
  const byHost = new Map();

  for (const tab of tabs) {
    const host = aiTabHost(tab);
    if (!host || byHost.has(host)) continue;
    byHost.set(host, tab);
  }

  const picked = [];
  for (const host of WORKSPACE_HOST_PRIORITY) {
    const tab = byHost.get(host);
    if (tab) picked.push({ url: tab.url, title: tab.title || host });
    if (picked.length === count) break;
  }

  for (const url of WORKSPACE_DEFAULTS) {
    if (picked.length === count) break;
    const host = new URL(url).hostname;
    if (!picked.some(panel => {
      try { return new URL(panel.url).hostname === host; } catch { return false; }
    })) {
      picked.push({ url, title: host });
    }
  }

  for (const provider of PROVIDERS) {
    if (picked.length === count) break;
    const host = new URL(provider.url).hostname;
    if (!picked.some(panel => {
      try { return new URL(panel.url).hostname === host; } catch { return false; }
    })) {
      picked.push({ url: provider.url, title: provider.label || host });
    }
  }

  return picked;
}

workspacePanelCountEl.addEventListener('click', async event => {
  const btn = event.target.closest('button[data-count]');
  if (!btn) return;

  workspacePanelCount = clampPanelCount(btn.dataset.count);
  renderWorkspacePanelCount();
  await chrome.storage.local.set({ aib_workspace_panel_count: workspacePanelCount });
});

chrome.storage.local.get('aib_workspace_panel_count', ({ aib_workspace_panel_count }) => {
  workspacePanelCount = clampPanelCount(aib_workspace_panel_count);
  renderWorkspacePanelCount();
});

workspaceBtn.addEventListener('click', async () => {
  workspaceBtn.disabled = true;
  showStatus('Opening workspace...', 'info');

  try {
    const panels = pickWorkspacePanels([], workspacePanelCount);
    await chrome.storage.local.set({
      aib_workspace_seed: { timestamp: Date.now(), panels, count: workspacePanelCount },
      aib_workspace_panel_count: workspacePanelCount
    });
    const result = await chrome.runtime.sendMessage({ action: 'openWorkspace' });
    if (!result?.ok) throw new Error(result?.reason || 'Could not open workspace');
    showStatus('Workspace opened.', 'success');
  } catch (err) {
    showStatus('Workspace error: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    workspaceBtn.disabled = false;
  }
});

promptEl.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;

  event.preventDefault();
  broadcastBtn.click();
});

// Broadcast
broadcastBtn.addEventListener('click', async () => {
  const text = promptEl.value.trim();
  const images = broadcastImages();

  if (!text && images.length === 0) {
    showStatus('Enter a prompt or attach an image first.', 'error');
    return;
  }

  broadcastBtn.disabled = true;
  broadcastBtn.textContent = 'Sending...';
  showStatus('Broadcasting...', 'info');

  // Clear immediately so the box feels instant
  promptEl.value = '';
  attachedImages = [];
  renderAttachedImages();

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'execute',
      text,
      images,
      imageBase64: images[0]?.base64 || null,
      imageName:   images[0]?.name   || null,
      imageType:   images[0]?.type   || null
    });
    const n      = response?.count  ?? 0;
    const sent   = response?.sent   ?? false;
    const frames = response?.frames ?? 0;

    if (n > 0) {
      showStatus(`Sent to ${n} AI panel${n === 1 ? '' : 's'}!`, 'success');
    } else if (sent && frames > 0) {
      showStatus(`Reached ${frames} panel${frames === 1 ? '' : 's'} — check for responses.`, 'info');
    } else if (sent) {
      showStatus('Broadcast sent — reload your PageVS tab once if no response.', 'info');
    } else {
      showStatus('Error sending broadcast.', 'error');
    }
  } catch (err) {
    showStatus('Error: ' + (err.message || 'Unknown error'), 'error');
  } finally {
    broadcastBtn.disabled = false;
    broadcastBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>
      Broadcast to All AIs`;
  }
});
