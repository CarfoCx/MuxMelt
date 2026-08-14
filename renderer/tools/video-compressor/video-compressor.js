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
let cancelRequested = false;
let log = null;
let progressCleanup = null;
let batchStartTime = 0;
let batchTotalFiles = 0;

let dropZone, browseBtn, fileList, compressBtn, clearBtn, openOutputBtn, retryBtn;
let lastOutputDir = persistedState.lastOutputDir || '';
let outputDirBtn, statusText, processingIndicator, etaText;
let footerProgress, footerProgressFill, progressPercent;
let compressionGoal, crfSlider, crfValue, preset, resolution, codec, customWidth, twoPassCheck;
let applyingCompressionGoal = false;
let _pasteHandler = null;

async function init(ctx) {
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
  compressionGoal = document.getElementById('compressionGoal');
  crfSlider = document.getElementById('crfSlider');
  crfValue = document.getElementById('crfValue');
  preset = document.getElementById('preset');
  resolution = document.getElementById('resolution');
  codec = document.getElementById('codec');
  customWidth = document.getElementById('customWidth');
  twoPassCheck = document.getElementById('twoPassCheck');

  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  await loadToolSettings();
  bindEvents();
  _pasteHandler = (e) => { if (window.isToolActive('video-compressor') && e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
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
  compressionGoal.addEventListener('change', () => {
    applyCompressionGoal(compressionGoal.value);
    saveToolSettings();
  });

  crfSlider.addEventListener('input', () => {
    crfValue.textContent = crfSlider.value;
    markCompressionGoalCustom();
    saveToolSettings();
  });

  preset.addEventListener('change', () => { markCompressionGoalCustom(); saveToolSettings(); });
  codec.addEventListener('change', () => { markCompressionGoalCustom(); saveToolSettings(); });
  resolution.addEventListener('change', () => {
    updateCustomWidthState();
    saveToolSettings();
  });
  customWidth.addEventListener('change', () => {
    updateCustomWidthState();
    saveToolSettings();
  });
  twoPassCheck.addEventListener('change', () => { markCompressionGoalCustom(); saveToolSettings(); });

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      persistedState.outputDir = outputDir;
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
    if (isProcessing) return;
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
    if (isProcessing) return;
    const paths = await window.api.system.selectFiles({ title: 'Select Videos', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  const browseFolderBtn = document.getElementById('browseFolderBtn');
  if (browseFolderBtn) {
    browseFolderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isProcessing) return;
      if (statusText) statusText.textContent = 'Scanning folder...';
      const paths = await window.api.system.selectFolder();
      if (paths.length > 0) addFiles(paths);
      else log('No supported files found in folder', 'warn');
      if (statusText) statusText.textContent = 'Waiting for Video';
    });
  }

  dropZone.addEventListener('click', async (e) => {
    if (isProcessing) return;
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
    cancelRequested = true;
    compressBtn.disabled = true;
    compressBtn.textContent = 'Cancelling...';
    try { await window.api.tools.videoCompressor.cancelVideoCompression(); } catch {}
    return;
  }
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;

  const selectedResolution = resolution.value;
  const batchOptions = {
    crf: parseInt(crfSlider.value, 10),
    preset: preset.value,
    resolution: selectedResolution,
    codec: codec.value,
    customWidth: selectedResolution === 'custom' ? parseInt(customWidth.value, 10) || 1280 : undefined,
    twoPass: !!twoPassCheck.checked,
    outputDir
  };

  cancelRequested = false;
  const outputFiles = [];
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

  pending.forEach(f => { f.state = 'queued'; f.progress = 0; f.status = 'Queued...'; });
  persistRuntimeState();
  renderFileList();

  log(`Starting compression: ${pending.length} file(s), codec=${batchOptions.codec}, CRF=${batchOptions.crf}, preset=${batchOptions.preset}, max resolution=${batchOptions.resolution}${batchOptions.resolution === 'custom' ? ' (' + batchOptions.customWidth + 'px)' : ''}${batchOptions.twoPass ? ', two-pass' : ''}`);

  for (const file of pending) {
    if (cancelRequested) break;
    file.state = 'processing';
    file.status = 'Compressing...';
    persistRuntimeState();
    renderFileItem(files.indexOf(file));

    try {
      const result = await window.api.tools.videoCompressor.compressVideo({
        inputPath: file.path,
        ...batchOptions
      });

      if (result && result.success) {
        file.state = 'complete';
        file.progress = 1;
        if (typeof result.output === 'string' && result.output) {
          file.output = result.output;
          outputFiles.push(result.output);
          lastOutputDir = window.getParentDirectory(result.output);
          persistedState.lastOutputDir = lastOutputDir;
        }
        file.status = result.savedPercent ? `Done (${result.savedPercent}% smaller)` : 'Complete';
        log(`Compressed: ${file.name}${result.savedPercent ? ` — ${result.savedPercent}% smaller` : ''}`, 'success');
      } else if (cancelRequested) {
        file.state = 'pending';
        file.status = 'Cancelled — ready to retry';
      } else {
        file.state = 'error';
        file.status = `Error: ${result ? result.error : 'unknown'}`;
        log(`Error [${file.name}]: ${result ? result.error : 'unknown'}`, 'error');
      }
    } catch (err) {
      file.state = cancelRequested ? 'pending' : 'error';
      file.status = cancelRequested ? 'Cancelled — ready to retry' : `Error: ${err.message}`;
      if (!cancelRequested) log(`Error [${file.name}]: ${err.message}`, 'error');
    }
    persistRuntimeState();
    renderFileItem(files.indexOf(file));
    if (cancelRequested) break;
  }

  files.forEach(file => {
    if (file.state === 'queued') {
      file.state = 'pending';
      file.status = cancelRequested ? 'Waiting after cancellation' : 'Waiting for Video';
    }
  });
  renderFileList();

  isProcessing = false;
  persistedState.isProcessing = false;
  if (etaText) etaText.textContent = '';
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  setFooterProgress(0, false);
  compressBtn.textContent = 'Compress';
  compressBtn.classList.remove('btn-cancel');
  compressBtn.disabled = files.filter(f => f.state === 'pending' || f.state === 'error').length === 0;
  processingIndicator.classList.remove('active');
  const completed = pending.filter(f => f.state === 'complete').length;
  const errors = pending.filter(f => f.state === 'error').length;
  const remaining = pending.filter(f => f.state === 'pending' || f.state === 'error').length;
  statusText.textContent = cancelRequested
    ? `Cancelled. ${completed} compressed${remaining ? `, ${remaining} remaining` : ''}`
    : `Done! ${completed} compressed${errors > 0 ? `, ${errors} failed` : ''}`;
  persistedState.statusText = statusText.textContent;
  persistedState.etaText = '';
  if (completed > 0 && lastOutputDir) openOutputBtn.style.display = '';
  if (retryBtn) retryBtn.style.display = errors > 0 ? '' : 'none';
  log(cancelRequested ? 'Compression cancelled' : `Compression finished: ${completed} completed, ${errors} failed`, cancelRequested || errors > 0 ? 'warn' : 'success');
  if (!cancelRequested && window.showCompletionToast) window.showCompletionToast('Compression complete: ' + completed + ' compressed' + (errors > 0 ? ', ' + errors + ' failed' : ''), errors > 0, outputFiles);
  outputFiles.forEach(filePath => { if (window.addRecentFile) window.addRecentFile(filePath); });
  if (!cancelRequested && outputFiles.length > 0 && window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
  persistRuntimeState();
}

function handleProgress(data) {
  if (!isProcessing || !data || typeof data !== 'object') return;
  const idx = files.findIndex(f => f.path === data.file);
  if (idx === -1) return;

  if (data.type === 'progress') {
    const progress = normalizeProgress(data);
    files[idx].progress = progress;
    files[idx].status = typeof data.status === 'string' ? data.status : 'Compressing...';
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
    const error = typeof data.error === 'string' ? data.error : 'Compression failed';
    files[idx].status = `Error: ${error}`;
    files[idx].state = 'error';
    setFooterProgress(0, false);
    log(`Error [${files[idx].name}]: ${error}`, 'error');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
    persistRuntimeState();
  }
  renderFileItem(idx);
}

function normalizeProgress(data) {
  if (Number.isFinite(data.progress)) {
    return Math.max(0, Math.min(1, data.progress));
  }
  if (Number.isFinite(data.percent)) {
    return Math.max(0, Math.min(1, data.percent / 100));
  }
  return 0;
}

const COMPRESSION_GOALS = Object.freeze({
  quick: { crf: '24', preset: 'fast', codec: 'h264', twoPass: false },
  balanced: { crf: '23', preset: 'medium', codec: 'h264', twoPass: false },
  smaller: { crf: '28', preset: 'slow', codec: 'h265', twoPass: false },
  quality: { crf: '19', preset: 'slow', codec: 'h264', twoPass: false }
});

function applyCompressionGoal(goal) {
  const values = COMPRESSION_GOALS[goal];
  if (!values) return;
  applyingCompressionGoal = true;
  crfSlider.value = values.crf;
  crfValue.textContent = values.crf;
  preset.value = values.preset;
  codec.value = values.codec;
  twoPassCheck.checked = values.twoPass;
  applyingCompressionGoal = false;
}

function markCompressionGoalCustom() {
  if (!applyingCompressionGoal && compressionGoal) compressionGoal.value = 'custom';
}

function identifyCompressionGoal() {
  return Object.entries(COMPRESSION_GOALS).find(([, values]) =>
    crfSlider.value === values.crf && preset.value === values.preset &&
    codec.value === values.codec && twoPassCheck.checked === values.twoPass
  )?.[0] || 'custom';
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
  if (isProcessing || !Array.isArray(paths)) return;
  let added = 0;
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const ext = getFileExtension(p);
    if (!VIDEO_EXTS.has(ext)) continue;
    if (files.some(f => f.path === p)) continue;
    try {
      const size = await window.api.system.getFileSize(p);
      const info = await probeVideoInfo(p);
      if (isProcessing) break;
      files.push({ path: p, name: getFileName(p), size, width: info.width, height: info.height, progress: 0, status: 'Waiting for Video', state: 'pending' });
      added++;
    } catch (err) {
      log(`Could not add ${getFileName(p)}: ${err.message}`, 'warn');
    }
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
  if (window.updateQueueSummary) window.updateQueueSummary([], 'video-compressor');
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
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'video-compressor');
}

function renderFileItem(index) {
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'video-compressor');
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
    <button class="file-remove" data-index="${index}" title="Remove" aria-label="Remove ${window.escapeHtml(file.name)}">\u00D7</button>`;

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
    compressionGoal.value = s.goal && (s.goal === 'custom' || COMPRESSION_GOALS[s.goal]) ? s.goal : identifyCompressionGoal();
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
    window.updateSettings(all => {
      all['video-compressor'] = { goal: compressionGoal.value, crf: crfSlider.value, preset: preset.value, codec: codec.value, resolution: resolution.value, customWidth: customWidth.value, twoPass: twoPassCheck.checked, outputDir };
    }).catch(err => log('Could not save settings: ' + err.message, 'warn'));
  }, 300);
}

window.registerTool('video-compressor', { init, cleanup });

})();
