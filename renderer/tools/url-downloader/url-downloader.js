// ============================================================================
// Online Video Downloader Tool
// ============================================================================

(function() {

let rows = [];
let outputDir = '';
let cookiesFile = '';
let isProcessing = false;
let log = null;
let progressCleanup = null;
let lastOutputDir = '';
let lastOutputs = [];
let batchStartTime = 0;
let batchTotalFiles = 0;

let urlList, addUrlBtn, downloadBtn, clearBtn, retryBtn, openOutputBtn;
let outputDirBtn, qualitySelect, cookiesFileBtn, statusText, processingIndicator, etaText;

const EDIT_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

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
  cookiesFileBtn = document.getElementById('cookiesFileBtn');
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
    if (isProcessing) return;
    const dir = await window.api.system.selectOutputDir();
    if (dir) {
      outputDir = dir;
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
    'concurrentFragmentsInput', 'proxyInput', 'usernameInput', 
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
          alert('Downloader dependencies (yt-dlp) updated successfully!');
        } else {
          log('Upgrade failed: ' + (res.error || 'Unknown error'), 'error');
          alert('Failed to update: ' + (res.error || 'Unknown error'));
        }
      } catch (err) {
        log('Upgrade error: ' + err.message, 'error');
        alert('Error updating: ' + err.message);
      } finally {
        updateYtDlpBtn.classList.remove('updating');
        textSpan.textContent = 'Update Downloader (yt-dlp)';
      }
    });
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
    if (lastOutputDir) window.api.system.openFolder(lastOutputDir);
  });

  downloadBtn.addEventListener('click', startDownload);

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
    isFetchingInfo: false,
    isEditing: false
  };
  rows.push(row);
  renderRows();
  updateButton();
  
  if (value && isValidHttpUrl(value)) {
    fetchInfoForRow(row, value);
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
    isFetchingInfo: false,
    isEditing: false
  };
}

function removeRow(id) {
  if (isProcessing) return;
  const row = rows.find(r => r.id === id);
  if (row && row.fetchTimeout) clearTimeout(row.fetchTimeout);
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

async function fetchInfoForRow(row, url) {
  if (isProcessing) return;
  if (!url || !isValidHttpUrl(url)) {
    row.info = null;
    row.isFetchingInfo = false;
    row.status = 'Waiting for URL';
    renderRows();
    return;
  }

  if (row.info && row.info.webpage_url === url) return;

  row.isFetchingInfo = true;
  row.status = 'Fetching video info...';
  row.info = null;
  renderRows();

  try {
    const res = await window.api.tools.urlDownloader.getVideoInfo({
      url,
      cookiesFile: cookiesFile || undefined,
      cookieBrowser: document.getElementById('cookieBrowserSelect').value || undefined
    });

    if (res && res.success && res.info) {
      row.info = res.info;
      row.status = 'Ready';
      row.url = url;
    } else {
      row.info = null;
      row.status = 'Ready';
    }
  } catch (err) {
    row.info = null;
    row.status = 'Ready';
  } finally {
    row.isFetchingInfo = false;
    renderRows();
  }
}

async function startDownload() {
  if (isProcessing) {
    isProcessing = false;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Cancelling...';
    try { await window.api.tools.urlDownloader.cancelUrlDownload(); } catch {}
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

  // Read current settings options to pass down
  const format = qualitySelect ? qualitySelect.value : 'best';
  const cookieBrowser = document.getElementById('cookieBrowserSelect').value || '';
  const playlist = document.getElementById('playlistCheckbox').checked;
  const maxDownloads = document.getElementById('maxDownloadsInput').value;
  const limitRate = document.getElementById('limitRateInput').value;
  const subtitles = document.getElementById('subtitlesSelect').value;
  const subLangs = document.getElementById('subLangsInput').value;
  const customFormat = document.getElementById('customFormatInput').value;
  const filenameTemplate = document.getElementById('filenameTemplateSelect').value;
  const skipSponsors = document.getElementById('skipSponsorsCheckbox').checked;
  const embedMetadata = document.getElementById('embedMetadataCheckbox').checked;
  const embedThumbnail = document.getElementById('embedThumbnailCheckbox').checked;
  const splitChapters = document.getElementById('splitChaptersCheckbox').checked;
  const writeDescription = document.getElementById('writeDescriptionCheckbox').checked;
  const writeThumbnail = document.getElementById('writeThumbnailCheckbox').checked;
  const audioFormat = document.getElementById('audioFormatSelect').value;
  const writeAutoSubs = document.getElementById('writeAutoSubsCheckbox').checked;
  const timeRange = document.getElementById('timeRangeInput').value;
  const concurrentFragments = document.getElementById('concurrentFragmentsInput').value;
  const proxy = document.getElementById('proxyInput').value;
  const username = document.getElementById('usernameInput').value;
  const password = document.getElementById('passwordInput').value;
  const videoPassword = document.getElementById('videoPasswordInput').value;
  const geoBypass = document.getElementById('geoBypassCheckbox').checked;

  async function worker() {
    while (isProcessing && index < pending.length) {
      const row = pending[index++];
      row.state = 'processing';
      row.status = 'Starting...';
      row.progress = 0;
      renderRows();

      let result;
      try {
        result = await window.api.tools.urlDownloader.downloadVideoUrl({
          url: row.url,
          outputDir,
          cookiesFile: cookiesFile || undefined,
          format,
          cookieBrowser,
          playlist,
          maxDownloads: maxDownloads ? parseInt(maxDownloads) : undefined,
          limitRate,
          subtitles,
          subLangs,
          customFormat,
          filenameTemplate,
          skipSponsors,
          embedMetadata,
          embedThumbnail,
          splitChapters,
          writeDescription,
          writeThumbnail,
          audioFormat,
          writeAutoSubs,
          timeRange,
          concurrentFragments: concurrentFragments ? parseInt(concurrentFragments) : undefined,
          proxy,
          username,
          password,
          videoPassword,
          geoBypass
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
  downloadBtn.textContent = 'Download All';
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

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
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
    
    let statusDisplay = row.status;
    if (row.isFetchingInfo) {
      statusDisplay = `<span class="url-row-spinner"></span>Fetching info...`;
    }

    let mainContentHtml = '';
    
    if (row.info && !row.isEditing) {
      // Info preview mode
      const durationStr = row.info.duration ? formatDuration(row.info.duration) : '';
      const uploaderStr = row.info.uploader || row.info.channel || 'Unknown';
      const thumbnailSrc = row.info.thumbnail || '';
      
      mainContentHtml = `
        <div class="url-main has-info">
          <div class="url-thumbnail-container">
            ${thumbnailSrc ? `<img src="${thumbnailSrc}" class="url-thumbnail" onerror="this.style.display='none'">` : ''}
          </div>
          <div class="url-info-details">
            <span class="url-video-title" title="${window.escapeHtml(row.info.title)}">${window.escapeHtml(row.info.title)}</span>
            <div class="url-video-meta">
              <span class="url-video-uploader">${window.escapeHtml(uploaderStr)}</span>
              ${durationStr ? `<span class="url-video-duration">${durationStr}</span>` : ''}
            </div>
          </div>
          <div class="url-row-actions">
            <button class="url-action-btn edit-url-btn" title="Edit URL">${EDIT_SVG}</button>
            ${row.output ? `<button class="url-output" title="${window.escapeHtml(row.output)}">Open file</button>` : ''}
          </div>
        </div>
      `;
    } else {
      // Edit URL mode
      mainContentHtml = `
        <div class="url-main">
          <input class="url-input" type="url" placeholder="https://example.com/watch..." value="${window.escapeHtml(row.url)}" ${isProcessing ? 'disabled' : ''}>
          ${row.info ? `<button class="url-action-btn cancel-edit-btn" title="Cancel edit" style="margin-left: 4px;">&times;</button>` : ''}
          ${row.output ? `<button class="url-output" title="${window.escapeHtml(row.output)}">Open file</button>` : ''}
        </div>
      `;
    }

    el.innerHTML = `
      ${mainContentHtml}
      <div class="url-state" title="${window.escapeHtml(row.status)}">${statusDisplay}</div>
      <button class="url-remove" title="Remove from list" ${isProcessing ? 'disabled' : ''}>&times;</button>
      <div class="url-progress">
        <div class="url-progress-fill${progressClass}" style="width: ${percent}%"></div>
        ${showPercent ? `<div class="url-progress-text">${percent}%</div>` : ''}
      </div>
    `;

    // Hook events
    const input = el.querySelector('.url-input');
    if (input) {
      input.addEventListener('input', () => {
        row.url = input.value.trim();
        row.state = 'pending';
        row.status = 'Waiting for URL';
        row.progress = 0;
        row.info = null;
        
        clearTimeout(row.fetchTimeout);
        if (isValidHttpUrl(row.url)) {
          row.fetchTimeout = setTimeout(() => {
            fetchInfoForRow(row, row.url);
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
          
          rows.forEach(r => {
            if (r.url && isValidHttpUrl(r.url) && !r.info && !r.isFetchingInfo) {
              fetchInfoForRow(r, r.url);
            }
          });
        }, 50);
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
  addUrlBtn.disabled = isProcessing;
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
    if (s.proxy !== undefined) document.getElementById('proxyInput').value = s.proxy;
    if (s.username !== undefined) document.getElementById('usernameInput').value = s.username;
    if (s.password !== undefined) document.getElementById('passwordInput').value = s.password;
    if (s.videoPassword !== undefined) document.getElementById('videoPasswordInput').value = s.videoPassword;
    if (s.geoBypass !== undefined) document.getElementById('geoBypassCheckbox').checked = s.geoBypass;

    updateDependencies();
  } catch {}
}

let _saveTimer = null;
function saveToolSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.loadAllSettings().then(all => {
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
        proxy: document.getElementById('proxyInput').value,
        username: document.getElementById('usernameInput').value,
        password: document.getElementById('passwordInput').value,
        videoPassword: document.getElementById('videoPasswordInput').value,
        geoBypass: document.getElementById('geoBypassCheckbox').checked
      };
      window.saveAllSettings(all);
    });
  }, 300);
}

window.registerTool('url-downloader', { init, cleanup });

})();
