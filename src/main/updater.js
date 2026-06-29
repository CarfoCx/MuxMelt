const { autoUpdater } = require('electron-updater');
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

const ALLOWED_INSTALLER_EXTS = new Set(['.exe', '.dmg', '.pkg', '.appimage', '.zip']);

let isUpdateReady = false;

// Configure autoUpdater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function loadSettings() {
  const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function compareVersions(v1, v2) {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((p1[i] || 0) > (p2[i] || 0)) return 1;
    if ((p1[i] || 0) < (p2[i] || 0)) return -1;
  }
  return 0;
}

// Re-derive the installer to run from the trusted version.json inside the
// user-configured update folder. Never trust a path handed in by the renderer:
// validate containment (no traversal out of the folder), a newer version, and
// an allowed installer extension. Returns { installerPath, sha256, version }.
function resolveTrustedLocalInstaller(updateFolder, currentVersion) {
  if (!updateFolder || !fs.existsSync(updateFolder)) {
    throw new Error('No local update folder is configured.');
  }
  const versionPath = path.join(updateFolder, 'version.json');
  if (!fs.existsSync(versionPath)) {
    throw new Error('No version.json found in the update folder.');
  }
  const info = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
  if (!info || !info.version || !info.installer) {
    throw new Error('version.json is missing version/installer fields.');
  }
  if (compareVersions(String(info.version), String(currentVersion)) <= 0) {
    throw new Error(`Update folder version ${info.version} is not newer than ${currentVersion}.`);
  }

  const folderResolved = path.resolve(updateFolder);
  const installerResolved = path.resolve(updateFolder, info.installer);
  const rel = path.relative(folderResolved, installerResolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Installer path escapes the update folder.');
  }

  const ext = path.extname(installerResolved).toLowerCase();
  if (!ALLOWED_INSTALLER_EXTS.has(ext)) {
    throw new Error(`Installer has a disallowed extension: ${ext || '(none)'}`);
  }
  if (!fs.existsSync(installerResolved) || !fs.statSync(installerResolved).isFile()) {
    throw new Error('Installer file not found in update folder.');
  }

  return {
    installerPath: installerResolved,
    sha256: info.sha256 ? String(info.sha256).toLowerCase() : null,
    version: String(info.version)
  };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

function checkForUpdates(sendUpdateEvent) {
  const pkg = require('../../package.json');
  const currentVersion = pkg.version;

  try {
    const settings = loadSettings();
    const updateFolder = settings.global && settings.global.updateFolderPath;
    if (updateFolder && fs.existsSync(updateFolder)) {
      const versionPath = path.join(updateFolder, 'version.json');
      if (fs.existsSync(versionPath)) {
        const info = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
        if (info.version && info.installer) {
          const isNewer = compareVersions(info.version, currentVersion) > 0;
          return Promise.resolve({
            upToDate: !isNewer,
            updateAvailable: !!isNewer,
            currentVersion,
            latestVersion: info.version,
            version: info.version,
            installerPath: path.join(updateFolder, info.installer),
            isLocal: true
          });
        }
      }
    }
  } catch (err) {
    console.warn('Failed to check local update folder:', err.message);
  }

  const repoUrl = pkg.repository && pkg.repository.url;
  if (!repoUrl) {
    return Promise.resolve({
      upToDate: true,
      currentVersion,
      message: 'No repository configured for update checks'
    });
  }

  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) {
    return Promise.resolve({ upToDate: true, currentVersion });
  }

  const [, owner, repo] = match;

  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { headers: { 'User-Agent': 'MuxMelt' } },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            const isNewer = latestVersion && compareVersions(latestVersion, currentVersion) > 0;
            resolve({
              currentVersion,
              latestVersion,
              version: latestVersion,
              upToDate: !isNewer,
              updateAvailable: !!isNewer,
              releaseUrl: release.html_url || '',
              isLocal: false
            });
          } catch {
            resolve({ upToDate: true, updateAvailable: false, currentVersion });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ error: err.message, upToDate: true, updateAvailable: false, currentVersion }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ error: 'Update check timed out', upToDate: true, updateAvailable: false, currentVersion });
    });
  });
}

function emitManualUpdateResult(result, sendUpdateEvent) {
  if (result.error) {
    sendUpdateEvent('update-error', result.error);
    return;
  }

  if (result.updateAvailable) {
    sendUpdateEvent('update-available', {
      version: result.latestVersion || result.version,
      currentVersion: result.currentVersion,
      installerPath: result.installerPath,
      releaseUrl: result.releaseUrl,
      isLocal: !!result.isLocal
    });
  } else {
    sendUpdateEvent('update-not-available', {
      version: result.latestVersion || result.currentVersion,
      currentVersion: result.currentVersion,
      message: result.message,
      isLocal: !!result.isLocal
    });
  }
}

function initAutoUpdater(sendUpdateEvent) {
  autoUpdater.on('checking-for-update', () => sendUpdateEvent('update-status', 'Checking for updates...'));
  autoUpdater.on('update-available', (info) => sendUpdateEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdateEvent('update-not-available', info));
  autoUpdater.on('error', (err) => sendUpdateEvent('update-error', err.message));
  autoUpdater.on('download-progress', (progressObj) => sendUpdateEvent('update-download-progress', progressObj));
  autoUpdater.on('update-downloaded', (info) => {
    isUpdateReady = true;
    sendUpdateEvent('update-downloaded', info);
  });
}

function registerUpdaterIpcHandlers(sendUpdateEvent) {
  ipcMain.handle('check-for-updates', async () => {
    try {
      sendUpdateEvent('update-status', 'Checking for updates...');

      const manualResult = await checkForUpdates(sendUpdateEvent);
      if (manualResult.isLocal || !app.isPackaged || manualResult.error || !manualResult.updateAvailable) {
        emitManualUpdateResult(manualResult, sendUpdateEvent);
        return manualResult;
      }

      try {
        const electronUpdaterResult = await autoUpdater.checkForUpdates();
        return {
          ...manualResult,
          provider: 'electron-updater',
          updateInfo: electronUpdaterResult && electronUpdaterResult.updateInfo
        };
      } catch (err) {
        console.warn('electron-updater check failed, using GitHub release check:', err.message);
        emitManualUpdateResult(manualResult, sendUpdateEvent);
        return {
          ...manualResult,
          warning: err.message
        };
      }
    } catch (err) {
      console.error('Update check failed:', err);
      const result = { error: err.message, upToDate: true, updateAvailable: false };
      emitManualUpdateResult(result, sendUpdateEvent);
      return result;
    }
  });

  ipcMain.handle('download-update', async () => {
    try {
      return await autoUpdater.downloadUpdate();
    } catch (err) {
      console.error('Update download failed:', err);
      sendUpdateEvent('update-error', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('restart-to-update', () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('download-and-update', async (event, requestedPath) => {
    const pkg = require('../../package.json');
    const settings = loadSettings();
    const updateFolder = settings.global && settings.global.updateFolderPath;

    // Authoritatively resolve the installer from the trusted version.json.
    // The renderer cannot make us launch an arbitrary executable.
    const { installerPath, sha256 } = resolveTrustedLocalInstaller(updateFolder, pkg.version);

    if (requestedPath && path.resolve(requestedPath) !== installerPath) {
      throw new Error('Requested installer does not match the trusted update folder.');
    }

    // Copy to temp first, then verify the integrity of the copy we will
    // actually launch. Hashing the source and launching the copy would leave
    // a window where the file could be swapped between check and use. The
    // async copy also keeps a multi-hundred-MB installer from freezing the UI.
    const tempDir = app.getPath('temp');
    const targetPath = path.join(tempDir, path.basename(installerPath));
    await fs.promises.copyFile(installerPath, targetPath);

    if (sha256) {
      const actual = (await hashFile(targetPath)).toLowerCase();
      if (actual !== sha256) {
        try { await fs.promises.unlink(targetPath); } catch {}
        throw new Error('Installer failed integrity check (SHA-256 mismatch).');
      }
    }

    const isWin = process.platform === 'win32';
    if (isWin) {
      spawn(targetPath, [], {
        detached: true,
        stdio: 'ignore'
      }).unref();
    } else {
      shell.openPath(targetPath);
    }

    app.quit();
    return true;
  });
}

function getIsUpdateReady() {
  return isUpdateReady;
}

module.exports = {
  autoUpdater,
  checkForUpdates,
  emitManualUpdateResult,
  initAutoUpdater,
  getIsUpdateReady,
  registerUpdaterIpcHandlers,
  resolveTrustedLocalInstaller,
  hashFile
};
