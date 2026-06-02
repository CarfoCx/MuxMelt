// ============================================================================
// Torrent Downloader Tool
// ============================================================================

(function() {

let outputDir = '';
let torrentFile = null;
let log = null;
let progressCleanup = null;
const activeDownloads = {};

let magnetInput, dropZone, fileCount, outputDirBtn, outputDirText;
let startBtn, openOutputBtn, cancelAllBtn, footerStatus, footerCount;
let downloadsContainer, emptyState;

function init(ctx) {
  log = ctx.log;

  magnetInput = document.getElementById('magnetInput');
  dropZone = document.getElementById('dropZone');
  fileCount = document.getElementById('fileCount');
  outputDirBtn = document.getElementById('outputDirBtn');
  outputDirText = document.getElementById('outputDirText');
  downloadsContainer = document.getElementById('downloadsContainer');
  emptyState = document.getElementById('emptyState');

  startBtn = document.getElementById('startBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  cancelAllBtn = document.getElementById('cancelAllBtn');
  footerStatus = document.getElementById('footerStatus');
  footerCount = document.getElementById('footerCount');

  bindEvents();
  loadToolSettings();
  updateFooter();
  log('Torrent Downloader initialized');
}

function cleanup() {
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

// ── Event binding ──────────────────────────────────────────────────────

function bindEvents() {
  outputDirBtn.addEventListener('click', async () => {
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      updateOutputButton();
      saveToolSettings();
    }
  });

  dropZone.addEventListener('click', async () => {
    const files = await window.api.system.selectFiles({
      title: 'Select Torrent File',
      filters: [{ name: 'Torrent Files', extensions: ['torrent'] }]
    });
    if (files && files.length > 0) {
      torrentFile = files[0];
      magnetInput.value = '';
      updateFileText();
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.path && file.name.endsWith('.torrent')) {
        torrentFile = file.path;
        magnetInput.value = '';
        updateFileText();
      }
    }
  });

  magnetInput.addEventListener('input', () => {
    if (magnetInput.value.trim().length > 0) {
      torrentFile = null;
      updateFileText();
    }
  });

  // Allow Enter key to start download
  magnetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startDownload();
  });

  startBtn.addEventListener('click', startDownload);

  openOutputBtn.addEventListener('click', () => {
    if (outputDir) window.api.system.openFolder(outputDir);
  });

  cancelAllBtn.addEventListener('click', async () => {
    await window.api.tools.torrentDownloader.cancelAllTorrents();
  });

  progressCleanup = window.api.tools.onToolProgress((data) => {
    if (data.tool !== 'torrent-downloader') return;
    handleProgress(data);
  });
}

// ── UI helpers ─────────────────────────────────────────────────────────

function updateOutputButton() {
  outputDirText.textContent = outputDir || 'Select output directory...';
  outputDirText.title = outputDir || '';
}

function updateFileText() {
  if (torrentFile) {
    fileCount.textContent = 'Selected: ' + torrentFile.split(/[/\\]/).pop();
    fileCount.style.display = 'block';
  } else {
    fileCount.style.display = 'none';
  }
}

function updateFooter() {
  const ids = Object.keys(activeDownloads);
  const activeCount = ids.filter(id => {
    const s = activeDownloads[id].state;
    return s === 'starting' || s === 'downloading' || s === 'paused';
  }).length;
  const totalCount = ids.length;

  if (totalCount === 0) {
    footerStatus.textContent = 'Ready';
    footerCount.textContent = '';
    cancelAllBtn.style.display = 'none';
  } else {
    footerStatus.textContent = activeCount > 0 ? 'Downloading' : 'Idle';
    footerCount.textContent = activeCount > 0
      ? `${activeCount} active / ${totalCount} total`
      : `${totalCount} torrent${totalCount !== 1 ? 's' : ''}`;
    cancelAllBtn.style.display = activeCount > 0 ? '' : 'none';
  }

  emptyState.style.display = totalCount === 0 ? '' : 'none';
}

// ── Formatting utilities ───────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return '0 B/s';
  return formatBytes(bytesPerSec) + '/s';
}

function formatEta(seconds) {
  if (seconds === Infinity || !seconds || seconds < 0) return '--';
  if (seconds < 60) return Math.floor(seconds) + 's';
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m ${Math.floor(seconds % 60)}s`;
}

// ── Download card creation ─────────────────────────────────────────────

function createDownloadCard(id) {
  const card = document.createElement('div');
  card.className = 'torrent-card state-downloading';

  // Header
  const header = document.createElement('div');
  header.className = 'torrent-card-header';

  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0; flex:1;';

  const dot = document.createElement('div');
  dot.className = 'torrent-state-dot starting';

  const title = document.createElement('span');
  title.className = 'torrent-card-title loading';
  title.textContent = 'Fetching torrent metadata…';

  titleWrap.appendChild(dot);
  titleWrap.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'torrent-card-actions';

  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'btn btn-secondary';
  pauseBtn.textContent = 'Pause';
  pauseBtn.onclick = () => togglePause(id);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-danger';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => cancelDownload(id);

  actions.appendChild(pauseBtn);
  actions.appendChild(cancelBtn);

  header.appendChild(titleWrap);
  header.appendChild(actions);

  // Stats grid
  const stats = document.createElement('div');
  stats.className = 'torrent-card-stats';

  const createStat = (label, initial) => {
    const s = document.createElement('div');
    s.className = 'torrent-stat';
    const l = document.createElement('span');
    l.className = 'torrent-stat-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'torrent-stat-value';
    v.textContent = initial || '--';
    s.appendChild(l);
    s.appendChild(v);
    return v;
  };

  const elDown = createStat('↓ Speed', '0 B/s');
  const elUp = createStat('↑ Speed', '0 B/s');
  const elPeers = createStat('Peers', '0');
  const elEta = createStat('ETA', '--');
  const elSize = createStat('Size', '--');
  const elRatio = createStat('Ratio', '0.00');

  stats.appendChild(elDown.parentNode);
  stats.appendChild(elUp.parentNode);
  stats.appendChild(elPeers.parentNode);
  stats.appendChild(elEta.parentNode);
  stats.appendChild(elSize.parentNode);
  stats.appendChild(elRatio.parentNode);

  // Progress bar
  const progressBar = document.createElement('div');
  progressBar.className = 'torrent-progress-bar';

  const progressFill = document.createElement('div');
  progressFill.className = 'torrent-progress-fill';

  const progressText = document.createElement('span');
  progressText.className = 'torrent-progress-text';
  progressText.textContent = '0.0%';

  progressBar.appendChild(progressFill);
  progressBar.appendChild(progressText);

  // Assemble
  card.appendChild(header);
  card.appendChild(stats);
  card.appendChild(progressBar);

  downloadsContainer.prepend(card);

  activeDownloads[id] = {
    card, title, dot, pauseBtn, cancelBtn,
    elDown, elUp, elPeers, elEta, elSize, elRatio,
    progressFill, progressText,
    state: 'starting',
    totalLength: 0
  };

  updateFooter();
}

// ── Torrent actions ────────────────────────────────────────────────────

async function togglePause(id) {
  const dl = activeDownloads[id];
  if (!dl) return;
  if (dl.state === 'downloading') {
    dl.state = 'paused';
    dl.dot.className = 'torrent-state-dot paused';
    dl.pauseBtn.textContent = 'Resume';
    dl.elDown.textContent = '0 B/s';
    dl.elUp.textContent = '0 B/s';
    dl.progressFill.classList.add('paused');
    dl.card.className = 'torrent-card state-paused';
    await window.api.tools.torrentDownloader.pauseTorrent(id);
    updateFooter();
  } else if (dl.state === 'paused') {
    dl.state = 'downloading';
    dl.dot.className = 'torrent-state-dot downloading';
    dl.pauseBtn.textContent = 'Pause';
    dl.progressFill.classList.remove('paused');
    dl.card.className = 'torrent-card state-downloading';
    await window.api.tools.torrentDownloader.resumeTorrent(id);
    updateFooter();
  }
}

async function cancelDownload(id) {
  const dl = activeDownloads[id];
  if (!dl) return;
  dl.pauseBtn.disabled = true;
  dl.cancelBtn.disabled = true;
  await window.api.tools.torrentDownloader.cancelTorrent(id);
}

function finalizeCard(id, label, onclick) {
  const dl = activeDownloads[id];
  if (!dl) return;
  dl.pauseBtn.style.display = 'none';
  dl.cancelBtn.textContent = label;
  dl.cancelBtn.className = 'btn btn-secondary';
  dl.cancelBtn.disabled = false;
  dl.cancelBtn.onclick = onclick || (() => {
    dl.card.style.animation = 'none';
    dl.card.style.transition = 'opacity 0.25s, transform 0.25s';
    dl.card.style.opacity = '0';
    dl.card.style.transform = 'translateY(-4px)';
    setTimeout(() => {
      dl.card.remove();
      delete activeDownloads[id];
      updateFooter();
    }, 250);
  });
}

// ── Progress handler ───────────────────────────────────────────────────

function handleProgress(data) {
  const id = data.id;
  const dl = activeDownloads[id];
  if (!dl) return;

  // Error
  if (data.status === 'error') {
    log(data.message || 'Download error', 'error');
    dl.state = 'error';
    dl.dot.className = 'torrent-state-dot error';
    dl.title.classList.remove('loading');
    dl.progressFill.classList.add('error');
    dl.card.className = 'torrent-card state-error';
    finalizeCard(id, 'Remove');
    updateFooter();
    return;
  }

  // Cancelled
  if (data.status === 'cancelled') {
    log('Download cancelled', 'warn');
    dl.state = 'cancelled';
    dl.dot.className = 'torrent-state-dot cancelled';
    dl.title.classList.remove('loading');
    dl.progressFill.classList.add('cancelled');
    dl.card.className = 'torrent-card state-cancelled';
    finalizeCard(id, 'Remove');
    updateFooter();
    return;
  }

  // Complete
  if (data.status === 'done') {
    log('Download complete: ' + data.name, 'success');
    dl.state = 'complete';
    dl.dot.className = 'torrent-state-dot complete';
    dl.title.classList.remove('loading');
    dl.progressFill.style.width = '100%';
    dl.progressFill.classList.add('complete');
    dl.progressText.textContent = '100%';
    dl.elDown.textContent = '0 B/s';
    dl.elUp.textContent = '0 B/s';
    dl.elEta.textContent = 'Done';
    dl.card.className = 'torrent-card state-complete';

    if (data.length) dl.elSize.textContent = formatBytes(data.length);
    if (data.downloaded && data.uploaded) {
      dl.elRatio.textContent = (data.uploaded / data.downloaded).toFixed(2);
    }

    finalizeCard(id, 'Remove');
    window.showCompletionToast(`Downloaded: ${data.name}`);
    updateFooter();
    return;
  }

  // Metadata fetched
  if (data.status === 'metadata_fetched') {
    dl.title.textContent = data.name || 'Unknown Torrent';
    dl.title.title = dl.title.textContent;
    dl.title.classList.remove('loading');
    dl.state = 'downloading';
    dl.dot.className = 'torrent-state-dot downloading';
    dl.totalLength = data.length || 0;

    if (data.length) dl.elSize.textContent = formatBytes(data.length);
    if (data.files && data.files.length > 0) {
      log(`${data.name}: ${data.files.length} file${data.files.length > 1 ? 's' : ''}, ${formatBytes(data.length)}`);
    }
    updateFooter();
  }

  // Downloading progress
  if (data.status === 'downloading' && dl.state === 'downloading') {
    if (data.progress !== undefined) {
      const pct = (data.progress * 100).toFixed(1);
      dl.progressFill.style.width = `${pct}%`;
      dl.progressText.textContent = `${pct}%`;
    }
    if (data.downloadSpeed !== undefined) {
      dl.elDown.textContent = formatSpeed(data.downloadSpeed);
    }
    if (data.uploadSpeed !== undefined) {
      dl.elUp.textContent = formatSpeed(data.uploadSpeed);
    }
    if (data.numPeers !== undefined) {
      dl.elPeers.textContent = data.numPeers.toString();
    }
    if (data.timeRemaining !== undefined) {
      dl.elEta.textContent = formatEta(data.timeRemaining / 1000);
    }
    if (data.downloaded !== undefined && data.length) {
      dl.elSize.textContent = formatBytes(data.downloaded) + ' / ' + formatBytes(data.length);
    }
    if (data.downloaded && data.uploaded !== undefined) {
      const ratio = data.downloaded > 0 ? (data.uploaded / data.downloaded) : 0;
      dl.elRatio.textContent = ratio.toFixed(2);
    }
  }
}

// ── Start download ─────────────────────────────────────────────────────

async function startDownload() {
  const source = torrentFile || magnetInput.value.trim();
  if (!source) {
    log('Please provide a magnet link or select a .torrent file.', 'warn');
    return;
  }

  if (!outputDir) {
    const dir = await window.api.system.selectOutputDir();
    if (!dir) return;
    outputDir = dir;
    updateOutputButton();
    saveToolSettings();
  }

  log('Starting torrent download…');

  // Clear inputs for next add
  const currentSource = source;
  torrentFile = null;
  magnetInput.value = '';
  updateFileText();

  const result = await window.api.tools.torrentDownloader.downloadTorrent({
    source: currentSource,
    outputDir: outputDir
  });

  if (result.success) {
    createDownloadCard(result.id);
  } else {
    log(`Error: ${result.error}`, 'error');
    window.showCompletionToast(result.error, true);
  }
}

// ── Settings ───────────────────────────────────────────────────────────

function loadToolSettings() {
  const settings = window.api.system.loadSettings();
  if (settings.torrentDownloader) {
    outputDir = settings.torrentDownloader.outputDir || '';
    updateOutputButton();
  }
}

function saveToolSettings() {
  const settings = window.api.system.loadSettings();
  settings.torrentDownloader = settings.torrentDownloader || {};
  settings.torrentDownloader.outputDir = outputDir;
  window.api.system.saveSettings(settings);
}

// ── Register ───────────────────────────────────────────────────────────

window.registerTool({
  id: 'torrent-downloader',
  init: init,
  cleanup: cleanup
});

})();
