// ============================================================================
// GIF Maker Tool
// ============================================================================

(function() {

const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm']);
const MIN_GIF_DURATION = 0.5;
const MAX_GIF_DURATION = 60;

let videoFile = null;
let outputDir = '';
let isProcessing = false;
let log = null;
let progressCleanup = null;

let dropZone, browseBtn, createBtn, clearBtn, openOutputBtn;
let outputDirBtn, statusText, processingIndicator;
let footerProgress, footerProgressFill, progressPercent;
let fpsSlider, fpsValue, widthInput, startTime, endTime, duration;
let ditherSelect, maxColorsSlider, maxColorsValue, reverseCheck;
let videoInfo, videoName, removeVideoBtn, previewArea;
let lastOutputDir = '';
let syncingTimeFields = false;

function init(ctx) {
  log = ctx.log;

  dropZone = document.getElementById('dropZone');
  browseBtn = document.getElementById('browseBtn');
  createBtn = document.getElementById('createBtn');
  clearBtn = document.getElementById('clearBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  footerProgress = document.getElementById('footerProgress');
  footerProgressFill = document.getElementById('footerProgressFill');
  progressPercent = document.getElementById('progressPercent');
  fpsSlider = document.getElementById('fpsSlider');
  fpsValue = document.getElementById('fpsValue');
  widthInput = document.getElementById('widthInput');
  startTime = document.getElementById('startTime');
  endTime = document.getElementById('endTime');
  duration = document.getElementById('duration');
  ditherSelect = document.getElementById('dither');
  maxColorsSlider = document.getElementById('maxColors');
  maxColorsValue = document.getElementById('maxColorsValue');
  reverseCheck = document.getElementById('reverseCheck');
  videoInfo = document.getElementById('videoInfo');
  videoName = document.getElementById('videoName');
  removeVideoBtn = document.getElementById('removeVideoBtn');
  previewArea = document.getElementById('previewArea');
  openOutputBtn = document.getElementById('openOutputBtn');

  bindEvents();
  if (!outputDir && window.applyDefaultOutputDir) outputDir = window.applyDefaultOutputDir(outputDirBtn);
  loadToolSettings();
  log('GIF Maker initialized');
}

function cleanup() {
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function bindEvents() {
  fpsSlider.addEventListener('input', () => {
    fpsValue.textContent = fpsSlider.value;
    saveToolSettings();
  });

  widthInput.addEventListener('change', () => { saveToolSettings(); });
  startTime.addEventListener('change', () => {
    updateEndFromDuration();
    saveToolSettings();
  });
  endTime.addEventListener('change', () => {
    updateDurationFromEnd();
    saveToolSettings();
  });
  duration.addEventListener('change', () => {
    normalizeDurationInput();
    updateEndFromDuration();
    saveToolSettings();
  });

  ditherSelect.addEventListener('change', () => { saveToolSettings(); });
  reverseCheck.addEventListener('change', () => { saveToolSettings(); });
  maxColorsSlider.addEventListener('input', () => {
    maxColorsValue.textContent = maxColorsSlider.value;
    saveToolSettings();
  });

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
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
      const resolved = await window.api.system.resolveDroppedPaths(paths);
      if (resolved.length > 0) setVideo(resolved[0]);
      else log('No supported video file found', 'warn');
    }
  });

  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const paths = await window.api.system.selectFiles({ title: 'Select Video', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
    if (paths.length > 0) setVideo(paths[0]);
  });

  dropZone.addEventListener('click', async (e) => {
    if (e.target.id === 'browseBtn') return;
    const paths = await window.api.system.selectFiles({ title: 'Select Video', filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm'] }] });
    if (paths.length > 0) setVideo(paths[0]);
  });

  removeVideoBtn.addEventListener('click', () => {
    if (!isProcessing) clearAll();
  });

  clearBtn.addEventListener('click', () => {
    if (!isProcessing) { clearAll(); window.clearLog(); }
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.system.openFolder(lastOutputDir);
  });

  createBtn.addEventListener('click', startCreation);

  progressCleanup = window.api.tools.onToolProgress((data) => {
    if (data.tool !== 'gif-maker') return;
    handleProgress(data);
  });
}

function setVideo(path) {
  const ext = getFileExtension(path);
  if (!VIDEO_EXTS.has(ext)) {
    log('Not a supported video file', 'warn');
    return;
  }
  videoFile = path;
  videoName.textContent = getFileName(path);
  videoName.title = path;
  videoInfo.style.display = 'flex';
  previewArea.innerHTML = '<div class="empty-state">Set parameters and create GIF. Adjust settings and click Create.</div>';
  createBtn.disabled = false;
  if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'pending' }]);
  log(`Selected: ${getFileName(path)}`);
  updateEndFromDuration();
}

async function startCreation() {
  if (isProcessing) {
    createBtn.disabled = true;
    createBtn.textContent = 'Cancelling...';
    try { await window.api.tools.gifMaker.cancelGifMaker(); } catch {}
    return;
  }
  if (!videoFile) return;
  updateDurationFromEnd();

  isProcessing = true;
  if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'processing' }]);
  createBtn.disabled = false;
  createBtn.textContent = 'Cancel';
  createBtn.classList.add('btn-cancel');
  processingIndicator.classList.add('active');
  statusText.textContent = 'Creating GIF...';
  setFooterProgress(0, true);
  previewArea.innerHTML = `
    <div style="text-align: center;">
      <div class="file-progress-bar"><div class="file-progress-fill" id="gifProgress" style="width: 0%"></div></div>
      <div style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">Processing...</div>
    </div>`;

  log(`Creating GIF: FPS=${fpsSlider.value}, width=${widthInput.value}px, start=${startTime.value}, duration=${duration.value}s, dither=${ditherSelect.value}, colors=${maxColorsSlider.value}`);

  try {
    const result = await window.api.tools.gifMaker.makeGif({
      inputPath: videoFile,
      fps: parseInt(fpsSlider.value),
      width: parseInt(widthInput.value),
      startTime: startTime.value,
      duration: parseFloat(duration.value),
      dither: ditherSelect.value,
      maxColors: parseInt(maxColorsSlider.value),
      reverse: reverseCheck.checked,
      outputDir: outputDir
    });
    if (result && result.success) {
      log(`GIF created: ${result.output || 'done'}`, 'success');
      if (result.output) { lastOutputDir = result.output.replace(/\\/g, '/').split('/').slice(0, -1).join('/'); openOutputBtn.style.display = ''; }
      statusText.textContent = 'GIF created!';
      if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'complete' }]);
      if (window.showCompletionToast) window.showCompletionToast('GIF created successfully!');
      if (window.autoOpenOutputIfEnabled) window.autoOpenOutputIfEnabled(lastOutputDir);
    } else if (result && result.error) {
      log(`GIF error: ${result.error}`, 'error');
      statusText.textContent = 'Error creating GIF';
      if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'error' }]);
    }
  } catch (err) {
    log(`GIF creation error: ${err.message}`, 'error');
    statusText.textContent = 'Error creating GIF';
    if (window.updateQueueSummary) window.updateQueueSummary([{ state: 'error' }]);
  }

  isProcessing = false;
  createBtn.textContent = 'Create GIF';
  createBtn.classList.remove('btn-cancel');
  createBtn.disabled = !videoFile;
  processingIndicator.classList.remove('active');
  setFooterProgress(0, false);
}

function handleProgress(data) {
  const progressFill = document.getElementById('gifProgress');

  if (data.type === 'progress' || typeof data.percent === 'number' || typeof data.progress === 'number') {
    const progress = normalizeProgress(data);
    if (progressFill) progressFill.style.width = `${Math.round(progress * 100)}%`;
    setFooterProgress(progress, true);
    statusText.textContent = data.status || 'Creating GIF...';
  } else if (data.type === 'complete') {
    setFooterProgress(1, true);
    if (progressFill) {
      progressFill.style.width = '100%';
      progressFill.classList.add('complete');
    }
    statusText.textContent = 'GIF created successfully!';
    log(`GIF created: ${data.output || 'done'}`, 'success');
    previewArea.innerHTML = '<div class="empty-state" style="color: var(--success);">GIF created successfully!</div>';
  } else if (data.type === 'error') {
    setFooterProgress(0, false);
    if (progressFill) progressFill.classList.add('error');
    statusText.textContent = `Error: ${data.error}`;
    log(`Error: ${data.error}`, 'error');
  }
}

function normalizeProgress(data) {
  const raw = typeof data.progress === 'number' ? data.progress : data.percent;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 0;
  return Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
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

function parseTimeToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, parseFloat(raw));

  const parts = raw.split(':').map(p => p.trim());
  if (parts.some(p => p === '' || Number.isNaN(Number(p)))) return 0;

  const nums = parts.map(Number);
  if (nums.length === 3) return Math.max(0, nums[0] * 3600 + nums[1] * 60 + nums[2]);
  if (nums.length === 2) return Math.max(0, nums[0] * 60 + nums[1]);
  return 0;
}

function formatSecondsAsTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const fraction = safe - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const suffix = fraction > 0 ? (fraction.toFixed(1).slice(1)) : '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${suffix}`;
}

function clampDuration(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(MIN_GIF_DURATION, Math.min(MAX_GIF_DURATION, parsed));
}

function normalizeDurationInput() {
  const clamped = clampDuration(duration.value);
  duration.value = Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);
}

function updateEndFromDuration() {
  if (syncingTimeFields) return;
  syncingTimeFields = true;
  normalizeDurationInput();
  const startSeconds = parseTimeToSeconds(startTime.value);
  endTime.value = formatSecondsAsTime(startSeconds + clampDuration(duration.value));
  syncingTimeFields = false;
}

function updateDurationFromEnd() {
  if (syncingTimeFields) return;
  syncingTimeFields = true;
  const startSeconds = parseTimeToSeconds(startTime.value);
  const endSeconds = parseTimeToSeconds(endTime.value);
  const clamped = clampDuration(endSeconds - startSeconds);
  duration.value = Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);
  endTime.value = formatSecondsAsTime(startSeconds + clamped);
  syncingTimeFields = false;
}

function clearAll() {
  videoFile = null;
  videoInfo.style.display = 'none';
  openOutputBtn.style.display = 'none';
  videoName.textContent = '';
  previewArea.innerHTML = '<div class="empty-state">Drop a video above to get started.</div>';
  createBtn.disabled = true;
  statusText.textContent = 'Waiting for Video';
  setFooterProgress(0, false);
  if (window.updateQueueSummary) window.updateQueueSummary([]);
}

function getFileExtension(fp) {
  const parts = fp.replace(/\\/g, '/').split('/').pop().split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

function getFileName(fp) { return fp.replace(/\\/g, '/').split('/').pop(); }

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all['gif-maker'] || {};
    if (s.fps) { fpsSlider.value = s.fps; fpsValue.textContent = s.fps; }
    if (s.width) widthInput.value = s.width;
    if (s.startTime) startTime.value = s.startTime;
    if (s.duration) duration.value = s.duration;
    if (s.endTime) endTime.value = s.endTime;
    if (s.dither) ditherSelect.value = s.dither;
    if (s.maxColors) { maxColorsSlider.value = s.maxColors; maxColorsValue.textContent = s.maxColors; }
    if (s.reverse) reverseCheck.checked = s.reverse;
    if (s.outputDir) {
      outputDir = s.outputDir;
      const parts = outputDir.replace(/\\/g, '/').split('/');
      const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : outputDir;
      outputDirBtn.textContent = display;
      outputDirBtn.title = outputDir;
    }
    if (s.endTime) updateDurationFromEnd();
    else updateEndFromDuration();
  } catch {}
}

let _saveTimer = null;
function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.loadAllSettings().then(all => {
      all['gif-maker'] = { fps: fpsSlider.value, width: widthInput.value, startTime: startTime.value, endTime: endTime.value, duration: duration.value, dither: ditherSelect.value, maxColors: maxColorsSlider.value, reverse: reverseCheck.checked, outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('gif-maker', { init, cleanup });

})();
