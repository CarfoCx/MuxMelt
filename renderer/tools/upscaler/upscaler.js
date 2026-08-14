// ============================================================================
// Upscaler Tool
// ============================================================================

(function() {

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);

const persistedState = (() => {
  window.__muxmeltToolState = window.__muxmeltToolState || {};
  window.__muxmeltToolState.upscaler = window.__muxmeltToolState.upscaler || {
    files: [],
    scale: 2,
    outputDir: '',
    modelProfile: 'general',
    outputFormat: null,
    statusText: 'Waiting for File',
    etaText: '',
    footerProgress: 0,
    footerProgressVisible: false
  };
  return window.__muxmeltToolState.upscaler;
})();

let files = persistedState.files;
let scale = persistedState.scale || 2;
let outputDir = persistedState.outputDir || '';
let modelProfile = persistedState.modelProfile || 'general';
let ws = null;
let isProcessing = !!persistedState.isProcessing;
let isPreparing = false;
let cancelRequested = false;
let getPythonPort = () => null;
let connectedPythonPort = null;
let pythonToken = null;
let log = null;

// ETA tracking
let batchStartTime = 0;
let batchTotalFiles = 0;
let batchMegapixels = 0;
let batchFilePaths = new Set();

// Reconnection
let reconnectDelay = 1000;
let reconnectAttempts = 0;
let reconnectTimerId = null;
let cancelWatchdog = null;
const MAX_RECONNECT_DELAY = 30000;

// DOM refs (set during init)
let dropZone, browseBtn, browseFolderBtn, fileList, upscaleBtn, clearBtn;
let openOutputBtn, outputDirBtn, statusText, etaText, processingIndicator, retryBtn;
let outputFormat, modelProfileSelect, ffmpegWarning, footerProgress, footerProgressFill;
let overwriteModal, overwriteFileName, overwriteSkipBtn, overwriteAlwaysBtn, overwriteConfirmBtn;
let previewModal, previewOverlay, previewClose, previewContainer;
let previewBefore, previewAfter, previewBeforeClip, previewSlider, previewTitle;

let _pasteHandler = null;
let previewDragging = false;
let _mouseMoveHandler = null;
let _mouseUpHandler = null;
let _keyDownHandler = null;
let _resizeHandler = null;
let previewReturnFocus = null;
let overwriteReturnFocus = null;

function trapDialogFocus(event, dialog) {
  const focusable = Array.from(dialog.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.disabled && element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

async function init(ctx) {
  getPythonPort = typeof ctx.getPythonPort === 'function' ? ctx.getPythonPort : () => ctx.pythonPort;
  pythonToken = ctx.pythonToken;
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
  footerProgress = document.getElementById('footerProgress');
  footerProgressFill = document.getElementById('footerProgressFill');
  outputFormat = document.getElementById('outputFormat');
  modelProfileSelect = document.getElementById('modelProfile');
  ffmpegWarning = document.getElementById('ffmpegWarning');
  overwriteModal = document.getElementById('overwriteModal');
  overwriteFileName = document.getElementById('overwriteFileName');
  overwriteSkipBtn = document.getElementById('overwriteSkipBtn');
  overwriteAlwaysBtn = document.getElementById('overwriteAlwaysBtn');
  overwriteConfirmBtn = document.getElementById('overwriteConfirmBtn');

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

  await loadSettings();
  bindEvents();
  restoreViewState();
  connectWebSocket();

  _pasteHandler = (e) => { if (window.isToolActive('upscaler') && e.detail && e.detail.length > 0) addFiles(e.detail); };
  document.addEventListener('paste-files', _pasteHandler);

  if (!persistedState.initialized) {
    log('Upscaler initialized');
    persistedState.initialized = true;
  }
}

function cleanup() {
  persistRuntimeState();
  if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  connectedPythonPort = null;
  if (_pasteHandler) { document.removeEventListener('paste-files', _pasteHandler); _pasteHandler = null; }
  if (_mouseMoveHandler) document.removeEventListener('mousemove', _mouseMoveHandler);
  if (_mouseUpHandler) document.removeEventListener('mouseup', _mouseUpHandler);
  if (_keyDownHandler) document.removeEventListener('keydown', _keyDownHandler);
  if (_resizeHandler) window.removeEventListener('resize', _resizeHandler);
}

function persistRuntimeState() {
  persistedState.files = files;
  persistedState.scale = scale;
  persistedState.outputDir = outputDir;
  persistedState.modelProfile = modelProfile;
  persistedState.outputFormat = outputFormat ? outputFormat.value : persistedState.outputFormat;
  persistedState.statusText = statusText ? statusText.textContent : persistedState.statusText;
  persistedState.etaText = etaText ? etaText.textContent : persistedState.etaText;
  persistedState.isProcessing = isProcessing;
}

function restoreViewState() {
  if (outputFormat) outputFormat.value = persistedState.outputFormat || outputFormat.value;
  if (modelProfileSelect) modelProfileSelect.value = modelProfile;
  if (statusText) statusText.textContent = persistedState.statusText || 'Waiting for File';
  if (etaText) etaText.textContent = persistedState.etaText || '';
  setFooterProgress(persistedState.footerProgress || 0, !!persistedState.footerProgressVisible);
  if (processingIndicator) processingIndicator.classList.toggle('active', isProcessing);
  if (upscaleBtn) {
    upscaleBtn.textContent = isProcessing ? 'Cancel' : 'Upscale';
    upscaleBtn.classList.toggle('btn-cancel', isProcessing);
  }
  renderFileList();
  setBusyControls(isProcessing || isPreparing);
  updateUpscaleButton();
  if (retryBtn) {
    const retryable = files.some(f => f.state === 'error' || f.state === 'cancelled');
    retryBtn.style.display = retryable ? '' : 'none';
  }
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function setFooterProgress(progress, visible = true) {
  const pct = Math.max(0, Math.min(1, Number(progress) || 0));
  persistedState.footerProgress = pct;
  persistedState.footerProgressVisible = visible;
  if (footerProgress) footerProgress.classList.toggle('active', visible);
  if (footerProgressFill) footerProgressFill.style.width = `${Math.round(pct * 100)}%`;
}

function isNoisyProgressLog(message) {
  if (typeof message !== 'string') return false;
  return /\b\d{1,3}%\b/.test(message) && /download|upscal|process|frame|tile/i.test(message);
}

// ---- Settings ----
async function loadSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all.upscaler || {};
    if (s.scale) {
      scale = s.scale;
      persistedState.scale = scale;
      document.querySelectorAll('.scale-btn').forEach(b => {
        const active = parseInt(b.dataset.scale) === scale;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    }
    if (s.outputFormat && !persistedState.outputFormat) {
      outputFormat.value = s.outputFormat;
      persistedState.outputFormat = s.outputFormat;
    }
    if (persistedState.outputFormat) outputFormat.value = persistedState.outputFormat;
    if (s.modelProfile) { modelProfile = persistedState.modelProfile || s.modelProfile; modelProfileSelect.value = modelProfile; }
    if (s.outputDir) {
      outputDir = persistedState.outputDir || s.outputDir;
      persistedState.outputDir = outputDir;
      const parts = outputDir.replace(/\\/g, '/').split('/');
      const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : outputDir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = outputDir;
    }
    if (!outputDir && window.applyDefaultOutputDir) {
      outputDir = window.applyDefaultOutputDir(outputDirBtn);
      persistedState.outputDir = outputDir;
    }
  } catch {}
}

let _saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(_saveSettingsTimer);
  _saveSettingsTimer = setTimeout(() => {
    window.updateSettings(all => {
      all.upscaler = { scale, outputFormat: outputFormat.value, modelProfile, outputDir };
    }).catch(err => log('Could not save settings: ' + err.message, 'warn'));
  }, 300);
}

// ---- ffmpeg check ----
async function checkFfmpeg() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`http://127.0.0.1:${getPythonPort()}/health?token=${encodeURIComponent(pythonToken || '')}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Health request failed (${response.status})`);
    const data = await response.json();
    if (!data.ffmpeg) {
      ffmpegWarning.style.display = 'flex';
      log('ffmpeg not found - video upscaling disabled', 'warn');
    } else {
      ffmpegWarning.style.display = 'none';
    }
  } catch {
    // Connection state is handled by the WebSocket/reconnect UI.
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Event binding ----
function bindEvents() {
  // Scale buttons
  document.querySelectorAll('.scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isProcessing || isPreparing) return;
      document.querySelectorAll('.scale-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      scale = parseInt(btn.dataset.scale);
      persistedState.scale = scale;
      if (modelProfile === 'anime' && scale === 2) {
        log('Note: Anime 2x uses the same model as General 2x', 'info');
      }
      refreshIdleStatus();
      saveSettings();
    });
  });

  modelProfileSelect.addEventListener('change', () => {
    if (isProcessing || isPreparing) return;
    modelProfile = modelProfileSelect.value;
    persistedState.modelProfile = modelProfile;
    if (modelProfile === 'anime' && scale === 2) {
      log('Note: Anime 2x uses the same model as General 2x (no anime-specific 2x model exists)', 'info');
    }
    refreshIdleStatus();
    saveSettings();
  });

  outputFormat.addEventListener('change', () => {
    if (isProcessing || isPreparing) return;
    persistedState.outputFormat = outputFormat.value;
    saveSettings();
  });

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing || isPreparing) return;
    const dir = await window.api.system.selectOutputDir();
    if (isProcessing || isPreparing) return;
    if (dir) {
      outputDir = dir;
      persistedState.outputDir = outputDir;
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
    if (isProcessing || isPreparing) return;
    const paths = [];
    for (const file of e.dataTransfer.files) paths.push(window.api.system.getPathForFile(file));
    if (paths.length > 0) {
      const resolved = await window.api.system.resolveDroppedPaths(paths);
      if (resolved.length > 0) addFiles(resolved);
      else log('No supported files found in dropped items', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isProcessing || isPreparing) return;
    const paths = await window.api.system.selectFiles();
    if (paths.length > 0) addFiles(paths);
  });

  browseFolderBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isProcessing || isPreparing) return;
    if (statusText) statusText.textContent = 'Scanning folder...';
    const paths = await window.api.system.selectFolder();
    if (isProcessing || isPreparing) return;
    if (paths.length > 0) addFiles(paths);
    else log('No supported files found in folder', 'warn');
    if (statusText) statusText.textContent = 'Waiting for File';
  });

  dropZone.addEventListener('click', async (e) => {
    if (isProcessing || isPreparing) return;
    if (dropZone.classList.contains('collapsed')) { dropZone.classList.remove('collapsed'); return; }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseFolderBtn') return;
    const paths = await window.api.system.selectFiles();
    if (paths.length > 0) addFiles(paths);
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing && !isPreparing) { clearFiles(); window.clearLog(); }
  });

  openOutputBtn.addEventListener('click', () => {
    if (outputDir) { window.api.system.openFolder(outputDir); }
    else if (files.length > 0 && files[0].output) {
      const dir = window.getParentDirectory(files[0].output);
      window.api.system.openFolder(dir);
    } else if (files.length > 0) {
      const dir = window.getParentDirectory(files[0].path);
      window.api.system.openFolder(dir);
    }
  });

  upscaleBtn.addEventListener('click', async () => {
    if (isProcessing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        cancelRequested = true;
        try { ws.send(JSON.stringify({ action: 'cancel' })); }
        catch (err) {
          cancelRequested = false;
          log(`Could not request cancellation: ${err.message}`, 'error');
          return;
        }
        upscaleBtn.disabled = true;
        upscaleBtn.textContent = 'Cancelling...';
        log('Cancelling...', 'warn');
        if (cancelWatchdog) clearTimeout(cancelWatchdog);
        cancelWatchdog = setTimeout(() => {
          cancelWatchdog = null;
          if (isProcessing) {
            upscaleBtn.disabled = false;
            upscaleBtn.textContent = 'Cancel';
            log('Cancel may not have completed — you can try again', 'warn');
          }
        }, 10000);
      }
      return;
    }
    if (isPreparing) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    isPreparing = true;
    setBusyControls(true);
    const batchConfig = {
      scale,
      outputFormat: outputFormat.value,
      outputDir,
      profile: modelProfile
    };
    const pendingFiles = files.filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled');
    const filesToProcess = [];
    for (const file of pendingFiles) {
      const targetPath = getOutputPath(file.path, batchConfig);
      const conflictChoice = await confirmExistingOutput(targetPath);
      if (!conflictChoice || !conflictChoice.proceed) {
        file.state = 'cancelled';
        file.progress = 0;
        file.status = 'Skipped: output exists';
        log(`Skipped ${file.name}: output already exists`, 'warn');
        renderFileItem(files.indexOf(file));
        continue;
      }
      file.state = 'pending';
      file.progress = 0;
      file.status = 'Queued...';
      filesToProcess.push(file.path);
    }
    if (filesToProcess.length === 0) {
      isPreparing = false;
      setBusyControls(false);
      renderFileList();
      updateUpscaleButton();
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      isPreparing = false;
      setBusyControls(false);
      renderFileList();
      updateUpscaleButton();
      log('Backend disconnected before the upscale could start', 'error');
      return;
    }

    isPreparing = false;
    cancelRequested = false;
    if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
    isProcessing = true;
    persistedState.isProcessing = true;
    batchStartTime = Date.now();
    batchTotalFiles = filesToProcess.length;
    batchMegapixels = 0;
    batchFilePaths = new Set(filesToProcess);
    upscaleBtn.disabled = false;
    upscaleBtn.textContent = 'Cancel';
    upscaleBtn.classList.add('btn-cancel');
    processingIndicator.classList.add('active');
    statusText.textContent = `Processing ${filesToProcess.length} file(s)...`;
    etaText.textContent = 'ETA: calculating...';
    setFooterProgress(0, true);
    persistRuntimeState();
    renderFileList();

    log(`Starting upscale: ${filesToProcess.length} file(s), ${batchConfig.scale}x, profile=${batchConfig.profile}, format=${batchConfig.outputFormat}`);
    try {
      ws.send(JSON.stringify({
        action: 'upscale', files: filesToProcess, scale: batchConfig.scale, output_format: batchConfig.outputFormat,
        output_dir: batchConfig.outputDir, profile: batchConfig.profile
      }));
    } catch (err) {
      isProcessing = false;
      persistedState.isProcessing = false;
      files.filter(file => batchFilePaths.has(file.path)).forEach(file => {
        file.state = 'pending';
        file.status = 'Ready to retry';
      });
      processingIndicator.classList.remove('active');
      setBusyControls(false);
      upscaleBtn.textContent = 'Upscale';
      upscaleBtn.classList.remove('btn-cancel');
      statusText.textContent = 'Could not start upscaling';
      setFooterProgress(0, false);
      renderFileList();
      updateUpscaleButton();
      persistRuntimeState();
      log(`Could not start upscaling: ${err.message}`, 'error');
    }
  });

  // ffmpeg link
  document.getElementById('ffmpegLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.system.openExternal('https://ffmpeg.org/download.html');
  });

  // Retry failed
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (isProcessing || isPreparing) return;
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
  previewSlider.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const current = Number(previewSlider.getAttribute('aria-valuenow')) || 50;
    setPreviewPosition(e.key === 'Home' ? 2 : e.key === 'End' ? 98 : current + (e.key === 'ArrowRight' ? 5 : -5));
  });

  _mouseMoveHandler = (e) => {
    if (!previewDragging) return;
    const rect = previewContainer.getBoundingClientRect();
    let x = (e.clientX - rect.left) / rect.width;
    x = Math.max(0.02, Math.min(0.98, x));
    setPreviewPosition(x * 100);
  };
  document.addEventListener('mousemove', _mouseMoveHandler);

  _mouseUpHandler = () => { previewDragging = false; };
  document.addEventListener('mouseup', _mouseUpHandler);

  _keyDownHandler = (e) => {
    if (!previewModal.classList.contains('active')) return;
    if (e.key === 'Escape') closePreview();
    if (e.key === 'Tab') trapDialogFocus(e, previewModal.querySelector('.preview-dialog'));
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
function connectWebSocket() {
  const port = getPythonPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  connectedPythonPort = port;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(pythonToken || '')}`);
  ws.onopen = () => {
    reconnectDelay = 1000; reconnectAttempts = 0;
    reconnectTimerId = null;
    // Removed technical logs
    // Request initial data if needed
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
    if (!statusText) return; // tool was unloaded
    if (isProcessing) {
      isProcessing = false;
      persistedState.isProcessing = false;
      processingIndicator.classList.remove('active');
      setBusyControls(false);
      upscaleBtn.textContent = 'Upscale';
      upscaleBtn.classList.remove('btn-cancel');
      files.forEach(file => {
        if (file.state === 'processing') {
          file.state = 'error';
          file.status = 'Connection lost — ready to retry';
        }
      });
      renderFileList();
      updateUpscaleButton();
      persistRuntimeState();
    }
    statusText.textContent = 'Disconnected - reconnecting...';
    reconnectAttempts++;
    const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`WebSocket disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s...`, 'warn');
    if (reconnectAttempts > 0 && reconnectAttempts % 5 === 0) {
      // Only restart the backend if it's genuinely unreachable. If /health
      // still answers, the process is alive and the WebSocket is being refused
      // for some other reason (auth/origin) — restarting just churns the GPU
      // and reloads models for nothing.
      backendReachable().then(reachable => {
        if (reachable) {
          log('Backend is running but the live connection keeps failing — not restarting. Retrying...', 'error');
          if (statusText) statusText.textContent = 'Connection refused by backend';
        } else {
          log('Backend appears down, restarting Python...', 'warn');
          window.api.python.restartPython().then(r => {
            log(r.success ? 'Python backend restarted' : `Failed to restart: ${r.error}`, r.success ? 'success' : 'error');
          });
        }
      });
    }
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

function backendReachable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  return fetch(`http://127.0.0.1:${getPythonPort()}/health?token=${encodeURIComponent(pythonToken || '')}`, { signal: controller.signal })
    .then(r => r.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timeout));
}

function handleWSMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  if (data.type === 'log') {
    if (typeof data.message === 'string' && !isNoisyProgressLog(data.message)) log(data.message, data.level || 'info');
    return;
  }
  if (data.type === 'model_loading') {
    const message = typeof data.message === 'string' ? data.message : 'Loading model...';
    log(message);
    statusText.textContent = message;
    setFooterProgress(0, true);
    persistRuntimeState();
    return;
  }
  if (data.type === 'model_progress') {
    const pct = normalizeProgress(data.progress, persistedState.footerProgress);
    statusText.textContent = typeof data.status === 'string' ? data.status : 'Loading model...';
    setFooterProgress(pct, true);
    persistRuntimeState();
    return;
  }
  if (data.type === 'model_loaded') { log('Model loaded', 'success'); setFooterProgress(0, false); return; }

  const fileIndex = files.findIndex(f => f.path === data.file);
  if (fileIndex === -1 && data.type !== 'all_complete' && data.type !== 'fatal_error') return;
  const fname = fileIndex >= 0 ? files[fileIndex].name : '';

  switch (data.type) {
    case 'progress':
      files[fileIndex].progress = normalizeProgress(data.progress);
      files[fileIndex].status = typeof data.status === 'string' ? data.status : 'Processing...';
      if (files[fileIndex].state !== 'processing') log(`Processing: ${fname}`);
      files[fileIndex].state = 'processing';
      statusText.textContent = `${fname}: ${files[fileIndex].status}`;
      setFooterProgress(files[fileIndex].progress, true);
      renderFileItem(fileIndex);
      updateETA();
      persistRuntimeState();
      if (window.setTaskbarProgress) window.setTaskbarProgress(files[fileIndex].progress);
      break;
    case 'complete':
      files[fileIndex].progress = 1;
      files[fileIndex].status = 'Complete';
      files[fileIndex].state = 'complete';
      files[fileIndex].output = typeof data.output === 'string' ? data.output : '';
      setFooterProgress(1, true);
      renderFileItem(fileIndex);
      const outName = files[fileIndex].output ? files[fileIndex].output.replace(/\\/g, '/').split('/').pop() : fname;
      const tput = formatThroughput(data.megapixels, data.elapsed);
      if (typeof data.megapixels === 'number') batchMegapixels += data.megapixels;
      log(`Complete: ${fname} \u2192 ${outName}${tput ? ` (${tput})` : ''}`, 'success');
      if (files[fileIndex].output && window.addRecentFile) window.addRecentFile(files[fileIndex].output);
      updateETA();
      persistRuntimeState();
      break;
    case 'error':
      data.error = typeof data.error === 'string' ? data.error : 'Upscaling failed';
      files[fileIndex].progress = 0;
      files[fileIndex].status = `Error: ${data.error}`;
      files[fileIndex].state = data.error === 'Cancelled' ? 'cancelled' : 'error';
      setFooterProgress(0, false);
      renderFileItem(fileIndex);
      log(data.error === 'Cancelled' ? `Cancelled: ${fname}` : `Error [${fname}]: ${data.error}`, data.error === 'Cancelled' ? 'warn' : 'error');
      updateETA();
      persistRuntimeState();
      break;
    case 'all_complete':
      if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
      isProcessing = false;
      persistedState.isProcessing = false;
      processingIndicator.classList.remove('active');
      setBusyControls(false);
      upscaleBtn.textContent = 'Upscale';
      upscaleBtn.classList.remove('btn-cancel');
      etaText.textContent = '';
      setFooterProgress(0, false);
      const batchFiles = files.filter(file => batchFilePaths.has(file.path));
      const completed = batchFiles.filter(f => f.state === 'complete').length;
      const errors = batchFiles.filter(f => f.state === 'error').length;
      const cancelled = batchFiles.filter(f => f.state === 'cancelled').length;
      const outputs = batchFiles.filter(f => f.state === 'complete' && typeof f.output === 'string' && f.output).map(f => f.output);
      let parts = [`${completed} completed`];
      if (errors > 0) parts.push(`${errors} failed`);
      if (cancelled > 0) parts.push(`${cancelled} cancelled`);
      const batchElapsed = (Date.now() - batchStartTime) / 1000;
      const batchTput = formatThroughput(batchMegapixels, batchElapsed);
      statusText.textContent = `${cancelRequested ? 'Cancelled.' : 'Done!'} ${parts.join(', ')}${batchTput ? ` · ${batchTput}` : ''}`;
      persistedState.statusText = statusText.textContent;
      persistedState.etaText = '';
      log(cancelRequested ? `Upscale cancelled: ${parts.join(', ')}` : `Batch finished: ${parts.join(', ')}`, cancelRequested || errors > 0 ? 'warn' : 'success');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      if (!cancelRequested && window.showCompletionToast) {
        window.showCompletionToast(`Upscale complete: ${parts.join(', ')}`, errors > 0, outputs);
      }
      if (retryBtn) retryBtn.style.display = errors > 0 || cancelled > 0 ? '' : 'none';
      if (!cancelRequested && outputs.length > 0 && window.autoOpenOutputIfEnabled) {
        const completedDir = outputs[0] ? window.getParentDirectory(outputs[0]) : '';
        window.autoOpenOutputIfEnabled(outputDir || completedDir);
      }
      updateUpscaleButton();
      persistRuntimeState();
      break;
    case 'fatal_error':
      if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
      isProcessing = false;
      persistedState.isProcessing = false;
      processingIndicator.classList.remove('active');
      setBusyControls(false);
      upscaleBtn.textContent = 'Upscale';
      upscaleBtn.classList.remove('btn-cancel');
      etaText.textContent = '';
      setFooterProgress(0, false);
      data.error = typeof data.error === 'string' ? data.error : 'Upscaling failed';
      statusText.textContent = `Fatal error: ${data.error}`;
      persistRuntimeState();
      log(`Fatal: ${data.error}`, 'error');
      if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
      updateUpscaleButton();
      break;
  }
}

function normalizeProgress(value, fallback = 0) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return Math.max(0, Math.min(1, Number(fallback) || 0));
  return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
}

// ---- ETA ----
function updateETA() {
  if (!isProcessing || batchTotalFiles === 0) { etaText.textContent = ''; persistedState.etaText = ''; return; }
  const elapsed = (Date.now() - batchStartTime) / 1000;
  if (elapsed < 2) { etaText.textContent = 'ETA: calculating...'; persistedState.etaText = etaText.textContent; return; }
  const batchFiles = files.filter(file => batchFilePaths.has(file.path));
  const completedFiles = batchFiles.filter(f => f.state === 'complete' || f.state === 'error' || f.state === 'cancelled').length;
  const current = batchFiles.find(f => f.state === 'processing');
  const effectiveCompleted = completedFiles + (current ? current.progress : 0);
  if (effectiveCompleted < 0.05) { etaText.textContent = 'ETA: calculating...'; persistedState.etaText = etaText.textContent; return; }
  const remaining = batchTotalFiles - effectiveCompleted;
  const eta = Math.max(0, Math.round((elapsed / effectiveCompleted) * remaining));
  etaText.textContent = `ETA: ${formatDuration(eta)}`;
  persistedState.etaText = etaText.textContent;
}

function formatDuration(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// "12.3 MP/s" style throughput, or '' when we don't have usable numbers.
function formatThroughput(megapixels, elapsed) {
  if (typeof megapixels !== 'number' || typeof elapsed !== 'number') return '';
  if (megapixels <= 0 || elapsed <= 0) return '';
  const mps = megapixels / elapsed;
  return mps >= 10 ? `${mps.toFixed(0)} MP/s` : `${mps.toFixed(1)} MP/s`;
}

// Human label for the active model + scale, e.g. "General · 2x".
function activeConfigLabel() {
  const profileLabel = modelProfile === 'anime' ? 'Anime' : 'General';
  return `${profileLabel} · ${scale}x`;
}

// When idle, keep the status line reflecting the active model/scale so the
// user can see what the next run will use. Never clobbers a processing or
// finished-batch ("Done!") status.
function refreshIdleStatus() {
  if (isProcessing || !statusText) return;
  if (statusText.textContent.startsWith('Done!')) return;
  statusText.textContent = files.length > 0 ? `Ready · ${activeConfigLabel()}` : 'Waiting for File';
  persistedState.statusText = statusText.textContent;
}

// ---- File management ----
function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }
function isImage(fp) { return IMAGE_EXTS.has(getFileExtension(fp)); }

function getOutputPath(inputPath, config = { scale, outputFormat: outputFormat.value, outputDir }) {
  const normalized = inputPath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const sourceDir = slashIndex >= 0 ? inputPath.slice(0, slashIndex) : '';
  const name = getFileName(inputPath);
  const dotIndex = name.lastIndexOf('.');
  const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const inputExt = getFileExtension(inputPath);
  const outExt = config.outputFormat === 'same' ? inputExt : `.${config.outputFormat}`;
  const outDir = config.outputDir || sourceDir;
  const separator = outDir.includes('\\') ? '\\' : '/';
  return `${outDir}${outDir.endsWith('\\') || outDir.endsWith('/') ? '' : separator}${baseName}_${config.scale}x${outExt}`;
}

async function confirmExistingOutput(filePath) {
  try {
    if (!await window.api.system.pathExists(filePath)) return { proceed: true };
  } catch (err) {
    log(`Could not check output path: ${err.message}`, 'error');
    return { proceed: false };
  }

  try {
    const all = await window.loadAllSettings();
    if (all.global && all.global.skipOverwriteConfirm) return { proceed: true };
  } catch {}

  return new Promise((resolve) => {
    const finish = async (result) => {
      overwriteModal.classList.remove('active');
      overwriteModal.setAttribute('aria-hidden', 'true');
      overwriteSkipBtn.removeEventListener('click', onSkip);
      overwriteAlwaysBtn.removeEventListener('click', onAlways);
      overwriteConfirmBtn.removeEventListener('click', onCreateCopy);
      document.removeEventListener('keydown', onKeyDown);
      if (overwriteReturnFocus?.isConnected) overwriteReturnFocus.focus();
      overwriteReturnFocus = null;

      if (result.always) {
        try {
          await window.updateSettings(all => {
            all.global = all.global || {};
            all.global.skipOverwriteConfirm = true;
          });
        } catch {}
      }

      resolve({ proceed: result.proceed });
    };

    const onSkip = () => finish({ proceed: false });
    const onAlways = () => finish({ proceed: true, always: true });
    const onCreateCopy = () => finish({ proceed: true });
    const onKeyDown = (e) => {
      if (e.key === 'Escape') finish({ proceed: false });
      if (e.key === 'Enter') finish({ proceed: true });
      if (e.key === 'Tab') trapDialogFocus(e, overwriteModal.querySelector('.upscaler-overwrite-dialog'));
    };

    overwriteReturnFocus = document.activeElement;
    overwriteFileName.textContent = getFileName(filePath);
    overwriteFileName.title = filePath;
    overwriteSkipBtn.addEventListener('click', onSkip);
    overwriteAlwaysBtn.addEventListener('click', onAlways);
    overwriteConfirmBtn.addEventListener('click', onCreateCopy);
    document.addEventListener('keydown', onKeyDown);
    overwriteModal.classList.add('active');
    overwriteModal.setAttribute('aria-hidden', 'false');
    overwriteConfirmBtn.focus();
  });
}

async function addFiles(paths) {
  if (isProcessing || isPreparing || !Array.isArray(paths)) return;
  let added = 0;
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const ext = getFileExtension(p);
    let type = null;
    if (IMAGE_EXTS.has(ext)) type = 'image';
    else if (VIDEO_EXTS.has(ext)) type = 'video';
    else continue;
    if (files.some(f => f.path === p)) { log(`Skipped duplicate: ${getFileName(p)}`, 'warn'); continue; }
    try {
      const size = await window.api.system.getFileSize(p);
      if (isProcessing || isPreparing) break;
      files.push({ path: p, name: getFileName(p), type, size, progress: 0, status: 'Waiting for File', state: 'pending', output: null });
      added++;
    } catch (err) {
      log(`Could not add ${getFileName(p)}: ${err.message}`, 'warn');
    }
  }
  if (added > 0) log(`Added ${added} file(s)`);
  persistedState.files = files;
  refreshIdleStatus();
  persistedState.statusText = statusText ? statusText.textContent : persistedState.statusText;
  renderFileList();
  updateUpscaleButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function removeFile(index) {
  if (isProcessing || isPreparing) return;
  files.splice(index, 1);
  persistedState.files = files;
  renderFileList();
  updateUpscaleButton();
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, files.length);
}

function clearFiles() {
  if (isProcessing || isPreparing) return;
  files = [];
  persistedState.files = files;
  persistedState.statusText = 'Waiting for File';
  persistedState.etaText = '';
  persistedState.isProcessing = false;
  renderFileList();
  updateUpscaleButton();
  statusText.textContent = 'Waiting for File';
  etaText.textContent = '';
  setFooterProgress(0, false);
  if (retryBtn) retryBtn.style.display = 'none';
  if (window.updateDropZoneCollapse) window.updateDropZoneCollapse(dropZone, 0);
  if (window.updateQueueSummary) window.updateQueueSummary([], 'upscaler');
}

// ---- Rendering ----
function renderFileList() {
  if (files.length === 0) {
    fileList.innerHTML = '<div class="empty-state">No files added. Drag files here, browse, or press <span class="shortcut-hint">Ctrl+O</span></div>';
    if (window.updateQueueSummary) window.updateQueueSummary([], 'upscaler');
    return;
  }
  fileList.innerHTML = '';
  files.forEach((f, i) => fileList.appendChild(createFileElement(f, i)));
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'upscaler');
}

function renderFileItem(index) {
  if (window.updateQueueSummary) window.updateQueueSummary(files, 'upscaler');
  const existing = fileList.children[index];
  if (!existing) return;
  updateFileElement(existing, files[index]);
}

function updateFileElement(el, file) {
  el.classList.toggle('file-previewable', file.state === 'complete' && file.type === 'image');

  const status = el.querySelector('.file-status');
  if (status) {
    status.textContent = file.status;
    status.classList.toggle('cancelled', file.state === 'cancelled');
  }

  const fill = el.querySelector('.file-progress-fill');
  if (fill) {
    fill.style.width = `${Math.round(file.progress * 100)}%`;
    fill.classList.toggle('complete', file.state === 'complete');
    fill.classList.toggle('error', file.state === 'error' || file.state === 'cancelled');
  }

  let previewBtn = el.querySelector('.file-preview-btn');
  if (file.state === 'complete' && file.type === 'image') {
    if (!previewBtn) {
      previewBtn = document.createElement('button');
      previewBtn.className = 'file-preview-btn';
      previewBtn.title = 'Preview';
      previewBtn.textContent = '\u{1F50D}';
      previewBtn.addEventListener('click', (e) => { e.stopPropagation(); openPreview(file); });
      const removeBtn = el.querySelector('.file-remove');
      el.insertBefore(previewBtn, removeBtn);
    }
  } else if (previewBtn) {
    previewBtn.remove();
  }
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

  el.querySelector('.file-remove').addEventListener('click', (e) => { e.stopPropagation(); if (!isProcessing && !isPreparing) removeFile(index); });
  const prevBtn = el.querySelector('.file-preview-btn');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); openPreview(file); });

  el.addEventListener('contextmenu', (e) => {
    if (window.showFileContextMenu) {
      window.showFileContextMenu(e, file.path, isProcessing || isPreparing ? null : () => removeFile(index));
    }
  });

  return el;
}

function updateUpscaleButton() {
  const pending = files.filter(f => f.state === 'pending' || f.state === 'error' || f.state === 'cancelled');
  upscaleBtn.disabled = isPreparing || (pending.length === 0 && !isProcessing);
}

function setBusyControls(busy) {
  document.querySelectorAll('.scale-btn').forEach(button => { button.disabled = busy; });
  [modelProfileSelect, outputFormat, outputDirBtn, browseBtn, browseFolderBtn, clearBtn, retryBtn]
    .filter(Boolean)
    .forEach(control => { control.disabled = busy; });
  if (!isProcessing) updateUpscaleButton();
}

// ---- Preview ----
async function openPreview(file) {
  if (!file.output || file.type !== 'image') return;
  previewReturnFocus = document.activeElement;
  previewTitle.textContent = file.name;
  previewModal.classList.add('active');
  previewModal.setAttribute('aria-hidden', 'false');
  previewClose.focus();
  const [beforeData, afterData] = await Promise.all([
    window.api.system.readImagePreview(file.path),
    window.api.system.readImagePreview(file.output)
  ]);
  if (!beforeData || !afterData) { log('Failed to load preview images', 'error'); closePreview(); return; }
  previewBefore.src = beforeData;
  previewAfter.src = afterData;
  setPreviewPosition(50);
  requestAnimationFrame(() => {
    previewBefore.style.width = previewContainer.offsetWidth + 'px';
    previewBefore.style.height = previewContainer.offsetHeight + 'px';
  });
}

function setPreviewPosition(percent) {
  const value = Math.max(2, Math.min(98, Number(percent) || 50));
  previewBeforeClip.style.width = `${value}%`;
  previewSlider.style.left = `${value}%`;
  previewSlider.setAttribute('aria-valuenow', String(Math.round(value)));
}

function closePreview() {
  previewModal.classList.remove('active');
  previewModal.setAttribute('aria-hidden', 'true');
  previewBefore.src = '';
  previewAfter.src = '';
  if (previewReturnFocus?.isConnected) previewReturnFocus.focus();
  previewReturnFocus = null;
}

// ---- Register ----
window.registerTool('upscaler', { init, cleanup, onBackendStatus });

})();
