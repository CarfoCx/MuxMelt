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

let urlList, addUrlBtn, downloadBtn, clearBtn, retryBtn, openOutputBtn;
let outputDirBtn, statusText, processingIndicator, etaText;

function init(ctx) {
  log = ctx.log;

  urlList = document.getElementById('urlList');
  addUrlBtn = document.getElementById('addUrlBtn');
  downloadBtn = document.getElementById('downloadBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');

  bindEvents();
  loadToolSettings();
  addRow('');
  log('Online Video Downloader ready');
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

  clearBtn.addEventListener('click', () => {
    if (isProcessing) return;
    rows = [];
    lastOutputs = [];
    lastOutputDir = '';
    openOutputBtn.style.display = 'none';
    retryBtn.style.display = 'none';
    window.clearLog();
    addRow('');
    statusText.textContent = 'Ready';
  });

  retryBtn.addEventListener('click', () => {
    rows.forEach(row => {
      if (row.state === 'error') {
        row.state = 'pending';
        row.progress = 0;
        row.status = 'Ready';
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
    status: 'Ready',
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
    status: 'Ready',
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

  for (const row of pending) {
    if (!isProcessing) break;
    row.state = 'processing';
    row.status = 'Starting...';
    row.progress = 0;
    renderRows();

    let result;
    try {
      result = await window.api.downloadVideoUrl({
        url: row.url,
        outputDir
      });
    } catch (err) {
      result = { success: false, error: err.message || String(err) };
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
    renderRows();
  }

  isProcessing = false;
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  downloadBtn.textContent = 'Download';
  downloadBtn.classList.remove('btn-cancel');
  processingIndicator.classList.remove('active');

  const completed = rows.filter(row => row.state === 'complete').length;
  const errors = rows.filter(row => row.state === 'error').length;
  statusText.textContent = `Done! ${completed} downloaded${errors > 0 ? `, ${errors} failed` : ''}`;
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
    if (window.setTaskbarProgress) window.setTaskbarProgress(row.progress);
  } else if (data.type === 'complete') {
    row.state = 'complete';
    row.progress = 1;
    row.status = 'Complete';
    row.output = data.output || row.output;
    if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  } else if (data.type === 'start') {
    row.state = 'processing';
    row.status = data.status || 'Starting...';
  }

  renderRows();
}

function renderRows() {
  urlList.innerHTML = '';
  rows.forEach(row => {
    const el = document.createElement('div');
    el.className = `url-row state-${row.state}`;

    let progressClass = '';
    if (row.state === 'complete') progressClass = ' complete';
    else if (row.state === 'error') progressClass = ' error';

    el.innerHTML = `
      <div class="url-main">
        <input class="url-input" type="url" placeholder="https://example.com/watch..." value="${window.escapeHtml(row.url)}" ${isProcessing ? 'disabled' : ''}>
        ${row.output ? `<button class="url-output" title="${window.escapeHtml(row.output)}">Open downloaded file</button>` : ''}
      </div>
      <div class="url-state" title="${window.escapeHtml(row.status)}">${window.escapeHtml(row.status)}</div>
      <button class="url-remove" title="Remove from list" ${isProcessing ? 'disabled' : ''}>&times;</button>
      <div class="url-progress"><div class="url-progress-fill${progressClass}" style="width: ${Math.round((row.progress || 0) * 100)}%"></div></div>
    `;

    const input = el.querySelector('.url-input');
    input.addEventListener('input', () => {
      row.url = input.value;
      row.state = 'pending';
      row.status = 'Ready';
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
    updateOutputButton();
  } catch {}
}

let _saveTimer = null;
function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.loadAllSettings().then(all => {
      all['url-downloader'] = { outputDir };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('url-downloader', { init, cleanup });

})();
