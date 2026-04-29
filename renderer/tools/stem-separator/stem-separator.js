// ============================================================================
// Stem Separator Tool (WebSocket-based, powered by Demucs)
// ============================================================================

(function() {

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);

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

let dropZone, browseBtn, fileList, separateBtn, clearBtn, openOutputBtn, retryBtn;
let outputDirBtn, statusText, processingIndicator, etaText;
let modelSelect, stemCheckboxes, modelDescription;

const MODEL_DESCRIPTIONS = {
  htdemucs: 'Default model. Good balance of quality and speed. Best for most music.',
  htdemucs_ft: 'Fine-tuned version. Highest quality separation but slower. Best for professional use.',
  mdx_extra: 'MDX architecture. Good vocal isolation. Faster than fine-tuned model.'
};
let lastOutputDir = '';
let _pasteHandler = null;

function init(ctx) {
  pythonPort = ctx.pythonPort;
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  fileList = document.getElementById('fileList');
  separateBtn = document.getElementById('separateBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');
  modelSelect = document.getElementById('modelSelect');
  stemCheckboxes = document.getElementById('stemCheckboxes');
  modelDescription = document.getElementById('modelDescription');
  updateModelDescription();

  bindEvents();
  _pasteHandler = (e) => { if (e.detail && e.detail.length > 0) addFilesDirect(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);
  connectWebSocket(pythonPort);
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  loadToolSettings();
  log('Stem Separator ready');
}

function cleanup() {
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// ---- WebSocket ----
function connectWebSocket(port) {
  ws = new WebSocket(`ws://127.0.0.1:${port}/stem-separator/ws`);
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
  if (fileIndex === -1 && data.type !== 'all_complete') return;

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
      files[fileIndex].state = 'complete';
      files[fileIndex].outputs = data.outputs || {};
      const stemNames = Object.keys(data.outputs || {});
      files[fileIndex].status = `Done: ${stemNames.join(', ')}`;
      if (stemNames.length > 0) {
        const firstOutput = data.outputs[stemNames[0]];
        lastOutputDir = firstOutput.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      }
      renderFileItem(fileIndex);
      log(`Separated: ${files[fileIndex].name} -> ${stemNames.join(', ')}`, 'success');
      break;
    case 'error':
      files[fileIndex].progress = 0;
      files[fileIndex].status = `Error: ${data.error}`;
      files[fileIndex].state = data.error === 'Cancelled' ? 'cancelled' : 'error';
      renderFileItem(fileIndex);
      log(`Error [${files[fileIndex].name}]: ${data.error}`, data.error === 'Cancelled' ? 'warn' : 'error');
      break;
    case 'all_complete':
      isProcessing = false;
      if (etaText) etaText.textContent = '';
      processingIndicator.classList.remove('active');
      separateBtn.disabled = false;
      separateBtn.textContent = 'Separate Stems';
      separateBtn.classList.remove('btn-cancel');
      const completed = files.filter(f => f.state === 'complete').length;
      const errors = files.filter(f => f.state === 'error').length;
      const cancelled = files.filter(f => f.state === 'cancelled').length;
      statusText.textContent = `Done! ${completed} separated${errors > 0 ? `, ${errors} failed` : ''}${cancelled > 0 ? `, ${cancelled} cancelled` : ''}`;
      if (lastOutputDir) openOutputBtn.style.display = '';
      if (retryBtn) retryBtn.style.display = (errors > 0 || cancelled > 0) ? '' : 'none';
      log(`Batch finished: ${completed} completed, ${errors} failed`, errors > 0 ? 'warn' : 'success');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      if (window.showCompletionToast) window.showCompletionToast(`Stem separation complete: ${completed} separated${errors > 0 ? `, ${errors} failed` : ''}`, errors > 0);
      if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
      break;
  }
}

function getSelectedStems() {
  const checks = stemCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
  const stems = Array.from(checks).map(c => c.value);
  return stems.length > 0 ? stems : null; // null = all
}

function bindEvents() {
  modelSelect.addEventListener('change', () => { updateModelDescription(); saveToolSettings(); });
  stemCheckboxes.addEventListener('change', () => { saveToolSettings(); });

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.selectOutputDir();
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
    for (const file of e.dataTransfer.files) paths.push(file.path);
    if (paths.length > 0) {
      const resolved = await window.api.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else addFilesDirect(paths);
    }
  });

  const fileFilter = {
    title: 'Select Audio or Video',
    filters: [
      { name: 'Audio & Video', extensions: ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'mp4', 'avi', 'mkv', 'mov', 'webm'] }
    ]
  };

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.selectFiles(fileFilter);
    if (paths.length > 0) addFilesDirect(paths);
  });

  const browseFolderBtn = document.getElementById('browseFolderBtn');
  if (browseFolderBtn) {
    browseFolderBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (statusText) statusText.textContent = 'Scanning folder...';
      const paths = await window.api.selectFolder();
      if (paths.length > 0) addFilesDirect(paths);
      else log('No supported files found in folder', 'warn');
      if (statusText) statusText.textContent = 'Ready';
    });
  }

  dropZone.addEventListener('click', async (e) => {
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.selectFiles(fileFilter);
    if (paths.length > 0) addFilesDirect(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearFiles(); window.clearLog(); openOutputBtn.style.display = 'none'; if (retryBtn) retryBtn.style.display = 'none'; }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.openFolder(lastOutputDir);
  });

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      files.forEach(f => { if (f.state === 'error' || f.state === 'cancelled') { f.state = 'pending'; f.progress = 0; f.status = 'Queued...'; } });
      retryBtn.style.display = 'none';
      renderFileList();
      updateButton();
      separateBtn.click();
    });
  }

  separateBtn.addEventListener('click', () => {
    if (isProcessing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'cancel' }));
        separateBtn.disabled = true;
        separateBtn.textContent = 'Cancelling...';
        log('Cancelling...', 'warn');
        setTimeout(() => {
          if (isProcessing) {
            separateBtn.disabled = false;
            separateBtn.textContent = 'Cancel';
            log('Cancel may not have completed — you can try again', 'warn');
          }
        }, 10000);
      }
      return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Not connected to backend', 'error');
      return;
    }

    const filesToProcess = files
      .filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled')
      .map(f => { f.state = 'pending'; f.progress = 0; f.status = 'Queued...'; return f.path; });
    if (filesToProcess.length === 0) return;

    isProcessing = true;
    batchStartTime = Date.now();
    batchTotalFiles = filesToProcess.length;
    if (etaText) etaText.textContent = 'ETA: calculating...';
    if (retryBtn) retryBtn.style.display = 'none';
    separateBtn.disabled = false;
    separateBtn.textContent = 'Cancel';
    separateBtn.classList.add('btn-cancel');
    processingIndicator.classList.add('active');
    statusText.textContent = `Separating ${filesToProcess.length} file(s)...`;
    renderFileList();

    const stems = getSelectedStems();
    log(`Starting separation: ${filesToProcess.length} file(s), model=${modelSelect.value}, stems=${stems ? stems.join(',') : 'all'}`);

    ws.send(JSON.stringify({
      action: 'separate',
      files: filesToProcess,
      model: modelSelect.value,
      stems: stems,
      output_dir: outputDir
    }));
  });
}

// ---- File management ----
function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }

function isSupported(fp) {
  const ext = getFileExtension(fp);
  return AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

function addFiles(paths) {
  addFilesDirect(paths.filter(p => isSupported(p)));
}

async function addFilesDirect(paths) {
  let added = 0;
  for (const p of paths) {
    if (!isSupported(p)) continue;
    if (files.some(f => f.path === p)) { log(`Skipped duplicate: ${getFileName(p)}`, 'warn'); continue; }
    const ext = getFileExtension(p);
    const type = AUDIO_EXTS.has(ext) ? 'audio' : 'video';
    const size = await window.api.getFileSize(p);
    files.push({ path: p, name: getFileName(p), type, size, progress: 0, status: 'Ready', state: 'pending', outputs: {} });
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
  if (window.updateQueueSummary) window.updateQueueSummary([]);
}

function updateButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled');
  separateBtn.disabled = pending.length === 0 && !isProcessing;
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

  const icon = file.type === 'audio' ? '\u{1F3B5}' : '\u{1F3AC}';
  let progressClass = '';
  if (file.state === 'complete') progressClass = ' complete';
  else if (file.state === 'error' || file.state === 'cancelled') progressClass = ' error';

  let stemBadges = '';
  if (file.state === 'complete' && file.outputs) {
    const rows = Object.entries(file.outputs).map(([s, path]) => {
      const fileUrl = 'file://' + path.replace(/\\/g, '/');
      return `<div class="stem-audio-row">
        <span class="stem-badge">${s}</span>
        <div class="audio-preview">
          <button class="audio-play-btn" data-src="${window.escapeHtml(fileUrl)}" title="Play ${s}">&#9654;</button>
        </div>
      </div>`;
    }).join('');
    stemBadges = `<div class="stem-outputs">${rows}</div>`;
  }

  el.innerHTML = `
    <span class="file-icon">${icon}</span>
    <div class="file-info">
      <div class="file-name" title="${window.escapeHtml(file.path)}">${window.escapeHtml(file.name)}</div>
      <div class="file-status">${window.escapeHtml(file.status)}</div>
      ${stemBadges}
    </div>
    ${file.size ? `<span class="file-size">${window.formatFileSize(file.size)}</span>` : ''}
    <div class="file-progress-bar">
      <div class="file-progress-fill${progressClass}" style="width: ${Math.round(file.progress * 100)}%"></div>
    </div>
    <button class="file-remove" data-index="${index}" title="Remove">\u00D7</button>`;

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing) removeFile(index); });

  // Bind audio preview play/stop buttons
  el.querySelectorAll('.audio-play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const src = btn.getAttribute('data-src');
      // If this button is already playing, stop it
      if (btn._audio && !btn._audio.paused) {
        btn._audio.pause();
        btn._audio.currentTime = 0;
        btn.innerHTML = '&#9654;';
        btn.classList.remove('playing');
        btn._audio = null;
        return;
      }
      // Stop any other playing previews in the file list
      fileList.querySelectorAll('.audio-play-btn.playing').forEach(other => {
        if (other._audio) { other._audio.pause(); other._audio.currentTime = 0; other._audio = null; }
        other.innerHTML = '&#9654;';
        other.classList.remove('playing');
      });
      // Play this one
      const audio = new Audio(src);
      btn._audio = audio;
      btn.innerHTML = '&#9632;';
      btn.classList.add('playing');
      audio.play().catch(() => {
        btn.innerHTML = '&#9654;';
        btn.classList.remove('playing');
        log('Could not play audio preview', 'warn');
      });
      audio.addEventListener('ended', () => {
        btn.innerHTML = '&#9654;';
        btn.classList.remove('playing');
        btn._audio = null;
      });
    });
  });

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing ? null : () => removeFile(index));
    }
  });

  return el;
}

function updateModelDescription() {
  if (modelDescription) {
    modelDescription.textContent = MODEL_DESCRIPTIONS[modelSelect.value] || '';
  }
}

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all['stem-separator'] || {};
    if (s.model) { modelSelect.value = s.model; updateModelDescription(); }
    if (s.stems && Array.isArray(s.stems)) {
      const checks = stemCheckboxes.querySelectorAll('input[type="checkbox"]');
      checks.forEach(c => { c.checked = s.stems.includes(c.value); });
    }
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
      const checks = stemCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
      const stems = Array.from(checks).map(c => c.value);
      all['stem-separator'] = { model: modelSelect.value, stems, outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('stem-separator', { init, cleanup });

})();
