'use strict';

const DELIVERY = globalThis.AIBDeliveryProtocol;
const ATTACHMENT_LIMITS = DELIVERY.ATTACHMENT_LIMITS;
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
let workspacePanelCount = 4;

const PANEL_COUNTS = [2, 3, 4, 5, 6];
const PROVIDERS = globalThis.AIB_PROVIDERS || [];
const WORKSPACE_DEFAULTS = globalThis.AIB_DEFAULT_PANEL_URLS || [
  'https://gemini.google.com/app',
  'https://chat.deepseek.com/',
  'https://venice.ai/chat/agent',
  'https://chat.mistral.ai/'
];

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

// Attachments
function attachmentErrorMessage(reason) {
  return {
    too_many_attachments: `Attach no more than ${ATTACHMENT_LIMITS.maxCount} files.`,
    attachment_too_large: 'Each attachment must be 20 MB or smaller.',
    attachment_batch_too_large: 'The combined attachment payload must be 48 MB or smaller.',
    unsupported_attachment_type: 'Only images and PDF files are supported.',
    invalid_attachment_data: 'One attachment could not be read safely.'
  }[reason] || 'Could not attach that file.';
}

function readAttachmentFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      resolve({
        id: nextImageId++,
        base64: event.target.result,
        name: file.name || (file.type === 'application/pdf' ? 'document.pdf' : 'image.png'),
        type: file.type || 'application/octet-stream',
        size: file.size || 0
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function attachmentFilesFromList(files) {
  return Array.from(files || []).filter(file =>
    file?.type === 'application/pdf' || file?.type?.startsWith('image/'));
}

function attachmentFilesFromClipboard(clipboardData) {
  const files = attachmentFilesFromList(clipboardData?.files);
  if (files.length) return files;

  return Array.from(clipboardData?.items || [])
    .filter(item => item.type === 'application/pdf' || item.type?.startsWith('image/'))
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
    tile.className = `image-tile${image.type === 'application/pdf' ? ' is-pdf' : ''}`;

    if (image.type === 'application/pdf') {
      const badge = document.createElement('span');
      badge.className = 'file-badge';
      badge.textContent = 'PDF';
      badge.title = image.name;
      tile.append(badge);
    } else {
      const img = document.createElement('img');
      img.src = image.base64;
      img.alt = image.name;
      tile.append(img);
    }

    const remove = document.createElement('button');
    remove.className = 'remove-btn';
    remove.type = 'button';
    remove.title = `Remove ${image.name}`;
    remove.setAttribute('aria-label', `Remove ${image.name}`);
    remove.dataset.imageId = String(image.id);
    remove.textContent = '×';

    tile.append(remove);
    imagePreview.append(tile);
  }
}

async function loadImageFiles(files) {
  const candidates = attachmentFilesFromList(files);
  if (!candidates.length) {
    if (Array.from(files || []).length) showStatus('Only images and PDF files are supported.', 'error');
    return;
  }
  if (attachedImages.length + candidates.length > ATTACHMENT_LIMITS.maxCount) {
    showStatus(attachmentErrorMessage('too_many_attachments'), 'error');
    return;
  }
  if (candidates.some(file => file.size > ATTACHMENT_LIMITS.maxFileBytes)) {
    showStatus(attachmentErrorMessage('attachment_too_large'), 'error');
    return;
  }
  const currentBytes = attachedImages.reduce((total, file) =>
    total + (file.size || DELIVERY.estimatedDataUrlBytes(file.base64)), 0);
  const incomingBytes = candidates.reduce((total, file) => total + (file.size || 0), 0);
  if (currentBytes + incomingBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
    showStatus(attachmentErrorMessage('attachment_batch_too_large'), 'error');
    return;
  }

  const attachments = await Promise.all(candidates.map(readAttachmentFile));
  const validation = DELIVERY.validateAttachments([...attachedImages, ...attachments]);
  if (!validation.ok) {
    showStatus(attachmentErrorMessage(validation.reason), 'error');
    return;
  }
  attachedImages.push(...attachments);
  imageInput.value = '';
  renderAttachedImages();
}

function broadcastImages() {
  return attachedImages.map(({ base64, name, type, size }) => ({ base64, name, type, size }));
}

dropZone.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', (e) => {
  loadImageFiles(e.target.files).catch(() => {
    showStatus('Could not load one or more attachments.', 'error');
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
    showStatus('Could not load one or more attachments.', 'error');
  });
});

// Also support pasting attachments directly into the popup
document.addEventListener('paste', (e) => {
  loadImageFiles(attachmentFilesFromClipboard(e.clipboardData)).catch(() => {
    showStatus('Could not load one or more pasted attachments.', 'error');
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
  return PANEL_COUNTS.includes(n) ? n : 4;
}

function renderWorkspacePanelCount() {
  for (const btn of workspacePanelCountEl.querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.count) === workspacePanelCount);
  }
  workspaceBtn.lastChild.textContent = ` Open New ${workspacePanelCount}-Panel Workspace`;
}

function buildWorkspacePanels(count) {
  const candidates = [
    ...WORKSPACE_DEFAULTS.map(url => ({ url, title: new URL(url).hostname })),
    ...PROVIDERS.map(provider => ({ url: provider.url, title: provider.label }))
  ];
  const seenHosts = new Set();
  const panels = [];

  for (const candidate of candidates) {
    let host;
    try { host = new URL(candidate.url).hostname; } catch { continue; }
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    panels.push(candidate);
    if (panels.length === count) break;
  }

  return panels;
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
    const panels = buildWorkspacePanels(workspacePanelCount);
    await chrome.storage.local.set({
      aib_workspace_seed: { timestamp: Date.now(), panels, count: workspacePanelCount },
      aib_workspace_panel_count: workspacePanelCount
    });
    const result = await chrome.runtime.sendMessage({
      action: 'openWorkspace',
      count: workspacePanelCount
    });
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
  const promptSnapshot = promptEl.value;
  const text = promptSnapshot.trim();
  const imageIds = attachedImages.map(image => image.id);
  const images = broadcastImages();

  if (!text && images.length === 0) {
    showStatus('Enter a prompt or attach a file first.', 'error');
    return;
  }

  broadcastBtn.disabled = true;
  broadcastBtn.textContent = 'Sending...';
  showStatus('Broadcasting...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'execute',
      text,
      images,
      imageBase64: images[0]?.base64 || null,
      imageName:   images[0]?.name   || null,
      imageType:   images[0]?.type   || null
    });
    const outcome = response?.outcome || 'failed';
    const verified = response?.verified ?? response?.count ?? 0;
    const expected = response?.expected ?? response?.frames ?? 0;

    if (outcome === 'verified' && expected > 0) {
      if (promptEl.value === promptSnapshot) promptEl.value = '';
      const deliveredIds = new Set(imageIds);
      attachedImages = attachedImages.filter(image => !deliveredIds.has(image.id));
      renderAttachedImages();
      showStatus(`Verified by all ${verified} panel${verified === 1 ? '' : 's'}.`, 'success');
    } else if (outcome === 'partial') {
      showStatus(`${verified}/${expected} panels verified. Draft retained for inspection.`, 'error');
    } else if (outcome === 'unverified') {
      showStatus('Submission was dispatched but could not be verified. Draft retained.', 'error');
    } else if (outcome === 'no_targets') {
      showStatus('No ready workspace panels were found. Draft retained.', 'error');
    } else {
      showStatus('Delivery failed. Draft retained.', 'error');
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
