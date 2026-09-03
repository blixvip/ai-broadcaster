'use strict';

(function initAttachmentUI(global) {
  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function createChip(attachment) {
    const name = String(attachment?.name || 'Attachment');
    const type = String(attachment?.type || 'application/octet-stream');
    const isPdf = type === 'application/pdf';
    const chip = document.createElement('div');
    chip.className = `attachment-chip image-tile${isPdf ? ' is-pdf' : ''}`;
    chip.title = `${name} · ${formatBytes(attachment?.size)}`;

    const thumb = document.createElement('span');
    thumb.className = 'attachment-thumb';
    if (isPdf) {
      thumb.textContent = 'PDF';
    } else {
      thumb.classList.add('is-loading');
      const image = document.createElement('img');
      image.src = attachment?.base64 || '';
      image.alt = '';
      image.addEventListener('load', () => thumb.classList.remove('is-loading'), { once: true });
      image.addEventListener('error', () => {
        thumb.classList.remove('is-loading');
        thumb.classList.add('is-error');
        image.remove();
        thumb.textContent = 'IMG';
        chip.dataset.preview = 'error';
      }, { once: true });
      thumb.append(image);
    }

    const copy = document.createElement('span');
    copy.className = 'attachment-copy';
    const filename = document.createElement('strong');
    filename.textContent = name;
    const meta = document.createElement('small');
    meta.textContent = `${isPdf ? 'PDF' : 'IMAGE'} · ${formatBytes(attachment?.size)}`;
    copy.append(filename, meta);

    const remove = document.createElement('button');
    remove.className = 'attachment-remove';
    remove.type = 'button';
    remove.dataset.imageId = String(attachment?.id ?? '');
    remove.title = `Remove ${name}`;
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.textContent = '×';

    chip.append(thumb, copy, remove);
    return chip;
  }

  global.AIBAttachmentUI = Object.freeze({ createChip, formatBytes });
})(globalThis);
