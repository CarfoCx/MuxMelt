// ============================================================================
// Online Video Downloader Tool
// ============================================================================

(function() {

let rows = [];
let outputDir = '';
let isProcessing = false;
let log = null;
let progressCleanup = null;
let lastOutputDir = '';
let lastOutputs = [];
let batchStartTime = 0;
let batchTotalFiles = 0;

let urlList, addUrlBtn, downloadBtn, clearBtn, retryBtn, openOutputBtn;
let outputDirBtn, qualitySelect, statusText, processingIndicator, etaText;

function init(ctx) {
  log = ctx.log;

  urlList = document.getElementById('urlList');
  addUrlBtn = document.getElementById('addUrlBtn');
  downloadBtn = document.getElementById('downloadBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  qualitySelect = document.getElementById('qualitySelect');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');

  bindEvents();
  loadToolSettings();
  addRow('');
  log('Online Video Downloader initialized');
}

function cleanup() {
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function bindEvents() {
  addUrlBtn.addEventListener('click', () => addRow(''));

  outputDirBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    const dir = await window.api.selectOutputDir();
    if (dir) {
      outputDir = dir;
      updateOutputButton();
      saveToolSettings();
    }
  });

  if (qualitySelect) {
    qualitySelect.addEventListener('change', saveToolSettings);
  }

  clearBtn.addEventListener('click', () => {
    if (isProcessing) return;
    rows = [];
    lastOutputs = [];
    lastOutputDir = '';
    openOutputBtn.style.display = 'none';
    retryBtn.style.display = 'none';
    window.clearLog();
    addRow('');
    statusText.textContent = 'Waiting for URL';
  });

  retryBtn.addEventListener('click', () => {
    rows.forEach(row => {
      if (row.state === 'error') {
        row.state = 'pending';
        row.progress = 0;
        row.status = 'Waiting for URL';
      }
    });
    retryBtn.style.display = 'none';
    renderRows();
    startDownload();
  });

  openOutputBtn.addEventListener('click', () => {
    if (lastOutputDir) window.api.openFolder(lastOutputDir);
  });

  downloadBtn.addEventListener('click', startDownload);

  progressCleanup = window.api.onToolProgress((data) => {
    if (data.tool !== 'url-downloader') return;
    handleProgress(data);
  });
}

function addRow(value) {
  rows.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    url: value || '',
    progress: 0,
    status: 'Waiting for URL',
    state: 'pending',
    output: ''
  });
  renderRows();
  updateButton();
  setTimeout(() => {
    const inputs = urlList.querySelectorAll('.url-input');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }, 0);
}

function createEmptyRow() {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    url: '',
    progress: 0,
    status: 'Waiting for URL',
    state: 'pending',
    output: ''
  };
}

function removeRow(id) {
  if (isProcessing) return;
  rows = rows.filter(row => row.id !== id);
  if (rows.length === 0) {
    rows.push(createEmptyRow());
  }
  renderRows();
  updateButton();
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function startDownload() {
  if (isProcessing) {
    isProcessing = false;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Cancelling...';
    try { await window.api.cancelUrlDownload(); } catch {}
    return;
  }

  rows.forEach(row => {
    row.url = row.url.trim();
    if (row.url && row.state === 'complete') row.state = 'pending';
  });

  const invalid = rows.filter(row => row.url && !isValidHttpUrl(row.url));
  if (invalid.length > 0) {
    invalid.forEach(row => { row.state = 'error'; row.status = 'Invalid URL'; });
    renderRows();
    log('One or more URLs are invalid. Use full http or https links.', 'error');
    return;
  }

  const pending = rows.filter(row => row.url && (row.state === 'pending' || row.state === 'error'));
  if (pending.length === 0) return;

  isProcessing = true;
  batchStartTime = Date.now();
  batchTotalFiles = pending.length;
  lastOutputs = [];
  downloadBtn.disabled = false;
  downloadBtn.textContent = 'Cancel';
  downloadBtn.classList.add('btn-cancel');
  processingIndicator.classList.add('active');
  retryBtn.style.display = 'none';
  openOutputBtn.style.display = 'none';
  statusText.textContent = `Downloading ${pending.length} video URL(s)...`;
  if (etaText) etaText.textContent = '';

  log(`Starting online video downloads: ${pending.length} URL(s)`);

  const CONCURRENCY_LIMIT = 3;
  let index = 0;

  async function worker() {
    while (isProcessing && index < pending.length) {
      const row = pending[index++];
      row.state = 'processing';
      row.status = 'Starting...';
      row.progress = 0;
      renderRows();

      let result;
      try {
        result = await window.api.downloadVideoUrl({
          url: row.url,
          outputDir,
          format: qualitySelect ? qualitySelect.value : 'best'
        });
      } catch (err) {
        result = { success: false, error: err.message || String(err) };
      }

      if (!isProcessing) {
        row.state = 'pending';
        row.status = 'Cancelled';
        row.progress = 0;
        break;
      }

      if (result && result.success) {
        row.state = 'complete';
        row.progress = 1;
        row.status = 'Complete';
        row.output = result.output || '';
        lastOutputDir = result.outputDir || lastOutputDir;
        if (row.output) {
          lastOutputs.push(row.output);
          if (window.addRecentFile) window.addRecentFile(row.output);
        }
        log(`Downloaded: ${row.url}`, 'success');
      } else {
        row.state = 'error';
        row.progress = 0;
        row.status = result && result.error ? result.error : 'Download failed';
        log(`Download failed: ${row.url} - ${row.status}`, 'error');
      }

      const completedCount = rows.filter(r => r.url.trim() && (r.state === 'complete' || r.state === 'error')).length;
      if (batchTotalFiles > 1) {
        statusText.textContent = `Downloading ${batchTotalFiles} video URL(s) (${completedCount}/${batchTotalFiles} complete)`;
      }

      // Update overall taskbar progress
      const batch = rows.filter(r => r.url.trim());
      const totalProgress = batch.reduce((sum, r) => sum + (r.progress || 0), 0) / (batch.length || 1);
      if (window.setTaskbarProgress) window.setTaskbarProgress(totalProgress);

      renderRows();
    }
  }

  // Start workers in parallel
  const workers = [];
  const numWorkers = Math.min(CONCURRENCY_LIMIT, pending.length);
  for (let i = 0; i < numWorkers; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  isProcessing = false;
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  downloadBtn.textContent = 'Download';
  downloadBtn.classList.remove('btn-cancel');
  processingIndicator.classList.remove('active');

  const completed = rows.filter(row => row.state === 'complete').length;
  const errors = rows.filter(row => row.state === 'error').length;
  const cancelledCount = rows.filter(row => row.status === 'Cancelled').length;

  if (cancelledCount > 0) {
    statusText.textContent = `Cancelled! ${completed} downloaded, ${cancelledCount} cancelled`;
  } else {
    statusText.textContent = `Done! ${completed} downloaded${errors > 0 ? `, ${errors} failed` : ''}`;
  }

  openOutputBtn.style.display = completed > 0 && lastOutputDir ? '' : 'none';
  retryBtn.style.display = errors > 0 ? '' : 'none';
  updateButton();

  if (window.showCompletionToast) {
    window.showCompletionToast(`Downloads complete: ${completed} downloaded${errors > 0 ? `, ${errors} failed` : ''}`, errors > 0, lastOutputs);
  }
  if (window.autoOpenOutputIfEnabled && completed > 0) window.autoOpenOutputIfEnabled(lastOutputDir);
}

function handleProgress(data) {
  const row = rows.find(item => item.url === data.url);
  if (!row) return;

  if (data.type === 'progress') {
    row.state = 'processing';
    row.progress = data.progress || 0;
    row.status = data.status || 'Downloading...';

    if (statusText) {
      if (batchTotalFiles === 1) {
        statusText.textContent = row.status;
      } else {
        const completedCount = rows.filter(r => r.url.trim() && (r.state === 'complete' || r.state === 'error')).length;
        statusText.textContent = `Downloading ${batchTotalFiles} video URL(s) (${completedCount}/${batchTotalFiles} complete)`;
      }
    }

    const batch = rows.filter(r => r.url.trim());
    const totalProgress = batch.reduce((sum, r) => sum + (r.progress || 0), 0) / (batch.length || 1);
    if (window.setTaskbarProgress) window.setTaskbarProgress(totalProgress);

    if (etaText && window.calculateETA) {
      etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, rows.filter(r => r.url.trim()));
    }
  } else if (data.type === 'complete') {
    row.state = 'complete';
    row.progress = 1;
    row.status = 'Complete';
    row.output = data.output || row.output;

    if (statusText) {
      if (batchTotalFiles === 1) {
        statusText.textContent = 'Download complete';
      } else {
        const completedCount = rows.filter(r => r.url.trim() && (r.state === 'complete' || r.state === 'error')).length;
        statusText.textContent = `Downloading ${batchTotalFiles} video URL(s) (${completedCount}/${batchTotalFiles} complete)`;
      }
    }

    const batch = rows.filter(r => r.url.trim());
    const totalProgress = batch.reduce((sum, r) => sum + (r.progress || 0), 0) / (batch.length || 1);
    const allDone = batch.every(r => r.state === 'complete' || r.state === 'error');
    if (window.setTaskbarProgress) window.setTaskbarProgress(allDone ? -1 : totalProgress);

    if (etaText && window.calculateETA) {
      etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, rows.filter(r => r.url.trim()));
    }
  } else if (data.type === 'start') {
    row.state = 'processing';
    if (typeof data.progress === 'number') {
      row.progress = Math.max(row.progress || 0, data.progress);
    }
    row.status = data.status || 'Starting...';

    if (statusText) {
      if (batchTotalFiles === 1) {
        statusText.textContent = row.status;
      } else {
        const completedCount = rows.filter(r => r.url.trim() && (r.state === 'complete' || r.state === 'error')).length;
        statusText.textContent = `Downloading ${batchTotalFiles} video URL(s) (${completedCount}/${batchTotalFiles} complete)`;
      }
    }

    const batch = rows.filter(r => r.url.trim());
    const totalProgress = batch.reduce((sum, r) => sum + (r.progress || 0), 0) / (batch.length || 1);
    if (window.setTaskbarProgress && typeof data.progress === 'number') {
      window.setTaskbarProgress(totalProgress);
    }

    if (etaText && window.calculateETA) {
      etaText.textContent = window.calculateETA(batchStartTime, batchTotalFiles, rows.filter(r => r.url.trim()));
    }
  }
  renderRows();
}

function renderRows() {
  if (window.updateQueueSummary) window.updateQueueSummary(rows.filter(row => row.url.trim()));
  urlList.innerHTML = '';
  rows.forEach(row => {
    const el = document.createElement('div');
    el.className = `url-row state-${row.state}`;

    let progressClass = '';
    if (row.state === 'complete') progressClass = ' complete';
    else if (row.state === 'error') progressClass = ' error';

    const percent = Math.round((row.progress || 0) * 100);
    const showPercent = row.state === 'processing' || row.state === 'complete';

    el.innerHTML = `
      <div class="url-main">
        <input class="url-input" type="url" placeholder="https://example.com/watch..." value="${window.escapeHtml(row.url)}" ${isProcessing ? 'disabled' : ''}>
        ${row.output ? `<button class="url-output" title="${window.escapeHtml(row.output)}">Open downloaded file</button>` : ''}
      </div>
      <div class="url-state" title="${window.escapeHtml(row.status)}">${window.escapeHtml(row.status)}</div>
      <button class="url-remove" title="Remove from list" ${isProcessing ? 'disabled' : ''}>&times;</button>
      <div class="url-progress">
        <div class="url-progress-fill${progressClass}" style="width: ${percent}%"></div>
        ${showPercent ? `<div class="url-progress-text">${percent}%</div>` : ''}
      </div>
    `;

    const input = el.querySelector('.url-input');
    input.addEventListener('input', () => {
      row.url = input.value;
      row.state = 'pending';
      row.status = 'Waiting for URL';
      row.progress = 0;
      updateButton();
    });
    input.addEventListener('paste', () => {
      setTimeout(() => {
        const value = input.value.trim();
        const parts = value.split(/\s+/).filter(Boolean);
        if (parts.length > 1 && parts.every(isValidHttpUrl)) {
          row.url = parts.shift();
          parts.forEach(addRow);
          renderRows();
          updateButton();
        }
      }, 0);
    });

    const outputBtn = el.querySelector('.url-output');
    if (outputBtn) {
      outputBtn.addEventListener('click', () => window.api.openPath(row.output));
    }

    el.querySelector('.url-remove').addEventListener('click', () => removeRow(row.id));
    urlList.appendChild(el);
  });
}

function updateButton() {
  const hasUrl = rows.some(row => row.url.trim());
  downloadBtn.disabled = !hasUrl && !isProcessing;
  addUrlBtn.disabled = isProcessing;
}

function updateOutputButton() {
  if (!outputDir) {
    outputDirBtn.textContent = 'Downloads/MuxMelt Downloads';
    outputDirBtn.title = 'Default Downloads folder';
    return;
  }
  const parts = outputDir.replace(/\\/g, '/').split('/');
  outputDirBtn.textContent = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : outputDir;
  outputDirBtn.title = outputDir;
}

async function loadToolSettings() {
  try {
    const all = await window.loadAllSettings();
    const s = all['url-downloader'] || {};
    if (!outputDir && window.applyDefaultOutputDir) {
      outputDir = window.applyDefaultOutputDir(outputDirBtn);
    }
    if (s.outputDir) outputDir = s.outputDir;
    if (s.quality && qualitySelect) qualitySelect.value = s.quality;
    updateOutputButton();
  } catch {}
}

let _saveTimer = null;
function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.loadAllSettings().then(all => {
      all['url-downloader'] = {
        outputDir,
        quality: qualitySelect ? qualitySelect.value : 'best'
      };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('url-downloader', { init, cleanup });

})();
