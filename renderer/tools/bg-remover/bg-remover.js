// ============================================================================
// Background Remover Tool (WebSocket-based)
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif']);

let files = [];
let outputDir = '';
let isProcessing = false;
let cancelRequested = false;
let ws = null;
let getPythonPort = () => null;
let connectedPythonPort = null;
let pythonToken = null;
let log = null;
let batchStartTime = 0;
let batchTotalFiles = 0;
let batchFilePaths = new Set();

let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
let cancelWatchdog = null;
const MAX_RECONNECT_DELAY = 30000;

let dropZone, browseBtn, fileList, processBtn, clearBtn, openOutputBtn;
let outputDirBtn, statusText, processingIndicator, outputFormat, etaText;
let alphaMatting;
let bgMode, bgColor, bgColorGroup, bgBlur, bgBlurGroup, bgBlurValue;
let bgImageGroup, bgImageBtn;
let bgImagePath = '';
let compareOverlay, compareClose, compareContainer, compareBefore, compareAfter, compareSlider, compareTitle;
let lastOutputDir = '';
let _pasteHandler = null;
let compareReturnFocus = null;
// Window-level drag handlers for the compare slider; tracked so cleanup() can
// remove them (otherwise they leak — and keep the old DOM alive — every time
// the tool is opened and closed).
let _winMouseMove = null, _winMouseUp = null, _winTouchMove = null, _winTouchEnd = null;

async function init(ctx) {
  getPythonPort = typeof ctx.getPythonPort === 'function' ? ctx.getPythonPort : () => ctx.pythonPort;
  pythonToken = ctx.pythonToken;
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  processBtn = document.getElementById('processBtn');
  clearBtn = document.getElementById('clearBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  outputFormat = document.getElementById('outputFormat');
  alphaMatting = document.getElementById('alphaMatting');
  openOutputBtn = document.getElementById('openOutputBtn');
  etaText = document.getElementById('etaText');
  bgMode = document.getElementById('bgMode');
  bgColor = document.getElementById('bgColor');
  bgColorGroup = document.getElementById('bgColorGroup');
  bgBlur = document.getElementById('bgBlur');
  bgBlurGroup = document.getElementById('bgBlurGroup');
  bgBlurValue = document.getElementById('bgBlurValue');
  bgImageGroup = document.getElementById('bgImageGroup');
  bgImageBtn = document.getElementById('bgImageBtn');
  compareOverlay = document.getElementById('compareOverlay');
  compareClose = document.getElementById('compareClose');
  compareContainer = document.getElementById('compareContainer');
  compareBefore = document.getElementById('compareBefore');
  compareAfter = document.getElementById('compareAfter');
  compareSlider = document.getElementById('compareSlider');
  compareTitle = document.getElementById('compareTitle');

  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  await loadToolSettings();
  bindEvents();
  _pasteHandler = (e) => { if (window.isToolActive('bg-remover') && e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  connectWebSocket();
  log('Background Editor initialized');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (_winMouseMove) { window.removeEventListener('mousemove', _winMouseMove); _winMouseMove = null; }
  if (_winMouseUp) { window.removeEventListener('mouseup', _winMouseUp); _winMouseUp = null; }
  if (_winTouchMove) { window.removeEventListener('touchmove', _winTouchMove); _winTouchMove = null; }
  if (_winTouchEnd) { window.removeEventListener('touchend', _winTouchEnd); _winTouchEnd = null; }
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  connectedPythonPort = null;
}

// ---- WebSocket ----
function connectWebSocket() {
  const port = getPythonPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  connectedPythonPort = port;
  ws = new WebSocket(`ws://127.0.0.1:${port}/bg-remover/ws?token=${encodeURIComponent(pythonToken || '')}`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    reconnectTimerId = null;
    // Removed technical logs
  };
  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; } // ignore malformed frames rather than throwing in the socket loop
    handleWSMessage(data);
  };
  ws.onclose = () => {
    ws = null;
    connectedPythonPort = null;
    if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
    if (!statusText) return;
    if (isProcessing) {
      isProcessing = false;
      processingIndicator.classList.remove('active');
      updateButton();
      processBtn.textContent = 'Apply background';
      processBtn.classList.remove('btn-cancel');
      files.forEach(file => {
        if (file.state === 'processing') {
          file.state = 'error';
          file.status = 'Connection lost — ready to retry';
        }
      });
      renderFileList();
    }
    statusText.textContent = 'Disconnected - reconnecting...';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`WebSocket disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s...`, 'warn');
    reconnectTimerId = setTimeout(connectWebSocket, delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function onBackendStatus(status = {}) {
  const nextPort = status.port;
  if (status.state !== 'ready' || !Number.isInteger(nextPort) || nextPort === connectedPythonPort) return;
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) ws.close();
  else connectWebSocket();
}

function handleWSMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  if (data.type === 'log') {
    if (typeof data.message === 'string') log(data.message, data.level || 'info');
    return;
  }

  const fileIndex = files.findIndex(f => f.path === data.file);
  if (fileIndex === -1 && data.type !== 'all_complete' && data.type !== 'fatal_error') return;

  switch (data.type) {
    case 'progress':
      files[fileIndex].progress = normalizeProgress(data.progress);
      files[fileIndex].status = typeof data.status === 'string' ? data.status : 'Processing...';
      files[fileIndex].state = 'processing';
      renderFileItem(fileIndex);
      if (window.setTaskbarProgress) window.setTaskbarProgress(files[fileIndex].progress);
      if (etaText && window.calculateETA) etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, files.filter(file => batchFilePaths.has(file.path)));
      break;
    case 'complete':
      files[fileIndex].progress = 1;
      files[fileIndex].status = 'Complete';
      files[fileIndex].state = 'complete';
      if (typeof data.output === 'string' && data.output) files[fileIndex].outputPath = data.output;
      renderFileItem(fileIndex);
      if (typeof data.output === 'string' && data.output) lastOutputDir = window.getParentDirectory(data.output);
      if (typeof data.output === 'string' && data.output && window.addRecentFile) window.addRecentFile(data.output);
      log(`Complete: ${files[fileIndex].name}`, 'success');
      break;
    case 'error':
      data.error = typeof data.error === 'string' ? data.error : 'Background processing failed';
      files[fileIndex].progress = 0;
      files[fileIndex].status = `Error: ${data.error}`;
      files[fileIndex].state = data.error === 'Cancelled' ? 'cancelled' : 'error';
      renderFileItem(fileIndex);
      log(`Error [${files[fileIndex].name}]: ${data.error}`, data.error === 'Cancelled' ? 'warn' : 'error');
      break;
    case 'all_complete':
      if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
      isProcessing = false;
      if (etaText) etaText.textContent = '';
      processingIndicator.classList.remove('active');
      updateButton();
      processBtn.textContent = 'Apply background';
      processBtn.classList.remove('btn-cancel');
      const batchFiles = files.filter(file => batchFilePaths.has(file.path));
      const completed = batchFiles.filter(f => f.state === 'complete').length;
      const errors = batchFiles.filter(f => f.state === 'error').length;
      const cancelled = batchFiles.filter(f => f.state === 'cancelled').length;
      const outputs = batchFiles.filter(f => f.state === 'complete' && typeof f.outputPath === 'string').map(f => f.outputPath);
      statusText.textContent = cancelRequested
        ? `Cancelled. ${completed} processed${cancelled ? `, ${cancelled} cancelled` : ''}`
        : `Done! ${completed} processed${errors > 0 ? `, ${errors} failed` : ''}`;
      if (lastOutputDir) openOutputBtn.style.display = '';
      log(`Batch finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      if (!cancelRequested && window.showCompletionToast) window.showCompletionToast(`Background removal complete: ${completed} processed${errors > 0 ? `, ${errors} failed` : ''}`, errors > 0, outputs);
      if (!cancelRequested && outputs.length > 0 && window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
      break;
    case 'fatal_error':
      if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
      data.error = typeof data.error === 'string' ? data.error : 'Background processing failed';
      isProcessing = false;
      if (etaText) etaText.textContent = '';
      processingIndicator.classList.remove('active');
      updateButton();
      processBtn.textContent = 'Apply background';
      processBtn.classList.remove('btn-cancel');
      statusText.textContent = `Fatal error: ${data.error}`;
      log(`Fatal: ${data.error}`, 'error');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      break;
  }
}

function normalizeProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
}

function bindEvents() {
  outputFormat.addEventListener('change', () => { saveToolSettings(); });
  alphaMatting.addEventListener('change', () => { saveToolSettings(); });

  // Background mode controls
  bgMode.addEventListener('change', () => {
    updateBgModeGroups();
    saveToolSettings();
  });
  bgColor.addEventListener('input', () => { saveToolSettings(); });

  // Image background: pick the replacement image (right-click to clear).
  if (bgImageBtn) {
    bgImageBtn.addEventListener('click', async () => {
      if (isProcessing) return;
      const paths = await window.api.system.selectFiles({
        title: 'Select Background Image',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'] }]
      });
      if (paths && paths.length > 0) {
        bgImagePath = paths[0];
        updateBgImageButton();
        saveToolSettings();
      }
    });
    bgImageBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (bgImagePath) {
        bgImagePath = '';
        updateBgImageButton();
        saveToolSettings();
      }
    });
  }
  bgBlur.addEventListener('input', () => {
    bgBlurValue.textContent = bgBlur.value;
    saveToolSettings();
  });

  // Comparison modal controls
  compareClose.addEventListener('click', closeCompare);
  compareOverlay.addEventListener('click', (e) => { if (e.target === compareOverlay) closeCompare(); });
  compareOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCompare();
      return;
    }
    if (e.key === 'Tab') {
      trapCompareFocus(e);
    }
  });
  compareSlider.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const current = Number(compareSlider.getAttribute('aria-valuenow')) || 50;
    setComparePosition(e.key === 'Home' ? 0 : e.key === 'End' ? 100 : current + (e.key === 'ArrowRight' ? 5 : -5));
  });
  initCompareSlider();

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      const parts = dir.replace(/\\/g, '/').split('/');
      const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : dir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = dir;
      saveToolSettings();
    }
  });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover');
    const paths = [];
    for (const file of e.dataTransfer.files) paths.push(window.api.system.getPathForFile(file));
    if (paths.length > 0) {
      const resolved = await window.api.system.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else log('No supported image files found', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.system.selectFiles({ title: 'Select Images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  const browseFolderBtn = document.getElementById('browseFolderBtn');
  if (browseFolderBtn) {
    browseFolderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (statusText) statusText.textContent = 'Scanning folder...';
      const paths = await window.api.system.selectFolder();
      if (paths.length > 0) addFiles(paths);
      else log('No supported files found in folder', 'warn');
      if (statusText) statusText.textContent = 'Waiting for image';
    });
  }

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.system.selectFiles({ title: 'Select Images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.system.openFolder(lastOutputDir);
  });

  processBtn.addEventListener('click', () => {
    if (isProcessing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        cancelRequested = true;
        try { ws.send(JSON.stringify({ action: 'cancel' })); }
        catch (err) {
          cancelRequested = false;
          log(`Could not request cancellation: ${err.message}`, 'error');
          return;
        }
        processBtn.disabled = true;
        processBtn.textContent = 'Cancelling...';
        log('Cancelling...', 'warn');
        if (cancelWatchdog) clearTimeout(cancelWatchdog);
        cancelWatchdog = setTimeout(() => {
          cancelWatchdog = null;
          if (isProcessing) {
            processBtn.disabled = false;
            processBtn.textContent = 'Cancel';
            log('Cancel may not have completed — you can try again', 'warn');
          }
        }, 10000);
      }
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (bgMode.value === 'image' && !bgImagePath) {
      log('Select a background image first, or choose a different Background mode.', 'warn');
      if (statusText) statusText.textContent = 'Choose a background image';
      return;
    }

    const filesToProcess = files
      .filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled')
      .map(f => { f.state = 'pending'; f.progress = 0; f.status = 'Queued...'; return f.path; });
    if (filesToProcess.length === 0) return;

    cancelRequested = false;
    if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
    batchFilePaths = new Set(filesToProcess);
    isProcessing = true;
    batchStartTime = Date.now();
    batchTotalFiles = filesToProcess.length;
    if (etaText) etaText.textContent = 'ETA: calculating...';
    processBtn.disabled = false;
    processBtn.textContent = 'Cancel';
    processBtn.classList.add('btn-cancel');
    processingIndicator.classList.add('active');
    statusText.textContent = `Processing ${filesToProcess.length} file(s)...`;
    renderFileList();

    log(`Starting background removal: ${filesToProcess.length} file(s), format=${outputFormat.value}, bg=${bgMode.value}, edge refinement=${alphaMatting.checked}`);
    try {
      ws.send(JSON.stringify({
        action: 'remove',
        files: filesToProcess,
        output_format: outputFormat.value,
        output_dir: outputDir,
        alpha_matting: alphaMatting.checked,
        bg_mode: bgMode.value,
        bg_color: bgColor.value,
        bg_blur: parseInt(bgBlur.value, 10),
        bg_image: bgImagePath
      }));
    } catch (err) {
      isProcessing = false;
      files.filter(file => batchFilePaths.has(file.path)).forEach(file => {
        file.state = 'pending';
        file.status = 'Ready to retry';
      });
      processingIndicator.classList.remove('active');
      processBtn.textContent = 'Apply background';
      processBtn.classList.remove('btn-cancel');
      statusText.textContent = 'Could not start processing';
      renderFileList();
      updateButton();
      log(`Could not start background processing: ${err.message}`, 'error');
    }
  });
}

// Show only the controls relevant to the chosen background mode.
function updateBgModeGroups() {
  bgColorGroup.style.display = bgMode.value === 'color' ? '' : 'none';
  bgBlurGroup.style.display = bgMode.value === 'blur' ? '' : 'none';
  if (bgImageGroup) bgImageGroup.style.display = bgMode.value === 'image' ? '' : 'none';
}

function updateBgImageButton() {
  if (!bgImageBtn) return;
  if (!bgImagePath) {
    bgImageBtn.innerHTML = 'Choose image&hellip;';
    bgImageBtn.title = 'Choose a background image to place behind the subject (right-click to clear)';
    return;
  }
  const name = bgImagePath.replace(/\\/g, '/').split('/').pop();
  bgImageBtn.textContent = name;
  bgImageBtn.title = bgImagePath + ' — right-click to clear';
}

// ---- File management ----
function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }

async function addFiles(paths) {
  let added = 0;
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const ext = getFileExtension(p);
    if (!IMAGE_EXTS.has(ext)) continue;
    if (files.some(f => f.path === p)) { log(`Skipped duplicate: ${getFileName(p)}`, 'warn'); continue; }
    try {
      const size = await window.api.system.getFileSize(p);
      files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Queued', state: 'pending' });
      added++;
    } catch (err) {
      log(`Could not add ${getFileName(p)}: ${err.message}`, 'warn');
    }
  }
  if (added > 0) log(`Added ${added} image file(s)`);
  renderFileList();
  updateButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function removeFile(index) { files.splice(index, 1); renderFileList(); updateButton(); }

function clearFiles() {
  files = [];
  renderFileList();
  updateButton();
  statusText.textContent = 'Waiting for image';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([], 'bg-remover');
}

function updateButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled');
  processBtn.disabled = pending.length === 0 && !isProcessing;
}

// ---- Rendering ----
function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">Your files will appear here. Choose files above, drop them here, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach((f, i) => fileList.appendChild(createFileElement(f, i)));
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'bg-remover');
}

function renderFileItem(index) {
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'bg-remover');
  const existing = fileList.children[index];
  if (!existing) return;
  const file = files[index];
  // Only rebuild when the file finishes to attach the comparison action.
  // For progress/error updates, mutate the existing fields in place.
  if (file.state === 'complete') {
    fileList.replaceChild(createFileElement(file, index), existing);
  } else {
    updateFileElement(existing, file);
  }
}

function updateFileElement(el, file) {
  const status = el.querySelector('.file-status');
  if (status) status.textContent = file.status;
  const fill = el.querySelector('.file-progress-fill');
  if (fill) {
    fill.style.width = `${Math.round(file.progress * 100)}%`;
    fill.classList.toggle('complete', file.state === 'complete');
    fill.classList.toggle('error', file.state === 'error');
  }
}

function createFileElement(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item';

  const isComplete = file.state === 'complete' && file.outputPath;

  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error') progressClass = ' error';

  el.innerHTML = `
    <span class="file-type">${window.escapeHtml(getFileExtension(file.path).slice(1).toUpperCase())}</span>
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}</div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
    ${isComplete ? `<button type="button" class="file-compare-btn" title="Compare original and result" aria-label="Compare before and after for ${window.escapeHtml(file.name)}">Compare</button>` : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    <button class="file-remove" data-index="${index}" title="Remove" aria-label="Remove ${window.escapeHtml(file.name)}">\u00D7</button>`;

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing) removeFile(index); });

  const compareBtn = el.querySelector('.file-compare-btn');
  if (compareBtn) {
    compareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCompare(file);
    });
  }

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing ? null : () => removeFile(index));
    }
  });

  return el;
}

// ---- Before/After Comparison ----
function openCompare(file) {
  if (!file.outputPath) return;
  compareReturnFocus = document.activeElement;
  compareTitle.textContent = `Before / After - ${file.name}`;
  compareBefore.src = window.localPathToFileUrl(file.path);
  compareAfter.src = window.localPathToFileUrl(file.outputPath);
  // Reset slider to 50%
  setComparePosition(50);
  compareOverlay.classList.add('active');
  compareOverlay.setAttribute('aria-hidden', 'false');
  compareClose.focus();
}

function closeCompare() {
  compareOverlay.classList.remove('active');
  compareOverlay.setAttribute('aria-hidden', 'true');
  compareBefore.src = '';
  compareAfter.src = '';
  if (compareReturnFocus?.isConnected) compareReturnFocus.focus();
  compareReturnFocus = null;
}

function trapCompareFocus(event) {
  const dialog = compareOverlay.querySelector('.compare-modal');
  if (!dialog) return;

  const focusable = Array.from(dialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');

  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = document.activeElement;
  const focusIsInside = dialog.contains(activeElement);

  if (event.shiftKey && (activeElement === first || !focusIsInside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !focusIsInside)) {
    event.preventDefault();
    first.focus();
  }
}

function setComparePosition(pct) {
  pct = Math.max(0, Math.min(100, pct));
  const beforeEl = compareContainer.querySelector('.compare-before');
  beforeEl.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  compareSlider.style.left = pct + '%';
  compareSlider.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function initCompareSlider() {
  let isDragging = false;

  function onMove(clientX) {
    if (!isDragging) return;
    const rect = compareContainer.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setComparePosition(pct);
  }

  compareSlider.addEventListener('mousedown', (e) => { e.preventDefault(); isDragging = true; });
  compareContainer.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = compareContainer.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setComparePosition(pct);
  });
  _winMouseMove = (e) => { if (isDragging) onMove(e.clientX); };
  _winMouseUp = () => { isDragging = false; };
  window.addEventListener('mousemove', _winMouseMove);
  window.addEventListener('mouseup', _winMouseUp);

  // Touch support
  compareSlider.addEventListener('touchstart', (e) => { e.preventDefault(); isDragging = true; });
  compareContainer.addEventListener('touchstart', (e) => {
    isDragging = true;
    const rect = compareContainer.getBoundingClientRect();
    const pct = ((e.touches[0].clientX - rect.left) / rect.width) * 100;
    setComparePosition(pct);
  });
  _winTouchMove = (e) => { if (isDragging) onMove(e.touches[0].clientX); };
  _winTouchEnd = () => { isDragging = false; };
  window.addEventListener('touchmove', _winTouchMove);
  window.addEventListener('touchend', _winTouchEnd);
}

// ---- Settings persistence ----
async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all['bg-remover'] || {};
    if (s.outputFormat) outputFormat.value = s.outputFormat;
    if (typeof s.alphaMatting === 'boolean') alphaMatting.checked = s.alphaMatting;
    if (s.bgImage) bgImagePath = s.bgImage;
    if (s.bgMode) bgMode.value = s.bgMode;
    updateBgModeGroups();
    updateBgImageButton();
    if (s.bgColor) bgColor.value = s.bgColor;
    if (s.bgBlur) { bgBlur.value = s.bgBlur; bgBlurValue.textContent = s.bgBlur; }
    if (s.outputDir) {
      outputDir = s.outputDir;
      const parts = outputDir.replace(/\\/g, '/').split('/');
      const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : outputDir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = outputDir;
    }
  } catch {}
}

let _saveTimer = null;
function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.updateSettings(all => {
      all['bg-remover'] = {
        outputFormat: outputFormat.value,
        alphaMatting: alphaMatting.checked,
        bgMode: bgMode.value,
        bgColor: bgColor.value,
        bgBlur: bgBlur.value,
        bgImage: bgImagePath,
        outputDir
      };
    }).catch(err => log('Could not save settings: ' + err.message, 'warn'));
  }, 300);
}

window.registerTool('bg-remover', { init, cleanup, onBackendStatus });

})();
