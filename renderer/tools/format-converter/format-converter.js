// ============================================================================
// Format Converter Tool
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);

let files = [];
let outputDir = '';
let isProcessing = false;
let log = null;
let progressCleanup = null;
let batchStartTime = 0;
let batchTotalFiles = 0;

let dropZone, browseBtn, fileList, convertBtn, clearBtn, openOutputBtn, retryBtn;
let outputDirBtn, statusText, processingIndicator, etaText;
let outputFormat, qualitySlider, qualityValue, keepMetadata;
let lastOutputDir = '';
let _pasteHandler = null;

function init(ctx) {
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  convertBtn = document.getElementById('convertBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');
  outputFormat = document.getElementById('outputFormat');
  qualitySlider = document.getElementById('qualitySlider');
  qualityValue = document.getElementById('qualityValue');
  keepMetadata = document.getElementById('keepMetadata');

  bindEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  loadToolSettings();
  log('Format Converter ready');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function bindEvents() {
  qualitySlider.addEventListener('input', () => {
    qualityValue.textContent = qualitySlider.value;
    saveToolSettings();
  });

  outputFormat.addEventListener('change', () => {
    saveToolSettings();
  });

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
    const paths = await window.api.selectFiles();
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; if (retryBtn) retryBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.openFolder(lastOutputDir);
  });

  convertBtn.addEventListener('click', startConversion);

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      files.forEach(f => { if (f.state === 'error') { f.state = 'pending'; f.progress = 0; f.status = 'Ready'; } });
      retryBtn.style.display = 'none';
      renderFileList();
      updateButton();
      startConversion();
    });
  }

  // Listen for progress
  progressCleanup = window.api.onToolProgress((data) => {
    if (data.tool !== 'format-converter') return;
    handleProgress(data);
  });
}

async function startConversion() {
  if (isProcessing) {
    // Cancel
    convertBtn.disabled = true;
    convertBtn.textContent = 'Cancelling...';
    try { await window.api.cancelFormatConversion && window.api.cancelFormatConversion(); } catch {}
    return;
  }
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error');
  if (pending.length === 0) return;

  isProcessing = true;
  batchStartTime = Date.now();
  batchTotalFiles = pending.length;
  if (etaText) etaText.textContent = 'ETA: calculating...';
  if (retryBtn) retryBtn.style.display = 'none';
  convertBtn.disabled = false;
  convertBtn.textContent = 'Cancel';
  convertBtn.classList.add('btn-cancel');
  processingIndicator.classList.add('active');
  statusText.textContent = `Converting ${pending.length} file(s)...`;

  const targetFmt = outputFormat.value;
  const imageFormats = new Set(['png', 'jpg', 'webp', 'avif', 'tiff']);
  const videoFormats = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov']);
  const targetIsImage = imageFormats.has(targetFmt);
  const targetIsVideo = videoFormats.has(targetFmt);

  log(`Starting conversion: ${pending.length} file(s) to ${targetFmt.toUpperCase()}, quality ${qualitySlider.value}`);

  for (const file of pending) {
    const fileExt = getFileExtension(file.path);
    const fileIsImage = IMAGE_EXTS.has(fileExt);
    const fileIsVideo = VIDEO_EXTS.has(fileExt);

    if (fileIsImage && targetIsVideo) {
      file.state = 'error';
      file.status = 'Cannot convert image to video format';
      log(`Skipped ${file.name}: cannot convert image to video format`, 'warn');
      renderFileItem(files.indexOf(file));
      continue;
    }
    if (fileIsVideo && targetIsImage) {
      file.state = 'error';
      file.status = 'Cannot convert video to image format';
      log(`Skipped ${file.name}: cannot convert video to image format`, 'warn');
      renderFileItem(files.indexOf(file));
      continue;
    }
    file.state = 'processing';
    file.progress = 0;
    file.status = 'Converting...';
    renderFileItem(files.indexOf(file));

    try {
      const result = await window.api.convertFormat({
        inputPath: file.path,
        targetFormat: outputFormat.value,
        quality: parseInt(qualitySlider.value),
        keepMetadata: keepMetadata.checked,
        outputDir: outputDir
      });

      if (result && result.success) {
        file.state = 'complete';
        file.progress = 1;
        file.status = 'Complete';
        if (result.output) lastOutputDir = result.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        log(`Converted: ${file.name}`, 'success');
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
  convertBtn.textContent = 'Convert';
  convertBtn.classList.remove('btn-cancel');
  convertBtn.disabled = files.filter(f => f.state === 'pending' || f.state === 'error').length === 0;
  processingIndicator.classList.remove('active');
  const completed = files.filter(f => f.state === 'complete').length;
  const errors = files.filter(f => f.state === 'error').length;
  statusText.textContent = `Done! ${completed} converted${errors > 0 ? `, ${errors} failed` : ''}`;
  if (completed > 0 && lastOutputDir) openOutputBtn.style.display = '';
  if (retryBtn) retryBtn.style.display = errors > 0 ? '' : 'none';
  log(`Conversion finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
  if (window.showCompletionToast) window.showCompletionToast(`Conversion complete: ${completed} converted${errors > 0 ? `, ${errors} failed` : ''}`, errors > 0);
  if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
}

function handleProgress(data) {
  const idx = files.findIndex(f => f.path === data.file);
  if (idx === -1) return;

  if (data.type === 'progress') {
    files[idx].progress = data.progress;
    files[idx].status = data.status || 'Converting...';
    files[idx].state = 'processing';
    if (window.setTaskbarProgress) window.setTaskbarProgress(data.progress);
    if (etaText && window.calculateETA) etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, files);
  } else if (data.type === 'complete') {
    files[idx].progress = 1;
    files[idx].status = 'Complete';
    files[idx].state = 'complete';
    log(`Converted: ${files[idx].name}`, 'success');
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
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue;
    if (files.some(f => f.path === p)) { log(`Skipped duplicate: ${getFileName(p)}`, 'warn'); continue; }
    const size = await window.api.getFileSize(p);
    files.push({ path: p, name: getFileName(p), size, progress: 0, status: 'Ready', state: 'pending' });
    added++;
  }
  if (added > 0) log(`Added ${added} file(s)`);
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
  convertBtn.disabled = pending.length === 0 || isProcessing;
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

  const ext = getFileExtension(file.path);
  const isImage = IMAGE_EXTS.has(ext);
  const iconHtml = isImage
    ? `<img class="file-thumb" data-path="${window.escapeHtml(file.path)}" src="" alt="">`
    : `<span class="file-icon">\u{1F3AC}</span>`;
  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error') progressClass = ' error';

  el.innerHTML = `
    ${iconHtml}
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}</div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
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
    const s = all['format-converter'] || {};
    if (s.outputFormat) outputFormat.value = s.outputFormat;
    if (s.quality) { qualitySlider.value = s.quality; qualityValue.textContent = s.quality; }
    if (s.keepMetadata != null) keepMetadata.checked = s.keepMetadata;
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
      all['format-converter'] = { outputFormat: outputFormat.value, quality: qualitySlider.value, keepMetadata: keepMetadata.checked, outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('format-converter', { init, cleanup });

})();
