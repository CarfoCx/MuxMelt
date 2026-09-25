// ============================================================================
// Audio Extractor Tool
// ============================================================================

(function() {

const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);

let files = [];
let outputDir = '';
let isProcessing = false;
let cancelRequested = false;
let log = null;
let progressCleanup = null;
let batchStartTime = 0;
let batchTotalFiles = 0;

let dropZone, browseBtn, fileList, extractBtn, clearBtn, openOutputBtn, retryBtn;
let outputDirBtn, statusText, processingIndicator, etaText;
let footerProgress, footerProgressFill, progressPercent;
let audioFormat, bitrate, sampleRate, normalizeCheck, fadeInInput, fadeOutInput;
let lastOutputDir = '';
let _pasteHandler = null;

async function init(ctx) {
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  extractBtn = document.getElementById('extractBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');
  footerProgress = document.getElementById('footerProgress');
  footerProgressFill = document.getElementById('footerProgressFill');
  progressPercent = document.getElementById('progressPercent');
  audioFormat = document.getElementById('audioFormat');
  bitrate = document.getElementById('bitrate');
  sampleRate = document.getElementById('sampleRate');
  normalizeCheck = document.getElementById('normalizeCheck');
  fadeInInput = document.getElementById('fadeIn');
  fadeOutInput = document.getElementById('fadeOut');
  openOutputBtn = document.getElementById('openOutputBtn');

  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  await loadToolSettings();
  bindEvents();
  _pasteHandler = (e) => { if (window.isToolActive('audio-extractor') && e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  log('Audio Extractor initialized');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function bindEvents() {
  audioFormat.addEventListener('change', () => { saveToolSettings(); });
  bitrate.addEventListener('change', () => { saveToolSettings(); });
  sampleRate.addEventListener('change', () => { saveToolSettings(); });
  normalizeCheck.addEventListener('change', () => { saveToolSettings(); });
  fadeInInput.addEventListener('change', () => { saveToolSettings(); });
  fadeOutInput.addEventListener('change', () => { saveToolSettings(); });

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
      if (statusText) statusText.textContent = 'Waiting for video';
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

  extractBtn.addEventListener('click', startExtraction);

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      files.forEach(f => { if (f.state === 'error') { f.state = 'pending'; f.progress = 0; f.status = 'Queued'; } });
      retryBtn.style.display = 'none';
      renderFileList();
      updateButton();
      startExtraction();
    });
  }

  progressCleanup = window.api.tools.onToolProgress((data) => {
    if (data.tool !== 'audio-extractor') return;
    handleProgress(data);
  });
}

async function startExtraction() {
  if (isProcessing) {
    cancelRequested = true;
    extractBtn.textContent = 'Cancelling...';
    extractBtn.disabled = true;
    try { await window.api.tools.audioExtractor.cancelAudioExtraction(); } catch {}
    return;
  }
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;

  const batchOptions = {
    format: audioFormat.value,
    bitrate: bitrate.value,
    sampleRate: sampleRate.value || null,
    normalize: !!normalizeCheck.checked,
    fadeIn: parseFloat(fadeInInput.value) || 0,
    fadeOut: parseFloat(fadeOutInput.value) || 0,
    outputDir
  };

  cancelRequested = false;
  const outputFiles = [];
  isProcessing = true;
  batchStartTime = Date.now();
  batchTotalFiles = pending.length;
  if (etaText) etaText.textContent = 'ETA: calculating...';
  if (retryBtn) retryBtn.style.display = 'none';
  extractBtn.disabled = false;
  extractBtn.textContent = 'Cancel';
  extractBtn.classList.add('btn-cancel');
  processingIndicator.classList.add('active');
  statusText.textContent = `Extracting audio from ${pending.length} file(s)...`;
  setFooterProgress(0, true);

  const srLabel = batchOptions.sampleRate ? batchOptions.sampleRate + ' Hz' : 'original';
  log(`Starting extraction: ${pending.length} file(s) to ${batchOptions.format.toUpperCase()}, ${batchOptions.bitrate}, ${srLabel}${batchOptions.normalize ? ', normalized' : ''}`);

  for (const file of pending) {
    if (cancelRequested) break;
    file.state = 'processing';
    file.progress = 0;
    file.status = 'Extracting...';
    renderFileItem(files.indexOf(file));

    try {
      const result = await window.api.tools.audioExtractor.extractAudio({
        inputPath: file.path,
        ...batchOptions
      });

      if (result && result.success) {
        file.state = 'complete';
        file.progress = 1;
        file.status = 'Complete';
        log(`Extracted: ${file.name}`, 'success');
        if (typeof result.output === 'string' && result.output) {
          file.output = result.output;
          outputFiles.push(result.output);
          lastOutputDir = window.getParentDirectory(result.output);
        }
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
    renderFileItem(files.indexOf(file));
    if (cancelRequested) break;
  }

  isProcessing = false;
  if (etaText) etaText.textContent = '';
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  setFooterProgress(0, false);
  extractBtn.textContent = 'Extract audio';
  extractBtn.classList.remove('btn-cancel');
  updateButton();
  processingIndicator.classList.remove('active');
  const completed = pending.filter(f => f.state === 'complete').length;
  const errors = pending.filter(f => f.state === 'error').length;
  const remaining = pending.filter(f => f.state === 'pending' || f.state === 'error').length;
  statusText.textContent = cancelRequested
    ? `Cancelled. ${completed} extracted${remaining ? `, ${remaining} remaining` : ''}`
    : `Done! ${completed} extracted${errors > 0 ? `, ${errors} failed` : ''}`;
  if (completed > 0 && lastOutputDir) openOutputBtn.style.display = '';
  if (retryBtn) retryBtn.style.display = errors > 0 ? '' : 'none';
  log(cancelRequested ? 'Audio extraction cancelled' : `Extraction finished: ${completed} completed, ${errors} failed`, cancelRequested || errors > 0 ? 'warn' : 'success');
  if (!cancelRequested && window.showCompletionToast) window.showCompletionToast('Audio extraction complete: ' + completed + ' extracted' + (errors > 0 ? ', ' + errors + ' failed' : ''), errors > 0, outputFiles);
  outputFiles.forEach(filePath => { if (window.addRecentFile) window.addRecentFile(filePath); });
  if (!cancelRequested && outputFiles.length > 0 && window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
}

function handleProgress(data) {
  if (!isProcessing || !data || typeof data !== 'object') return;
  const idx = files.findIndex(f => f.path === data.file);
  if (idx === -1) return;

  if (data.type === 'progress') {
    const progress = normalizeProgress(data);
    files[idx].progress = progress;
    files[idx].status = typeof data.status === 'string' ? data.status : 'Extracting...';
    files[idx].state = 'processing';
    statusText.textContent = `${files[idx].name}: ${files[idx].status}`;
    setFooterProgress(progress, true);
    if (window.setTaskbarProgress) window.setTaskbarProgress(progress);
    if (etaText && window.calculateETA) etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, files);
  } else if (data.type === 'complete') {
    files[idx].progress = 1;
    files[idx].status = 'Complete';
    files[idx].state = 'complete';
    setFooterProgress(1, true);
    log(`Extracted: ${files[idx].name}`, 'success');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  } else if (data.type === 'error') {
    files[idx].progress = 0;
    const error = typeof data.error === 'string' ? data.error : 'Extraction failed';
    files[idx].status = `Error: ${error}`;
    files[idx].state = 'error';
    setFooterProgress(0, false);
    log(`Error [${files[idx].name}]: ${error}`, 'error');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
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

function setFooterProgress(progress, visible = true) {
  const pct = Math.max(0, Math.min(1, Number(progress) || 0));
  const label = `${Math.round(pct * 100)}%`;
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
      if (isProcessing) break;
      files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Queued', state: 'pending' });
      added++;
    } catch (err) {
      log(`Could not add ${getFileName(p)}: ${err.message}`, 'warn');
    }
  }
  if (added > 0) log(`Added ${added} video file(s)`);
  renderFileList();
  updateButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function removeFile(index) { files.splice(index, 1); renderFileList(); updateButton(); }

function clearFiles() {
  files = [];
  renderFileList();
  updateButton();
  statusText.textContent = 'Waiting for video';
  setFooterProgress(0, false);
  if (etaText) etaText.textContent = '';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([], 'audio-extractor');
}

function updateButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  extractBtn.disabled = isProcessing ? cancelRequested : pending.length === 0;
}

// ---- Rendering ----
function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">Your files will appear here. Choose files above, drop them here, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    return;
  }
  fileList.innerHTML = '';
  files.forEach((f, i) => fileList.appendChild(createFileElement(f, i)));
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'audio-extractor');
}

function renderFileItem(index) {
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'audio-extractor');
  const existing = fileList.children[index];
  if (!existing) return;
  // Update in place rather than rebuilding the row (and rebinding listeners)
  // on every progress tick.
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
    const s = all['audio-extractor'] || {};
    if (s.audioFormat) audioFormat.value = s.audioFormat;
    if (s.bitrate) bitrate.value = s.bitrate;
    if (s.sampleRate !== undefined) sampleRate.value = s.sampleRate;
    if (s.normalize !== undefined) normalizeCheck.checked = s.normalize;
    if (s.fadeIn !== undefined) fadeInInput.value = s.fadeIn;
    if (s.fadeOut !== undefined) fadeOutInput.value = s.fadeOut;
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
      all['audio-extractor'] = { audioFormat: audioFormat.value, bitrate: bitrate.value, sampleRate: sampleRate.value, normalize: normalizeCheck.checked, fadeIn: parseFloat(fadeInInput.value) || 0, fadeOut: parseFloat(fadeOutInput.value) || 0, outputDir };
    }).catch(err => log('Could not save settings: ' + err.message, 'warn'));
  }, 300);
}

window.registerTool('audio-extractor', { init, cleanup });

})();
