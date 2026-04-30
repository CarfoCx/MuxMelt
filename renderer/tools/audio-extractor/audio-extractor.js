// ============================================================================
// Audio Extractor Tool
// ============================================================================

(function() {

const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);

let files = [];
let outputDir = '';
let isProcessing = false;
let log = null;
let progressCleanup = null;
let batchStartTime = 0;
let batchTotalFiles = 0;

let dropZone, browseBtn, fileList, extractBtn, clearBtn, openOutputBtn, retryBtn;
let outputDirBtn, statusText, processingIndicator, etaText;
let audioFormat, bitrate, sampleRate, normalizeCheck, fadeInInput, fadeOutInput;
let lastOutputDir = '';
let _pasteHandler = null;

function init(ctx) {
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
  audioFormat = document.getElementById('audioFormat');
  bitrate = document.getElementById('bitrate');
  sampleRate = document.getElementById('sampleRate');
  normalizeCheck = document.getElementById('normalizeCheck');
  fadeInInput = document.getElementById('fadeIn');
  fadeOutInput = document.getElementById('fadeOut');
  openOutputBtn = document.getElementById('openOutputBtn');

  bindEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  loadToolSettings();
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
      else log('No supported video files found', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.selectFiles({ title: 'Select Videos', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
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
      if (statusText) statusText.textContent = 'Waiting for Video';
    });
  }

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.selectFiles({ title: 'Select Videos', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; if (retryBtn) retryBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.openFolder(lastOutputDir);
  });

  extractBtn.addEventListener('click', startExtraction);

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      files.forEach(f => { if (f.state === 'error') { f.state = 'pending'; f.progress = 0; f.status = 'Waiting for Video'; } });
      retryBtn.style.display = 'none';
      renderFileList();
      updateButton();
      startExtraction();
    });
  }

  progressCleanup = window.api.onToolProgress((data) => {
    if (data.tool !== 'audio-extractor') return;
    handleProgress(data);
  });
}

async function startExtraction() {
  if (isProcessing) {
    window.api.cancelAudioExtraction();
    extractBtn.textContent = 'Cancelling...';
    extractBtn.disabled = true;
    return;
  }
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;

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

  const srLabel = sampleRate.value ? sampleRate.value + ' Hz' : 'original';
  log(`Starting extraction: ${pending.length} file(s) to ${audioFormat.value.toUpperCase()}, ${bitrate.value}, ${srLabel}${normalizeCheck.checked ? ', normalized' : ''}`);

  for (const file of pending) {
    file.state = 'processing';
    file.progress = 0;
    file.status = 'Extracting...';
    renderFileItem(files.indexOf(file));

    try {
      const result = await window.api.extractAudio({
        inputPath: file.path,
        format: audioFormat.value,
        bitrate: bitrate.value,
        sampleRate: sampleRate.value || null,
        normalize: normalizeCheck.checked,
        fadeIn: parseFloat(fadeInInput.value) || 0,
        fadeOut: parseFloat(fadeOutInput.value) || 0,
        outputDir: outputDir
      });

      if (result && result.success) {
        file.state = 'complete';
        file.progress = 1;
        file.status = 'Complete';
        log(`Extracted: ${file.name}`, 'success');
        if (result.output) lastOutputDir = result.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
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
    renderFileItem(files.indexOf(file));
  }

  isProcessing = false;
  if (etaText) etaText.textContent = '';
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  extractBtn.textContent = 'Extract Audio';
  extractBtn.classList.remove('btn-cancel');
  extractBtn.disabled = files.filter(f => f.state === 'pending' || f.state === 'error').length === 0;
  processingIndicator.classList.remove('active');
  const completed = files.filter(f => f.state === 'complete').length;
  const errors = files.filter(f => f.state === 'error').length;
  statusText.textContent = `Done! ${completed} extracted${errors > 0 ? `, ${errors} failed` : ''}`;
  if (completed > 0 && lastOutputDir) openOutputBtn.style.display = '';
  if (retryBtn) retryBtn.style.display = errors > 0 ? '' : 'none';
  log(`Extraction finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
  if (window.showCompletionToast) window.showCompletionToast('Audio extraction complete: ' + completed + ' extracted' + (errors > 0 ? ', ' + errors + ' failed' : ''), errors > 0);
  if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
}

function handleProgress(data) {
  const idx = files.findIndex(f => f.path === data.file);
  if (idx === -1) return;

  if (data.type === 'progress') {
    files[idx].progress = data.progress;
    files[idx].status = data.status || 'Extracting...';
    files[idx].state = 'processing';
    if (window.setTaskbarProgress) window.setTaskbarProgress(data.progress);
    if (etaText && window.calculateETA) etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, files);
  } else if (data.type === 'complete') {
    files[idx].progress = 1;
    files[idx].status = 'Complete';
    files[idx].state = 'complete';
    log(`Extracted: ${files[idx].name}`, 'success');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  } else if (data.type === 'error') {
    files[idx].progress = 0;
    files[idx].status = `Error: ${data.error}`;
    files[idx].state = 'error';
    log(`Error [${files[idx].name}]: ${data.error}`, 'error');
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  }
  renderFileItem(idx);
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
    const size = await window.api.getFileSize(p);
    files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Waiting for Video', state: 'pending' });
    added++;
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
  statusText.textContent = 'Waiting for Video';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([]);
}

function updateButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  extractBtn.disabled = pending.length === 0 || isProcessing;
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
    window.loadAllSettings().then(all => {
      all['audio-extractor'] = { audioFormat: audioFormat.value, bitrate: bitrate.value, sampleRate: sampleRate.value, normalize: normalizeCheck.checked, fadeIn: parseFloat(fadeInInput.value) || 0, fadeOut: parseFloat(fadeOutInput.value) || 0, outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('audio-extractor', { init, cleanup });

})();
