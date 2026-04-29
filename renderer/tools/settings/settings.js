// ============================================================================
// Settings Tool
// ============================================================================

(function() {

let log = null;

function init(ctx) {
  log = ctx.log;
  loadCurrentSettings();
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

  // Filename pattern
  document.getElementById('filenamePattern').value = g.filenamePattern || '';

  // Upscaler defaults
  const u = all.upscaler || {};
  if (u.scale) document.getElementById('defaultScale').value = String(u.scale);
  if (u.modelProfile) document.getElementById('defaultModelProfile').value = u.modelProfile;
}

function bindEvents() {
  // Default output dir
  document.getElementById('defaultOutputDirBtn').addEventListener('click', async () => {
    const dir = await window.api.selectOutputDir();
    if (!dir) return;

    const all = await window.loadAllSettings();
    all.global = all.global || {};
    all.global.defaultOutputDir = dir;
    await window.saveAllSettings(all);

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
    const all = await window.loadAllSettings();
    all.global = all.global || {};
    all.global.theme = theme;
    await window.saveAllSettings(all);
    log(`Theme set to ${theme}`);
  });

  document.getElementById('resetOutputDir').addEventListener('click', async () => {
    const all = await window.loadAllSettings();
    if (all.global) delete all.global.defaultOutputDir;
    await window.saveAllSettings(all);

    document.getElementById('defaultOutputDirBtn').textContent = 'Same as source';
    document.getElementById('defaultOutputDirBtn').title = '';
    log('Default output directory reset', 'success');
  });

  // Log collapsed
  document.getElementById('logCollapsedCheck').addEventListener('change', async (e) => {
    const all = await window.loadAllSettings();
    all.global = all.global || {};
    all.global.logCollapsed = e.target.checked;
    await window.saveAllSettings(all);
  });

  // Auto-open output
  document.getElementById('autoOpenOutputCheck').addEventListener('change', async (e) => {
    const all = await window.loadAllSettings();
    all.global = all.global || {};
    all.global.autoOpenOutput = e.target.checked;
    await window.saveAllSettings(all);
  });

  // Overwrite confirmation
  document.getElementById('overwriteConfirmCheck').addEventListener('change', async (e) => {
    const all = await window.loadAllSettings();
    all.global = all.global || {};
    all.global.skipOverwriteConfirm = !e.target.checked;
    await window.saveAllSettings(all);
  });

  // Filename pattern
  document.getElementById('filenamePattern').addEventListener('input', async (e) => {
    const all = await window.loadAllSettings();
    all.global = all.global || {};
    all.global.filenamePattern = e.target.value;
    await window.saveAllSettings(all);
  });

  // Default scale
  document.getElementById('defaultScale').addEventListener('change', async (e) => {
    const all = await window.loadAllSettings();
    all.upscaler = all.upscaler || {};
    all.upscaler.scale = parseInt(e.target.value);
    await window.saveAllSettings(all);
    log(`Default upscale factor set to ${e.target.value}x`);
  });

  // Donate button
  document.getElementById('donateBtn').addEventListener('click', () => {
    window.api.openExternal('https://ko-fi.com/carfo');
  });

  // GitHub / Issues buttons
  document.getElementById('githubBtn').addEventListener('click', () => {
    window.api.openExternal('https://github.com/CarfoCx/MuxMelt');
  });

  document.getElementById('issuesBtn').addEventListener('click', () => {
    window.api.openExternal('https://github.com/CarfoCx/MuxMelt/issues');
  });

  // Check for updates button
  document.getElementById('checkUpdateBtn').addEventListener('click', async () => {
    const btn = document.getElementById('checkUpdateBtn');
    const label = document.getElementById('updateStatusLabel');
    const hint = document.getElementById('updateStatusHint');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    try {
      const result = await window.api.checkForUpdates();
      if (result.upToDate) {
        label.textContent = 'You are up to date!';
        hint.textContent = `Current version: ${result.currentVersion}`;
        btn.textContent = 'Up to Date';
      } else {
        label.textContent = `Update available: ${result.latestVersion}`;
        hint.textContent = `Current: ${result.currentVersion}`;
        btn.textContent = 'Download Update';
        btn.disabled = false;
        btn.onclick = () => window.api.openExternal(result.releaseUrl);
      }
    } catch {
      label.textContent = 'Failed to check for updates';
      btn.textContent = 'Retry';
      btn.disabled = false;
    }
  });

  // Default model profile
  document.getElementById('defaultModelProfile').addEventListener('change', async (e) => {
    const all = await window.loadAllSettings();
    all.upscaler = all.upscaler || {};
    all.upscaler.modelProfile = e.target.value;
    await window.saveAllSettings(all);
    log(`Default model profile set to ${e.target.value}`);
  });
}

async function loadSystemInfo() {
  // App version (git-based)
  try {
    const version = await window.api.getAppVersion();
    document.getElementById('appVersion').textContent = version;
  } catch {
    document.getElementById('appVersion').textContent = 'unknown';
  }

  // Backend info
  try {
    const port = window.pythonPort || await window.api.getPythonPort();
    const resp = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await resp.json();

    document.getElementById('pythonVersion').textContent = data.python_version || '-';
    document.getElementById('deviceInfo').textContent = (data.device || '-').toUpperCase();
    document.getElementById('gpuInfo').textContent = data.gpu_name || 'None (CPU mode)';
    document.getElementById('ffmpegInfo').textContent = data.ffmpeg ? 'Installed' : 'Not found';
    document.getElementById('modulesInfo').textContent = (data.modules || []).join(', ');

    if (data.vram_total) {
      const gb = (data.vram_total / (1024 ** 3)).toFixed(1);
      document.getElementById('vramInfo').textContent = `${gb} GB`;
    } else {
      document.getElementById('vramInfo').textContent = '-';
    }
  } catch {
    document.getElementById('pythonVersion').textContent = 'Backend unavailable';
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
      item.innerHTML = `<span class="recent-file-name">${window.escapeHtml(fileName)}</span><span class="recent-file-path">${window.escapeHtml(dirPath)}</span>`;
      item.addEventListener('click', () => {
        const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        window.api.openFolder(dir);
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
