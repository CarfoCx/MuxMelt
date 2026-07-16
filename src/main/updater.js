const { autoUpdater } = require('electron-updater');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

const PLATFORM_INSTALLER_EXTS = {
  win32: new Set(['.exe']),
  darwin: new Set(['.dmg', '.pkg']),
  linux: new Set(['.appimage']),
};

let isUpdateReady = false;
let updaterInitialized = false;

// Configure autoUpdater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function localUpdatePreferencePath() {
  return path.join(app.getPath('userData'), 'local-update-source.json');
}

function loadLocalUpdateFolder() {
  const preferencePath = localUpdatePreferencePath();
  try {
    const stat = fs.lstatSync(preferencePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return '';
    const value = JSON.parse(fs.readFileSync(preferencePath, 'utf-8'));
    if (!value || typeof value.folder !== 'string' || !value.folder) return '';
    const resolved = fs.realpathSync(value.folder);
    return fs.statSync(resolved).isDirectory() ? resolved : '';
  } catch {
    return '';
  }
}

function saveLocalUpdateFolder(folder) {
  const preferencePath = localUpdatePreferencePath();
  const resolved = fs.realpathSync(folder);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Update source must be a directory.');
  const temporaryPath = `${preferencePath}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({ folder: resolved, selectedAt: new Date().toISOString() }),
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.renameSync(temporaryPath, preferencePath);
  return resolved;
}

function compareVersions(v1, v2) {
  const parse = (value) => {
    const match = String(value).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) throw new Error(`Invalid version: ${value}`);
    const core = match.slice(1, 4).map((part) => Number(part || 0));
    if (core.some((part) => !Number.isSafeInteger(part))) {
      throw new Error(`Version component is too large: ${value}`);
    }
    return { core, prerelease: match[4] ? match[4].split('.') : [] };
  };

  const p1 = parse(v1);
  const p2 = parse(v2);
  for (let i = 0; i < 3; i++) {
    if (p1.core[i] > p2.core[i]) return 1;
    if (p1.core[i] < p2.core[i]) return -1;
  }
  if (p1.prerelease.length === 0 || p2.prerelease.length === 0) {
    if (p1.prerelease.length === p2.prerelease.length) return 0;
    return p1.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(p1.prerelease.length, p2.prerelease.length);
  for (let i = 0; i < count; i++) {
    const left = p1.prerelease[i];
    const right = p2.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) > Number(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
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
  const folderResolved = fs.realpathSync(updateFolder);
  if (!fs.statSync(folderResolved).isDirectory()) {
    throw new Error('The configured update path is not a directory.');
  }
  const versionPath = path.join(folderResolved, 'version.json');
  if (!fs.existsSync(versionPath)) {
    throw new Error('No version.json found in the update folder.');
  }
  const versionStat = fs.lstatSync(versionPath);
  if (!versionStat.isFile() || versionStat.isSymbolicLink()) {
    throw new Error('version.json must be a regular file inside the update folder.');
  }
  if (versionStat.size > 1024 * 1024) {
    throw new Error('version.json exceeds the 1 MB limit.');
  }
  const info = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
  if (!info || typeof info.version !== 'string' || typeof info.installer !== 'string') {
    throw new Error('version.json is missing version/installer fields.');
  }
  if (compareVersions(String(info.version), String(currentVersion)) <= 0) {
    throw new Error(`Update folder version ${info.version} is not newer than ${currentVersion}.`);
  }

  const installerResolved = path.resolve(folderResolved, info.installer);
  const rel = path.relative(folderResolved, installerResolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Installer path escapes the update folder.');
  }

  const ext = path.extname(installerResolved).toLowerCase();
  const allowedInstallerExts = PLATFORM_INSTALLER_EXTS[process.platform] || new Set();
  if (!allowedInstallerExts.has(ext)) {
    throw new Error(`Installer has a disallowed extension: ${ext || '(none)'}`);
  }
  if (!fs.existsSync(installerResolved)) {
    throw new Error('Installer file not found in update folder.');
  }
  const installerStat = fs.lstatSync(installerResolved);
  if (!installerStat.isFile() || installerStat.isSymbolicLink()) {
    throw new Error('Installer must be a regular file, not a symbolic link.');
  }
  const installerRealPath = fs.realpathSync(installerResolved);
  const realRelative = path.relative(folderResolved, installerRealPath);
  if (realRelative === '' || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('Installer resolves outside the update folder.');
  }

  const sha256 = typeof info.sha256 === 'string' ? info.sha256.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('version.json must contain the installer SHA-256 value.');
  }

  return {
    installerPath: installerRealPath,
    sha256,
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

async function cleanupStaleUpdateDirectories() {
  const tempRoot = await fs.promises.realpath(app.getPath('temp'));
  const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith('muxmelt-update-')) return;
    const candidate = path.join(tempRoot, entry.name);
    const relative = path.relative(tempRoot, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const stat = await fs.promises.lstat(candidate);
    if (stat.isSymbolicLink() || stat.mtimeMs >= cutoff) return;
    await fs.promises.rm(candidate, { recursive: true, force: true });
  }));
}

async function checkForUpdates(sendUpdateEvent) {
  const pkg = require('../../package.json');
  const currentVersion = pkg.version;

  try {
    const updateFolder = loadLocalUpdateFolder();
    if (typeof updateFolder === 'string' && updateFolder) {
      const versionPath = path.join(updateFolder, 'version.json');
      try {
        const versionStat = await fs.promises.lstat(versionPath);
        if (!versionStat.isFile() || versionStat.isSymbolicLink() || versionStat.size > 1024 * 1024) {
          throw new Error('Local version.json is not a valid regular file.');
        }
        const info = JSON.parse(await fs.promises.readFile(versionPath, 'utf-8'));
        if (typeof info.version === 'string' && typeof info.installer === 'string') {
          const isNewer = compareVersions(info.version, currentVersion) > 0;
          if (isNewer) {
            const trusted = resolveTrustedLocalInstaller(updateFolder, currentVersion);
            return Promise.resolve({
              upToDate: false,
              updateAvailable: true,
              currentVersion,
              latestVersion: trusted.version,
              version: trusted.version,
              installerPath: trusted.installerPath,
              isLocal: true
            });
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = https.get(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { headers: { 'User-Agent': 'MuxMelt' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish({
            error: `GitHub update check failed with HTTP ${res.statusCode}`,
            upToDate: false,
            updateAvailable: false,
            currentVersion
          });
          return;
        }
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (Buffer.byteLength(data, 'utf8') > 2 * 1024 * 1024) {
            res.destroy(new Error('GitHub update response exceeded 2 MB'));
          }
        });
        res.on('error', (err) => finish({
          error: err.message,
          upToDate: false,
          updateAvailable: false,
          currentVersion
        }));
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            if (!release || typeof release.tag_name !== 'string') {
              throw new Error('GitHub release response is missing a version tag');
            }
            const latestVersion = release.tag_name.replace(/^v/, '');
            const isNewer = compareVersions(latestVersion, currentVersion) > 0;
            finish({
              currentVersion,
              latestVersion,
              version: latestVersion,
              upToDate: !isNewer,
              updateAvailable: !!isNewer,
              releaseUrl: release.html_url || '',
              isLocal: false
            });
          } catch (err) {
            finish({
              error: `Invalid GitHub update response: ${err.message}`,
              upToDate: false,
              updateAvailable: false,
              currentVersion
            });
          }
        });
      }
    );
    req.on('error', (err) => finish({ error: err.message, upToDate: false, updateAvailable: false, currentVersion }));
    req.setTimeout(10000, () => {
      finish({ error: 'Update check timed out', upToDate: false, updateAvailable: false, currentVersion });
      req.destroy();
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
      isLocal: !!result.isLocal,
      manualOnly: !!result.manualOnly
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
  if (updaterInitialized) return;
  updaterInitialized = true;
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
  cleanupStaleUpdateDirectories().catch((err) => {
    console.warn('Failed to clean stale update files:', err.message);
  });

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
        const fallbackResult = {
          ...manualResult,
          manualOnly: true
        };
        emitManualUpdateResult(fallbackResult, sendUpdateEvent);
        return {
          ...fallbackResult,
          warning: err.message
        };
      }
    } catch (err) {
      console.error('Update check failed:', err);
      const result = { error: err.message, upToDate: false, updateAvailable: false };
      emitManualUpdateResult(result, sendUpdateEvent);
      return result;
    }
  });

  ipcMain.handle('get-local-update-folder', () => loadLocalUpdateFolder());

  ipcMain.handle('select-local-update-folder', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Select Local Update Source',
      properties: ['openDirectory'],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { cancelled: true, path: '' };
    }
    const folder = saveLocalUpdateFolder(result.filePaths[0]);
    return { cancelled: false, path: folder };
  });

  ipcMain.handle('clear-local-update-folder', () => {
    fs.rmSync(localUpdatePreferencePath(), { force: true });
    return true;
  });

  ipcMain.handle('download-update', async () => {
    try {
      isUpdateReady = false;
      return await autoUpdater.downloadUpdate();
    } catch (err) {
      console.error('Update download failed:', err);
      sendUpdateEvent('update-error', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('restart-to-update', () => {
    if (!isUpdateReady) return false;
    autoUpdater.quitAndInstall();
    return true;
  });

  ipcMain.handle('download-and-update', async (event, requestedPath) => {
    const pkg = require('../../package.json');
    const updateFolder = loadLocalUpdateFolder();

    // Authoritatively resolve the installer from the trusted version.json.
    // The renderer cannot make us launch an arbitrary executable.
    const { installerPath, sha256, version } = resolveTrustedLocalInstaller(updateFolder, pkg.version);

    if (requestedPath !== undefined && requestedPath !== null) {
      if (typeof requestedPath !== 'string') throw new Error('Requested installer path is invalid.');
      const requestedResolved = path.resolve(requestedPath);
      const pathsMatch = process.platform === 'win32'
        ? requestedResolved.toLowerCase() === installerPath.toLowerCase()
        : requestedResolved === installerPath;
      if (!pathsMatch) throw new Error('Requested installer does not match the trusted update folder.');
    }

    // Copy to temp first, then verify the integrity of the copy we will
    // actually launch. Hashing the source and launching the copy would leave
    // a window where the file could be swapped between check and use. The
    // async copy also keeps a multi-hundred-MB installer from freezing the UI.
    const tempDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'muxmelt-update-'));
    const targetPath = path.join(tempDir, path.basename(installerPath));
    try {
      await fs.promises.copyFile(installerPath, targetPath);

      if (sha256) {
        const actual = (await hashFile(targetPath)).toLowerCase();
        if (actual !== sha256) {
          throw new Error('Installer failed integrity check (SHA-256 mismatch).');
        }
      }

      // A local manifest and its hash can be authored together, so neither is
      // a signature. Require an unmistakable native confirmation after
      // hashing the immutable temp copy and immediately before native launch.
      const owner = BrowserWindow.fromWebContents(event.sender);
      const confirmationOptions = {
        type: 'warning',
        title: 'Run Local Update Installer?',
        message: `Run the MuxMelt ${pkg.version} → ${version} local update?`,
        detail: `Version: ${version}\nInstaller: ${installerPath}\nSHA-256: ${sha256}\n\nOnly continue if you trust this folder and expected this installer.`,
        buttons: ['Cancel', 'Run Installer'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const confirmation = owner
        ? await dialog.showMessageBox(owner, confirmationOptions)
        : await dialog.showMessageBox(confirmationOptions);
      if (confirmation.response !== 1) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        return false;
      }

      if (process.platform === 'win32') {
        await new Promise((resolve, reject) => {
          const child = spawn(targetPath, [], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          const onError = (err) => reject(err);
          child.once('error', onError);
          child.once('spawn', () => {
            child.removeListener('error', onError);
            child.unref();
            resolve();
          });
        });
      } else {
        const openError = await shell.openPath(targetPath);
        if (openError) throw new Error(`Failed to open installer: ${openError}`);
      }
    } catch (err) {
      try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch {}
      throw err;
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
  hashFile,
  compareVersions
};
