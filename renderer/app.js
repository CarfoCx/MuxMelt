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
let _vramController = null;
let _gpuPollingEnabled = false;
const GPU_POLL_INTERVAL_MS = 10000;

const APP_META = Object.freeze({
  name: document.body?.dataset.appName || 'MuxMelt',
  supportUrl: 'https://ko-fi.com/carfo'
});

// One registry powers Settings and the dark/light toggle. The persisted IDs
// stay stable while both modes use the same workspace visual family.
const THEME_REGISTRY = Object.freeze([
  { id: 'mono-dark', family: 'system', mode: 'dark', label: 'Default', swatch: '#60cdff' },
  { id: 'mono-light', family: 'system', mode: 'light', label: 'Default', swatch: '#0067c0' }
]);

function normalizeTheme(themeName) {
  const candidate = String(themeName || '').toLowerCase();
  if (candidate === 'mono-light' || candidate === 'light' || candidate.endsWith('-light')) {
    return 'mono-light';
  }
  return 'mono-dark';
}

function getThemePair(themeName) {
  return normalizeTheme(themeName) === 'mono-light' ? 'mono-dark' : 'mono-light';
}

function applyAppTheme(themeName, persist = true) {
  const normalized = normalizeTheme(themeName);
  document.documentElement.setAttribute('data-theme', normalized);
  document.documentElement.style.colorScheme = normalized.endsWith('-light') ? 'light' : 'dark';
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = normalized;
  const themeButton = document.getElementById('themeToggleBtn');
  if (themeButton) {
    const nextMode = normalized.endsWith('-light') ? 'dark' : 'light';
    themeButton.setAttribute('aria-label', `Use ${nextMode} theme`);
    themeButton.title = `Use ${nextMode} theme`;
  }
  if (persist) {
    updateSettings(all => {
      all.global = all.global || {};
      all.global.theme = normalized;
    }).catch(() => {});
  }
  return normalized;
}

window.APP_META = APP_META;
window.getThemeRegistry = () => THEME_REGISTRY.map(theme => ({ ...theme }));
window.getThemePair = getThemePair;
window.applyAppTheme = applyAppTheme;

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
const systemStatus = gpuStats.closest('.system-status');
// versionBadge removed — version now shown in Settings
const toolStylesheet = document.getElementById('toolStylesheet');

// ============================================================================
// Log panel
// ============================================================================

const logsByTool = {};
const MAX_LOG_ENTRIES_PER_TOOL = 200;
let logRenderFrame = null;
let renderedLogToolId = null;
let renderedLogEntry = null;

function setLogCollapsed(collapsed) {
  logPanel.classList.toggle('collapsed', collapsed);
  logToggle.setAttribute('aria-expanded', String(!collapsed));
  if (collapsed) cancelLogRender();
  else scheduleLogRender();
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
  if (getLogToolId(toolId) !== getLogToolId(currentToolId)) return;
  renderedLogToolId = null;
  scheduleLogRender();
}

function cancelLogRender() {
  if (logRenderFrame !== null) cancelAnimationFrame(logRenderFrame);
  logRenderFrame = null;
}

function scheduleLogRender() {
  if (logRenderFrame !== null || document.hidden || logPanel.classList.contains('collapsed')) return;
  logRenderFrame = requestAnimationFrame(flushLogEntries);
}

function flushLogEntries() {
  logRenderFrame = null;
  if (document.hidden || logPanel.classList.contains('collapsed')) return;
  const toolId = currentToolId;
  const key = getLogToolId(toolId);
  const entries = logsByTool[key] || [];
  const previousIndex = renderedLogToolId === key ? entries.indexOf(renderedLogEntry) : -1;
  const pending = previousIndex < 0 ? entries : entries.slice(previousIndex + 1);
  if (previousIndex >= 0 && pending.length === 0) return;

  const fragment = document.createDocumentFragment();
  pending.forEach(entry => fragment.appendChild(createLogEntry(entry)));
  if (previousIndex < 0) logEntries.replaceChildren(fragment);
  else logEntries.appendChild(fragment);
  while (logEntries.children.length > MAX_LOG_ENTRIES_PER_TOOL) {
    logEntries.removeChild(logEntries.firstChild);
  }
  renderedLogToolId = key;
  renderedLogEntry = entries[entries.length - 1] || null;
  // One layout read per visible batch; hidden activity stays in the bounded
  // buffer and is rendered only when the user opens the log.
  logEntries.parentElement.scrollTop = logEntries.parentElement.scrollHeight;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelLogRender();
  else scheduleLogRender();
});

function log(message, level = 'info', toolId = currentToolId) {
  const key = getLogToolId(toolId);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const safeLevel = ['info', 'warn', 'error', 'success'].includes(level) ? level : 'info';
  const entry = { time, message: String(message ?? ''), level: safeLevel };

  logsByTool[key] = logsByTool[key] || [];
  logsByTool[key].push(entry);
  while (logsByTool[key].length > MAX_LOG_ENTRIES_PER_TOOL) {
    logsByTool[key].shift();
  }

  if (key === getLogToolId(currentToolId)) {
    scheduleLogRender();
  }
}

function clearLog(toolId = currentToolId) {
  const key = getLogToolId(toolId);
  logsByTool[key] = [];
  if (key === getLogToolId(currentToolId)) renderLogEntries(toolId);
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

// Build a valid URL for local media previews. Concatenating "file://" breaks
// Windows drive paths and treats # / ? in filenames as URL syntax.
function localPathToFileUrl(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return '';

  if (normalized.startsWith('//')) {
    const [host, ...segments] = normalized.slice(2).split('/');
    return `file://${host}/${segments.map(encodeURIComponent).join('/')}`;
  }

  const encoded = normalized.split('/').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) return segment;
    return encodeURIComponent(segment);
  }).join('/');
  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}
window.localPathToFileUrl = localPathToFileUrl;

function getParentDirectory(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return '';
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Za-z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, separator);
}
window.getParentDirectory = getParentDirectory;

// Show an in-app toast notification + native OS notification
function showCompletionToast(message, isError = false, outputFiles = []) {
  message = String(message ?? '');
  window.setTaskbarProgress(-1); // Clear on completion
  const safeOutputFiles = Array.isArray(outputFiles)
    ? outputFiles.filter(filePath => typeof filePath === 'string' && filePath.length > 0)
    : [];

  // Store last output files for workflow chaining
  if (safeOutputFiles.length > 0) {
    window.lastOutputFiles = safeOutputFiles;
    if (!isError) {
      updateSettings(all => {
        all.global = all.global || {};
        const current = Number(all.global.completedOutputCount) || 0;
        all.global.completedOutputCount = Math.min(1000000, current + safeOutputFiles.length);
      }).catch(() => {});
    }
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
  if (!isError && safeOutputFiles.length > 0) {
    const suggestions = getSendToSuggestions(safeOutputFiles);
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

  // Native notification details are private by default because tool messages
  // may contain filenames. Users can explicitly choose detailed or no alerts.
  const notificationDetail = ['generic', 'detailed', 'off'].includes(globalSettings.notificationDetail)
    ? globalSettings.notificationDetail
    : 'generic';
  if (notificationDetail !== 'off' && typeof window.api.system.showNotification === 'function') {
    const genericBody = isError
      ? `${APP_META.name} needs your attention`
      : `Your ${APP_META.name} task is complete`;
    window.api.system.showNotification({
      title: APP_META.name,
      body: notificationDetail === 'detailed' ? message : genericBody
    }).catch(() => {});
  }
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
window.sendToTool = async function(toolId) {
  const files = window.lastOutputFiles || [];
  return window.openFilesInTool(toolId, files);
};

window.openFilesInTool = async function(toolId, files) {
  const safeFiles = Array.isArray(files)
    ? files.filter(filePath => typeof filePath === 'string' && filePath)
    : [];
  const loaded = await loadTool(toolId);
  // loadTool resolves only after the destination has initialized. A fixed
  // delay raced slower disks and caused files to be silently dropped.
  if (loaded && currentToolId === toolId) {
    document.dispatchEvent(new CustomEvent('paste-files', { detail: safeFiles }));
    return true;
  }
  return false;
};

window.openTool = loadTool;

// Auto-open output folder if setting is enabled
window.autoOpenOutputIfEnabled = async function(outputDir) {
  if (!outputDir) return;
  try {
    const all = await loadAllSettings();
    if (all.global && all.global.autoOpenOutput) {
      window.api.system.openFolder(outputDir);
    }
  } catch {}
};

// Recent files history — save output file paths after processing
const RECENT_FILES_MAX = 20;

window.addRecentFile = async function(filePath) {
  if (typeof filePath !== 'string' || !filePath) return;
  try {
    const existing = await loadAllSettings();
    if (existing.global?.rememberRecentFiles !== true) return;
    await updateSettings(all => {
      all.global = all.global || {};
      let recent = Array.isArray(all.global.recentFiles) ? all.global.recentFiles : [];
      recent = recent.filter(f => f !== filePath);
      recent.unshift(filePath);
      all.global.recentFiles = recent.slice(0, RECENT_FILES_MAX);
    });
  } catch {}
};

window.getRecentFiles = async function() {
  try {
    const all = await loadAllSettings();
    if (all.global?.rememberRecentFiles !== true) return [];
    const recent = all.global && all.global.recentFiles;
    return Array.isArray(recent) ? recent.filter(filePath => typeof filePath === 'string' && filePath) : [];
  } catch { return []; }
};

window.clearRecentFiles = async function() {
  try {
    await updateSettings(all => {
      if (all.global) all.global.recentFiles = [];
    });
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

function getToolSummaryRoot(toolIdOrRoot) {
  if (toolIdOrRoot && typeof toolIdOrRoot.querySelector === 'function') return toolIdOrRoot;
  if (typeof toolIdOrRoot === 'string') {
    return toolCache[toolIdOrRoot]?.container || null;
  }
  return toolContent.querySelector('.tool-instance');
}

// Update a tool's own cached footer, even while another tool is visible.
window.updateFileCount = function(count, toolIdOrRoot) {
  const root = getToolSummaryRoot(toolIdOrRoot);
  if (!root) return;
  let badge = root.querySelector('.file-count');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'file-count';
      const footerLeft = root.querySelector('.tool-footer-left');
      if (footerLeft) footerLeft.appendChild(badge);
    }
    const label = count === 1 ? '1 file' : `${count} files`;
    if (badge.textContent !== label) badge.textContent = label;
  } else if (badge) {
    badge.remove();
  }
};

window.updateQueueSummary = function(items, toolIdOrRoot) {
  const root = getToolSummaryRoot(toolIdOrRoot);
  if (!root) return;
  const footerLeft = root.querySelector('.tool-footer-left');
  if (!footerLeft) return;

  let summary = root.querySelector('.queue-summary');
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    if (summary) summary.remove();
    window.updateFileCount(0, root);
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
    const fileCount = root.querySelector('.file-count');
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

  const markup = parts.join('');
  if (summary.innerHTML !== markup) summary.innerHTML = markup;
  window.updateFileCount(list.length, root);
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
    const dir = getParentDirectory(filePath);
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

// Global clipboard paste support: disk files are resolved normally and
// in-memory screenshots are persisted through the validated main-process API.
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const pastedPaths = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const blobPath = window.api.system.getPathForFile(blob);
      if (blobPath) {
        const resolved = await window.api.system.resolveDroppedPaths([blobPath]);
        pastedPaths.push(...resolved);
      } else if (window.api.system.saveClipboardImage) {
        try {
          const savedPath = await window.api.system.saveClipboardImage(await blob.arrayBuffer(), blob.type);
          if (savedPath) pastedPaths.push(savedPath);
        } catch (err) {
          log(`Could not paste image: ${err.message}`, 'error');
        }
      }
    }
  }
  if (pastedPaths.length > 0) {
    document.dispatchEvent(new CustomEvent('paste-files', { detail: pastedPaths }));
  }
});

// ============================================================================
// Settings
// ============================================================================

let globalSettings = {};
let settingsWriteQueue = Promise.resolve();

function queueSettingsWrite(operation) {
  const result = settingsWriteQueue.catch(() => {}).then(operation);
  settingsWriteQueue = result.catch(err => {
    console.warn('Failed to save settings:', err);
  });
  return result;
}

async function loadAllSettings() {
  await settingsWriteQueue;
  const loaded = await window.api.system.loadSettings();
  return loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
}

function updateSettings(mutator) {
  if (typeof mutator !== 'function') {
    return Promise.reject(new TypeError('Settings mutator must be a function'));
  }
  return queueSettingsWrite(async () => {
    const loaded = await window.api.system.loadSettings();
    const all = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
    await mutator(all);
    const saved = await window.api.system.saveSettings(all);
    if (saved !== true) throw new Error('The settings file could not be saved');
    globalSettings = all.global || {};
    return all;
  });
}

function replaceAllSettings(settings) {
  return queueSettingsWrite(async () => {
    const next = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    const saved = await window.api.system.saveSettings(next);
    if (saved !== true) throw new Error('The settings file could not be saved');
    globalSettings = next.global || {};
    return next;
  });
}

async function loadGlobalSettings() {
  try {
    const all = await loadAllSettings();
    globalSettings = all.global || {};
    return all;
  } catch (err) {
    console.warn('Failed to load settings:', err);
    return {};
  }
}

function saveGlobalSettings() {
  return updateSettings(all => {
    all.global = {
      ...(all.global || {}),
      logCollapsed: logPanel.classList.contains('collapsed'),
      lastTool: currentToolId,
    };
  }).catch(err => console.warn('Failed to save global settings:', err));
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
window.loadAllSettings = loadAllSettings;
window.saveAllSettings = replaceAllSettings;
window.updateSettings = updateSettings;

// ============================================================================
// Shared accessibility enhancements for dynamically loaded tools
// ============================================================================

let generatedControlId = 0;

function syncProgressbar(progressbar) {
  if (!progressbar) return;
  progressbar.setAttribute('role', 'progressbar');
  progressbar.setAttribute('aria-valuemin', '0');
  progressbar.setAttribute('aria-valuemax', '100');
  const fill = progressbar.querySelector('[class*="progress-fill"], .file-progress-fill');
  const match = fill?.style.width?.match(/[\d.]+/);
  const value = match ? Math.min(100, Math.max(0, Math.round(Number(match[0])))) : 0;
  progressbar.setAttribute('aria-valuenow', String(value));
  const isFooterProgress = progressbar.className.includes('footer-progress');
  if (isFooterProgress) progressbar.setAttribute('aria-hidden', String(!progressbar.classList.contains('active')));
}

function enhanceAccessibility(root = document) {
  root.querySelectorAll?.('.drop-zone').forEach(zone => {
    if (!zone.hasAttribute('role')) zone.setAttribute('role', 'button');
    if (!zone.hasAttribute('tabindex')) zone.tabIndex = 0;
    if (!zone.hasAttribute('aria-label')) zone.setAttribute('aria-label', 'Add media files');
  });

  root.querySelectorAll?.('.drop-zone-link:not(button)').forEach(link => {
    link.setAttribute('role', 'button');
    link.tabIndex = 0;
  });

  root.querySelectorAll?.('.status-text').forEach(status => {
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
  });

  root.querySelectorAll?.('[class*="footer-progress"], .file-progress-bar').forEach(syncProgressbar);

  // Associate the common "label + control in one row" pattern without
  // changing tool behavior. Explicit labels remain untouched.
  root.querySelectorAll?.('label:not([for])').forEach(label => {
    if (label.querySelector('input, select, textarea')) return;
    const row = label.closest('.options-row, .option-row, .settings-row, .control-row, .qr-field');
    const control = row?.querySelector('input, select, textarea');
    if (!control) return;
    if (!control.id) control.id = `accessibleControl${++generatedControlId}`;
    label.htmlFor = control.id;
  });

  root.querySelectorAll?.('button').forEach(button => {
    if (!button.textContent.trim() && !button.hasAttribute('aria-label')) {
      const fallback = button.title || 'Action';
      button.setAttribute('aria-label', fallback);
    }
  });
}

const accessibilityObserver = new MutationObserver(records => {
  records.forEach(record => {
    if (record.type === 'childList') {
      record.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceAccessibility(node);
      });
    }
    if (record.type === 'attributes') {
      const target = record.target;
      const progressbar = target.matches?.('[class*="footer-progress"], .file-progress-bar')
        ? target
        : target.closest?.('[class*="footer-progress"], .file-progress-bar');
      syncProgressbar(progressbar);
    }
  });
});
accessibilityObserver.observe(toolContent, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

document.addEventListener('keydown', event => {
  const link = event.target.closest?.('.drop-zone-link:not(button)');
  if (link && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    link.click();
    return;
  }
  const zone = event.target.closest?.('.drop-zone');
  if (zone && event.target === zone && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    zone.querySelector('.drop-zone-link, button')?.click();
  }
});

// ============================================================================
// GPU monitoring
// ============================================================================

function startGpuPolling() {
  _gpuPollingEnabled = true;
  syncGpuPolling();
}

function stopGpuPolling() {
  _gpuPollingEnabled = false;
  pauseGpuPolling();
  _vramFailCount = 0;
  gpuStats.classList.remove('active');
}

function canPollGpuStats() {
  return _gpuPollingEnabled && !document.hidden && (!systemStatus || systemStatus.open);
}

function pauseGpuPolling() {
  if (_vramTimer !== null) clearTimeout(_vramTimer);
  _vramTimer = null;
  const controller = _vramController;
  _vramController = null;
  controller?.abort();
}

function syncGpuPolling() {
  if (!canPollGpuStats()) pauseGpuPolling();
  else _scheduleVramPoll(0);
}

function _scheduleVramPoll(delayMs) {
  if (!canPollGpuStats() || _vramTimer !== null || _vramController !== null) return;
  _vramTimer = setTimeout(async () => {
    _vramTimer = null;
    await pollGpuStats();
  }, delayMs);
}

async function pollGpuStats() {
  if (!canPollGpuStats() || _vramController !== null) return;
  const controller = new AbortController();
  _vramController = controller;
  const tid = setTimeout(() => controller.abort(), 4000);
  let nextDelay = GPU_POLL_INTERVAL_MS;
  try {
    const resp = await fetch(`http://127.0.0.1:${pythonPort}/vram?token=${encodeURIComponent(pythonToken || '')}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`GPU status request failed (${resp.status})`);
    const data = await resp.json();
    if (_vramController !== controller || !canPollGpuStats()) return;

    _vramFailCount = 0;

    if (!data.available) {
      gpuStats.classList.remove('active');
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

  } catch {
    if (_vramController !== controller || !canPollGpuStats()) return;
    _vramFailCount++;
    gpuStats.classList.remove('active');
    // Telemetry is informational, so failed checks back off aggressively.
    nextDelay = Math.min(GPU_POLL_INTERVAL_MS * (2 ** (_vramFailCount - 1)), 60000);
  } finally {
    clearTimeout(tid);
    if (_vramController === controller) {
      _vramController = null;
      _scheduleVramPoll(nextDelay);
    }
  }
}

// Collapsed diagnostics and hidden windows require no telemetry timers or
// requests. Expanding or returning to the app refreshes them immediately.
systemStatus?.addEventListener('toggle', syncGpuPolling);
document.addEventListener('visibilitychange', syncGpuPolling);

function checkHealth() {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);
  fetch(`http://127.0.0.1:${pythonPort}/health?token=${encodeURIComponent(pythonToken || '')}`, { signal: controller.signal })
    .then(r => {
      clearTimeout(tid);
      if (!r.ok) throw new Error(`Health request failed (${r.status})`);
      return r.json();
    })
    .then(data => {
      const hasGpu = data.device === 'cuda' || data.device === 'mps';
      gpuBadge.textContent = hasGpu ? data.gpu_name || 'GPU Active' : 'CPU Mode (slower)';
      gpuBadge.style.borderColor = hasGpu ? '#4ade80' : '#fbbf24';
      _vramFailCount = 0;
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
  if (!window.WORKSPACE_TOOLS.some(tool => tool.id === id) || !module || typeof module.init !== 'function') {
    console.error('Ignoring invalid tool registration:', id);
    return false;
  }
  toolRegistry[id] = module;
  return true;
}

// Make this available globally so tool scripts can self-register
window.registerTool = registerTool;
// Tool DOM nodes are cached between visits, so their document-level event
// listeners remain alive too. Handlers use this to ignore events intended for
// the currently visible tool.
window.isToolActive = (toolId) => currentToolId === toolId;
window.pythonPort = null; // will be set during init
window.pythonToken = null; // will be set during init

let _loadRequestId = 0;

function updateSidebarSelection(toolId) {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    const active = item.dataset.tool === toolId;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

let lastBackendUiState = null;
function handleBackendStatus(status = {}) {
  if (Number.isInteger(status.port) && status.port >= 1 && status.port <= 65535) {
    pythonPort = status.port;
    window.pythonPort = status.port;
  }

  // Tool modules and their DOM are cached between visits. Forward status
  // changes so an initialized Python-backed tool can move an existing socket,
  // while the live getter passed below keeps later reconnects on this port.
  for (const [toolId, entry] of Object.entries(toolCache)) {
    if (!entry?.initialized || typeof entry.module?.onBackendStatus !== 'function') continue;
    try {
      entry.module.onBackendStatus({ ...status, port: pythonPort });
    } catch (err) {
      log(`Could not refresh ${toolId}'s backend connection: ${err.message}`, 'warn', toolId);
    }
  }

  const state = typeof status.state === 'string' ? status.state : 'unknown';
  if (state === 'ready') {
    lastBackendUiState = state;
    gpuBadge.textContent = 'Checking local backend...';
    gpuBadge.style.borderColor = 'var(--border-color, #64748b)';
    checkHealth();
    startGpuPolling();
    return;
  }

  stopGpuPolling();
  if (state === 'starting' || state === 'restarting') {
    gpuBadge.textContent = state === 'restarting' ? 'Backend restarting...' : 'Backend starting...';
    gpuBadge.style.borderColor = '#fbbf24';
  } else if (state === 'setup-required' || state === 'stopped') {
    gpuBadge.textContent = state === 'setup-required' ? 'Media pack optional' : 'Backend stopped';
    gpuBadge.style.borderColor = 'var(--border-color, #64748b)';
  } else if (state === 'error') {
    gpuBadge.textContent = 'Backend unavailable';
    gpuBadge.style.borderColor = '#f87171';
    if (lastBackendUiState !== 'error') {
      log(status.detail || 'The optional local media backend is unavailable.', 'warn');
    }
  }
  lastBackendUiState = state;
}

function updateDocumentTitle(toolId) {
  document.body.dataset.activeTool = toolId || '';
  const label = toolId
    ? document.querySelector(`.sidebar-item[data-tool="${toolId}"] .sidebar-label`)
    : null;
  document.title = label ? `${label.textContent} - ${APP_META.name}` : APP_META.name;
  const tool = window.WORKSPACE_TOOLS.find(item => item.id === toolId);
  document.getElementById('workspaceCategory').textContent = tool?.category || 'Workspace';
  document.getElementById('workspaceTitle').textContent = tool?.label || 'All tools';
  const mode = document.getElementById('workspaceMode');
  const online = tool?.category === 'Downloads';
  mode.textContent = online ? 'Network access' : toolId === 'settings' ? 'Device settings' : 'Local processing';
  mode.classList.toggle('online', online);
}

function restorePreviousTool(previousToolId, message) {
  const previous = previousToolId && toolCache[previousToolId];
  if (previous && previous.initialized && previous.container) {
    toolContent.replaceChildren(previous.container);
    currentToolId = previousToolId;
    currentToolModule = previous.module || toolRegistry[previousToolId] || null;
    toolStylesheet.href = `tools/${previousToolId}/${previousToolId}.css`;
    renderLogEntries(previousToolId);
  } else {
    currentToolId = null;
    currentToolModule = null;
    toolStylesheet.removeAttribute('href');
    toolContent.innerHTML = `
      <div class="tool-placeholder">
        <div class="tool-placeholder-icon">&#9888;</div>
        <div class="tool-placeholder-text">${escapeHtml(message || 'Unable to load this tool')}</div>
      </div>`;
  }

  updateSidebarSelection(currentToolId);
  updateDocumentTitle(currentToolId);
}

function arrangeWorkbench(container, toolId) {
  // Keep a file's queue and output settings beside each other on desktop.
  // IDs and the existing tool controllers remain unchanged by this layout.
  if (!['format-converter', 'video-compressor', 'audio-extractor', 'upscaler', 'bg-remover', 'stem-separator'].includes(toolId)) return;
  const body = container.querySelector('.tool-body');
  const drop = body?.querySelector(':scope > .drop-zone');
  const files = body?.querySelector(':scope > .file-list-container');
  const settings = body?.querySelector(':scope > .settings-bar');
  if (!drop || !files || !settings) return;
  const layout = document.createElement('div');
  layout.className = 'workbench-layout';
  const stage = document.createElement('div');
  stage.className = 'workbench-stage';
  const inspector = document.createElement('aside');
  inspector.className = 'workbench-inspector';
  inspector.setAttribute('aria-label', 'Output settings');
  const heading = document.createElement('h3');
  heading.textContent = 'Output settings';
  inspector.appendChild(heading);
  body.insertBefore(layout, drop);
  stage.append(drop, files);
  inspector.appendChild(settings);
  const advanced = body.querySelector(':scope > .tool-options');
  if (advanced) inspector.appendChild(advanced);
  layout.append(stage, inspector);
}

async function loadTool(toolId) {
  if (!window.WORKSPACE_TOOLS.some(tool => tool.id === toolId)) return false;
  if (toolId === currentToolId && toolCache[toolId]?.initialized) return true;

  // A monotonically increasing request id also handles A -> B -> A races;
  // comparing only the tool name lets the first stale A request win again.
  const requestId = ++_loadRequestId;

  const displayedToolId = toolContent.firstElementChild?.dataset?.tool;
  const previousToolId = displayedToolId && toolCache[displayedToolId]?.initialized
    ? displayedToolId
    : (toolCache[currentToolId]?.initialized ? currentToolId : null);
  if (previousToolId && previousToolId !== toolId) {
    const previous = toolCache[previousToolId];
    previous?.container?.querySelectorAll('audio, video').forEach(media => {
      try { media.pause(); } catch {}
    });
    try { previous?.module?.deactivate?.(); } catch (err) {
      log(`Could not deactivate ${previousToolId}: ${err.message}`, 'warn', previousToolId);
    }
  }
  currentToolModule = null;

  // Update sidebar
  updateSidebarSelection(toolId);

  currentToolId = toolId;
  renderLogEntries(toolId);

  // Update window title
  updateDocumentTitle(toolId);

  // Load tool CSS
  toolStylesheet.href = `tools/${toolId}/${toolId}.css`;

  let container = toolCache[toolId]?.container || null;
  if (container) {
    toolContent.replaceChildren(container);
    currentToolModule = toolCache[toolId].module || toolRegistry[toolId] || null;
    if (toolCache[toolId].initialized) {
      try { await currentToolModule?.activate?.(); }
      catch (err) { log(`Could not refresh ${toolId}: ${err.message}`, 'warn', toolId); }
      if (_loadRequestId !== requestId) return false;
      saveGlobalSettings();
      return true;
    }
    // A rapid navigation can cache HTML before its script initializes. Fall
    // through and finish initialization instead of returning a dead UI.
  } else try {
    container = document.createElement('div');
    container.className = 'tool-instance';
    container.dataset.tool = toolId;
    const resp = await fetch(`tools/${toolId}/${toolId}.html`);
    if (!resp.ok) throw new Error('not found');
    const html = await resp.text();
    if (_loadRequestId !== requestId) return false;
    container.innerHTML = html;
    arrangeWorkbench(container, toolId);
    enhanceAccessibility(container);
    toolCache[toolId] = {
      ...(toolCache[toolId] || {}),
      container,
      module: null,
    };
    toolContent.replaceChildren(container);
  } catch (err) {
    // If another tool was requested while this one was loading, that load owns
    // the UI now — don't stomp its content or roll its state back.
    if (_loadRequestId !== requestId) return false;
    delete toolCache[toolId];
    log(`Failed to load ${toolId}: ${err.message}`, 'error', toolId);
    restorePreviousTool(previousToolId, 'Unable to load this tool');
    saveGlobalSettings();
    return false;
  }

  // Load and execute tool JS
  try {
    const cacheEntry = toolCache[toolId];
    const existingScript = document.getElementById(`toolScript-${toolId}`);

    if (!existingScript) {
      const script = document.createElement('script');
      script.id = `toolScript-${toolId}`;
      script.src = `tools/${toolId}/${toolId}.js`;
      // Store the promise so a second visit while the same script is still
      // loading waits for registration rather than mistaking it for loaded.
      cacheEntry.scriptLoadPromise = new Promise((resolve) => {
        script.onload = () => resolve(true);
        script.onerror = () => {
          script.remove();
          resolve(false);
        };
      });
      document.body.appendChild(script);
    }
    if (cacheEntry.scriptLoadPromise && !(await cacheEntry.scriptLoadPromise)) {
      cacheEntry.scriptLoadPromise = null;
      throw new Error(`Failed to load script for ${toolId}`);
    }
    if (_loadRequestId !== requestId) return false;
    if (!toolRegistry[toolId]) throw new Error(`Tool script did not register ${toolId}`);

    // Initialize the tool once. Its state and DOM stay cached across navigation
    // until the user clears the tool from inside that module.
    currentToolModule = toolRegistry[toolId];
    toolCache[toolId].module = currentToolModule;
    if (!toolCache[toolId].initialized) {
      if (!cacheEntry.initPromise) {
        const toolLog = (message, level = 'info') => log(message, level, toolId);
        const toolClearLog = () => clearLog(toolId);
        const moduleToInitialize = currentToolModule;
        cacheEntry.initPromise = Promise.resolve().then(() => moduleToInitialize.init({
          pythonPort,
          getPythonPort: () => pythonPort,
          pythonToken,
          log: toolLog,
          escapeHtml,
          clearLog: toolClearLog
        }));
      }
      await cacheEntry.initPromise;
      cacheEntry.initPromise = null;
      cacheEntry.initialized = true;
      if (_loadRequestId !== requestId) return false;
    }
    enhanceAccessibility(container);
  } catch (e) {
    const staleRequest = _loadRequestId !== requestId;
    const failedModule = toolRegistry[toolId];
    try { failedModule?.cleanup?.(); } catch {}
    delete toolRegistry[toolId];
    document.getElementById(`toolScript-${toolId}`)?.remove();
    delete toolCache[toolId];
    if (staleRequest) return false;
    log(`Failed to load tool ${toolId}: ${e.message}`, 'error', toolId);
    restorePreviousTool(previousToolId, 'Unable to initialize this tool');
    saveGlobalSettings();
    return false;
  }

  saveGlobalSettings();
  return true;
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
  if (dragArea) dragArea.addEventListener('dblclick', toggleMax);

  wc.onMaximizeChange(reflectMaxState);
  wc.isMaximized().then(reflectMaxState).catch(() => {});
}

async function init() {
  setupWindowControls();
  const allSettings = await loadGlobalSettings();
  setLogCollapsed(allSettings.global?.logCollapsed !== false);

  // Preserve the saved appearance; fresh installs use the dark workspace.
  const savedTheme = allSettings.global?.theme || 'mono-dark';
  const theme = applyAppTheme(savedTheme, false);
  if (theme !== savedTheme) {
    updateSettings(all => {
      all.global = all.global || {};
      all.global.theme = theme;
    }).catch(() => {});
  }

  const appNameEl = document.getElementById('titlebarAppName');
  const versionEl = document.getElementById('titlebarVersion');
  if (appNameEl) appNameEl.textContent = APP_META.name;
  if (versionEl && typeof window.api.system.getAppVersion === 'function') {
    window.api.system.getAppVersion().then(version => {
      if (version) {
        versionEl.textContent = `v${String(version).replace(/^v/i, '')}`;
        versionEl.setAttribute('aria-label', `${APP_META.name} version ${String(version).replace(/^v/i, '')}`);
      }
    }).catch(() => {});
  }

  // Bind titlebar header quick action controls
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const headerLogBtn = document.getElementById('headerLogBtn');

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'mono-dark';
      applyAppTheme(getThemePair(current));
    });
  }

  if (headerLogBtn) {
    headerLogBtn.addEventListener('click', () => {
      toggleLogPanel();
    });
  }

  pythonPort = await window.api.python.getPythonPort();
  window.pythonPort = pythonPort;
  pythonToken = await window.api.python.getPythonToken();
  window.pythonToken = pythonToken;

  if (typeof window.api.python.onBackendStatus === 'function') {
    window.api.python.onBackendStatus(handleBackendStatus);
  }
  try {
    const componentStatus = await window.api.python.getStatus();
    handleBackendStatus(componentStatus?.backend || {});
  } catch {
    handleBackendStatus({ state: 'error', detail: 'Could not read the local backend status.' });
  }

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
      window.api.system.openExternal(APP_META.supportUrl);
    });
  }

  // Network access is opt-in. Manual checks remain available in Settings.
  if (allSettings.global?.automaticUpdateChecks === true && allSettings.global?.offlineMode !== true) {
    checkForAppUpdates();
  }

  // Home gives new users a neutral start instead of assuming an AI workflow.
  const savedTool = allSettings.global?.lastTool || 'home';
  const startTool = document.querySelector(`.sidebar-item[data-tool="${savedTool}"]`) ? savedTool : 'home';
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
    if (updateBanner && updateBannerText && updateDownloadBtn && updateRestartBtn) {
      updateBannerText.textContent = info.isLocal
        ? `A new local version (v${info.version}) is available!`
        : `A new version (v${info.version}) is available!`;
      updateBanner.style.display = 'flex';
      updateDownloadBtn.style.display = 'inline-block';
      updateDownloadBtn.disabled = false;
      updateDownloadBtn.textContent = info.isLocal
        ? 'Install'
        : info.manualOnly
          ? 'Open release'
          : 'Download';
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
      const rawPercent = Number(progress && progress.percent);
      const pct = Number.isFinite(rawPercent) ? Math.min(100, Math.max(0, Math.round(rawPercent))) : 0;
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
    const isManualRelease = !!(pendingUpdateInfo && pendingUpdateInfo.manualOnly);
    updateDownloadBtn.textContent = pendingUpdateInfo && pendingUpdateInfo.isLocal
      ? 'Installing...'
      : isManualRelease
        ? 'Opening...'
        : 'Downloading...';
    try {
      let result;
      if (isManualRelease) {
        const releaseUrl = pendingUpdateInfo && pendingUpdateInfo.releaseUrl;
        if (typeof releaseUrl !== 'string' || !/^https:\/\/github\.com\//i.test(releaseUrl)) {
          throw new Error('The update release page URL is invalid');
        }
        const opened = await window.api.system.openExternal(releaseUrl);
        result = opened ? { success: true } : { error: 'The release page could not be opened' };
      } else {
        result = pendingUpdateInfo && pendingUpdateInfo.isLocal && pendingUpdateInfo.installerPath
          ? await window.api.updater.downloadAndUpdate(pendingUpdateInfo.installerPath)
          : await window.api.updater.downloadUpdate();
      }
      if (!result || result.error || result.success === false) {
        const error = result && result.error ? result.error : 'Update could not be started';
        log(`Update error: ${error}`, 'error');
        updateDownloadBtn.disabled = false;
        updateDownloadBtn.textContent = 'Retry';
      } else if (isManualRelease) {
        updateDownloadBtn.disabled = false;
        updateDownloadBtn.textContent = 'Open release';
      }
    } catch (err) {
      log(`Update error: ${err.message}`, 'error');
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
const shortcutsDialog = shortcutsOverlay.querySelector('.shortcuts-modal');
let shortcutsReturnFocus = null;

function toggleShortcutsOverlay() {
  if (shortcutsOverlay.classList.contains('active')) closeShortcutsOverlay();
  else openShortcutsOverlay();
}

function openShortcutsOverlay() {
  if (Array.from(document.querySelectorAll('[aria-modal="true"]')).some(modal =>
    modal.getClientRects().length > 0 && !modal.closest('[aria-hidden="true"]'))) return;
  shortcutsReturnFocus = document.activeElement;
  shortcutsOverlay.classList.add('active');
  shortcutsOverlay.setAttribute('aria-hidden', 'false');
  shortcutsDialog.focus();
}

function closeShortcutsOverlay() {
  shortcutsOverlay.classList.remove('active');
  shortcutsOverlay.setAttribute('aria-hidden', 'true');
  if (shortcutsReturnFocus?.isConnected) shortcutsReturnFocus.focus();
  shortcutsReturnFocus = null;
}

shortcutsClose.addEventListener('click', closeShortcutsOverlay);

shortcutsOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutsOverlay) {
    closeShortcutsOverlay();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (document.getElementById('toolSearchDialog').open) return;
  // Escape — close shortcuts overlay, then context menus
  if (e.key === 'Escape') {
    if (shortcutsOverlay.classList.contains('active')) {
      closeShortcutsOverlay();
      return;
    }
    const menu = document.querySelector('.context-menu');
    if (menu) { menu.remove(); return; }
  }

  if (e.key === 'Tab' && shortcutsOverlay.classList.contains('active')) {
    const focusable = Array.from(shortcutsDialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.disabled && element.offsetParent !== null);
    if (focusable.length === 0) {
      e.preventDefault();
      shortcutsDialog.focus();
    } else {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === shortcutsDialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Ctrl+? (Ctrl+Shift+/) — toggle shortcuts overlay
  if (e.ctrlKey && e.shiftKey && e.key === '?') {
    e.preventDefault();
    toggleShortcutsOverlay();
    return;
  }

  if (Array.from(document.querySelectorAll('[aria-modal="true"]')).some(modal =>
    modal.getClientRects().length > 0 && !modal.closest('[aria-hidden="true"]'))) return;

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

enhanceAccessibility(document);
init();
