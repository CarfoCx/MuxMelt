// ============================================================================
// Upscaler Tool
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);

let files = [];
let scale = 2;
let outputDir = '';
let modelProfile = 'general';
let ws = null;
let isProcessing = false;
let pythonPort = null;
let log = null;

// ETA tracking
let batchStartTime = 0;
let batchTotalFiles = 0;

// Reconnection
let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
const MAX_RECONNECT_DELAY = 30000;

// DOM refs (set during init)
let dropZone, browseBtn, browseFolderBtn, fileList, upscaleBtn, clearBtn;
let openOutputBtn, outputDirBtn, statusText, etaText, processingIndicator, retryBtn;
let outputFormat, modelProfileSelect, ffmpegWarning;
let previewModal, previewOverlay, previewClose, previewContainer;
let previewBefore, previewAfter, previewBeforeClip, previewSlider, previewTitle;

let _pasteHandler = null;
let previewDragging = false;
let _mouseMoveHandler = null;
let _mouseUpHandler = null;
let _keyDownHandler = null;
let _resizeHandler = null;

function init(ctx) {
  pythonPort = ctx.pythonPort;
  log = ctx.log;

  // Bind DOM elements
  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  browseFolderBtn = document.getElementById('browseFolderBtn');
  fileList = document.getElementById('fileList');
  upscaleBtn = document.getElementById('upscaleBtn');
  clearBtn = document.getElementById('clearBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  etaText = document.getElementById('etaText');
  processingIndicator = document.getElementById('processingIndicator');
  outputFormat = document.getElementById('outputFormat');
  modelProfileSelect = document.getElementById('modelProfile');
  ffmpegWarning = document.getElementById('ffmpegWarning');

  previewModal = document.getElementById('previewModal');
  previewOverlay = document.getElementById('previewOverlay');
  previewClose = document.getElementById('previewClose');
  previewContainer = document.getElementById('previewContainer');
  previewBefore = document.getElementById('previewBefore');
  previewAfter = document.getElementById('previewAfter');
  previewBeforeClip = document.getElementById('previewBeforeClip');
  previewSlider = document.getElementById('previewSlider');
  previewTitle = document.getElementById('previewTitle');

  retryBtn = document.getElementById('retryBtn');

  loadSettings();
  bindEvents();
  connectWebSocket(pythonPort);

  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);

  log('Upscaler initialized');
}

function cleanup() {
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (_mouseMoveHandler) document.removeEventListener('mousemove', _mouseMoveHandler);
  if (_mouseUpHandler) document.removeEventListener('mouseup', _mouseUpHandler);
  if (_keyDownHandler) document.removeEventListener('keydown', _keyDownHandler);
  if (_resizeHandler) window.removeEventListener('resize', _resizeHandler);
}

// ---- Settings ----
async function loadSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all.upscaler || {};
    if (s.scale) {
      scale = s.scale;
      document.querySelectorAll('.scale-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.scale) === scale);
      });
    }
    if (s.outputFormat) outputFormat.value = s.outputFormat;
    if (s.modelProfile) { modelProfile = s.modelProfile; modelProfileSelect.value = modelProfile; }
    if (s.outputDir) {
      outputDir = s.outputDir;
      const parts = outputDir.replace(/\\/g, '/').split('/');
      const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : outputDir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = outputDir;
    }
    if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  } catch {}
}

let _saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(_saveSettingsTimer);
  _saveSettingsTimer = setTimeout(() => {
    window.loadAllSettings().then(all => {
      all.upscaler = { scale, outputFormat: outputFormat.value, modelProfile, outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

// ---- ffmpeg check ----
function checkFfmpeg() {
  fetch(`http://127.0.0.1:${pythonPort}/health`)
    .then(r => r.json())
    .then(data => {
      if (!data.ffmpeg) {
        ffmpegWarning.style.display = 'flex';
        log('ffmpeg not found - video upscaling disabled', 'warn');
      } else {
        ffmpegWarning.style.display = 'none';
      }
    })
    .catch(() => {});
}

// ---- Event binding ----
function bindEvents() {
  // Scale buttons
  document.querySelectorAll('.scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isProcessing) return;
      document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      scale = parseInt(btn.dataset.scale);
      if (modelProfile === 'anime' && scale === 2) {
        log('Note: Anime 2x uses the same model as General 2x', 'info');
      }
      saveSettings();
    });
  });

  modelProfileSelect.addEventListener('change', () => {
    if (isProcessing) return;
    modelProfile = modelProfileSelect.value;
    if (modelProfile === 'anime' && scale === 2) {
      log('Note: Anime 2x uses the same model as General 2x (no anime-specific 2x model exists)', 'info');
    }
    saveSettings();
  });

  outputFormat.addEventListener('change', () => saveSettings());

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.selectOutputDir();
    if (dir) {
      outputDir = dir;
      const parts = dir.replace(/\\/g, '/').split('/');
      const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : dir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = dir;
      saveSettings();
    }
  });

  // Drop zone
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover');
    const paths = [];
    for (const file of e.dataTransfer.files) paths.push(file.path);
    if (paths.length > 0) {
      const resolved = await window.api.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else log('No supported files found in dropped items', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.selectFiles();
    if (paths.length > 0) addFiles(paths);
  });

  browseFolderBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (statusText) statusText.textContent = 'Scanning folder...';
    const paths = await window.api.selectFolder();
    if (paths.length > 0) addFiles(paths);
    else log('No supported files found in folder', 'warn');
    if (statusText) statusText.textContent = 'Waiting for File';
  });

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.selectFiles();
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); }
  });

  openOutputBtn.addEventListener('click', () => {
    if (outputDir) { window.api.openFolder(outputDir); }
    else if (files.length > 0 && files[0].output) {
      const dir = files[0].output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      window.api.openFolder(dir);
    } else if (files.length > 0) {
      const dir = files[0].path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      window.api.openFolder(dir);
    }
  });

  upscaleBtn.addEventListener('click', () => {
    if (isProcessing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'cancel' }));
        upscaleBtn.disabled = true;
        upscaleBtn.textContent = 'Cancelling...';
        log('Cancelling...', 'warn');
        setTimeout(() => {
          if (isProcessing) {
            upscaleBtn.disabled = false;
            upscaleBtn.textContent = 'Cancel';
            log('Cancel may not have completed — you can try again', 'warn');
          }
        }, 10000);
      }
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const filesToProcess = files
      .filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled')
      .map(f => { f.state = 'pending'; f.progress = 0; f.status = 'Queued...'; return f.path; });
    if (filesToProcess.length === 0) return;

    isProcessing = true;
    batchStartTime = Date.now();
    batchTotalFiles = filesToProcess.length;
    upscaleBtn.disabled = false;
    upscaleBtn.textContent = 'Cancel';
    upscaleBtn.classList.add('btn-cancel');
    processingIndicator.classList.add('active');
    statusText.textContent = `Processing ${filesToProcess.length} file(s)...`;
    etaText.textContent = 'ETA: calculating...';
    renderFileList();

    log(`Starting upscale: ${filesToProcess.length} file(s), ${scale}x, profile=${modelProfile}, format=${outputFormat.value}`);
    ws.send(JSON.stringify({
      action: 'upscale', files: filesToProcess, scale, output_format: outputFormat.value,
      output_dir: outputDir, profile: modelProfile
    }));
  });

  // ffmpeg link
  document.getElementById('ffmpegLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://ffmpeg.org/download.html');
  });

  // Retry failed
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      files.forEach(f => { if (f.state === 'error' || f.state === 'cancelled') { f.state = 'pending'; f.progress = 0; f.status = 'Queued...'; } });
      renderFileList();
      updateUpscaleButton();
      upscaleBtn.click();
    });
  }

  // Preview events
  previewClose.addEventListener('click', closePreview);
  previewOverlay.addEventListener('click', closePreview);
  previewSlider.addEventListener('mousedown', (e) => { e.preventDefault(); previewDragging = true; });

  _mouseMoveHandler = (e) => {
    if (!previewDragging) return;
    const rect = previewContainer.getBoundingClientRect();
    let x = (e.clientX - rect.left) / rect.width;
    x = Math.max(0.02, Math.min(0.98, x));
    previewBeforeClip.style.width = `${x * 100}%`;
    previewSlider.style.left = `${x * 100}%`;
  };
  document.addEventListener('mousemove', _mouseMoveHandler);

  _mouseUpHandler = () => { previewDragging = false; };
  document.addEventListener('mouseup', _mouseUpHandler);

  _keyDownHandler = (e) => {
    if (e.key === 'Escape' && previewModal.classList.contains('active')) closePreview();
  };
  document.addEventListener('keydown', _keyDownHandler);

  _resizeHandler = () => {
    if (previewModal.classList.contains('active')) {
      previewBefore.style.width = previewContainer.offsetWidth + 'px';
      previewBefore.style.height = previewContainer.offsetHeight + 'px';
    }
  };
  window.addEventListener('resize', _resizeHandler);
}

// ---- WebSocket ----
function connectWebSocket(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    // Removed technical logs
    // Request initial data if needed
  };
  ws.onmessage = (event) => handleWSMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (!statusText) return; // tool was unloaded
    statusText.textContent = 'Disconnected - reconnecting...';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`WebSocket disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s...`, 'warn');
    if (reconnectAttempts === 5) {
      log('Multiple reconnection failures, restarting Python backend...', 'warn');
      window.api.restartPython().then(r => {
        log(r.success ? 'Python backend restarted' : `Failed to restart: ${r.error}`, r.success ? 'success' : 'error');
      });
    }
    reconnectTimerId = setTimeout(() => connectWebSocket(port), delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function handleWSMessage(data) {
  if (data.type === 'log') { log(data.message, data.level || 'info'); return; }
  if (data.type === 'model_loading') { log(data.message || 'Loading model...'); statusText.textContent = data.message || 'Loading model...'; return; }
  if (data.type === 'model_loaded') { log('Model loaded', 'success'); return; }

  const fileIndex = files.findIndex(f => f.path === data.file);
  if (fileIndex === -1 && data.type !== 'all_complete' && data.type !== 'fatal_error') return;
  const fname = fileIndex >= 0 ? files[fileIndex].name : '';

  switch (data.type) {
    case 'progress':
      files[fileIndex].progress = data.progress;
      files[fileIndex].status = data.status || 'Processing...';
      if (files[fileIndex].state !== 'processing') log(`Processing: ${fname}`);
      files[fileIndex].state = 'processing';
      renderFileItem(fileIndex);
      updateETA();
      if (window.setTaskbarProgress) window.setTaskbarProgress(data.progress);
      break;
    case 'complete':
      files[fileIndex].progress = 1;
      files[fileIndex].status = 'Complete';
      files[fileIndex].state = 'complete';
      files[fileIndex].output = data.output;
      renderFileItem(fileIndex);
      log(`Complete: ${fname} \u2192 ${data.output.replace(/\\/g, '/').split('/').pop()}`, 'success');
      updateETA();
      break;
    case 'error':
      files[fileIndex].progress = 0;
      files[fileIndex].status = `Error: ${data.error}`;
      files[fileIndex].state = data.error === 'Cancelled' ? 'cancelled' : 'error';
      renderFileItem(fileIndex);
      log(data.error === 'Cancelled' ? `Cancelled: ${fname}` : `Error [${fname}]: ${data.error}`, data.error === 'Cancelled' ? 'warn' : 'error');
      updateETA();
      break;
    case 'all_complete':
      isProcessing = false;
      processingIndicator.classList.remove('active');
      upscaleBtn.disabled = false;
      upscaleBtn.textContent = 'Upscale';
      upscaleBtn.classList.remove('btn-cancel');
      etaText.textContent = '';
      const completed = files.filter(f => f.state === 'complete').length;
      const errors = files.filter(f => f.state === 'error').length;
      const cancelled = files.filter(f => f.state === 'cancelled').length;
      let parts = [`${completed} completed`];
      if (errors > 0) parts.push(`${errors} failed`);
      if (cancelled > 0) parts.push(`${cancelled} cancelled`);
      statusText.textContent = `Done! ${parts.join(', ')}`;
      log(`Batch finished: ${parts.join(', ')}`, errors > 0 ? 'warn' : 'success');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      if (window.showCompletionToast) {
        window.showCompletionToast(`Upscale complete: ${parts.join(', ')}`, errors > 0);
      }
      if (retryBtn) retryBtn.style.display = errors > 0 || cancelled > 0 ? '' : 'none';
      if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(outputDir || (files[0] && files[0].output ? files[0].output.replace(/\\/g, '/').split('/').slice(0, -1).join('/') : ''));
      break;
    case 'fatal_error':
      isProcessing = false;
      processingIndicator.classList.remove('active');
      upscaleBtn.disabled = false;
      upscaleBtn.textContent = 'Upscale';
      upscaleBtn.classList.remove('btn-cancel');
      etaText.textContent = '';
      statusText.textContent = `Fatal error: ${data.error}`;
      log(`Fatal: ${data.error}`, 'error');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      break;
  }
}

// ---- ETA ----
function updateETA() {
  if (!isProcessing || batchTotalFiles === 0) { etaText.textContent = ''; return; }
  const elapsed = (Date.now() - batchStartTime) / 1000;
  if (elapsed < 2) { etaText.textContent = 'ETA: calculating...'; return; }
  const completedFiles = files.filter(f => f.state === 'complete' || f.state === 'error' || f.state === 'cancelled').length;
  const current = files.find(f => f.state === 'processing');
  const effectiveCompleted = completedFiles + (current ? current.progress : 0);
  if (effectiveCompleted < 0.05) { etaText.textContent = 'ETA: calculating...'; return; }
  const remaining = batchTotalFiles - effectiveCompleted;
  const eta = Math.max(0, Math.round((elapsed / effectiveCompleted) * remaining));
  etaText.textContent = `ETA: ${formatDuration(eta)}`;
}

function formatDuration(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---- File management ----
function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }
function isImage(fp) { return IMAGE_EXTS.has(getFileExtension(fp)); }

async function addFiles(paths) {
  let added = 0;
  for (const p of paths) {
    const ext = getFileExtension(p);
    let type = null;
    if (IMAGE_EXTS.has(ext)) type = 'image';
    else if (VIDEO_EXTS.has(ext)) type = 'video';
    else continue;
    if (files.some(f => f.path === p)) { log(`Skipped duplicate: ${getFileName(p)}`, 'warn'); continue; }
    const size = await window.api.getFileSize(p);
    files.push({ path: p, name: getFileName(p), type, size, progress: 0, status: 'Waiting for File', state: 'pending', output: null });
    added++;
  }
  if (added > 0) log(`Added ${added} file(s)`);
  renderFileList();
  updateUpscaleButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function removeFile(index) { files.splice(index, 1); renderFileList(); updateUpscaleButton(); }

function clearFiles() {
  files = [];
  renderFileList();
  updateUpscaleButton();
  statusText.textContent = 'Waiting for File';
  etaText.textContent = '';
  if (retryBtn) retryBtn.style.display = 'none';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([]);
}

// ---- Rendering ----
function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">No files added. Drag files here, browse, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach((f, i) => fileList.appendChild(createFileElement(f, i)));
  if (window.updateQueueSummary) window.updateQueueSummary(files);
}

function renderFileItem(index) {
  if (window.updateQueueSummary) window.updateQueueSummary(files);
  const existing = fileList.children[index];
  if (!existing) return;
  fileList.replaceChild(createFileElement(files[index], index), existing);
}

function createFileElement(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item';
  if (file.state === 'complete' && file.type === 'image') el.classList.add('file-previewable');

  const iconHtml = file.type === 'image'
    ? `<img class="file-thumb" data-path="${escapeHtml(file.path)}" src="" alt="">`
    : `<span class="file-icon">\u{1F3AC}</span>`;
  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error' || file.state === 'cancelled') progressClass = ' error';
  let statusClass = file.state === 'cancelled' ? ' cancelled' : '';

  const sizeStr = file.size ? window.formatFileSize(file.size) : '';

  el.innerHTML = `
    ${iconHtml}
    <div class="file-info">
      <div class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</div>
      <div class="file-status${statusClass}">${escapeHtml(file.status)}</div>
    </div>
    ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    ${file.state === 'complete' && file.type === 'image' ? '<button class="file-preview-btn" title="Preview">\u{1F50D}</button>' : ''}
    <button class="file-remove" data-index="${index}" title="Remove">\u00D7</button>`;

  // Load thumbnail async
  const thumb = el.querySelector('.file-thumb');
  if (thumb) {
    window.getFileThumbnail(file.path).then(url => { if (url) thumb.src = url; });
  }

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing) removeFile(index); });
  const prevBtn = el.querySelector('.file-preview-btn');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); openPreview(file); });

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing ? null : () => removeFile(index));
    }
  });

  return el;
}

function updateUpscaleButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled');
  upscaleBtn.disabled = pending.length === 0 && !isProcessing;
}

// ---- Preview ----
async function openPreview(file) {
  if (!file.output || file.type !== 'image') return;
  previewTitle.textContent = file.name;
  previewModal.classList.add('active');
  const [beforeData, afterData] = await Promise.all([
    window.api.readImagePreview(file.path),
    window.api.readImagePreview(file.output)
  ]);
  if (!beforeData || !afterData) { log('Failed to load preview images', 'error'); previewModal.classList.remove('active'); return; }
  previewBefore.src = beforeData;
  previewAfter.src = afterData;
  previewBeforeClip.style.width = '50%';
  previewSlider.style.left = '50%';
  requestAnimationFrame(() => {
    previewBefore.style.width = previewContainer.offsetWidth + 'px';
    previewBefore.style.height = previewContainer.offsetHeight + 'px';
  });
}

function closePreview() {
  previewModal.classList.remove('active');
  previewBefore.src = '';
  previewAfter.src = '';
}

// ---- Register ----
window.registerTool('upscaler', { init, cleanup });

})();
