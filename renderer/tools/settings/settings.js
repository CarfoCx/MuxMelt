// ============================================================================
// Settings Tool
// ============================================================================

(function() {

let log = null;
let filenameSaveTimer = null;

async function init(ctx) {
  log = ctx.log;
  try {
    await loadCurrentSettings();
  } catch (err) {
    log(`Could not load settings: ${err.message}`, 'warn');
  }
  bindEvents();
  loadSystemInfo();
  loadRecentFiles();
}

function cleanup() {}

async function loadCurrentSettings() {
  const all = await window.loadAllSettings();
  const g = all.global || {};

  // Default output dir
  const dirBtn = document.getElementById('defaultOutputDirBtn');
  dirBtn.textContent = 'Same as source';
  dirBtn.title = '';
  if (g.defaultOutputDir) {
    const parts = g.defaultOutputDir.replace(/\\/g, '/').split('/');
    dirBtn.textContent = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : g.defaultOutputDir;
    dirBtn.title = g.defaultOutputDir;
  }

  // Theme
  const theme = g.theme || 'dark';
  document.getElementById('themeSelect').value = theme;

  // Log collapsed
  document.getElementById('logCollapsedCheck').checked = !!g.logCollapsed;

  // Auto-open output
  document.getElementById('autoOpenOutputCheck').checked = !!g.autoOpenOutput;

  // Overwrite confirmation
  document.getElementById('overwriteConfirmCheck').checked = !g.skipOverwriteConfirm;

  // Disable GPU Check
  document.getElementById('disableGpuCheck').checked = !!g.disableHardwareAcceleration;

  // Filename pattern
  document.getElementById('filenamePattern').value = g.filenamePattern || '';

  // Upscaler defaults
  const u = all.upscaler || {};
  document.getElementById('defaultScale').value = String(u.scale || 2);
  document.getElementById('defaultModelProfile').value = u.modelProfile || 'general';

  // Update folder
  const updateBtn = document.getElementById('updateFolderBtn');
  updateBtn.textContent = 'Not set';
  updateBtn.title = '';
  const updateFolder = await window.api.updater.getLocalUpdateFolder();
  if (updateFolder) {
    const parts = updateFolder.replace(/\\/g, '/').split('/');
    updateBtn.textContent = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : updateFolder;
    updateBtn.title = updateFolder;
  }
}

function bindEvents() {
  // Default output dir
  document.getElementById('defaultOutputDirBtn').addEventListener('click', async () => {
    const dir = await window.api.system.selectOutputDir();
    if (!dir) return;

    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.defaultOutputDir = dir;
    });

    const parts = dir.replace(/\\/g, '/').split('/');
    const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : dir;
    const btn = document.getElementById('defaultOutputDirBtn');
    btn.textContent = display;
    btn.title = dir;

    log(`Default output directory set to: ${dir}`, 'success');
  });

  // Theme
  document.getElementById('themeSelect').addEventListener('change', async (e) => {
    const theme = e.target.value;
    document.documentElement.setAttribute('data-theme', theme);
    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.theme = theme;
    });
    log(`Theme set to ${theme}`);
  });

  document.getElementById('resetOutputDir').addEventListener('click', async () => {
    await window.updateSettings(all => {
      if (all.global) delete all.global.defaultOutputDir;
    });

    document.getElementById('defaultOutputDirBtn').textContent = 'Same as source';
    document.getElementById('defaultOutputDirBtn').title = '';
    log('Default output directory reset', 'success');
  });

  // Log collapsed
  document.getElementById('logCollapsedCheck').addEventListener('change', async (e) => {
    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.logCollapsed = e.target.checked;
    });
  });

  // Auto-open output
  document.getElementById('autoOpenOutputCheck').addEventListener('change', async (e) => {
    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.autoOpenOutput = e.target.checked;
    });
  });

  // Overwrite confirmation
  document.getElementById('overwriteConfirmCheck').addEventListener('change', async (e) => {
    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.skipOverwriteConfirm = !e.target.checked;
    });
  });

  // Disable GPU Check
  document.getElementById('disableGpuCheck').addEventListener('change', async (e) => {
    await window.updateSettings(all => {
      all.global = all.global || {};
      all.global.disableHardwareAcceleration = e.target.checked;
    });
    log(`GPU Hardware Acceleration preference updated (restart app to apply)`);
  });

  // Filename pattern
  document.getElementById('filenamePattern').addEventListener('input', (e) => {
    const value = e.target.value;
    clearTimeout(filenameSaveTimer);
    filenameSaveTimer = setTimeout(() => {
      window.updateSettings(all => {
        all.global = all.global || {};
        all.global.filenamePattern = value;
      }).catch(err => log(`Could not save filename pattern: ${err.message}`, 'error'));
    }, 250);
  });

  // Default scale
  document.getElementById('defaultScale').addEventListener('change', async (e) => {
    await window.updateSettings(all => {
      all.upscaler = all.upscaler || {};
      all.upscaler.scale = parseInt(e.target.value, 10);
    });
    log(`Default upscale factor set to ${e.target.value}x`);
  });

  // Donate button
  document.getElementById('donateBtn').addEventListener('click', () => {
    window.api.system.openExternal('https://ko-fi.com/carfo');
  });

  // GitHub / Issues buttons
  document.getElementById('githubBtn').addEventListener('click', () => {
    window.api.system.openExternal('https://github.com/CarfoCx/MuxMelt');
  });

  document.getElementById('issuesBtn').addEventListener('click', () => {
    window.api.system.openExternal('https://github.com/CarfoCx/MuxMelt/issues');
  });

  // Update folder path
  document.getElementById('updateFolderBtn').addEventListener('click', async () => {
    const result = await window.api.updater.selectLocalUpdateFolder();
    const dir = result && !result.cancelled ? result.path : '';
    if (!dir) return;

    const parts = dir.replace(/\\/g, '/').split('/');
    const display = parts.length > 2 ? '.../' + parts.slice(-2).join('/') : dir;
    const btn = document.getElementById('updateFolderBtn');
    btn.textContent = display;
    btn.title = dir;

    log(`Update source folder set to: ${dir}`, 'success');
  });

  document.getElementById('resetUpdateFolder').addEventListener('click', async () => {
    await window.api.updater.clearLocalUpdateFolder();

    document.getElementById('updateFolderBtn').textContent = 'Not set';
    document.getElementById('updateFolderBtn').title = '';
    log('Update source folder reset', 'success');
  });

  // Check for updates button
  document.getElementById('checkUpdateBtn').addEventListener('click', async () => {
    const btn = document.getElementById('checkUpdateBtn');
    const label = document.getElementById('updateStatusLabel');
    const hint = document.getElementById('updateStatusHint');
    
    btn.disabled = true;
    btn.textContent = 'Checking...';
    label.textContent = 'Checking for updates...';
    hint.textContent = 'Comparing current version with latest release';
    
    try {
      const result = await window.api.updater.checkForUpdates();
      if (result && result.error) throw new Error(result.error);
      if (result && result.updateAvailable) {
        label.textContent = `Version ${result.latestVersion || result.version} is available`;
        hint.textContent = result.isLocal ? 'Ready from your local update source' : 'Use the update banner to download it';
      } else {
        label.textContent = 'MuxMelt is up to date';
        hint.textContent = result && result.currentVersion ? `Current version: ${result.currentVersion}` : 'No newer release was found';
      }
      btn.disabled = false;
      btn.textContent = 'Check again';
    } catch (err) {
      label.textContent = 'Failed to check for updates';
      hint.textContent = err.message;
      btn.textContent = 'Retry';
      btn.disabled = false;
    }
  });

  // Default model profile
  document.getElementById('defaultModelProfile').addEventListener('change', async (e) => {
    await window.updateSettings(all => {
      all.upscaler = all.upscaler || {};
      all.upscaler.modelProfile = e.target.value;
    });
    log(`Default model profile set to ${e.target.value}`);
  });

  // Reset all settings (double-click to confirm)
  document.getElementById('resetAllSettingsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('resetAllSettingsBtn');
    if (!btn.dataset.confirming) {
      btn.dataset.confirming = '1';
      btn.textContent = 'Click again to confirm';
      setTimeout(() => {
        if (btn.dataset.confirming) {
          delete btn.dataset.confirming;
          btn.textContent = 'Reset All';
        }
      }, 3000);
      return;
    }
    delete btn.dataset.confirming;
    btn.textContent = 'Reset All';

    await window.saveAllSettings({});
    await window.api.updater.clearLocalUpdateFolder();
    document.documentElement.setAttribute('data-theme', 'dark');
    await loadCurrentSettings();
    log('All settings reset to defaults', 'success');
    if (window.showCompletionToast) window.showCompletionToast('Settings reset. Reloading the interface...');
    setTimeout(() => window.location.reload(), 400);
  });
}

async function loadSystemInfo() {
  // App version (git-based)
  try {
    const version = await window.api.system.getAppVersion();
    document.getElementById('appVersion').textContent = version;
  } catch {
    document.getElementById('appVersion').textContent = 'unknown';
  }

  // Backend info
  let healthTimeout = null;
  try {
    const port = window.pythonPort || await window.api.python.getPythonPort();
    const token = window.pythonToken || await window.api.python.getPythonToken();
    const controller = new AbortController();
    healthTimeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`http://127.0.0.1:${port}/health?token=${encodeURIComponent(token || '')}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Backend health request failed (${resp.status})`);
    const data = await resp.json();

    document.getElementById('pythonVersion').textContent = data.python_version || '-';
    document.getElementById('deviceInfo').textContent = (data.device || '-').toUpperCase();
    document.getElementById('gpuInfo').textContent = data.gpu_name || 'None (CPU mode)';
    document.getElementById('ffmpegInfo').textContent = data.ffmpeg ? 'Installed' : 'Not found';
    document.getElementById('modulesInfo').textContent = Array.isArray(data.modules) ? data.modules.join(', ') : '-';

    if (data.vram_total) {
      const gb = (data.vram_total / (1024 ** 3)).toFixed(1);
      document.getElementById('vramInfo').textContent = `${gb} GB`;
    } else {
      document.getElementById('vramInfo').textContent = '-';
    }
  } catch {
    document.getElementById('pythonVersion').textContent = 'Backend unavailable';
  } finally {
    if (healthTimeout) clearTimeout(healthTimeout);
  }
}

async function loadRecentFiles() {
  const list = document.getElementById('recentFilesList');
  const label = document.getElementById('recentFilesLabel');
  const clearBtn = document.getElementById('clearRecentBtn');

  const recent = await window.getRecentFiles();

  function render(files) {
    list.innerHTML = '';
    if (files.length === 0) {
      label.textContent = 'No recent files';
      clearBtn.disabled = true;
      return;
    }

    label.textContent = `${files.length} recent file${files.length === 1 ? '' : 's'}`;
    clearBtn.disabled = false;

    files.forEach(filePath => {
      const parts = filePath.replace(/\\/g, '/').split('/');
      const fileName = parts.pop();
      const dirPath = parts.join('/');

      const item = document.createElement('div');
      item.className = 'recent-file-item';
      item.title = filePath;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `Open folder containing ${fileName}`);
      item.innerHTML = `<span class="recent-file-name">${window.escapeHtml(fileName)}</span><span class="recent-file-path">${window.escapeHtml(dirPath)}</span>`;
      const openContainingFolder = () => {
        const dir = window.getParentDirectory(filePath);
        window.api.system.openFolder(dir);
      };
      item.addEventListener('click', openContainingFolder);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openContainingFolder();
        }
      });
      list.appendChild(item);
    });
  }

  render(recent);

  clearBtn.addEventListener('click', async () => {
    await window.clearRecentFiles();
    render([]);
    log('Recent files history cleared', 'success');
  });
}

window.registerTool('settings', { init, cleanup });

})();
