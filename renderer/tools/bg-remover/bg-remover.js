// ============================================================================
// Background Remover Tool (WebSocket-based)
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif']);

let files = [];
let outputDir = '';
let isProcessing = false;
let ws = null;
let pythonPort = null;
let log = null;
let batchStartTime = 0;
let batchTotalFiles = 0;

let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
const MAX_RECONNECT_DELAY = 30000;

let dropZone, browseBtn, fileList, processBtn, clearBtn, openOutputBtn;
let outputDirBtn, statusText, processingIndicator, outputFormat, etaText;
let alphaMatting;
let bgMode, bgColor, bgColorGroup, bgBlur, bgBlurGroup, bgBlurValue;
let compareOverlay, compareClose, compareContainer, compareBefore, compareAfter, compareSlider, compareTitle;
let lastOutputDir = '';
let _pasteHandler = null;

function init(ctx) {
  pythonPort = ctx.pythonPort;
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
  compareOverlay = document.getElementById('compareOverlay');
  compareClose = document.getElementById('compareClose');
  compareContainer = document.getElementById('compareContainer');
  compareBefore = document.getElementById('compareBefore');
  compareAfter = document.getElementById('compareAfter');
  compareSlider = document.getElementById('compareSlider');
  compareTitle = document.getElementById('compareTitle');

  bindEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  connectWebSocket(pythonPort);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  loadToolSettings();
  log('Background Remover ready');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---- WebSocket ----
function connectWebSocket(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/bg-remover/ws`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    if (statusText) statusText.textContent = 'Connected to backend';
    log('WebSocket connected', 'success');
  };
  ws.onmessage = (event) => handleWSMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (!statusText) return;
    statusText.textContent = 'Disconnected - reconnecting...';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`WebSocket disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s...`, 'warn');
    reconnectTimerId = setTimeout(() => connectWebSocket(port), delay);
  };
  ws.onerror = () => { if (statusText) statusText.textContent = 'Connection error'; };
}

function handleWSMessage(data) {
  if (data.type === 'log') { log(data.message, data.level || 'info'); return; }

  const fileIndex = files.findIndex(f => f.path === data.file);
  if (fileIndex === -1 && data.type !== 'all_complete' && data.type !== 'fatal_error') return;

  switch (data.type) {
    case 'progress':
      files[fileIndex].progress = data.progress;
      files[fileIndex].status = data.status || 'Processing...';
      files[fileIndex].state = 'processing';
      renderFileItem(fileIndex);
      if (window.setTaskbarProgress) window.setTaskbarProgress(data.progress);
      if (etaText && window.calculateETA) etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, files);
      break;
    case 'complete':
      files[fileIndex].progress = 1;
      files[fileIndex].status = 'Complete';
      files[fileIndex].state = 'complete';
      if (data.output) files[fileIndex].outputPath = data.output;
      renderFileItem(fileIndex);
      if (data.output) lastOutputDir = data.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      log(`Complete: ${files[fileIndex].name}`, 'success');
      break;
    case 'error':
      files[fileIndex].progress = 0;
      files[fileIndex].status = `Error: ${data.error}`;
      files[fileIndex].state = 'error';
      renderFileItem(fileIndex);
      log(`Error [${files[fileIndex].name}]: ${data.error}`, 'error');
      break;
    case 'all_complete':
      isProcessing = false;
      if (etaText) etaText.textContent = '';
      processingIndicator.classList.remove('active');
      processBtn.disabled = false;
      processBtn.textContent = 'Remove Backgrounds';
      processBtn.classList.remove('btn-cancel');
      const completed = files.filter(f => f.state === 'complete').length;
      const errors = files.filter(f => f.state === 'error').length;
      statusText.textContent = `Done! ${completed} processed${errors > 0 ? `, ${errors} failed` : ''}`;
      if (lastOutputDir) openOutputBtn.style.display = '';
      log(`Batch finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      if (window.showCompletionToast) window.showCompletionToast(`Background removal complete: ${completed} processed${errors > 0 ? `, ${errors} failed` : ''}`, errors > 0);
      if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
      break;
    case 'fatal_error':
      isProcessing = false;
      if (etaText) etaText.textContent = '';
      processingIndicator.classList.remove('active');
      processBtn.disabled = false;
      processBtn.textContent = 'Remove Backgrounds';
      processBtn.classList.remove('btn-cancel');
      statusText.textContent = `Fatal error: ${data.error}`;
      log(`Fatal: ${data.error}`, 'error');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      break;
  }
}

function bindEvents() {
  outputFormat.addEventListener('change', () => { saveToolSettings(); });
  alphaMatting.addEventListener('change', () => { saveToolSettings(); });

  // Background mode controls
  bgMode.addEventListener('change', () => {
    bgColorGroup.style.display = bgMode.value === 'color' ? '' : 'none';
    bgBlurGroup.style.display = bgMode.value === 'blur' ? '' : 'none';
    saveToolSettings();
  });
  bgColor.addEventListener('input', () => { saveToolSettings(); });
  bgBlur.addEventListener('input', () => {
    bgBlurValue.textContent = bgBlur.value;
    saveToolSettings();
  });

  // Comparison modal controls
  compareClose.addEventListener('click', closeCompare);
  compareOverlay.addEventListener('click', (e) => { if (e.target === compareOverlay) closeCompare(); });
  initCompareSlider();

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.selectOutputDir();
    if (dir) {
      outputDir = dir;
      const parts = dir.replace(/\\\\/g, '/').split('/');
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
    for (const file of e.dataTransfer.files) paths.push(file.path);
    if (paths.length > 0) {
      const resolved = await window.api.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else log('No supported image files found', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.selectFiles({ title: 'Select Images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  const browseFolderBtn = document.getElementById('browseFolderBtn');
  if (browseFolderBtn) {
    browseFolderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (statusText) statusText.textContent = 'Scanning folder...';
      const paths = await window.api.selectFolder();
      if (paths.length > 0) addFiles(paths);
      else log('No supported files found in folder', 'warn');
      if (statusText) statusText.textContent = 'Ready';
    });
  }

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.selectFiles({ title: 'Select Images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.openFolder(lastOutputDir);
  });

  processBtn.addEventListener('click', () => {
    if (isProcessing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'cancel' }));
        processBtn.disabled = true;
        processBtn.textContent = 'Cancelling...';
        log('Cancelling...', 'warn');
        setTimeout(() => {
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
    const filesToProcess = files
      .filter(f => f.state === 'pending' || f.state === 'error')
      .map(f => { f.state = 'pending'; f.progress = 0; f.status = 'Queued...'; return f.path; });
    if (filesToProcess.length === 0) return;

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
    ws.send(JSON.stringify({
      action: 'remove',
      files: filesToProcess,
      output_format: outputFormat.value,
      output_dir: outputDir,
      alpha_matting: alphaMatting.checked,
      bg_mode: bgMode.value,
      bg_color: bgColor.value,
      bg_blur: parseInt(bgBlur.value, 10)
    }));
  });
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
    const ext = getFileExtension(p);
    if (!IMAGE_EXTS.has(ext)) continue;
    if (files.some(f => f.path === p)) { log(`Skipped duplicate: ${getFileName(p)}`, 'warn'); continue; }
    const size = await window.api.getFileSize(p);
    files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Ready', state: 'pending' });
    added++;
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
  statusText.textContent = 'Ready';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateFileCount) window.updateFileCount(0);
}

function updateButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  processBtn.disabled = pending.length === 0 && !isProcessing;
}

// ---- Rendering ----
function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">No files added. Drag files here, browse, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach((f, i) => fileList.appendChild(createFileElement(f, i)));
  if (window.updateFileCount) window.updateFileCount(files.length);
}

function renderFileItem(index) {
  const existing = fileList.children[index];
  if (!existing) return;
  fileList.replaceChild(createFileElement(files[index], index), existing);
}

function createFileElement(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item';

  const isComplete = file.state === 'complete' && file.outputPath;
  if (isComplete) el.classList.add('clickable-compare');

  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error') progressClass = ' error';

  el.innerHTML = `
    <img class="file-thumb" data-path="${window.escapeHtml(file.path)}" src="" alt="">
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}</div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
    ${isComplete ? '<span class="file-compare-hint">Compare</span>' : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    <button class="file-remove" data-index="${index}" title="Remove">\u00D7</button>`;

  // Load thumbnail async
  const thumb = el.querySelector('.file-thumb');
  if (thumb) {
    window.getFileThumbnail(file.path).then(url => { if (url) thumb.src = url; });
  }

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing) removeFile(index); });

  if (isComplete) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.file-remove')) return;
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
  compareTitle.textContent = `Before / After - ${file.name}`;
  // Use file:// protocol for local images
  compareBefore.src = 'file://' + file.path;
  compareAfter.src = 'file://' + file.outputPath;
  // Reset slider to 50%
  setComparePosition(50);
  compareOverlay.classList.add('active');
}

function closeCompare() {
  compareOverlay.classList.remove('active');
  compareBefore.src = '';
  compareAfter.src = '';
}

function setComparePosition(pct) {
  pct = Math.max(0, Math.min(100, pct));
  const beforeEl = compareContainer.querySelector('.compare-before');
  beforeEl.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  compareSlider.style.left = pct + '%';
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
  window.addEventListener('mousemove', (e) => { if (isDragging) onMove(e.clientX); });
  window.addEventListener('mouseup', () => { isDragging = false; });

  // Touch support
  compareSlider.addEventListener('touchstart', (e) => { e.preventDefault(); isDragging = true; });
  compareContainer.addEventListener('touchstart', (e) => {
    isDragging = true;
    const rect = compareContainer.getBoundingClientRect();
    const pct = ((e.touches[0].clientX - rect.left) / rect.width) * 100;
    setComparePosition(pct);
  });
  window.addEventListener('touchmove', (e) => { if (isDragging) onMove(e.touches[0].clientX); });
  window.addEventListener('touchend', () => { isDragging = false; });
}

// ---- Settings persistence ----
async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all['bg-remover'] || {};
    if (s.outputFormat) outputFormat.value = s.outputFormat;
    if (typeof s.alphaMatting === 'boolean') alphaMatting.checked = s.alphaMatting;
    if (s.bgMode) {
      bgMode.value = s.bgMode;
      bgColorGroup.style.display = s.bgMode === 'color' ? '' : 'none';
      bgBlurGroup.style.display = s.bgMode === 'blur' ? '' : 'none';
    }
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
    window.loadAllSettings().then(all => {
      all['bg-remover'] = {
        outputFormat: outputFormat.value,
        alphaMatting: alphaMatting.checked,
        bgMode: bgMode.value,
        bgColor: bgColor.value,
        bgBlur: bgBlur.value,
        outputDir
      };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('bg-remover', { init, cleanup });

})();
