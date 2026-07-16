// ============================================================================
// Online Video Downloader Tool
// ============================================================================

(function() {

let rows = [];
let outputDir = '';
let cookiesFile = '';
let isProcessing = false;
let cancelRequested = false;
let log = null;
let progressCleanup = null;
let lastOutputDir = '';
let lastOutputs = [];
let batchStartTime = 0;
let batchTotalFiles = 0;
// Live-queue state. Workers pull from `rows` dynamically (rather than a fixed
// snapshot) so URLs added while a batch is running are picked up automatically.
let concurrencyLimit = 3;
let activeWorkers = 0;
let batchRowIds = new Set();
const INFO_CONCURRENCY_LIMIT = 3;
let infoQueue = [];
let activeInfoRequests = 0;

let urlList, addUrlBtn, downloadBtn, clearBtn, retryBtn, openOutputBtn;
let outputDirBtn, qualitySelect, cookiesFileBtn, statusText, processingIndicator, etaText;

const EDIT_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

async function init(ctx) {
  log = ctx.log;

  urlList = document.getElementById('urlList');
  addUrlBtn = document.getElementById('addUrlBtn');
  downloadBtn = document.getElementById('downloadBtn');
  clearBtn = document.getElementById('clearBtn');
  retryBtn = document.getElementById('retryBtn');
  openOutputBtn = document.getElementById('openOutputBtn');
  outputDirBtn = document.getElementById('outputDirBtn');
  qualitySelect = document.getElementById('qualitySelect');
  cookiesFileBtn = document.getElementById('cookiesFileBtn');
  statusText = document.getElementById('statusText');
  processingIndicator = document.getElementById('processingIndicator');
  etaText = document.getElementById('etaText');

  await loadToolSettings();
  bindEvents();
  addRow('');
  log('Online Video Downloader initialized');
}

function cleanup() {
  cancelAllInfoRequests();
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
}

function updateDependencies() {
  const isPlaylist = document.getElementById('playlistCheckbox').checked;
  document.querySelector('.dependency-playlist').style.display = isPlaylist ? '' : 'none';

  const subsValue = document.getElementById('subtitlesSelect').value;
  document.querySelector('.dependency-subtitles').style.display = subsValue !== 'none' ? '' : 'none';

  const qualityValue = qualitySelect.value;
  document.querySelector('.dependency-custom-format').style.display = qualityValue === 'custom' ? '' : 'none';
  document.querySelector('.dependency-audio-format').style.display = qualityValue === 'audioonly' ? '' : 'none';
}

function bindEvents() {
  addUrlBtn.addEventListener('click', () => addRow(''));

  outputDirBtn.addEventListener('click', async () => {
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
      openOutputBtn.style.display = '';
      updateOutputButton();
      saveToolSettings();
    }
  });

  if (cookiesFileBtn) {
    cookiesFileBtn.addEventListener('click', async () => {
      if (isProcessing) return;
      const files = await window.api.system.selectFiles({
        title: 'Select Cookies File (.txt)',
        filters: [{ name: 'Cookies file (cookies.txt)', extensions: ['txt'] }]
      });
      if (files && files.length > 0) {
        cookiesFile = files[0];
      }
      updateCookiesButton();
      saveToolSettings();
    });
    cookiesFileBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (cookiesFile) {
        cookiesFile = '';
        updateCookiesButton();
        saveToolSettings();
      }
    });
  }

  // Advanced section collapsible
  const advancedToggleBtn = document.getElementById('advancedToggleBtn');
  const advancedChevron = document.getElementById('advancedChevron');
  const advancedSettingsPanel = document.getElementById('advancedSettingsPanel');

  advancedToggleBtn.addEventListener('click', () => {
    const collapsed = advancedSettingsPanel.classList.toggle('collapsed');
    if (collapsed) {
      advancedChevron.style.transform = 'rotate(0deg)';
    } else {
      advancedChevron.style.transform = 'rotate(180deg)';
    }
  });

  // Watch advanced elements to save/update dependecies
  const elementsToWatch = [
    'qualitySelect', 'cookieBrowserSelect', 'playlistCheckbox', 
    'maxDownloadsInput', 'limitRateInput', 'subtitlesSelect', 
    'subLangsInput', 'customFormatInput', 'filenameTemplateSelect',
    'skipSponsorsCheckbox', 'embedMetadataCheckbox', 'embedThumbnailCheckbox',
    'splitChaptersCheckbox', 'writeDescriptionCheckbox', 'writeThumbnailCheckbox',
    'audioFormatSelect', 'writeAutoSubsCheckbox', 'timeRangeInput',
    'concurrentFragmentsInput', 'simultaneousDownloadsInput', 'proxyInput', 'usernameInput',
    'passwordInput', 'videoPasswordInput', 'geoBypassCheckbox'
  ];

  elementsToWatch.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const eventName = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        updateDependencies();
        saveToolSettings();
      });
    }
  });

  // Dependency updater button
  const updateYtDlpBtn = document.getElementById('updateYtDlpBtn');
  if (updateYtDlpBtn) {
    updateYtDlpBtn.addEventListener('click', async () => {
      if (updateYtDlpBtn.classList.contains('updating')) return;
      updateYtDlpBtn.classList.add('updating');
      const textSpan = updateYtDlpBtn.querySelector('span');
      textSpan.textContent = 'Updating (yt-dlp)...';
      log('Starting yt-dlp dependencies update...');
      try {
        const res = await window.api.tools.urlDownloader.updateYtDlp();
        if (res && res.success) {
          log('yt-dlp upgraded successfully: ' + res.message, 'success');
          if (window.showCompletionToast) window.showCompletionToast('Downloader dependencies updated successfully');
        } else {
          const error = res && res.error ? res.error : 'Unknown error';
          log('Upgrade failed: ' + error, 'error');
          if (window.showCompletionToast) window.showCompletionToast('Failed to update downloader: ' + error, true);
        }
      } catch (err) {
        log('Upgrade error: ' + err.message, 'error');
        if (window.showCompletionToast) window.showCompletionToast('Error updating downloader: ' + err.message, true);
      } finally {
        updateYtDlpBtn.classList.remove('updating');
        textSpan.textContent = 'Update Downloader (yt-dlp)';
      }
    });
  }

  clearBtn.addEventListener('click', () => {
    if (isProcessing) return;
    cancelAllInfoRequests();
    rows = [];
    lastOutputs = [];
    lastOutputDir = '';
    batchRowIds = new Set();
    openOutputBtn.style.display = outputDir ? '' : 'none';
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
    if (lastOutputDir) window.api.system.openFolder(lastOutputDir);
    else if (outputDir) window.api.system.openFolder(outputDir);
  });

  downloadBtn.addEventListener('click', () => startDownload());

  progressCleanup = window.api.tools.onToolProgress((data) => {
    if (data.tool !== 'url-downloader') return;
    handleProgress(data);
  });
}

function addRow(value) {
  const row = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    url: value || '',
    progress: 0,
    status: 'Waiting for URL',
    state: 'pending',
    output: '',
    info: null,
    thumbnailDataUrl: null,
    isFetchingInfo: false,
    isEditing: false
  };
  rows.push(row);
  renderRows();
  updateButton();
  
  if (value && isValidHttpUrl(value)) {
    // If a batch is already running, a URL added with a value joins the live
    // queue immediately; otherwise fetch its info/thumbnail preview.
    if (isProcessing) enqueueRow(row);
    else fetchInfoForRow(row, value);
  }

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
    output: '',
    info: null,
    thumbnailDataUrl: null,
    isFetchingInfo: false,
    isEditing: false
  };
}

function removeRow(id) {
  const row = rows.find(r => r.id === id);
  if (!row) return;
  // A row that is actively downloading can't be pulled out from under its
  // worker; every other state (including queued) is safe to remove mid-batch.
  if (row.state === 'processing') return;
  cancelInfoForRow(row);
  row.queued = false;
  batchRowIds.delete(id);
  rows = rows.filter(r => r.id !== id);
  if (rows.length === 0) {
    rows.push(createEmptyRow());
  }
  renderRows();
  updateButton();
  if (isProcessing) updateBatchStatus();
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cancelInfoForRow(row) {
  if (!row) return;
  if (row.fetchTimeout) { clearTimeout(row.fetchTimeout); row.fetchTimeout = null; }
  row.infoRequestId = (row.infoRequestId || 0) + 1;
  infoQueue = infoQueue.filter(job => job.row !== row);
  const activeRequestKey = row.infoRequestKey;
  row.infoRequestKey = '';
  row.isFetchingInfo = false;
  if (activeRequestKey && window.api.tools.urlDownloader.cancelVideoInfo) {
    window.api.tools.urlDownloader.cancelVideoInfo(activeRequestKey).catch(() => {});
  }
  pumpInfoQueue();
}

function cancelAllInfoRequests() {
  infoQueue = [];
  rows.forEach(cancelInfoForRow);
}

function fetchInfoForRow(row, url) {
  if (isProcessing) return;
  if (!url || !isValidHttpUrl(url)) {
    cancelInfoForRow(row);
    row.info = null;
    row.isFetchingInfo = false;
    row.status = 'Waiting for URL';
    renderRows();
    return;
  }

  if (row.info && row.info.webpage_url === url) return;

  cancelInfoForRow(row);
  const requestId = row.infoRequestId;
  const requestKey = `${row.id}:${requestId}`;
  row.infoRequestKey = requestKey;
  row.isFetchingInfo = true;
  row.status = 'Fetching video info...';
  row.info = null;
  row.thumbnailDataUrl = null;
  renderRows();

  infoQueue.push({
    row,
    url,
    requestId,
    requestKey,
    options: {
      url,
      requestId: requestKey,
      cookiesFile: cookiesFile || undefined,
      cookieBrowser: document.getElementById('cookieBrowserSelect').value || undefined
    }
  });
  pumpInfoQueue();
}

function pumpInfoQueue() {
  while (activeInfoRequests < INFO_CONCURRENCY_LIMIT && infoQueue.length > 0) {
    const job = infoQueue.shift();
    if (job.row.infoRequestId !== job.requestId || job.row.infoRequestKey !== job.requestKey || !rows.includes(job.row)) {
      continue;
    }
    activeInfoRequests++;
    runInfoJob(job).finally(() => {
      activeInfoRequests--;
      pumpInfoQueue();
    });
  }
}

async function runInfoJob(job) {
  const { row, url, requestId, requestKey, options } = job;
  try {
    const res = await window.api.tools.urlDownloader.getVideoInfo(options);

    // The user may have edited the row again while yt-dlp was resolving the
    // previous URL. Never let a stale response restore the old value.
    if (row.infoRequestId !== requestId || row.infoRequestKey !== requestKey || row.url.trim() !== url) return;
    if (res && res.success && res.info) {
      row.info = res.info;
      row.status = 'Ready';
      row.url = url;
      loadThumbnailForRow(row);
    } else {
      row.info = null;
      row.status = 'Ready';
    }
  } catch (err) {
    if (row.infoRequestId !== requestId || row.infoRequestKey !== requestKey || row.url.trim() !== url) return;
    row.info = null;
    row.status = 'Ready';
  } finally {
    if (row.infoRequestId === requestId && row.infoRequestKey === requestKey) {
      row.infoRequestKey = '';
      row.isFetchingInfo = false;
      renderRows();
    }
  }
}

// Thumbnails are remote https images, which the app's CSP (img-src 'self' data:
// file:) blocks from loading directly in an <img>. The main process fetches the
// bytes and returns a data: URL we can render inline.
async function loadThumbnailForRow(row) {
  const info = row.info;
  if (!info) return;
  let thumbUrl = info.thumbnail || '';
  if (!thumbUrl && Array.isArray(info.thumbnails) && info.thumbnails.length) {
    // thumbnails are ordered worst -> best; take the last valid one.
    for (let i = info.thumbnails.length - 1; i >= 0; i--) {
      if (info.thumbnails[i] && info.thumbnails[i].url) { thumbUrl = info.thumbnails[i].url; break; }
    }
  }
  if (!thumbUrl) return;

  try {
    const res = await window.api.tools.urlDownloader.getThumbnail({
      url: thumbUrl,
      referer: info.webpage_url || row.url || undefined
    });
    // Guard against a stale response after the row's URL changed.
    if (res && res.success && typeof res.dataUrl === 'string'
        && /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/]+=*$/i.test(res.dataUrl)
        && row.info === info) {
      row.thumbnailDataUrl = res.dataUrl;
      renderRows();
    }
  } catch {}
}

// Read the current advanced/queue settings into a plain options object. Read
// fresh per row so a setting changed mid-batch — or on a row added after the
// batch started — is honoured for that download.
function readDownloadOptions() {
  const num = (id) => {
    const v = document.getElementById(id).value;
    if (!v) return undefined;
    const parsed = parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    outputDir,
    cookiesFile: cookiesFile || undefined,
    format: qualitySelect ? qualitySelect.value : 'best',
    cookieBrowser: document.getElementById('cookieBrowserSelect').value || '',
    playlist: document.getElementById('playlistCheckbox').checked,
    maxDownloads: num('maxDownloadsInput'),
    limitRate: document.getElementById('limitRateInput').value,
    subtitles: document.getElementById('subtitlesSelect').value,
    subLangs: document.getElementById('subLangsInput').value,
    customFormat: document.getElementById('customFormatInput').value,
    filenameTemplate: document.getElementById('filenameTemplateSelect').value,
    skipSponsors: document.getElementById('skipSponsorsCheckbox').checked,
    embedMetadata: document.getElementById('embedMetadataCheckbox').checked,
    embedThumbnail: document.getElementById('embedThumbnailCheckbox').checked,
    splitChapters: document.getElementById('splitChaptersCheckbox').checked,
    writeDescription: document.getElementById('writeDescriptionCheckbox').checked,
    writeThumbnail: document.getElementById('writeThumbnailCheckbox').checked,
    audioFormat: document.getElementById('audioFormatSelect').value,
    writeAutoSubs: document.getElementById('writeAutoSubsCheckbox').checked,
    timeRange: document.getElementById('timeRangeInput').value,
    concurrentFragments: num('concurrentFragmentsInput'),
    proxy: document.getElementById('proxyInput').value,
    username: document.getElementById('usernameInput').value,
    password: document.getElementById('passwordInput').value,
    videoPassword: document.getElementById('videoPasswordInput').value,
    geoBypass: document.getElementById('geoBypassCheckbox').checked
  };
}

// Queue concurrency (Advanced settings). Defaults to 3, clamped to 1-10 so a
// stray value can't spawn an unbounded number of yt-dlp processes or stall the
// queue with 0 workers.
function readConcurrencyLimit() {
  const raw = parseInt(document.getElementById('simultaneousDownloadsInput').value, 10);
  return Number.isFinite(raw) ? Math.min(10, Math.max(1, raw)) : 3;
}

// A row is eligible for a worker when the user has queued it and it still has a
// downloadable state and a valid URL.
function isQueuable(row) {
  const url = (row.url || '').trim();
  return !!row.queued && !!url && isValidHttpUrl(url) && (row.state === 'pending' || row.state === 'error');
}

function countQueued() {
  return rows.filter(isQueuable).length;
}

function batchTotal() {
  return batchRowIds.size;
}

function batchCompleted() {
  return rows.filter(r => batchRowIds.has(r.id) && (r.state === 'complete' || r.state === 'error')).length;
}

// Claim the next queued row for a worker, flipping it to `processing` so no
// other worker grabs it. Returns null when nothing is queued.
function claimNextRow() {
  for (const row of rows) {
    if (!isQueuable(row)) continue;
    row.url = (row.url || '').trim();
    row.queued = false;
    row.state = 'processing';
    row.status = 'Starting...';
    row.progress = 0;
    return row;
  }
  return null;
}

// Spawn workers up to the concurrency limit while there is queued work. Safe to
// call repeatedly — worker() increments activeWorkers synchronously at its top,
// so this never over-spawns. Called at batch start and on every live add.
function ensureWorkers() {
  if (!isProcessing || cancelRequested) return;
  const target = Math.min(concurrencyLimit, activeWorkers + countQueued());
  while (activeWorkers < target) {
    worker();
  }
}

// Add a row to the queue. When a batch is already running the row is picked up
// by a free worker (or a freshly spawned one, up to the limit); otherwise it
// simply waits for the next Download All / per-row download.
function enqueueRow(row) {
  const url = (row.url || '').trim();
  if (!url || !isValidHttpUrl(url) || row.state === 'processing' || cancelRequested) return;
  const duplicate = rows.find(other => other !== row
    && batchRowIds.has(other.id)
    && (other.queued || other.state === 'processing')
    && (other.url || '').trim() === url);
  if (duplicate) {
    row.queued = false;
    row.state = 'error';
    row.status = 'Duplicate URL';
    row.progress = 0;
    batchRowIds.add(row.id);
    renderRows();
    updateBatchStatus();
    return;
  }
  row.url = url;
  row.queued = true;
  row.state = 'pending';
  row.status = 'Queued...';
  batchRowIds.add(row.id);
  batchTotalFiles = batchTotal();
  renderRows();
  ensureWorkers();
}

async function worker() {
  activeWorkers++;
  try {
    while (isProcessing && !cancelRequested) {
      const row = claimNextRow();
      if (!row) break;
      renderRows();

      let result;
      try {
        result = await window.api.tools.urlDownloader.downloadVideoUrl({
          url: row.url,
          ...readDownloadOptions()
        });
      } catch (err) {
        result = { success: false, error: err.message || String(err) };
      }

      if (cancelRequested && !(result && result.success)) {
        row.state = 'pending';
        row.status = 'Cancelled';
        row.progress = 0;
        break;
      }

      if (result && result.success) {
        row.state = 'complete';
        row.progress = 1;
        row.status = 'Complete';
        row.output = typeof result.output === 'string' ? result.output : '';
        if (typeof result.outputDir === 'string' && result.outputDir) lastOutputDir = result.outputDir;
        if (row.output) {
          lastOutputs.push(row.output);
          if (window.addRecentFile) window.addRecentFile(row.output);
        }
        log(`Downloaded: ${row.url}`, 'success');
      } else {
        row.state = 'error';
        row.progress = 0;
        row.status = result && typeof result.error === 'string' ? result.error : 'Download failed';
        log(`Download failed: ${row.url} - ${row.status}`, 'error');
      }

      updateBatchStatus();
      renderRows();
      if (cancelRequested) break;
    }
  } finally {
    activeWorkers--;
    // The worker that drains the last active slot finalizes the batch. This
    // covers both a clean finish and a user cancel.
    if (activeWorkers === 0) finishBatch();
  }
}

// Keep the top-bar status line, taskbar progress, and ETA in sync mid-batch.
function updateBatchStatus() {
  const total = batchTotal();
  if (statusText && total > 1) {
    statusText.textContent = `Downloading ${total} video URL(s) (${batchCompleted()}/${total} complete)`;
  }
  const batch = rows.filter(r => batchRowIds.has(r.id));
  const totalProgress = batch.reduce((sum, r) => sum + (r.progress || 0), 0) / (batch.length || 1);
  if (window.setTaskbarProgress) window.setTaskbarProgress(totalProgress);
  if (etaText && window.calculateETA) {
    etaText.textContent = window.calculateETA(batchStartTime, total, batch);
  }
}

// `onlyRow` (optional) restricts the download to a single queue row — used by
// the per-row Download button when idle. When omitted, every pending/failed
// row in the queue is processed (the "Download All" button).
async function startDownload(onlyRow = null) {
  if (isProcessing) {
    // The primary button toggles to Cancel while a batch is running.
    if (cancelRequested) return;
    cancelRequested = true;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Cancelling...';
    try { await window.api.tools.urlDownloader.cancelUrlDownload(); } catch {}
    return;
  }

  const single = onlyRow && onlyRow.id ? onlyRow : null;
  const targetRows = single ? [single] : rows;

  // Trim, and allow a completed row to be re-downloaded on an explicit click.
  targetRows.forEach(row => {
    row.url = (row.url || '').trim();
    if (row.url && row.state === 'complete') row.state = 'pending';
  });

  const invalid = targetRows.filter(row => row.url && !isValidHttpUrl(row.url));
  if (invalid.length > 0) {
    invalid.forEach(row => { row.state = 'error'; row.status = 'Invalid URL'; });
    renderRows();
    log(single ? 'That URL is invalid. Use a full http or https link.'
              : 'One or more URLs are invalid. Use full http or https links.', 'error');
    if (single) return;
  }

  const duplicateRows = [];
  const seenUrls = new Set();
  const candidates = targetRows.filter(row => row.url && isValidHttpUrl(row.url)
    && (row.state === 'pending' || row.state === 'error'));
  const toQueue = single ? candidates : candidates.filter(row => {
    if (!seenUrls.has(row.url)) {
      seenUrls.add(row.url);
      return true;
    }
    row.queued = false;
    row.state = 'error';
    row.status = 'Duplicate URL';
    row.progress = 0;
    duplicateRows.push(row);
    return false;
  });
  if (toQueue.length === 0) return;

  // Metadata probes are advisory; reclaim their yt-dlp processes before the
  // real downloads start so they do not compete for CPU/network resources.
  cancelAllInfoRequests();

  concurrencyLimit = readConcurrencyLimit();
  batchRowIds = new Set([...toQueue, ...duplicateRows].map(r => r.id));
  toQueue.forEach(row => { row.queued = true; row.status = 'Queued...'; });

  isProcessing = true;
  cancelRequested = false;
  batchStartTime = Date.now();
  batchTotalFiles = batchTotal();
  lastOutputs = [];
  downloadBtn.disabled = false;
  downloadBtn.textContent = 'Cancel';
  downloadBtn.classList.add('btn-cancel');
  processingIndicator.classList.add('active');
  retryBtn.style.display = 'none';
  openOutputBtn.style.display = '';
  statusText.textContent = `Downloading ${toQueue.length} video URL(s)...`;
  if (etaText) etaText.textContent = '';
  updateButton();

  log(`Starting online video downloads: ${toQueue.length} URL(s)`);

  ensureWorkers();
}

// Finalize a batch once every worker has drained. Reached from the last
// worker's finally block, so it runs exactly once per batch.
function finishBatch() {
  if (!isProcessing && !cancelRequested) return;
  const wasCancelled = cancelRequested;
  isProcessing = false;
  cancelRequested = false;
  // Clear the stale "Queued..." label from rows that were queued but never
  // started (e.g. after a cancel). They stay pending so Download All can resume
  // them, but shouldn't look like they're still waiting on a worker.
  rows.forEach(r => {
    if (r.queued) {
      r.queued = false;
      if (r.state === 'pending') r.status = wasCancelled ? 'Cancelled' : 'Waiting for URL';
    }
  });
  if (window.setTaskbarProgress) window.setTaskbarProgress(-1);
  downloadBtn.textContent = 'Download All';
  downloadBtn.classList.remove('btn-cancel');
  downloadBtn.disabled = false;
  processingIndicator.classList.remove('active');

  // Report only this batch. Previously a one-row retry included every old
  // completed/failed row still visible in the queue.
  const batchRows = rows.filter(row => batchRowIds.has(row.id));
  const completed = batchRows.filter(row => row.state === 'complete').length;
  const errors = batchRows.filter(row => row.state === 'error').length;
  const cancelledCount = batchRows.filter(row => row.status === 'Cancelled').length;

  if (wasCancelled) {
    statusText.textContent = `Cancelled! ${completed} downloaded, ${cancelledCount} cancelled`;
  } else {
    statusText.textContent = `Done! ${completed} downloaded${errors > 0 ? `, ${errors} failed` : ''}`;
  }

  openOutputBtn.style.display = completed > 0 && lastOutputDir ? '' : 'none';
  retryBtn.style.display = errors > 0 ? '' : 'none';
  updateButton();

  if (window.showCompletionToast) {
    const message = wasCancelled
      ? `Downloads cancelled: ${completed} downloaded, ${cancelledCount} cancelled`
      : `Downloads complete: ${completed} downloaded${errors > 0 ? `, ${errors} failed` : ''}`;
    window.showCompletionToast(message, !wasCancelled && errors > 0, lastOutputs);
  }
  if (!wasCancelled && window.autoOpenOutputIfEnabled && completed > 0) window.autoOpenOutputIfEnabled(lastOutputDir);
  renderRows();
}

function handleProgress(data) {
  if (!data || typeof data !== 'object' || typeof data.url !== 'string') return;
  const row = rows.find(item => batchRowIds.has(item.id)
    && item.state === 'processing'
    && item.url === data.url);
  if (!row) return;

  if (data.type === 'progress') {
    row.state = 'processing';
    row.progress = Number.isFinite(data.progress) ? Math.min(1, Math.max(0, data.progress)) : 0;
    row.status = typeof data.status === 'string' ? data.status : 'Downloading...';
  } else if (data.type === 'complete') {
    row.state = 'complete';
    row.progress = 1;
    row.status = 'Complete';
    row.output = typeof data.output === 'string' ? data.output : row.output;
  } else if (data.type === 'start') {
    row.state = 'processing';
    if (Number.isFinite(data.progress)) {
      row.progress = Math.min(1, Math.max(row.progress || 0, data.progress));
    }
    row.status = typeof data.status === 'string' ? data.status : 'Starting...';
  }

  // Status line: single-file batch shows the live per-row status; a multi-file
  // batch shows the "x/y complete" roll-up (x/y grow as rows are added live).
  if (statusText) {
    if (batchTotal() <= 1) {
      statusText.textContent = data.type === 'complete' ? 'Download complete' : row.status;
    } else {
      statusText.textContent = `Downloading ${batchTotal()} video URL(s) (${batchCompleted()}/${batchTotal()} complete)`;
    }
  }

  const batch = rows.filter(r => batchRowIds.has(r.id));
  const totalProgress = batch.reduce((sum, r) => sum + (r.progress || 0), 0) / (batch.length || 1);
  const allDone = batch.length > 0 && batch.every(r => r.state === 'complete' || r.state === 'error');
  if (window.setTaskbarProgress) window.setTaskbarProgress(allDone ? -1 : totalProgress);

  if (etaText && window.calculateETA) {
    etaText.textContent = window.calculateETA(batchStartTime, batchTotal(), batch);
  }

  renderRows();
}

function formatDuration(seconds) {
  seconds = Number(seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function renderRows() {
  if (window.updateQueueSummary) window.updateQueueSummary(rows.filter(row => row.url.trim()), 'url-downloader');
  urlList.innerHTML = '';
  
  rows.forEach(row => {
    const el = document.createElement('div');
    el.className = `url-row state-${row.state}`;

    let progressClass = '';
    if (row.state === 'complete') progressClass = ' complete';
    else if (row.state === 'error') progressClass = ' error';

    const percent = Math.round(Math.min(1, Math.max(0, Number(row.progress) || 0)) * 100);
    const showPercent = row.state === 'processing' || row.state === 'complete';
    
    let statusDisplay = window.escapeHtml(String(row.status || ''));
    if (row.isFetchingInfo) {
      statusDisplay = `<span class="url-row-spinner"></span>Fetching info...`;
    }

    let mainContentHtml = '';
    
    if (row.info && !row.isEditing) {
      // Info preview mode
      const durationStr = row.info.duration ? formatDuration(row.info.duration) : '';
      const titleStr = row.info.title || row.info.fulltitle || row.info.id || 'Untitled';
      const uploaderStr = row.info.uploader || row.info.channel || row.info.uploader_id
        || row.info.extractor_key || row.info.webpage_url_domain || 'Unknown';
      // Only a data: URL (fetched by the main process) is renderable under the
      // app CSP; remote https thumbnails are blocked, so skip the <img> until
      // the data URL arrives rather than showing a broken-image icon.
      const thumbnailSrc = typeof row.thumbnailDataUrl === 'string'
        && /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/]+=*$/i.test(row.thumbnailDataUrl)
        ? row.thumbnailDataUrl : '';

      mainContentHtml = `
        <div class="url-main has-info">
          <div class="url-thumbnail-container">
            ${thumbnailSrc ? `<img src="${thumbnailSrc}" class="url-thumbnail" alt="">` : ''}
          </div>
          <div class="url-info-details">
            <span class="url-video-title" title="${window.escapeHtml(titleStr)}">${window.escapeHtml(titleStr)}</span>
            <div class="url-video-meta">
              <span class="url-video-uploader">${window.escapeHtml(uploaderStr)}</span>
              ${durationStr ? `<span class="url-video-duration">${durationStr}</span>` : ''}
            </div>
          </div>
          <div class="url-row-actions">
            <button class="url-action-btn download-url-btn" title="Download this video" ${row.state === 'processing' ? 'disabled' : ''}>${DOWNLOAD_SVG}</button>
            <button class="url-action-btn edit-url-btn" title="Edit URL">${EDIT_SVG}</button>
            ${row.output ? `<button class="url-output" title="${window.escapeHtml(row.output)}">Open file</button>` : ''}
          </div>
        </div>
      `;
    } else {
      // Edit URL mode
      mainContentHtml = `
        <div class="url-main">
          <input class="url-input" type="url" placeholder="https://example.com/watch..." value="${window.escapeHtml(row.url)}" ${row.state === 'processing' ? 'disabled' : ''}>
          <div class="url-main-actions">
            ${row.url.trim() ? `<button class="url-action-btn download-url-btn" title="Download this video" ${row.state === 'processing' ? 'disabled' : ''}>${DOWNLOAD_SVG}</button>` : ''}
            ${row.info ? `<button class="url-action-btn cancel-edit-btn" title="Cancel edit">&times;</button>` : ''}
            ${row.output ? `<button class="url-output" title="${window.escapeHtml(row.output)}">Open file</button>` : ''}
          </div>
        </div>
      `;
    }

    el.innerHTML = `
      ${mainContentHtml}
      <div class="url-state" title="${window.escapeHtml(String(row.status || ''))}">${statusDisplay}</div>
      <button class="url-remove" title="Remove from list" ${row.state === 'processing' ? 'disabled' : ''}>&times;</button>
      <div class="url-progress">
        <div class="url-progress-fill${progressClass}" style="width: ${percent}%"></div>
        ${showPercent ? `<div class="url-progress-text">${percent}%</div>` : ''}
      </div>
    `;

    // Hook events
    const input = el.querySelector('.url-input');
    if (input) {
      input.addEventListener('input', () => {
        cancelInfoForRow(row);
        row.url = input.value.trim();
        row.state = 'pending';
        row.status = 'Waiting for URL';
        row.progress = 0;
        row.info = null;
        row.thumbnailDataUrl = null;
        // Un-queue while the URL is being edited so a worker can't grab a
        // half-typed (transiently valid) URL; the debounce re-queues it.
        row.queued = false;

        clearTimeout(row.fetchTimeout);
        if (isValidHttpUrl(row.url)) {
          row.fetchTimeout = setTimeout(() => {
            // Mid-batch, a finished-typing valid URL joins the live queue;
            // otherwise just fetch its preview info.
            if (isProcessing) enqueueRow(row);
            else fetchInfoForRow(row, row.url);
          }, 1000);
        }

        updateButton();
      });
      
      input.addEventListener('paste', () => {
        setTimeout(() => {
          const value = input.value.trim();
          const parts = value.split(/\s+/).filter(Boolean);
          if (parts.length > 1 && parts.every(isValidHttpUrl)) {
            row.url = parts.shift();
            parts.forEach(url => addRow(url));
            renderRows();
            updateButton();
          }

          if (isProcessing) {
            // Live-add: join every valid, not-yet-running URL to the queue.
            rows.forEach(r => {
              if (r.state !== 'processing' && r.state !== 'complete' && isValidHttpUrl((r.url || '').trim())) {
                enqueueRow(r);
              }
            });
          } else {
            rows.forEach(r => {
              if (r.url && isValidHttpUrl(r.url) && !r.info && !r.isFetchingInfo) {
                fetchInfoForRow(r, r.url);
              }
            });
          }
        }, 50);
      });
    }

    const downloadUrlBtn = el.querySelector('.download-url-btn');
    if (downloadUrlBtn) {
      downloadUrlBtn.addEventListener('click', () => {
        row.url = (row.url || '').trim();
        if (!row.url || !isValidHttpUrl(row.url)) {
          log('Enter a valid http or https URL before downloading this row.', 'error');
          return;
        }
        if (row.state === 'processing') return;
        // Mid-batch this row joins the running queue; idle it starts a new
        // single-row batch.
        if (isProcessing) enqueueRow(row);
        else startDownload(row);
      });
    }

    const editUrlBtn = el.querySelector('.edit-url-btn');
    if (editUrlBtn) {
      editUrlBtn.addEventListener('click', () => {
        row.isEditing = true;
        renderRows();
        setTimeout(() => {
          const inp = el.querySelector('.url-input');
          if (inp) {
            inp.focus();
            inp.select();
          }
        }, 0);
      });
    }

    const cancelEditBtn = el.querySelector('.cancel-edit-btn');
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', () => {
        row.isEditing = false;
        renderRows();
      });
    }

    const outputBtn = el.querySelector('.url-output');
    if (outputBtn) {
      outputBtn.addEventListener('click', () => window.api.system.openPath(row.output));
    }

    el.querySelector('.url-remove').addEventListener('click', () => removeRow(row.id));
    urlList.appendChild(el);
  });
}

function updateButton() {
  const hasUrl = rows.some(row => row.url.trim());
  downloadBtn.disabled = !hasUrl && !isProcessing;
  // The queue accepts new rows even while a batch is downloading.
  addUrlBtn.disabled = false;
}

function updateCookiesButton() {
  if (!cookiesFileBtn) return;
  if (!cookiesFile) {
    cookiesFileBtn.textContent = 'None (optional)';
    cookiesFileBtn.title = 'Select a cookies.txt file for age-gated or login-required sites (right-click to clear)';
    return;
  }
  const name = cookiesFile.replace(/\\/g, '/').split('/').pop();
  cookiesFileBtn.textContent = name;
  cookiesFileBtn.title = cookiesFile + ' — right-click to clear';
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
    if (s.cookiesFile) { cookiesFile = s.cookiesFile; updateCookiesButton(); }
    updateOutputButton();
    if (outputDir) openOutputBtn.style.display = '';

    if (s.quality && qualitySelect) qualitySelect.value = s.quality;
    if (s.cookieBrowser) document.getElementById('cookieBrowserSelect').value = s.cookieBrowser;
    if (s.playlist !== undefined) document.getElementById('playlistCheckbox').checked = s.playlist;
    if (s.maxDownloads !== undefined) document.getElementById('maxDownloadsInput').value = s.maxDownloads;
    if (s.limitRate !== undefined) document.getElementById('limitRateInput').value = s.limitRate;
    if (s.subtitles !== undefined) document.getElementById('subtitlesSelect').value = s.subtitles;
    if (s.subLangs !== undefined) document.getElementById('subLangsInput').value = s.subLangs;
    if (s.customFormat !== undefined) document.getElementById('customFormatInput').value = s.customFormat;
    if (s.filenameTemplate !== undefined) document.getElementById('filenameTemplateSelect').value = s.filenameTemplate;
    if (s.skipSponsors !== undefined) document.getElementById('skipSponsorsCheckbox').checked = s.skipSponsors;
    if (s.embedMetadata !== undefined) document.getElementById('embedMetadataCheckbox').checked = s.embedMetadata;
    if (s.embedThumbnail !== undefined) document.getElementById('embedThumbnailCheckbox').checked = s.embedThumbnail;
    if (s.splitChapters !== undefined) document.getElementById('splitChaptersCheckbox').checked = s.splitChapters;
    if (s.writeDescription !== undefined) document.getElementById('writeDescriptionCheckbox').checked = s.writeDescription;
    if (s.writeThumbnail !== undefined) document.getElementById('writeThumbnailCheckbox').checked = s.writeThumbnail;
    if (s.audioFormat !== undefined) document.getElementById('audioFormatSelect').value = s.audioFormat;
    if (s.writeAutoSubs !== undefined) document.getElementById('writeAutoSubsCheckbox').checked = s.writeAutoSubs;
    if (s.timeRange !== undefined) document.getElementById('timeRangeInput').value = s.timeRange;
    if (s.concurrentFragments !== undefined) document.getElementById('concurrentFragmentsInput').value = s.concurrentFragments;
    if (s.simultaneousDownloads !== undefined) document.getElementById('simultaneousDownloadsInput').value = s.simultaneousDownloads;
    if (s.proxy !== undefined) document.getElementById('proxyInput').value = s.proxy;
    if (s.username !== undefined) document.getElementById('usernameInput').value = s.username;
    if (s.geoBypass !== undefined) document.getElementById('geoBypassCheckbox').checked = s.geoBypass;

    updateDependencies();
  } catch {}
}

let _saveTimer = null;
function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.updateSettings(all => {
      all['url-downloader'] = {
        outputDir,
        cookiesFile: cookiesFile || undefined,
        quality: qualitySelect ? qualitySelect.value : 'best',
        cookieBrowser: document.getElementById('cookieBrowserSelect').value || '',
        playlist: document.getElementById('playlistCheckbox').checked,
        maxDownloads: document.getElementById('maxDownloadsInput').value,
        limitRate: document.getElementById('limitRateInput').value,
        subtitles: document.getElementById('subtitlesSelect').value,
        subLangs: document.getElementById('subLangsInput').value,
        customFormat: document.getElementById('customFormatInput').value,
        filenameTemplate: document.getElementById('filenameTemplateSelect').value,
        skipSponsors: document.getElementById('skipSponsorsCheckbox').checked,
        embedMetadata: document.getElementById('embedMetadataCheckbox').checked,
        embedThumbnail: document.getElementById('embedThumbnailCheckbox').checked,
        splitChapters: document.getElementById('splitChaptersCheckbox').checked,
        writeDescription: document.getElementById('writeDescriptionCheckbox').checked,
        writeThumbnail: document.getElementById('writeThumbnailCheckbox').checked,
        audioFormat: document.getElementById('audioFormatSelect').value,
        writeAutoSubs: document.getElementById('writeAutoSubsCheckbox').checked,
        timeRange: document.getElementById('timeRangeInput').value,
        concurrentFragments: document.getElementById('concurrentFragmentsInput').value,
        simultaneousDownloads: document.getElementById('simultaneousDownloadsInput').value,
        proxy: document.getElementById('proxyInput').value,
        username: document.getElementById('usernameInput').value,
        geoBypass: document.getElementById('geoBypassCheckbox').checked
      };
    }).catch(err => log('Could not save settings: ' + err.message, 'warn'));
  }, 300);
}

window.registerTool('url-downloader', { init, cleanup });

})();
