const { autoUpdater } = require('electron-updater');
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

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
            currentVersion,
            latestVersion: info.version,
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

  ipcMain.handle('download-and-update', async (event, installerPath) => {
    if (!installerPath || !fs.existsSync(installerPath)) {
      throw new Error('Installer not found at ' + installerPath);
    }

    const tempDir = app.getPath('temp');
    const targetPath = path.join(tempDir, path.basename(installerPath));

    fs.copyFileSync(installerPath, targetPath);

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
  registerUpdaterIpcHandlers
};
