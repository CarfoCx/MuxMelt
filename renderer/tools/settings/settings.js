// ============================================================================
// Settings Tool
// ============================================================================

(function() {

let log = null;
let filenameSaveTimer = null;
let componentStatusUnsubscribe = null;
let settingsRoot = null;

const SAFE_DEFAULTS = Object.freeze({
  logCollapsed: true,
  automaticUpdateChecks: false,
  offlineMode: false,
  rememberRecentFiles: false,
  notificationDetail: 'generic'
});

const REPOSITORY_URL = 'https://github.com/CarfoCx/MuxMelt';
const SUPPORT_URL = 'https://ko-fi.com/carfo';

const byId = id => settingsRoot?.querySelector(`#${id}`);
const getSystemApi = () => (window.api && window.api.system) || {};
const getPythonApi = () => (window.api && window.api.python) || {};

function showSaveStatus(message, isError = false) {
  const status = byId('settingsSaveStatus');
  status.textContent = message;
  status.classList.toggle('error', isError);
  clearTimeout(showSaveStatus.timer);
  showSaveStatus.timer = setTimeout(() => { status.textContent = ''; }, 2400);
}

async function saveGlobalValue(key, value) {
  await window.updateSettings(all => {
    all.global = all.global || {};
    all.global[key] = value;
  });
  showSaveStatus('Saved on this device');
}

function populateThemes() {
  const select = byId('themeSelect');
  const registry = typeof window.getThemeRegistry === 'function' ? window.getThemeRegistry() : [];
  select.replaceChildren();
  const families = new Map();
  registry.forEach(theme => {
    if (!families.has(theme.family)) families.set(theme.family, []);
    families.get(theme.family).push(theme);
  });
  families.forEach(themes => {
    const group = document.createElement('optgroup');
    group.label = themes[0].label;
    themes.forEach(theme => {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = theme.mode === 'dark' ? 'Dark' : 'Light';
      group.appendChild(option);
    });
    select.appendChild(group);
  });
}

function setupSettingsTabs() {
  const page = document.querySelector('.settings-page');
  const groups = {
    General: ['appearanceHeading', 'generalHeading', 'resetHeading'],
    Privacy: ['privacyHeading', 'storageHeading', 'recentHeading'],
    Components: ['componentsHeading', 'systemHeading'],
    About: ['updatesHeading', 'aboutHeading']
  };
  const buttons = Array.from(page.querySelectorAll('[data-settings-tab]'));
  for (const [name, headings] of Object.entries(groups)) {
    const panel = document.createElement('div');
    panel.id = `settingsPanel${name}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `settingsTab${name}`);
    panel.tabIndex = 0;
    panel.hidden = name !== 'General';
    headings.forEach(heading => {
      const section = page.querySelector(`[aria-labelledby="${heading}"]`);
      if (section) panel.appendChild(section);
    });
    page.appendChild(panel);
  }
  function selectTab(button, focus = false) {
    buttons.forEach(item => {
      const selected = item === button;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      page.querySelector(`#settingsPanel${item.dataset.settingsTab}`).hidden = !selected;
    });
    if (focus) button.focus();
  }
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => selectTab(button));
    button.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault();
      selectTab(buttons[next], true);
    });
  });
}

async function loadCurrentSettings() {
  const all = await window.loadAllSettings();
  const global = { ...SAFE_DEFAULTS, ...(all.global || {}) };

  const dirButton = byId('defaultOutputDirBtn');
  dirButton.textContent = 'Same as source';
  dirButton.title = '';
  if (global.defaultOutputDir) setPathButton(dirButton, global.defaultOutputDir);

  const currentTheme = window.applyAppTheme ? window.applyAppTheme(global.theme || 'mono-dark', false) : (global.theme || 'mono-dark');
  const themeSelect = byId('themeSelect');
  if (Array.from(themeSelect.options).some(option => option.value === currentTheme)) themeSelect.value = currentTheme;

  byId('offlineModeCheck').checked = global.offlineMode === true;
  byId('automaticUpdateChecksCheck').checked = global.automaticUpdateChecks === true;
  byId('rememberRecentFilesCheck').checked = global.rememberRecentFiles === true;
  byId('notificationDetailSelect').value = ['generic', 'detailed', 'off'].includes(global.notificationDetail) ? global.notificationDetail : 'generic';
  byId('logCollapsedCheck').checked = global.logCollapsed === true;
  byId('autoOpenOutputCheck').checked = global.autoOpenOutput === true;
  byId('overwriteConfirmCheck').checked = global.skipOverwriteConfirm !== true;
  byId('disableGpuCheck').checked = global.disableHardwareAcceleration === true;
  byId('filenamePattern').value = global.filenamePattern || '';

  const upscaler = all.upscaler || {};
  byId('defaultScale').value = String(upscaler.scale || 2);
  byId('defaultModelProfile').value = upscaler.modelProfile || 'general';

  reflectOfflineMode(global.offlineMode === true);

  const updateButton = byId('updateFolderBtn');
  updateButton.textContent = 'Not set';
  updateButton.title = '';
  try {
    const folder = await window.api.updater.getLocalUpdateFolder();
    if (folder) setPathButton(updateButton, folder);
  } catch {}

  await loadRecentFiles();
}

function setPathButton(button, fullPath) {
  const parts = String(fullPath).replace(/\\/g, '/').split('/');
  button.textContent = parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : fullPath;
  button.title = fullPath;
}

function reflectOfflineMode(enabled) {
  byId('automaticUpdateChecksCheck').disabled = enabled;
  byId('checkUpdateBtn').disabled = enabled;
  byId('updateFolderBtn').disabled = enabled;
  if (enabled) {
    byId('updateStatusLabel').textContent = 'Offline mode is on';
    byId('updateStatusHint').textContent = 'Turn off Offline mode before accessing local or network update sources.';
  } else if (byId('updateStatusLabel').textContent === 'Offline mode is on') {
    byId('updateStatusLabel').textContent = 'Check for new versions';
    byId('updateStatusHint').textContent = 'Manual checks contact GitHub unless a local update source is selected.';
  }
}

function bindEvents() {
  byId('themeSelect').addEventListener('change', event => {
    window.applyAppTheme(event.target.value);
    showSaveStatus('Theme saved');
  });

  byId('offlineModeCheck').addEventListener('change', async event => {
    const checkbox = event.target;
    const next = checkbox.checked;
    let actual = !next;
    const systemApi = getSystemApi();
    checkbox.disabled = true;
    try {
      if (typeof systemApi.setOfflineMode === 'function') {
        const result = await systemApi.setOfflineMode(next);
        if (typeof result?.offlineMode === 'boolean') actual = result.offlineMode;
        if (result && result.success === false) throw new Error(result.error || 'Could not change Offline mode');
        if (result?.warning) {
          reflectOfflineMode(actual);
          showSaveStatus(result.warning, true);
          log(result.warning, 'warn');
          return;
        }
      } else {
        await saveGlobalValue('offlineMode', next);
      }
      actual = next;
      reflectOfflineMode(next);
      showSaveStatus(next ? 'Offline mode enabled' : 'Offline mode disabled');
      log(`Offline mode ${next ? 'enabled' : 'disabled'}`, 'success');
    } catch (error) {
      checkbox.checked = actual;
      reflectOfflineMode(actual);
      showSaveStatus(`Could not change Offline mode: ${error.message}`, true);
      log(`Could not change Offline mode: ${error.message}`, 'error');
    } finally {
      checkbox.disabled = false;
    }
  });

  byId('automaticUpdateChecksCheck').addEventListener('change', event => saveGlobalValue('automaticUpdateChecks', event.target.checked).catch(reportSaveError));
  byId('notificationDetailSelect').addEventListener('change', event => saveGlobalValue('notificationDetail', event.target.value).catch(reportSaveError));
  byId('rememberRecentFilesCheck').addEventListener('change', async event => {
    const remember = event.target.checked;
    try {
      await saveGlobalValue('rememberRecentFiles', remember);
      if (!remember) await window.clearRecentFiles();
      await loadRecentFiles();
    } catch (error) { reportSaveError(error); }
  });

  byId('defaultOutputDirBtn').addEventListener('click', async () => {
    const directory = await getSystemApi().selectOutputDir();
    if (!directory) return;
    await saveGlobalValue('defaultOutputDir', directory);
    setPathButton(byId('defaultOutputDirBtn'), directory);
    log(`Default output directory set to: ${directory}`, 'success');
  });
  byId('resetOutputDir').addEventListener('click', async () => {
    await window.updateSettings(all => { if (all.global) delete all.global.defaultOutputDir; });
    const button = byId('defaultOutputDirBtn');
    button.textContent = 'Same as source';
    button.title = '';
    showSaveStatus('Output folder reset');
  });

  bindGlobalCheckbox('logCollapsedCheck', 'logCollapsed');
  bindGlobalCheckbox('autoOpenOutputCheck', 'autoOpenOutput');
  byId('overwriteConfirmCheck').addEventListener('change', event => saveGlobalValue('skipOverwriteConfirm', !event.target.checked).catch(reportSaveError));
  bindGlobalCheckbox('disableGpuCheck', 'disableHardwareAcceleration');

  byId('filenamePattern').addEventListener('input', event => {
    clearTimeout(filenameSaveTimer);
    filenameSaveTimer = setTimeout(() => saveGlobalValue('filenamePattern', event.target.value).catch(reportSaveError), 300);
  });
  byId('defaultScale').addEventListener('change', event => {
    window.updateSettings(all => {
      all.upscaler = all.upscaler || {};
      all.upscaler.scale = Number.parseInt(event.target.value, 10);
    }).then(() => showSaveStatus('Upscaler default saved')).catch(reportSaveError);
  });
  byId('defaultModelProfile').addEventListener('change', event => {
    window.updateSettings(all => {
      all.upscaler = all.upscaler || {};
      all.upscaler.modelProfile = event.target.value;
    }).then(() => showSaveStatus('Upscaler default saved')).catch(reportSaveError);
  });

  byId('installMediaPackBtn').addEventListener('click', () => runPackAction('installMediaPack', 'media'));
  bindRemovePack('removeMediaPackBtn', 'media');
  bindRemovePack('removeLegacyChatBtn', 'chat');

  byId('openDataFolderBtn').addEventListener('click', async () => {
    const method = getSystemApi().openDataFolder;
    if (typeof method !== 'function') return showSaveStatus('Data-folder access is unavailable in this build', true);
    try { await method(); } catch (error) { showSaveStatus(error.message, true); }
  });
  byId('clearPrivateDataBtn').addEventListener('click', clearSelectedPrivateData);
  byId('clearRecentBtn').addEventListener('click', async () => {
    await window.clearRecentFiles();
    await loadRecentFiles();
    showSaveStatus('Recent paths cleared');
  });

  byId('updateFolderBtn').addEventListener('click', chooseUpdateFolder);
  byId('resetUpdateFolder').addEventListener('click', resetUpdateFolder);
  byId('checkUpdateBtn').addEventListener('click', checkForUpdates);

  const externalLinks = {
    privacyBtn: `${REPOSITORY_URL}/blob/main/PRIVACY.md`,
    securityBtn: `${REPOSITORY_URL}/blob/main/SECURITY.md`,
    noticesBtn: `${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`,
    githubBtn: REPOSITORY_URL,
    issuesBtn: `${REPOSITORY_URL}/issues`,
    donateBtn: SUPPORT_URL
  };
  Object.entries(externalLinks).forEach(([id, url]) => byId(id).addEventListener('click', () => getSystemApi().openExternal(url)));

  byId('resetAllSettingsBtn').addEventListener('click', resetAllSettings);
}

function bindGlobalCheckbox(id, key) {
  byId(id).addEventListener('change', event => saveGlobalValue(key, event.target.checked).catch(reportSaveError));
}

function reportSaveError(error) {
  showSaveStatus(`Could not save: ${error.message}`, true);
  log(`Could not save settings: ${error.message}`, 'error');
}

function normalizePackStatus(status, packId) {
  const source = status?.[packId] || status?.packs?.[packId] || status?.installed?.[packId] || {};
  if (typeof source === 'boolean') return { installed: source, installing: false, detail: '' };
  return {
    installed: source.installed === true || source.status === 'installed',
    repairable: source.repairable === true,
    installing: source.installing === true || ['installing', 'downloading'].includes(source.status),
    detail: source.detail || source.message || (Number.isFinite(source.progress) ? `${Math.round(source.progress)}%` : '')
  };
}

function renderPack(packId, pack) {
  const title = 'Media AI pack';
  const status = byId(`${packId}PackStatus`);
  const install = byId('installMediaPackBtn');
  const remove = byId('removeMediaPackBtn');
  status.textContent = pack.installing ? `${title}: installing${pack.detail ? ` - ${pack.detail}` : '...'}` : (pack.installed ? `${title}: installed${pack.detail ? ` - ${pack.detail}` : ''}` : `${title}: not installed`);
  status.classList.toggle('installed', pack.installed);
  status.setAttribute('aria-busy', String(pack.installing));
  install.hidden = pack.installed && !pack.repairable;
  install.disabled = pack.installing;
  install.textContent = pack.installing ? 'Installing...' : (pack.repairable ? 'Repair' : 'Install');
  remove.hidden = !pack.installed;
  remove.disabled = pack.installing;
}

async function refreshComponentStatus(payload) {
  const pythonApi = getPythonApi();
  const notice = byId('componentApiNotice');
  if (typeof pythonApi.getStatus !== 'function') {
    notice.hidden = false;
    byId('mediaPackStatus').textContent = 'Status unavailable in this build';
    byId('installMediaPackBtn').disabled = true;
    return;
  }
  try {
    const result = payload && typeof payload === 'object' ? payload : await pythonApi.getStatus();
    notice.hidden = true;
    if (typeof result.offlineMode === 'boolean') {
      byId('offlineModeCheck').checked = result.offlineMode;
      reflectOfflineMode(result.offlineMode);
    }
    renderPack('media', normalizePackStatus(result, 'media'));
  } catch (error) {
    notice.hidden = false;
    notice.textContent = `Could not read component status: ${error.message}`;
  }
}

async function runPackAction(action, packId) {
  const pythonApi = getPythonApi();
  const method = pythonApi[action];
  if (typeof method !== 'function') return showSaveStatus('Component installation is unavailable in this build', true);
  try {
    renderPack(packId, { installed: false, installing: true, detail: '' });
    const result = await method();
    if (result && result.success === false) throw new Error(result.error || 'Installation failed');
    await refreshComponentStatus();
    await refreshStorageSummary();
    log('Media AI pack installed', 'success');
  } catch (error) {
    showSaveStatus(error.message, true);
    log(`Component installation failed: ${error.message}`, 'error');
    await refreshComponentStatus();
  }
}

function bindRemovePack(buttonId, packId) {
  const button = byId(buttonId);
  button.addEventListener('click', async () => {
    if (!button.dataset.confirming) {
      button.dataset.confirming = 'true';
      button.textContent = 'Confirm remove';
      setTimeout(() => {
        if (button.dataset.confirming) {
          delete button.dataset.confirming;
          button.textContent = 'Remove';
        }
      }, 3500);
      return;
    }
    delete button.dataset.confirming;
    const method = getPythonApi().removePack;
    if (typeof method !== 'function') return showSaveStatus('Component removal is unavailable in this build', true);
    button.disabled = true;
    try {
      const result = await method(packId);
      if (result && result.success === false) throw new Error(result.error || 'Removal failed');
      await refreshComponentStatus();
      await refreshStorageSummary();
      showSaveStatus('Component removed');
    } catch (error) {
      showSaveStatus(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Remove';
    }
  });
}

async function refreshStorageSummary() {
  const method = getSystemApi().getStorageSummary;
  const summary = byId('storageSummary');
  if (typeof method !== 'function') {
    summary.textContent = 'Storage details are unavailable in this build.';
    byId('openDataFolderBtn').disabled = typeof getSystemApi().openDataFolder !== 'function';
    return;
  }
  try {
    const data = await method();
    const legacyChat = Array.isArray(data?.packs) ? data.packs.find(pack => pack.id === 'chat' && pack.installed) : null;
    byId('legacyChatStorage').hidden = !legacyChat;
    if (legacyChat) {
      byId('legacyChatStorageHint').textContent = `${formatBytes(Number(legacyChat.bytes))} from the removed chat feature. Remove these unused files to free space.`;
    }
    const total = Number(data?.totalBytes);
    const pieces = [Number.isFinite(total) ? `${formatBytes(total)} used by MuxMelt` : 'Local storage summary'];
    if (Number.isFinite(Number(data?.cachesBytes))) pieces.push(`${formatBytes(Number(data.cachesBytes))} caches`);
    if (Array.isArray(data?.packs) && data.packs.length) {
      const packBytes = data.packs.reduce((sum, pack) => sum + (Number(pack.bytes) || 0), 0);
      pieces.push(`${formatBytes(packBytes)} optional components`);
    }
    summary.textContent = pieces.join(' - ');
  } catch (error) {
    summary.textContent = `Could not calculate storage: ${error.message}`;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** power);
  return `${value.toFixed(power === 0 || value >= 10 ? 0 : 1)} ${units[power]}`;
}

async function clearSelectedPrivateData() {
  const options = {
    recentFiles: byId('clearRecentFilesCheck').checked,
    temporaryFiles: byId('clearTemporaryFilesCheck').checked,
    caches: byId('clearCachesCheck').checked,
    models: byId('clearModelsCheck').checked,
    logs: byId('clearLogsCheck').checked
  };
  if (!Object.values(options).some(Boolean)) return showSaveStatus('Choose at least one item to clear', true);
  const button = byId('clearPrivateDataBtn');
  if (!button.dataset.confirming) {
    button.dataset.confirming = 'true';
    button.textContent = 'Click again to confirm';
    setTimeout(() => {
      if (button.dataset.confirming) {
        delete button.dataset.confirming;
        button.textContent = 'Clear selected data';
      }
    }, 3500);
    return;
  }
  delete button.dataset.confirming;
  button.disabled = true;
  button.textContent = 'Clearing...';
  try {
    const method = getSystemApi().clearPrivateData;
    if (typeof method === 'function') {
      const result = await method(options);
      if (result && result.success === false) throw new Error(result.error || 'Could not clear private data');
    } else if (options.recentFiles && !options.temporaryFiles && !options.caches) {
      await window.clearRecentFiles();
    } else {
      throw new Error('Private-data cleanup is unavailable in this build');
    }
    await loadRecentFiles();
    await refreshStorageSummary();
    showSaveStatus('Selected local data cleared');
    log('Selected private data cleared', 'success');
  } catch (error) {
    showSaveStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Clear selected data';
  }
}

async function loadRecentFiles() {
  const all = await window.loadAllSettings();
  const remember = all.global?.rememberRecentFiles === true;
  const recent = remember ? await window.getRecentFiles() : [];
  const section = byId('recentFilesSection');
  const list = byId('recentFilesList');
  const label = byId('recentFilesLabel');
  section.hidden = !remember;
  list.replaceChildren();
  label.textContent = recent.length ? `${recent.length} recent output${recent.length === 1 ? '' : 's'}` : 'No recent outputs';
  byId('clearRecentBtn').disabled = recent.length === 0;
  recent.forEach(filePath => {
    const parts = String(filePath).replace(/\\/g, '/').split('/');
    const fileName = parts.pop();
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-file-item';
    item.title = filePath;
    item.innerHTML = `<span class="recent-file-name">${window.escapeHtml(fileName)}</span><span class="recent-file-path">${window.escapeHtml(parts.join('/'))}</span>`;
    item.addEventListener('click', () => getSystemApi().openFolder(window.getParentDirectory(filePath)));
    list.appendChild(item);
  });
}

async function loadSystemInfo() {
  try {
    const version = await getSystemApi().getAppVersion();
    byId('appVersion').textContent = version || 'unknown';
  } catch { byId('appVersion').textContent = 'unknown'; }

  let timeout = null;
  try {
    const port = window.pythonPort || await getPythonApi().getPythonPort();
    const token = window.pythonToken || await getPythonApi().getPythonToken();
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`http://127.0.0.1:${port}/health?token=${encodeURIComponent(token || '')}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Backend health request failed (${response.status})`);
    const data = await response.json();
    byId('pythonVersion').textContent = data.python_version || '-';
    byId('deviceInfo').textContent = String(data.device || '-').toUpperCase();
    byId('gpuInfo').textContent = data.gpu_name || 'None (CPU mode)';
    byId('ffmpegInfo').textContent = data.ffmpeg ? 'Installed' : 'Not found';
    byId('modulesInfo').textContent = Array.isArray(data.modules) ? data.modules.join(', ') : '-';
    byId('vramInfo').textContent = data.vram_total ? `${(data.vram_total / (1024 ** 3)).toFixed(1)} GB` : '-';
  } catch {
    byId('pythonVersion').textContent = 'Local service unavailable';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function chooseUpdateFolder() {
  try {
    const result = await window.api.updater.selectLocalUpdateFolder();
    const path = result && !result.cancelled ? result.path : '';
    if (!path) return;
    setPathButton(byId('updateFolderBtn'), path);
    showSaveStatus('Local update source saved');
  } catch (error) { showSaveStatus(error.message, true); }
}

async function resetUpdateFolder() {
  try {
    await window.api.updater.clearLocalUpdateFolder();
    byId('updateFolderBtn').textContent = 'Not set';
    byId('updateFolderBtn').title = '';
    showSaveStatus('Local update source reset');
  } catch (error) { showSaveStatus(error.message, true); }
}

async function checkForUpdates() {
  const all = await window.loadAllSettings();
  if (all.global?.offlineMode === true) {
    reflectOfflineMode(true);
    return;
  }
  const button = byId('checkUpdateBtn');
  const label = byId('updateStatusLabel');
  const hint = byId('updateStatusHint');
  button.disabled = true;
  button.textContent = 'Checking...';
  label.textContent = 'Checking for updates...';
  hint.textContent = 'This may contact GitHub.';
  try {
    const result = await window.api.updater.checkForUpdates();
    if (result?.error) throw new Error(result.error);
    if (result?.updateAvailable) {
      label.textContent = `Version ${result.latestVersion || result.version} is available`;
      hint.textContent = result.isLocal ? 'Ready from your local update source.' : 'Use the update notice to open the release.';
    } else {
      label.textContent = 'MuxMelt is up to date';
      hint.textContent = result?.currentVersion ? `Current version: ${result.currentVersion}` : 'No newer release was found.';
    }
    button.textContent = 'Check again';
  } catch (error) {
    label.textContent = 'Could not check for updates';
    hint.textContent = error.message;
    button.textContent = 'Retry';
  } finally {
    button.disabled = false;
  }
}

async function resetAllSettings() {
  const button = byId('resetAllSettingsBtn');
  if (!button.dataset.confirming) {
    button.dataset.confirming = 'true';
    button.textContent = 'Click again to confirm';
    setTimeout(() => {
      if (button.dataset.confirming) {
        delete button.dataset.confirming;
        button.textContent = 'Reset all settings';
      }
    }, 3500);
    return;
  }
  delete button.dataset.confirming;
  try {
    await window.saveAllSettings({ global: { ...SAFE_DEFAULTS, theme: 'mono-dark', lastTool: 'home' } });
    await window.api.updater.clearLocalUpdateFolder();
    window.applyAppTheme('mono-dark', false);
    showSaveStatus('Privacy-first defaults restored');
    setTimeout(() => window.location.reload(), 450);
  } catch (error) {
    button.textContent = 'Reset all settings';
    showSaveStatus(error.message, true);
  }
}

async function init(ctx) {
  settingsRoot = document.querySelector('.settings-page');
  setupSettingsTabs();
  log = ctx.log;
  populateThemes();
  bindEvents();
  try { await loadCurrentSettings(); } catch (error) { reportSaveError(error); }
  const pythonApi = getPythonApi();
  if (typeof pythonApi.onStatus === 'function') componentStatusUnsubscribe = pythonApi.onStatus(refreshComponentStatus);
  await Promise.all([refreshComponentStatus(), refreshStorageSummary(), loadSystemInfo()]);
}

function cleanup() {
  clearTimeout(filenameSaveTimer);
  clearTimeout(showSaveStatus.timer);
  if (typeof componentStatusUnsubscribe === 'function') componentStatusUnsubscribe();
  componentStatusUnsubscribe = null;
}

async function activate() {
  await Promise.all([loadCurrentSettings(), refreshComponentStatus(), refreshStorageSummary()]);
}

window.registerTool('settings', { init, cleanup, activate });

})();
