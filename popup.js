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
let pendingAttachmentLoads = 0;
let attachmentLoadQueue = Promise.resolve();
let isListening = false;
let workspacePanelCount = 4;
let draftRevision = 0;
let pendingDelivery = null;
let uncertainDraftRevision = null;
let broadcastInFlight = false;
const broadcastButtonMarkup = broadcastBtn.innerHTML;

function unresolvedDeliveryResults(delivery) {
  if (!delivery) return [];
  return delivery.expectedPanelIds
    .map(panelId => delivery.results.get(panelId))
    .filter(result => result && (result.attempt?.outcome || result.outcome) !== 'verified');
}

function safeRetryResults(delivery) {
  return unresolvedDeliveryResults(delivery).filter(result =>
    (result.attempt?.retry || result.retry)?.safe === true);
}

function renderBroadcastButton() {
  if (broadcastInFlight) {
    broadcastBtn.disabled = true;
    broadcastBtn.textContent = 'Sending…';
    broadcastBtn.title = 'Delivery in progress';
    return;
  }
  if (uncertainDraftRevision === draftRevision) {
    broadcastBtn.disabled = true;
    broadcastBtn.textContent = 'Edit Draft To Send Again';
    broadcastBtn.title = 'Delivery state is uncertain; check panels, then edit the draft before sending again.';
    return;
  }
  const current = pendingDelivery?.draftRevision === draftRevision ? pendingDelivery : null;
  const unresolved = unresolvedDeliveryResults(current);
  const retryable = safeRetryResults(current);
  if (!unresolved.length) {
    broadcastBtn.disabled = false;
    broadcastBtn.innerHTML = broadcastButtonMarkup;
    broadcastBtn.title = 'Broadcast to every registered workspace panel';
    return;
  }

  if (!retryable.length) {
    broadcastBtn.disabled = true;
    broadcastBtn.textContent = 'Edit Draft To Send Again';
    broadcastBtn.title = 'Previous submission may already have succeeded; edit the draft before sending again.';
    return;
  }

  broadcastBtn.disabled = false;
  broadcastBtn.textContent = `Retry ${retryable.length} Safe Panel${retryable.length === 1 ? '' : 's'}`;
  broadcastBtn.title = 'Retry only panels that failed before any submit action.';
}

function markDraftChanged() {
  draftRevision += 1;
  pendingDelivery = null;
  uncertainDraftRevision = null;
  renderBroadcastButton();
}

const PANEL_COUNTS = [2, 3, 4, 5, 6];
const PROVIDERS = globalThis.AIB_PROVIDERS || [];
const WORKSPACE_DEFAULTS = globalThis.AIB_DEFAULT_PANEL_URLS || [
  'https://gemini.google.com/app?hl=en',
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
    const nextValue = Array.from(event.results)
      .map(r => r[0].transcript)
      .join('');
    if (promptEl.value !== nextValue) {
      promptEl.value = nextValue;
      markDraftChanged();
    }
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
    attachment_fanout_too_large: 'This attachment set is too large to send safely to every panel. Remove or compress one or more files.',
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
  const files = Array.from(clipboardData?.files || []);
  if (files.length) return files;

  return Array.from(clipboardData?.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter(Boolean);
}

function renderAttachedImages() {
  imagePreview.innerHTML = '';
  const hasImages = attachedImages.length > 0;
  imagePreview.classList.toggle('hidden', !hasImages);
  document.querySelector('.textarea-wrap')?.classList.toggle('has-images', hasImages);

  for (const image of attachedImages) {
    imagePreview.append(globalThis.AIBAttachmentUI.createChip(image));
  }
}

async function loadImageFiles(files) {
  const sourceFiles = Array.from(files || []);
  if (!sourceFiles.length) return;
  const candidates = attachmentFilesFromList(sourceFiles);
  if (candidates.length !== sourceFiles.length) {
    showStatus('Only images and PDF files are supported. No files from this batch were added.', 'error');
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

  showStatus(`Loading ${candidates.length} attachment${candidates.length === 1 ? '' : 's'}…`, 'info');
  const attachments = await Promise.all(candidates.map(readAttachmentFile));
  const validation = DELIVERY.validateAttachments([...attachedImages, ...attachments]);
  if (!validation.ok) {
    showStatus(attachmentErrorMessage(validation.reason), 'error');
    return;
  }
  attachedImages.push(...attachments);
  markDraftChanged();
  imageInput.value = '';
  renderAttachedImages();
  const totalBytes = attachedImages.reduce((sum, image) => sum + (image.size || 0), 0);
  showStatus(`${attachedImages.length} attachment${attachedImages.length === 1 ? '' : 's'} ready · ${globalThis.AIBAttachmentUI.formatBytes(totalBytes)}.`, 'success');
}

function enqueueAttachmentFiles(files) {
  const snapshot = Array.from(files || []);
  pendingAttachmentLoads += 1;
  dropZone.setAttribute('aria-busy', 'true');
  const task = attachmentLoadQueue.then(() => loadImageFiles(snapshot));
  attachmentLoadQueue = task.catch(() => {});
  return task.finally(() => {
    pendingAttachmentLoads = Math.max(0, pendingAttachmentLoads - 1);
    if (!pendingAttachmentLoads) {
      dropZone.removeAttribute('aria-busy');
      imageInput.value = '';
    }
  });
}

function broadcastImages() {
  return attachedImages.map(({ base64, name, type, size }) => ({ base64, name, type, size }));
}

dropZone.addEventListener('click', () => imageInput.click());
dropZone.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  imageInput.click();
});

imageInput.addEventListener('change', (e) => {
  enqueueAttachmentFiles(e.target.files).catch(() => {
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
  enqueueAttachmentFiles(e.dataTransfer.files).catch(() => {
    showStatus('Could not load one or more attachments.', 'error');
  });
});

// Also support pasting attachments directly into the popup
document.addEventListener('paste', (e) => {
  const files = attachmentFilesFromClipboard(e.clipboardData);
  if (!files.length) return;
  enqueueAttachmentFiles(files).catch(() => {
    showStatus('Could not load one or more pasted attachments.', 'error');
  });
});

imagePreview.addEventListener('click', event => {
  const remove = event.target.closest('button[data-image-id]');
  if (!remove) return;

  const imageId = Number(remove.dataset.imageId);
  attachedImages = attachedImages.filter(image => image.id !== imageId);
  markDraftChanged();
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
    const selected = Number(btn.dataset.count) === workspacePanelCount;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
    btn.setAttribute('aria-label', `${btn.dataset.count} workspace panels`);
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

promptEl.addEventListener('input', markDraftChanged);
promptEl.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;

  event.preventDefault();
  broadcastBtn.click();
});

// Broadcast
function deliveryRecordFromResponse(response, draft) {
  const panelResults = Array.isArray(response?.panelResults)
    ? response.panelResults
    : Array.isArray(response?.results) ? response.results : [];
  const expectedPanelIds = [...new Set(panelResults.map(result => result?.panelId).filter(Boolean))];
  if (!expectedPanelIds.length) return null;
  return {
    deliveryId: response.deliveryId,
    workspaceTabId: Number.isInteger(response.workspaceTabId)
      ? response.workspaceTabId
      : panelResults.find(result => Number.isInteger(result?.frame?.tabId))?.frame?.tabId ?? null,
    draftRevision: draft.revision,
    promptSnapshot: draft.promptSnapshot,
    imageIds: draft.imageIds,
    expectedPanelIds,
    results: new Map(panelResults.map(result => [result.panelId, result])),
    attemptNumbers: new Map(expectedPanelIds.map(panelId => [panelId, 1]))
  };
}

function mergeDeliveryResults(delivery, response) {
  const results = response?.panelResults || response?.results || [];
  for (const result of results) {
    if (result?.panelId && delivery.expectedPanelIds.includes(result.panelId)) {
      delivery.results.set(result.panelId, result);
    }
  }
}

function retryPanelAttempts(delivery) {
  return safeRetryResults(delivery).flatMap(result => {
    const panelId = result.panelId;
    const panelEpoch = Number(result.panelEpoch ?? result.attempt?.panelEpoch);
    if (!panelId || !Number.isInteger(panelEpoch) || panelEpoch < 1) return [];
    const attemptNumber = (delivery.attemptNumbers.get(panelId) || 1) + 1;
    delivery.attemptNumbers.set(panelId, attemptNumber);
    return [{
      panelId,
      panelEpoch,
      providerKey: result.frame?.providerKey || result.attempt?.providerKey || result.providerKey || '',
      hostname: result.hostname || result.attempt?.hostname || result.frame?.hostname || '',
      attemptId: `${delivery.deliveryId}:${panelId}:${attemptNumber}`,
      isRetry: true
    }];
  });
}

function summarizeDeliveryRecord(delivery) {
  if (!delivery) return null;
  const results = delivery.expectedPanelIds.map(panelId => delivery.results.get(panelId)).filter(Boolean);
  return DELIVERY.summarizeDelivery(
    results,
    delivery.expectedPanelIds.map(panelId => ({ panelId }))
  );
}

function clearVerifiedDraft(draft) {
  if (draftRevision !== draft.revision || promptEl.value !== draft.promptSnapshot) return false;
  promptEl.value = '';
  const deliveredIds = new Set(draft.imageIds);
  attachedImages = attachedImages.filter(image => !deliveredIds.has(image.id));
  pendingDelivery = null;
  uncertainDraftRevision = null;
  draftRevision += 1;
  renderAttachedImages();
  return true;
}

function showDeliveryResult(summary, response, delivery) {
  const outcome = summary?.outcome || response?.outcome || 'failed';
  const verified = summary?.verified ?? response?.verified ?? response?.count ?? 0;
  const expected = summary?.expected ?? response?.expected ?? response?.frames ?? 0;
  const retryable = safeRetryResults(delivery).length;
  if (outcome === 'verified' && expected > 0) {
    showStatus(`Verified by all ${verified} panel${verified === 1 ? '' : 's'}.`, 'success');
  } else if (outcome === 'partial') {
    showStatus(
      retryable
        ? `${verified}/${expected} panels verified. ${retryable} failed before submit and can be retried safely.`
        : `${verified}/${expected} panels verified. Check unresolved panels before sending again.`,
      'error'
    );
  } else if (outcome === 'unverified') {
    showStatus('Submission was dispatched but could not be verified. Check panels before sending again.', 'error');
  } else if (outcome === 'no_targets') {
    showStatus('No ready workspace panels were found. Draft retained.', 'error');
  } else {
    const attachmentFailure = String(response?.reason || '').includes('attachment');
    showStatus(attachmentFailure
      ? attachmentErrorMessage(response.reason)
      : retryable
        ? `${retryable} panel${retryable === 1 ? '' : 's'} failed before submit and can be retried safely.`
        : 'Delivery failed. Draft retained.', 'error');
  }
}

broadcastBtn.addEventListener('click', async () => {
  if (pendingAttachmentLoads) {
    showStatus('Wait for attachments to finish loading before sending.', 'error');
    return;
  }
  if (broadcastInFlight) return;

  const promptSnapshot = promptEl.value;
  const text = promptSnapshot.trim();
  const imageIds = attachedImages.map(image => image.id);
  const images = broadcastImages();
  if (!text && images.length === 0) {
    showStatus('Enter a prompt or attach a file first.', 'error');
    return;
  }

  const revision = draftRevision;
  const retrying = pendingDelivery?.draftRevision === revision ? pendingDelivery : null;
  const panelAttempts = retrying ? retryPanelAttempts(retrying) : [];
  if (retrying && !panelAttempts.length) {
    showStatus('Previous submission may already have succeeded. Check panels or edit the draft before sending again.', 'error');
    renderBroadcastButton();
    return;
  }

  const draft = { revision, promptSnapshot, imageIds };
  broadcastInFlight = true;
  renderBroadcastButton();
  showStatus(retrying ? `Retrying ${panelAttempts.length} safe panel${panelAttempts.length === 1 ? '' : 's'}…` : 'Broadcasting…', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'execute',
      workspaceTabId: retrying?.workspaceTabId ?? undefined,
      deliveryId: retrying?.deliveryId,
      panelAttempts: retrying ? panelAttempts : undefined,
      text,
      images,
      imageBase64: images[0]?.base64 || null,
      imageName: images[0]?.name || null,
      imageType: images[0]?.type || null
    });

    if (draftRevision !== revision) {
      showStatus('Previous delivery finished. Current edited draft was preserved.', 'info');
      return;
    }

    const delivery = retrying || deliveryRecordFromResponse(response, draft);
    if (retrying) mergeDeliveryResults(delivery, response);
    const summary = summarizeDeliveryRecord(delivery) || response;
    const knownPreDispatchFailure = summary?.outcome === 'no_targets'
      || String(response?.reason || '').includes('attachment');
    uncertainDraftRevision = !delivery && !knownPreDispatchFailure ? revision : null;
    if (summary?.outcome === 'verified' && (summary.expected ?? 0) > 0) {
      clearVerifiedDraft(draft);
    } else {
      pendingDelivery = delivery;
    }
    showDeliveryResult(summary, response, delivery);
  } catch (err) {
    uncertainDraftRevision = revision;
    showStatus('Delivery state is uncertain. Check panels, then edit the draft before sending again.', 'error');
  } finally {
    broadcastInFlight = false;
    renderBroadcastButton();
  }
});
