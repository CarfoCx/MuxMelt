// ============================================================================
// Video Compressor Tool
// ============================================================================

(function() {

const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);
const DOWNSCALE_TARGETS = [
  { value: '1080p', label: '1080p', height: 1080 },
  { value: '720p', label: '720p', height: 720 },
  { value: '480p', label: '480p', height: 480 }
];

const persistedState = (() => {
  window.__muxmeltToolState = window.__muxmeltToolState || {};
  window.__muxmeltToolState.videoCompressor = window.__muxmeltToolState.videoCompressor || {
    files: [],
    outputDir: '',
    lastOutputDir: '',
    isProcessing: false,
    statusText: 'Waiting for Video',
    etaText: '',
    footerProgress: 0,
    footerProgressVisible: false
  };
  return window.__muxmeltToolState.videoCompressor;
})();

let files = persistedState.files;
let outputDir = persistedState.outputDir || '';
let isProcessing = !!persistedState.isProcessing;
let log = null;
let progressCleanup = null;
let batchStartTime = 0;
let batchTotalFiles = 0;

let dropZone, browseBtn, fileList, compressBtn, clearBtn, openOutputBtn, retryBtn;
let lastOutputDir = persistedState.lastOutputDir || '';
let outputDirBtn, statusText, processingIndicator, etaText;
let footerProgress, footerProgressFill, progressPercent;
let crfSlider, crfValue, preset, resolution, codec, customWidth, twoPassCheck;
let _pasteHandler = null;

function init(ctx) {
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  compressBtn = document.getElementById('compressBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');
  footerProgress = document.getElementById('footerProgress');
  footerProgressFill = document.getElementById('footerProgressFill');
  progressPercent = document.getElementById('progressPercent');
  crfSlider = document.getElementById('crfSlider');
  crfValue = document.getElementById('crfValue');
  preset = document.getElementById('preset');
  resolution = document.getElementById('resolution');
  codec = document.getElementById('codec');
  customWidth = document.getElementById('customWidth');
  twoPassCheck = document.getElementById('twoPassCheck');

  bindEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  loadToolSettings();
  restoreViewState();
  if (!persistedState.initialized) {
    log('Video Compressor initialized');
    persistedState.initialized = true;
  }
}

function cleanup() {
  persistRuntimeState();
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function persistRuntimeState() {
  persistedState.files = files;
  persistedState.outputDir = outputDir;
  persistedState.lastOutputDir = lastOutputDir;
  persistedState.isProcessing = isProcessing;
  persistedState.statusText = statusText ? statusText.textContent : persistedState.statusText;
  persistedState.etaText = etaText ? etaText.textContent : persistedState.etaText;
}

function restoreViewState() {
  if (statusText) statusText.textContent = persistedState.statusText || 'Waiting for Video';
  if (etaText) etaText.textContent = persistedState.etaText || '';
  setFooterProgress(persistedState.footerProgress || 0, !!persistedState.footerProgressVisible);
  if (processingIndicator) processingIndicator.classList.toggle('active', isProcessing);
  if (compressBtn) {
    compressBtn.textContent = isProcessing ? 'Cancel' : 'Compress';
    compressBtn.classList.toggle('btn-cancel', isProcessing);
  }
  if (openOutputBtn) openOutputBtn.style.display = lastOutputDir ? '' : 'none';
  if (retryBtn) retryBtn.style.display = files.some(f => f.state === 'error') ? '' : 'none';
  updateResolutionOptions();
  renderFileList();
  updateButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function bindEvents() {
  crfSlider.addEventListener('input', () => {
    crfValue.textContent = crfSlider.value;
    saveToolSettings();
  });

  preset.addEventListener('change', () => { saveToolSettings(); });
  codec.addEventListener('change', () => { saveToolSettings(); });
  resolution.addEventListener('change', () => {
    updateCustomWidthState();
    saveToolSettings();
  });
  customWidth.addEventListener('change', () => {
    updateCustomWidthState();
    saveToolSettings();
  });
  twoPassCheck.addEventListener('change', () => { saveToolSettings(); });

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      persistedState.outputDir = outputDir;
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
    for (const file of e.dataTransfer.files) paths.push(window.api.system.getPathForFile(file));
    if (paths.length > 0) {
      const resolved = await window.api.system.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else log('No supported video files found', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.system.selectFiles({ title: 'Select Videos', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
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
      if (statusText) statusText.textContent = 'Waiting for Video';
    });
  }

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.system.selectFiles({ title: 'Select Videos', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; if (retryBtn) retryBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.system.openFolder(lastOutputDir);
  });

  compressBtn.addEventListener('click', startCompression);

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      files.forEach(f => { if (f.state === 'error') { f.state = 'pending'; f.progress = 0; f.status = 'Waiting for Video'; } });
      persistRuntimeState();
      retryBtn.style.display = 'none';
      renderFileList();
      updateButton();
      startCompression();
    });
  }

  progressCleanup = window.api.tools.onToolProgress((data) => {
    if (data.tool !== 'video-compressor') return;
    handleProgress(data);
  });
}

async function startCompression() {
  if (isProcessing) {
    compressBtn.disabled = true;
    compressBtn.textContent = 'Cancelling...';
    try { await window.api.tools.videoCompressor.cancelVideoCompression(); } catch {}
    return;
  }
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;

  isProcessing = true;
  persistedState.isProcessing = true;
  batchStartTime = Date.now();
  batchTotalFiles = pending.length;
  if (etaText) etaText.textContent = 'ETA: calculating...';
  if (retryBtn) retryBtn.style.display = 'none';
  compressBtn.disabled = false;
  compressBtn.textContent = 'Cancel';
  compressBtn.classList.add('btn-cancel');
  processingIndicator.classList.add('active');
  statusText.textContent = `Compressing ${pending.length} file(s)...`;
  setFooterProgress(0, true);

  pending.forEach(f => { f.state = 'processing'; f.progress = 0; f.status = 'Queued...'; });
  persistRuntimeState();
  renderFileList();

  log(`Starting compression: ${pending.length} file(s), codec=${codec.value}, CRF=${crfSlider.value}, preset=${preset.value}, max resolution=${resolution.value}${resolution.value === 'custom' ? ' (' + (parseInt(customWidth.value) || 1280) + 'px)' : ''}${twoPassCheck.checked ? ', two-pass' : ''}`);

  for (const file of pending) {
    file.state = 'processing';
    file.status = 'Compressing...';
    persistRuntimeState();
    renderFileItem(files.indexOf(file));

    try {
      const result = await window.api.tools.videoCompressor.compressVideo({
        inputPath: file.path,
        crf: parseInt(crfSlider.value),
        preset: preset.value,
        resolution: resolution.value,
        codec: codec.value,
        customWidth: resolution.value === 'custom' ? parseInt(customWidth.value) || 1280 : undefined,
        twoPass: twoPassCheck.checked,
        outputDir: outputDir
      });

      if (result && result.success) {
        file.state = 'complete';
        file.progress = 1;
        if (result.output) {
          lastOutputDir = result.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
          persistedState.lastOutputDir = lastOutputDir;
        }
        file.status = result.savedPercent ? `Done (${result.savedPercent}% smaller)` : 'Complete';
        log(`Compressed: ${file.name}${result.savedPercent ? ` — ${result.savedPercent}% smaller` : ''}`, 'success');
      } else {
        file.state = 'error';
        file.status = `Error: ${result ? result.error : 'unknown'}`;
        log(`Error [${file.name}]: ${result ? result.error : 'unknown'}`, 'error');
      }
    } catch (err) {
      file.state = 'error';
      file.status = `Error: ${err.message}`;
      log(`Error [${file.name}]: ${err.message}`, 'error');
    }
    persistRuntimeState();
    renderFileItem(files.indexOf(file));
  }

  isProcessing = false;
  persistedState.isProcessing = false;
  if (etaText) etaText.textContent = '';
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  setFooterProgress(0, false);
  compressBtn.textContent = 'Compress';
  compressBtn.classList.remove('btn-cancel');
  compressBtn.disabled = files.filter(f => f.state === 'pending' || f.state === 'error').length === 0;
  processingIndicator.classList.remove('active');
  const completed = files.filter(f => f.state === 'complete').length;
  const errors = files.filter(f => f.state === 'error').length;
  statusText.textContent = `Done! ${completed} compressed${errors > 0 ? `, ${errors} failed` : ''}`;
  persistedState.statusText = statusText.textContent;
  persistedState.etaText = '';
  if (completed > 0 && lastOutputDir) openOutputBtn.style.display = '';
  if (retryBtn) retryBtn.style.display = errors > 0 ? '' : 'none';
  log(`Compression finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
  if (window.showCompletionToast) window.showCompletionToast('Compression complete: ' + completed + ' compressed' + (errors > 0 ? ', ' + errors + ' failed' : ''), errors > 0);
  if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
  persistRuntimeState();
}

function handleProgress(data) {
  const idx = files.findIndex(f => f.path === data.file);
  if (idx === -1) return;

  if (data.type === 'progress') {
    const progress = normalizeProgress(data);
    files[idx].progress = progress;
    files[idx].status = data.status || 'Compressing...';
    files[idx].state = 'processing';
    statusText.textContent = `${files[idx].name}: ${files[idx].status}`;
    setFooterProgress(progress, true);
    if (window.setTaskbarProgress) window.setTaskbarProgress(progress);
    if (etaText && window.calculateETA) etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, files);
    persistRuntimeState();
  } else if (data.type === 'complete') {
    files[idx].progress = 1;
    files[idx].status = 'Complete';
    files[idx].state = 'complete';
    setFooterProgress(1, true);
    log(`Compressed: ${files[idx].name}`, 'success');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
    persistRuntimeState();
  } else if (data.type === 'error') {
    files[idx].progress = 0;
    files[idx].status = `Error: ${data.error}`;
    files[idx].state = 'error';
    setFooterProgress(0, false);
    log(`Error [${files[idx].name}]: ${data.error}`, 'error');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
    persistRuntimeState();
  }
  renderFileItem(idx);
}

function normalizeProgress(data) {
  const raw = typeof data.progress === 'number' ? data.progress : data.percent;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 0;
  return Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
}

function setFooterProgress(progress, visible = true) {
  const pct = Math.max(0, Math.min(1, Number(progress) || 0));
  const label = `${Math.round(pct * 100)}%`;
  persistedState.footerProgress = pct;
  persistedState.footerProgressVisible = visible;
  if (footerProgress) footerProgress.classList.toggle('active', visible);
  if (footerProgressFill) footerProgressFill.style.width = label;
  if (progressPercent) {
    progressPercent.classList.toggle('active', visible);
    progressPercent.textContent = visible ? label : '';
  }
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
    if (!VIDEO_EXTS.has(ext)) continue;
    if (files.some(f => f.path === p)) continue;
    const size = await window.api.system.getFileSize(p);
    const info = await probeVideoInfo(p);
    files.push({ path: p, name: getFileName(p), size, width: info.width, height: info.height, progress: 0, status: 'Waiting for Video', state: 'pending' });
    added++;
  }
  if (added > 0) log(`Added ${added} video file(s)`);
  updateResolutionOptions();
  persistRuntimeState();
  renderFileList();
  updateButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

async function probeVideoInfo(filePath) {
  try {
    if (!window.api.tools.videoCompressor.probeVideo) return {};
    const result = await window.api.tools.videoCompressor.probeVideo(filePath);
    if (result && result.success) return result;
  } catch {}
  return {};
}

function removeFile(index) {
  files.splice(index, 1);
  updateResolutionOptions();
  persistRuntimeState();
  renderFileList();
  updateButton();
}

function clearFiles() {
  files = [];
  persistedState.files = files;
  persistedState.isProcessing = false;
  persistedState.statusText = 'Waiting for Video';
  persistedState.etaText = '';
  updateResolutionOptions();
  renderFileList();
  updateButton();
  statusText.textContent = 'Waiting for Video';
  if (etaText) etaText.textContent = '';
  setFooterProgress(0, false);
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([]);
}

function getSmallestVideoBounds() {
  const known = files.filter(f => f.width > 0 || f.height > 0);
  if (known.length === 0) return { width: 0, height: 0 };
  return known.reduce((bounds, file) => ({
    width: file.width > 0 ? Math.min(bounds.width || file.width, file.width) : bounds.width,
    height: file.height > 0 ? Math.min(bounds.height || file.height, file.height) : bounds.height
  }), { width: 0, height: 0 });
}

function updateResolutionOptions() {
  const previous = resolution.value || 'original';
  const { width, height } = getSmallestVideoBounds();
  const validTargets = height > 0
    ? DOWNSCALE_TARGETS.filter(target => target.height < height)
    : DOWNSCALE_TARGETS;

  resolution.innerHTML = '';
  resolution.appendChild(new Option('Original', 'original'));
  validTargets.forEach(target => {
    resolution.appendChild(new Option(`${target.label} or lower`, target.value));
  });

  const allowCustom = files.length === 0 || width > 128;
  if (allowCustom) {
    resolution.appendChild(new Option('Custom lower width...', 'custom'));
  }

  const stillValid = Array.from(resolution.options).some(option => option.value === previous);
  resolution.value = stillValid ? previous : 'original';
  updateCustomWidthState(width);
}

function updateCustomWidthState(maxWidth) {
  const bounds = maxWidth == null ? getSmallestVideoBounds() : { width: maxWidth };
  customWidth.style.display = resolution.value === 'custom' ? '' : 'none';
  if (bounds.width > 0) {
    customWidth.max = String(bounds.width - 1);
    if (resolution.value === 'custom') {
      const current = parseInt(customWidth.value, 10);
      if (!current || current >= bounds.width) customWidth.value = String(Math.max(128, bounds.width - 1));
    }
  } else {
    customWidth.max = '7680';
  }
}

function updateButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  compressBtn.disabled = pending.length === 0 && !isProcessing;
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
  updateFileElement(existing, files[index]);
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

  const removeBtn = el.querySelector('.file-remove');
  if (removeBtn) removeBtn.disabled = isProcessing;
}

function createFileElement(file, index) {
  const el = document.createElement('div');
  el.className = 'file-item';

  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error') progressClass = ' error';

  el.innerHTML = `
    <span class="file-icon">\u{1F3AC}</span>
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}</div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    <button class="file-remove" data-index="${index}" title="Remove">\u00D7</button>`;

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing) removeFile(index); });

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing ? null : () => removeFile(index));
    }
  });

  return el;
}

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all['video-compressor'] || {};
    if (s.crf) { crfSlider.value = s.crf; crfValue.textContent = s.crf; }
    if (s.preset) preset.value = s.preset;
    if (s.codec) codec.value = s.codec;
    if (s.resolution) resolution.value = s.resolution;
    if (s.customWidth) customWidth.value = s.customWidth;
    if (s.twoPass) twoPassCheck.checked = s.twoPass;
    updateResolutionOptions();
    if (s.outputDir) {
      outputDir = persistedState.outputDir || s.outputDir;
      persistedState.outputDir = outputDir;
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
      all['video-compressor'] = { crf: crfSlider.value, preset: preset.value, codec: codec.value, resolution: resolution.value, customWidth: customWidth.value, twoPass: twoPassCheck.checked, outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('video-compressor', { init, cleanup });

})();
