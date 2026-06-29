// ============================================================================
// MuxMelt - App Shell
// Handles sidebar navigation, tool loading, log panel, GPU stats
// ============================================================================

let pythonPort = null;
let pythonToken = null;
let currentToolId = null;
let currentToolModule = null;
let _vramTimer = null;
let _vramFailCount = 0;

// DOM elements
const toolContent = document.getElementById('toolContent');
const logEntries = document.getElementById('logEntries');
const logPanel = document.getElementById('logPanel');
const logToggle = document.getElementById('logToggle');
const gpuBadge = document.getElementById('gpuBadge');
const gpuStats = document.getElementById('gpuStats');
const gpuUtilStat = document.getElementById('gpuUtilStat');
const gpuTempStat = document.getElementById('gpuTempStat');
const gpuMemStat = document.getElementById('gpuMemStat');
// versionBadge removed — version now shown in Settings
const toolStylesheet = document.getElementById('toolStylesheet');

// ============================================================================
// Log panel
// ============================================================================

const logsByTool = {};
const MAX_LOG_ENTRIES_PER_TOOL = 200;

function setLogCollapsed(collapsed) {
  logPanel.classList.toggle('collapsed', collapsed);
  logToggle.setAttribute('aria-expanded', String(!collapsed));
}

function toggleLogPanel() {
  setLogCollapsed(!logPanel.classList.contains('collapsed'));
  saveGlobalSettings();
}

logToggle.addEventListener('click', toggleLogPanel);
// The log header is a div acting as a button, so make it keyboard-operable too.
logToggle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleLogPanel();
  }
});

function getLogToolId(toolId) {
  return toolId || currentToolId || 'app';
}

function createLogEntry(entry) {
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = `<span class="log-time">${entry.time}</span><span class="log-msg ${entry.level}">${escapeHtml(entry.message)}</span>`;
  return el;
}

function renderLogEntries(toolId = currentToolId) {
  const key = getLogToolId(toolId);
  const entries = logsByTool[key] || [];
  logEntries.innerHTML = '';
  entries.forEach(entry => logEntries.appendChild(createLogEntry(entry)));
  logEntries.parentElement.scrollTop = logEntries.parentElement.scrollHeight;
}

function log(message, level = 'info', toolId = currentToolId) {
  const key = getLogToolId(toolId);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = { time, message, level };

  logsByTool[key] = logsByTool[key] || [];
  logsByTool[key].push(entry);
  while (logsByTool[key].length > MAX_LOG_ENTRIES_PER_TOOL) {
    logsByTool[key].shift();
  }

  if (key === getLogToolId(currentToolId)) {
    logEntries.appendChild(createLogEntry(entry));
    while (logEntries.children.length > MAX_LOG_ENTRIES_PER_TOOL) {
      logEntries.removeChild(logEntries.firstChild);
    }
    logEntries.parentElement.scrollTop = logEntries.parentElement.scrollHeight;
  }
}

function clearLog(toolId = currentToolId) {
  logsByTool[getLogToolId(toolId)] = [];
  logEntries.innerHTML = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Make log and escapeHtml available globally for tools
window.log = log;
window.clearLog = clearLog;
window.escapeHtml = escapeHtml;

// ============================================================================
// Global utilities for tools
// ============================================================================

// Format file sizes for display
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
window.formatFileSize = formatFileSize;

// Show an in-app toast notification + native OS notification
function showCompletionToast(message, isError = false, outputFiles = []) {
  window.setTaskbarProgress(-1); // Clear on completion

  // Store last output files for workflow chaining
  if (outputFiles && outputFiles.length > 0) {
    window.lastOutputFiles = outputFiles;
  }

  // Remove existing toast
  const existing = document.querySelector('.completion-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'completion-toast' + (isError ? ' error' : '');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  let toastHTML = `<div class="toast-content"><div class="toast-message"><span class="completion-toast-icon">${isError ? '\u26A0' : '\u2714'}</span><span>${escapeHtml(message)}</span></div>`;

  // Add "Send to..." actions if we have output files and it's not an error
  if (!isError && outputFiles && outputFiles.length > 0) {
    const suggestions = getSendToSuggestions(outputFiles);
    if (suggestions.length > 0) {
      toastHTML += '<div class="toast-actions">';
      suggestions.forEach(s => {
        toastHTML += `<button class="toast-action" data-tool="${s.toolId}">Send to ${s.label}</button>`;
      });
      toastHTML += '</div>';
    }
  }

  toastHTML += '</div>';
  toast.innerHTML = toastHTML;

  // Bind "Send to" buttons
  toast.querySelectorAll('.toast-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.sendToTool(btn.dataset.tool);
      toast.remove();
    });
  });

  toast.addEventListener('click', (e) => {
    if (!e.target.classList.contains('toast-action')) toast.remove();
  });
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 7000);

  // Also fire a native OS notification (useful when app is in background)
  window.api.system.showNotification({
    title: 'MuxMelt',
    body: message
  });
}
window.showCompletionToast = showCompletionToast;

// Determine suggested tools based on output file types
function getSendToSuggestions(outputFiles) {
  if (!outputFiles || outputFiles.length === 0) return [];
  const ext = outputFiles[0].toLowerCase().split('.').pop();

  const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'tif', 'bmp', 'avif'];
  const videoExts = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
  const audioExts = ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma'];

  if (imageExts.includes(ext)) {
    return [
      { toolId: 'format-converter', label: 'Format Converter' },
      { toolId: 'upscaler', label: 'Upscaler' },
    ];
  }
  if (audioExts.includes(ext)) {
    return [
      { toolId: 'stem-separator', label: 'Stem Separator' },
    ];
  }
  if (videoExts.includes(ext)) {
    return [
      { toolId: 'format-converter', label: 'Format Converter' },
      { toolId: 'gif-maker', label: 'GIF Maker' },
    ];
  }
  return [];
}

// Send output files to another tool for chaining
window.sendToTool = function(toolId) {
  const files = window.lastOutputFiles || [];
  loadTool(toolId);
  // Dispatch paste-files after a short delay to let the tool initialize
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('paste-files', { detail: files }));
  }, 300);
};

// Auto-open output folder if setting is enabled
window.autoOpenOutputIfEnabled = async function(outputDir) {
  if (!outputDir) return;
  try {
    const all = await window.api.system.loadSettings();
    if (all.global && all.global.autoOpenOutput) {
      window.api.system.openFolder(outputDir);
    }
  } catch {}
};

// Recent files history — save output file paths after processing
const RECENT_FILES_MAX = 20;

window.addRecentFile = async function(filePath) {
  if (!filePath) return;
  try {
    const all = await window.api.system.loadSettings();
    all.global = all.global || {};
    let recent = all.global.recentFiles || [];
    // Remove duplicate if already exists
    recent = recent.filter(f => f !== filePath);
    // Add to front
    recent.unshift(filePath);
    // Trim to max
    if (recent.length > RECENT_FILES_MAX) recent = recent.slice(0, RECENT_FILES_MAX);
    all.global.recentFiles = recent;
    await window.api.system.saveSettings(all);
  } catch {}
};

window.getRecentFiles = async function() {
  try {
    const all = await window.api.system.loadSettings();
    return (all.global && all.global.recentFiles) || [];
  } catch { return []; }
};

window.clearRecentFiles = async function() {
  try {
    const all = await window.api.system.loadSettings();
    if (all.global) {
      all.global.recentFiles = [];
      await window.api.system.saveSettings(all);
    }
  } catch {}
};

// Set Windows taskbar progress (0-1, or -1 to clear)
window.setTaskbarProgress = function(value) {
  try { window.api.system.setProgress(value); } catch {}
};

// Shared ETA calculation for batch tools
window.formatDuration = function(s) {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return m + 'm ' + sec + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

window.calculateETA = function(batchStartTime, totalFiles, files) {
  if (totalFiles === 0) return '';
  const elapsed = (Date.now() - batchStartTime) / 1000;
  if (elapsed < 2) return 'ETA: calculating...';
  const completedFiles = files.filter(f => f.state === 'complete' || f.state === 'error' || f.state === 'cancelled').length;
  const processingProgress = files
    .filter(f => f.state === 'processing')
    .reduce((sum, f) => sum + (f.progress || 0), 0);
  const effectiveCompleted = completedFiles + processingProgress;
  if (effectiveCompleted < 0.05) return 'ETA: calculating...';
  const remaining = totalFiles - effectiveCompleted;
  const eta = Math.max(0, Math.round((elapsed / effectiveCompleted) * remaining));
  return 'ETA: ' + window.formatDuration(eta);
};

// Update file count badge in footer
window.updateFileCount = function(count) {
  let badge = document.querySelector('.file-count');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'file-count';
      const footerLeft = document.querySelector('.tool-footer-left');
      if (footerLeft) footerLeft.appendChild(badge);
    }
    badge.textContent = count === 1 ? '1 file' : `${count} files`;
  } else if (badge) {
    badge.remove();
  }
};

window.updateQueueSummary = function(items) {
  const footerLeft = document.querySelector('.tool-footer-left');
  if (!footerLeft) return;

  let summary = document.querySelector('.queue-summary');
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    if (summary) summary.remove();
    window.updateFileCount(0);
    return;
  }

  const counts = list.reduce((acc, item) => {
    const state = item && item.state ? item.state : 'pending';
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {});

  if (!summary) {
    summary = document.createElement('span');
    summary.className = 'queue-summary';
    const fileCount = document.querySelector('.file-count');
    if (fileCount && fileCount.parentNode === footerLeft) {
      fileCount.insertAdjacentElement('afterend', summary);
    } else {
      footerLeft.appendChild(summary);
    }
  }

  const pending = (counts.pending || 0) + (counts.queued || 0);
  const parts = [];
  if (pending) parts.push(`<span class="queue-pill">Queued ${pending}</span>`);
  if (counts.processing) parts.push(`<span class="queue-pill processing">Working ${counts.processing}</span>`);
  if (counts.complete) parts.push(`<span class="queue-pill complete">Done ${counts.complete}</span>`);
  if (counts.error) parts.push(`<span class="queue-pill error">Failed ${counts.error}</span>`);
  if (counts.cancelled) parts.push(`<span class="queue-pill">Cancelled ${counts.cancelled}</span>`);

  summary.innerHTML = parts.join('');
  window.updateFileCount(list.length);
};

// Platform-aware file reveal label
function getRevealLabel() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'Reveal in Finder';
  if (ua.includes('linux')) return 'Open in Files';
  return 'Show in Explorer';
}

// Global context menu for file items
window.showFileContextMenu = function(e, filePath, onRemove) {
  e.preventDefault();
  // Remove existing menu
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const revealBtn = document.createElement('button');
  revealBtn.className = 'context-menu-item';
  revealBtn.setAttribute('role', 'menuitem');
  revealBtn.textContent = getRevealLabel();
  revealBtn.addEventListener('click', () => {
    const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    window.api.system.openFolder(dir);
    menu.remove();
  });
  menu.appendChild(revealBtn);

  const copyPathBtn = document.createElement('button');
  copyPathBtn.className = 'context-menu-item';
  copyPathBtn.setAttribute('role', 'menuitem');
  copyPathBtn.textContent = 'Copy Path';
  copyPathBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(filePath);
    menu.remove();
  });
  menu.appendChild(copyPathBtn);

  if (onRemove) {
    const sep = document.createElement('div');
    sep.className = 'context-menu-sep';
    menu.appendChild(sep);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'context-menu-item';
    removeBtn.setAttribute('role', 'menuitem');
    removeBtn.style.color = 'var(--error)';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => { onRemove(); menu.remove(); });
    menu.appendChild(removeBtn);
  }

  document.body.appendChild(menu);

  // Keep menu in viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  // Close on click outside
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
};

// Collapse/expand drop zone based on whether files are present
function updateDropZoneCollapse(dropZone, fileCount) {
  if (!dropZone) return;
  if (fileCount > 0) {
    dropZone.classList.add('collapsed');
  } else {
    dropZone.classList.remove('collapsed');
  }
}
window.updateDropZoneCollapse = updateDropZoneCollapse;

// Load image thumbnail for file list items
const _thumbCache = new Map();
const _thumbCacheMax = 200;
window.getFileThumbnail = async function(filePath) {
  if (_thumbCache.has(filePath)) return _thumbCache.get(filePath);
  try {
    const dataUrl = await window.api.system.readImagePreview(filePath);
    if (dataUrl) {
      // Evict oldest entries if cache is full
      if (_thumbCache.size >= _thumbCacheMax) {
        const firstKey = _thumbCache.keys().next().value;
        _thumbCache.delete(firstKey);
      }
      _thumbCache.set(filePath, dataUrl);
    }
    return dataUrl;
  } catch { return null; }
};

// Global clipboard paste support — saves pasted images to temp and dispatches
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      // Only files copied from disk have a path; in-memory screenshots don't.
      const blobPath = blob ? window.api.system.getPathForFile(blob) : '';
      if (blobPath) {
        const resolved = await window.api.system.resolveDroppedPaths([blobPath]);
        if (resolved.length > 0) {
          document.dispatchEvent(new CustomEvent('paste-files', { detail: resolved }));
        }
      }
    }
  }
});

// ============================================================================
// Settings
// ============================================================================

let globalSettings = {};

async function loadGlobalSettings() {
  try {
    const all = await window.api.system.loadSettings();
    globalSettings = all.global || {};
    return all;
  } catch (err) {
    console.warn('Failed to load settings:', err);
    return {};
  }
}

function saveGlobalSettings() {
  window.api.system.loadSettings().then(all => {
    all.global = {
      ...(all.global || {}),
      logCollapsed: logPanel.classList.contains('collapsed'),
      lastTool: currentToolId,
    };
    globalSettings = all.global;
    window.api.system.saveSettings(all);
  });
}

// Default output directory helpers — used by all tools
window.getDefaultOutputDir = () => globalSettings.defaultOutputDir || '';
window.applyDefaultOutputDir = (outputDirBtn) => {
  const defaultDir = globalSettings.defaultOutputDir || '';
  if (defaultDir && outputDirBtn) {
    const parts = defaultDir.replace(/\\/g, '/').split('/');
    const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : defaultDir;
    outputDirBtn.textContent = display;
    outputDirBtn.title = defaultDir;
  }
  return defaultDir;
};

// Expose settings helpers for tools
window.loadAllSettings = () => window.api.system.loadSettings();
window.saveAllSettings = (settings) => window.api.system.saveSettings(settings);

// ============================================================================
// GPU monitoring
// ============================================================================

function startGpuPolling() {
  if (_vramTimer !== null) return;
  _scheduleVramPoll(0);
}

function _scheduleVramPoll(delayMs) {
  _vramTimer = setTimeout(async () => {
    _vramTimer = null;
    await pollGpuStats();
  }, delayMs);
}

async function pollGpuStats() {
  // No point hitting the backend for live GPU stats while the window is
  // minimized/hidden — nobody can see them. Re-check less often until shown.
  if (document.hidden) {
    _scheduleVramPoll(5000);
    return;
  }
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`http://127.0.0.1:${pythonPort}/vram?token=${encodeURIComponent(pythonToken || '')}`, { signal: controller.signal });
    clearTimeout(tid);
    const data = await resp.json();

    _vramFailCount = 0;

    if (!data.available) {
      gpuStats.classList.remove('active');
      _scheduleVramPoll(3000);
      return;
    }

    gpuStats.classList.add('active');

    if (data.gpu_util != null) {
      gpuUtilStat.textContent = `GPU ${data.gpu_util}%`;
      gpuUtilStat.className = 'gpu-stat';
      if (data.gpu_util > 90) gpuUtilStat.classList.add('danger');
      else if (data.gpu_util > 70) gpuUtilStat.classList.add('warn');
    }

    if (data.temperature != null) {
      gpuTempStat.textContent = `${data.temperature}°C`;
      gpuTempStat.className = 'gpu-stat';
      if (data.temperature > 85) gpuTempStat.classList.add('danger');
      else if (data.temperature > 75) gpuTempStat.classList.add('warn');
    }

    if (data.total) {
      const totalGB = (data.total / (1024 ** 3)).toFixed(1);
      const usedGB = (data.used / (1024 ** 3)).toFixed(1);
      const memPct = Math.round((data.used / data.total) * 100);
      gpuMemStat.textContent = `${usedGB}/${totalGB} GB`;
      gpuMemStat.className = 'gpu-stat';
      if (memPct > 90) gpuMemStat.classList.add('danger');
      else if (memPct > 75) gpuMemStat.classList.add('warn');
    }

    _scheduleVramPoll(3000);
  } catch {
    _vramFailCount++;
    gpuStats.classList.remove('active');
    // Exponential backoff: 3 s -> 6 s -> 12 s -> ... capped at 60 s
    const backoff = Math.min(3000 * (2 ** (_vramFailCount - 1)), 60000);
    _scheduleVramPoll(backoff);
  }
}



function checkHealth() {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);
  fetch(`http://127.0.0.1:${pythonPort}/health?token=${encodeURIComponent(pythonToken || '')}`, { signal: controller.signal })
    .then(r => { clearTimeout(tid); return r.json(); })
    .then(data => {
      const hasGpu = data.device === 'cuda' || data.device === 'mps';
      gpuBadge.textContent = hasGpu ? data.gpu_name || 'GPU Active' : 'CPU Mode (slower)';
      gpuBadge.style.borderColor = hasGpu ? '#4ade80' : '#fbbf24';
      if (!hasGpu) {
        log('No GPU detected — processing will be slower. An NVIDIA GPU with CUDA or Apple Silicon is recommended.', 'warn');
      }
    })
    .catch(() => {
      clearTimeout(tid);
      gpuBadge.textContent = 'Backend Error';
      gpuBadge.style.borderColor = '#f87171';
      log('Failed to reach backend', 'error');
    });
}

// ============================================================================
// Tool loading / sidebar navigation
// ============================================================================

const toolRegistry = {};
const toolCache = {};

function registerTool(id, module) {
  toolRegistry[id] = module;
}

// Make this available globally so tool scripts can self-register
window.registerTool = registerTool;
window.pythonPort = null; // will be set during init
window.pythonToken = null; // will be set during init

let _loadingToolId = null;

async function loadTool(toolId) {
  if (toolId === currentToolId) return;

  // Guard against concurrent loads from rapid clicks
  _loadingToolId = toolId;

  const previousToolId = currentToolId;
  currentToolModule = null;

  // Update sidebar
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tool === toolId);
  });

  currentToolId = toolId;
  renderLogEntries(toolId);

  // Update window title
  const toolLabel = document.querySelector(`.sidebar-item[data-tool="${toolId}"] .sidebar-label`);
  document.title = toolLabel ? `${toolLabel.textContent} - MuxMelt` : 'MuxMelt';

  // Load tool CSS
  toolStylesheet.href = `tools/${toolId}/${toolId}.css`;

  if (toolCache[toolId]?.container) {
    toolContent.replaceChildren(toolCache[toolId].container);
    currentToolModule = toolCache[toolId].module || toolRegistry[toolId] || null;
    saveGlobalSettings();
    return;
  }

  // Load tool HTML
  const container = document.createElement('div');
  container.className = 'tool-instance';
  container.dataset.tool = toolId;

  try {
    const resp = await fetch(`tools/${toolId}/${toolId}.html`);
    if (!resp.ok) throw new Error('not found');
    const html = await resp.text();
    container.innerHTML = html;
    toolCache[toolId] = {
      ...(toolCache[toolId] || {}),
      container,
      module: null,
    };
    if (_loadingToolId !== toolId) return;
    toolContent.replaceChildren(container);
  } catch {
    // If another tool was requested while this one was loading, that load owns
    // the UI now — don't stomp its content or roll its state back.
    if (_loadingToolId !== toolId) return;
    toolContent.innerHTML = `
      <div class="tool-placeholder">
        <div class="tool-placeholder-icon">&#128679;</div>
        <div class="tool-placeholder-text">This tool is coming soon</div>
      </div>`;
    // Roll the sidebar highlight and title back too, so the UI doesn't claim
    // the failed tool is active.
    currentToolId = previousToolId;
    document.querySelectorAll('.sidebar-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tool === previousToolId);
    });
    const prevLabel = document.querySelector(`.sidebar-item[data-tool="${previousToolId}"] .sidebar-label`);
    document.title = prevLabel ? `${prevLabel.textContent} - MuxMelt` : 'MuxMelt';
    saveGlobalSettings();
    return;
  }

  // Load and execute tool JS
  try {
    const existingScript = document.getElementById(`toolScript-${toolId}`);

    if (!existingScript) {
      const script = document.createElement('script');
      script.id = `toolScript-${toolId}`;
      script.src = `tools/${toolId}/${toolId}.js`;
      document.body.appendChild(script);

      // Wait for script to register.
      await new Promise((resolve) => {
        script.onload = resolve;
        script.onerror = resolve;
      });
    }

    // Initialize the tool once. Its state and DOM stay cached across navigation
    // until the user clears the tool from inside that module.
    if (toolRegistry[toolId]) {
      currentToolModule = toolRegistry[toolId];
      toolCache[toolId].module = currentToolModule;
      if (!toolCache[toolId].initialized && currentToolModule.init) {
        // Abort if another tool was requested while loading
        if (_loadingToolId !== toolId) return;
        const toolLog = (message, level = 'info') => log(message, level, toolId);
        const toolClearLog = () => clearLog(toolId);
        currentToolModule.init({ pythonPort, pythonToken, log: toolLog, escapeHtml, clearLog: toolClearLog });
        toolCache[toolId].initialized = true;
      }
    }
  } catch (e) {
    log(`Failed to load tool: ${toolId}`, 'error');
  }

  saveGlobalSettings();
}

// Sidebar click + keyboard handlers with ARIA
document.querySelectorAll('.sidebar-item').forEach(item => {
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  const label = item.querySelector('.sidebar-label');
  if (label) item.setAttribute('aria-label', label.textContent);

  item.addEventListener('click', () => {
    loadTool(item.dataset.tool);
  });
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      loadTool(item.dataset.tool);
    }
  });
});

// ============================================================================
// Init
// ============================================================================

// Custom (frameless) window controls — minimize / maximize-restore / close.
function setupWindowControls() {
  const wc = window.api && window.api.windowControls;
  if (!wc) return;

  const minBtn = document.getElementById('winMinBtn');
  const maxBtn = document.getElementById('winMaxBtn');
  const closeBtn = document.getElementById('winCloseBtn');
  const dragArea = document.getElementById('titlebarDrag');

  const reflectMaxState = (isMax) => {
    if (!maxBtn) return;
    maxBtn.classList.toggle('is-maximized', !!isMax);
    maxBtn.title = isMax ? 'Restore' : 'Maximize';
    maxBtn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
  };
  const toggleMax = async () => {
    try { reflectMaxState(await wc.maximizeToggle()); } catch {}
  };

  if (minBtn) minBtn.addEventListener('click', () => { wc.minimize().catch(() => {}); });
  if (closeBtn) closeBtn.addEventListener('click', () => { wc.close().catch(() => {}); });
  if (maxBtn) maxBtn.addEventListener('click', toggleMax);
  // Double-clicking the caption maximizes/restores, like a native title bar.
  if (dragArea) dragArea.addEventListener('dblclick', toggleMax);

  wc.onMaximizeChange(reflectMaxState);
  wc.isMaximized().then(reflectMaxState).catch(() => {});
}

async function init() {
  setupWindowControls();
  const allSettings = await loadGlobalSettings();
  setLogCollapsed(!!allSettings.global?.logCollapsed);

  // Apply saved theme
  const theme = allSettings.global?.theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  pythonPort = await window.api.python.getPythonPort();
  window.pythonPort = pythonPort;
  pythonToken = await window.api.python.getPythonToken();
  window.pythonToken = pythonToken;

  checkHealth();
  startGpuPolling();

  window.api.python.onPythonCrashed((code) => {
    log(`Python backend crashed (exit code ${code})`, 'error');
  });

  // Sidebar shortcuts button
  const shortcutsBtn = document.getElementById('shortcutsBtn');
  if (shortcutsBtn) {
    shortcutsBtn.addEventListener('click', toggleShortcutsOverlay);
  }

  // Sidebar donate button
  const sidebarDonateBtn = document.getElementById('sidebarDonateBtn');
  if (sidebarDonateBtn) {
    sidebarDonateBtn.addEventListener('click', () => {
      window.api.system.openExternal('https://ko-fi.com/carfo');
    });
  }

  // Check for updates and show banner if available
  checkForAppUpdates();

  // Load last used tool or default to upscaler
  const savedTool = allSettings.global?.lastTool || 'upscaler';
  const startTool = document.querySelector(`.sidebar-item[data-tool="${savedTool}"]`) ? savedTool : 'upscaler';
  loadTool(startTool);
}

async function checkForAppUpdates() {
  try {
    await window.api.updater.checkForUpdates();
  } catch (err) {
    console.error('Update check failed:', err);
  }
}

// Auto-update event listeners
const updateBanner = document.getElementById('updateBanner');
const updateBannerText = document.getElementById('updateBannerText');
const updateDownloadBtn = document.getElementById('updateDownloadBtn');
const updateRestartBtn = document.getElementById('updateRestartBtn');
const updateDismiss = document.getElementById('updateDismiss');
let pendingUpdateInfo = null;

if (window.api.updater.onUpdateAvailable) {
  window.api.updater.onUpdateAvailable((info) => {
    pendingUpdateInfo = info;
    if (updateBanner && updateBannerText && updateDownloadBtn) {
      updateBannerText.textContent = info.isLocal
        ? `A new local version (v${info.version}) is available!`
        : `A new version (v${info.version}) is available!`;
      updateBanner.style.display = 'flex';
      updateDownloadBtn.style.display = 'inline-block';
      updateDownloadBtn.disabled = false;
      updateDownloadBtn.textContent = info.isLocal ? 'Install' : 'Download';
      updateRestartBtn.style.display = 'none';
    }
    log(`Update available: ${info.version}`, 'info');
  });
}

if (window.api.updater.onUpdateDownloaded) {
  window.api.updater.onUpdateDownloaded((info) => {
    pendingUpdateInfo = info;
    if (updateBanner && updateBannerText && updateDownloadBtn && updateRestartBtn) {
      updateBannerText.textContent = `Version ${info.version} is ready to install.`;
      updateDownloadBtn.style.display = 'none';
      updateRestartBtn.style.display = 'inline-block';
      updateBanner.style.display = 'flex';
    }
    log(`Update downloaded: ${info.version}`, 'success');
  });
}

if (window.api.updater.onUpdateDownloadProgress) {
  window.api.updater.onUpdateDownloadProgress((progress) => {
    if (updateBannerText) {
      const pct = Math.round(progress.percent);
      updateBannerText.textContent = `Downloading update... ${pct}%`;
    }
  });
}

if (window.api.updater.onUpdateError) {
  window.api.updater.onUpdateError((err) => {
    log(`Update error: ${err}`, 'error');
  });
}

if (updateDownloadBtn) {
  updateDownloadBtn.addEventListener('click', async () => {
    updateDownloadBtn.disabled = true;
    updateDownloadBtn.textContent = pendingUpdateInfo && pendingUpdateInfo.isLocal ? 'Installing...' : 'Downloading...';

    if (pendingUpdateInfo && pendingUpdateInfo.isLocal && pendingUpdateInfo.installerPath) {
      await window.api.updater.downloadAndUpdate(pendingUpdateInfo.installerPath);
      return;
    }

    const result = await window.api.updater.downloadUpdate();
    if (result && result.error) {
      updateDownloadBtn.disabled = false;
      updateDownloadBtn.textContent = 'Retry';
    }
  });
}

if (updateRestartBtn) {
  updateRestartBtn.addEventListener('click', () => {
    window.api.updater.restartToUpdate();
  });
}

if (updateDismiss) {
  updateDismiss.addEventListener('click', () => {
    if (updateBanner) updateBanner.style.display = 'none';
  });
}

// ============================================================================
// Global keyboard shortcuts
// ============================================================================

// Shortcuts overlay
const shortcutsOverlay = document.getElementById('shortcutsOverlay');
const shortcutsClose = document.getElementById('shortcutsClose');

function toggleShortcutsOverlay() {
  shortcutsOverlay.classList.toggle('active');
}

shortcutsClose.addEventListener('click', () => {
  shortcutsOverlay.classList.remove('active');
});

shortcutsOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutsOverlay) {
    shortcutsOverlay.classList.remove('active');
  }
});

document.addEventListener('keydown', (e) => {
  // Escape — close shortcuts overlay, then context menus
  if (e.key === 'Escape') {
    if (shortcutsOverlay.classList.contains('active')) {
      shortcutsOverlay.classList.remove('active');
      return;
    }
    const menu = document.querySelector('.context-menu');
    if (menu) { menu.remove(); return; }
  }

  // Ctrl+? (Ctrl+Shift+/) — toggle shortcuts overlay
  if (e.ctrlKey && e.shiftKey && e.key === '?') {
    e.preventDefault();
    toggleShortcutsOverlay();
    return;
  }

  // Don't intercept when typing in inputs/textareas
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // Ctrl+O — open file browser (clicks the first visible browse button)
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    const browseBtn = document.getElementById('browseBtn');
    if (browseBtn) browseBtn.click();
  }

  // Ctrl+L — toggle log panel
  if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    toggleLogPanel();
  }

  // Enter — click the primary action button in the current tool
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    // A focused button/link/sidebar item already handles Enter itself;
    // triggering the primary action too would double-fire.
    const el = document.activeElement;
    if (el && el !== document.body &&
        (el.tagName === 'BUTTON' || el.tagName === 'A' ||
         el.getAttribute('role') === 'button' || el.isContentEditable)) {
      return;
    }
    const primaryBtn = toolContent.querySelector('.btn-primary:not(:disabled)');
    if (primaryBtn) {
      e.preventDefault();
      primaryBtn.click();
    }
  }
});

init();
