// ============================================================================
// MuxMelt - App Shell
// Handles sidebar navigation, tool loading, log panel, GPU stats
// ============================================================================

let pythonPort = null;
let currentToolId = null;
let currentToolModule = null;
let vramInterval = null;

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

logToggle.addEventListener('click', () => {
  logPanel.classList.toggle('collapsed');
  saveGlobalSettings();
});

function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${level}">${escapeHtml(message)}</span>`;
  logEntries.appendChild(entry);
  while (logEntries.children.length > 200) {
    logEntries.removeChild(logEntries.firstChild);
  }
  logEntries.parentElement.scrollTop = logEntries.parentElement.scrollHeight;
}

function clearLog() {
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
  window.api.showNotification({
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
    const all = await window.api.loadSettings();
    if (all.global && all.global.autoOpenOutput) {
      window.api.openFolder(outputDir);
    }
  } catch {}
};

// Recent files history — save output file paths after processing
const RECENT_FILES_MAX = 20;

window.addRecentFile = async function(filePath) {
  if (!filePath) return;
  try {
    const all = await window.api.loadSettings();
    all.global = all.global || {};
    let recent = all.global.recentFiles || [];
    // Remove duplicate if already exists
    recent = recent.filter(f => f !== filePath);
    // Add to front
    recent.unshift(filePath);
    // Trim to max
    if (recent.length > RECENT_FILES_MAX) recent = recent.slice(0, RECENT_FILES_MAX);
    all.global.recentFiles = recent;
    await window.api.saveSettings(all);
  } catch {}
};

window.getRecentFiles = async function() {
  try {
    const all = await window.api.loadSettings();
    return (all.global && all.global.recentFiles) || [];
  } catch { return []; }
};

window.clearRecentFiles = async function() {
  try {
    const all = await window.api.loadSettings();
    if (all.global) {
      all.global.recentFiles = [];
      await window.api.saveSettings(all);
    }
  } catch {}
};

// Set Windows taskbar progress (0-1, or -1 to clear)
window.setTaskbarProgress = function(value) {
  try { window.api.setProgress(value); } catch {}
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
  const current = files.find(f => f.state === 'processing');
  const effectiveCompleted = completedFiles + (current ? (current.progress || 0) : 0);
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
  if (pending) parts.push(`<span class="queue-pill">Ready ${pending}</span>`);
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
    window.api.openFolder(dir);
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
    const dataUrl = await window.api.readImagePreview(filePath);
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
      if (blob && blob.path) {
        // Electron file from clipboard — resolve and add
        const resolved = await window.api.resolveDroppedPaths([blob.path]);
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
    const all = await window.api.loadSettings();
    globalSettings = all.global || {};
    return all;
  } catch (err) {
    console.warn('Failed to load settings:', err);
    return {};
  }
}

function saveGlobalSettings() {
  window.api.loadSettings().then(all => {
    all.global = {
      ...(all.global || {}),
      logCollapsed: logPanel.classList.contains('collapsed'),
      lastTool: currentToolId,
    };
    globalSettings = all.global;
    window.api.saveSettings(all);
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
window.loadAllSettings = () => window.api.loadSettings();
window.saveAllSettings = (settings) => window.api.saveSettings(settings);

// ============================================================================
// GPU monitoring
// ============================================================================

function startGpuPolling() {
  if (vramInterval) return;
  vramInterval = setInterval(pollGpuStats, 3000);
  pollGpuStats();
}

async function pollGpuStats() {
  try {
    const resp = await fetch(`http://127.0.0.1:${pythonPort}/vram`);
    const data = await resp.json();
    if (!data.available) return;

    gpuStats.classList.add('active');

    if (data.gpu_util != null) {
      gpuUtilStat.textContent = `GPU ${data.gpu_util}%`;
      gpuUtilStat.className = 'gpu-stat';
      if (data.gpu_util > 90) gpuUtilStat.classList.add('danger');
      else if (data.gpu_util > 70) gpuUtilStat.classList.add('warn');
    }

    if (data.temperature != null) {
      gpuTempStat.textContent = `${data.temperature}\u00B0C`;
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
  } catch (err) {
    // GPU polling unavailable — hide stats silently
    gpuStats.classList.remove('active');
  }
}

function checkHealth() {
  fetch(`http://127.0.0.1:${pythonPort}/health`)
    .then(r => r.json())
    .then(data => {
      const hasGpu = data.device === 'cuda' || data.device === 'mps';
      gpuBadge.textContent = hasGpu ? data.gpu_name || 'GPU Ready' : 'CPU Mode (slower)';
      gpuBadge.style.borderColor = hasGpu ? '#4ade80' : '#fbbf24';
      log(`Device: ${data.device.toUpperCase()}`, hasGpu ? 'success' : 'warn');
      if (data.gpu_name) log(`GPU: ${data.gpu_name}`);
      if (!hasGpu) {
        log('No GPU detected — processing will be slower. An NVIDIA GPU with CUDA or Apple Silicon is recommended.', 'warn');
      }
      if (data.python_version) log(`Python ${data.python_version}`);
    })
    .catch(() => {
      gpuBadge.textContent = 'Backend Error';
      gpuBadge.style.borderColor = '#f87171';
      log('Failed to reach backend', 'error');
    });
}

// ============================================================================
// Tool loading / sidebar navigation
// ============================================================================

const toolRegistry = {};

function registerTool(id, module) {
  toolRegistry[id] = module;
}

// Make this available globally so tool scripts can self-register
window.registerTool = registerTool;
window.pythonPort = null; // will be set during init

let _loadingToolId = null;

async function loadTool(toolId) {
  if (toolId === currentToolId) return;

  // Guard against concurrent loads from rapid clicks
  _loadingToolId = toolId;

  // Cleanup current tool
  if (currentToolModule && currentToolModule.cleanup) {
    currentToolModule.cleanup();
  }
  currentToolModule = null;

  // Update sidebar
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tool === toolId);
  });

  currentToolId = toolId;
  if (window.updateQueueSummary) window.updateQueueSummary([]);

  // Update window title
  const toolLabel = document.querySelector(`.sidebar-item[data-tool="${toolId}"] .sidebar-label`);
  document.title = toolLabel ? `${toolLabel.textContent} - MuxMelt` : 'MuxMelt';

  // Load tool CSS
  toolStylesheet.href = `tools/${toolId}/${toolId}.css`;

  // Load tool HTML
  try {
    const resp = await fetch(`tools/${toolId}/${toolId}.html`);
    if (!resp.ok) throw new Error('not found');
    const html = await resp.text();
    toolContent.innerHTML = html;
  } catch {
    toolContent.innerHTML = `
      <div class="tool-placeholder">
        <div class="tool-placeholder-icon">&#128679;</div>
        <div class="tool-placeholder-text">This tool is coming soon</div>
      </div>`;
    saveGlobalSettings();
    return;
  }

  // Load and execute tool JS
  try {
    // Remove old tool script if any
    const oldScript = document.getElementById('toolScript');
    if (oldScript) oldScript.remove();

    const script = document.createElement('script');
    script.id = 'toolScript';
    script.src = `tools/${toolId}/${toolId}.js`;
    document.body.appendChild(script);

    // Wait for script to register and init
    await new Promise((resolve) => {
      script.onload = () => {
        // Abort if another tool was requested while loading
        if (_loadingToolId !== toolId) { resolve(); return; }
        if (toolRegistry[toolId]) {
          currentToolModule = toolRegistry[toolId];
          if (currentToolModule.init) {
            currentToolModule.init({ pythonPort, log, escapeHtml, clearLog });
          }
        }
        resolve();
      };
      script.onerror = resolve;
    });
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

async function init() {
  log('Starting MuxMelt...');

  const allSettings = await loadGlobalSettings();
  if (allSettings.global?.logCollapsed) {
    logPanel.classList.add('collapsed');
  }

  // Apply saved theme
  const theme = allSettings.global?.theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  pythonPort = await window.api.getPythonPort();
  window.pythonPort = pythonPort;
  log(`Backend port: ${pythonPort}`);

  checkHealth();
  startGpuPolling();

  window.api.onPythonCrashed((code) => {
    log(`Python backend crashed (exit code ${code})`, 'error');
  });

  // Sidebar donate button
  const sidebarDonateBtn = document.getElementById('sidebarDonateBtn');
  if (sidebarDonateBtn) {
    sidebarDonateBtn.addEventListener('click', () => {
      window.api.openExternal('https://ko-fi.com/carfo');
    });
  }

  // Check for updates and show banner if available
  checkForAppUpdates();

  // Load last used tool or default to upscaler
  const startTool = allSettings.global?.lastTool || 'upscaler';
  loadTool(startTool);
}

async function checkForAppUpdates() {
  try {
    const update = await window.api.checkForUpdates();
    if (update && !update.upToDate && update.releaseUrl) {
      const banner = document.getElementById('updateBanner');
      const link = document.getElementById('updateLink');
      const dismiss = document.getElementById('updateDismiss');
      if (banner && link) {
        banner.style.display = 'flex';
        link.addEventListener('click', () => {
          window.api.openExternal(update.releaseUrl);
        });
        if (dismiss) {
          dismiss.addEventListener('click', () => {
            banner.style.display = 'none';
          });
        }
        log(`Update available: ${update.latestVersion}`, 'info');
      }
    }
  } catch {}
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
    logPanel.classList.toggle('collapsed');
    saveGlobalSettings();
  }

  // Enter — click the primary action button in the current tool
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    const primaryBtn = toolContent.querySelector('.btn-primary:not(:disabled)');
    if (primaryBtn) {
      e.preventDefault();
      primaryBtn.click();
    }
  }
});

init();
