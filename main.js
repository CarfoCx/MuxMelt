const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const http = require('http');
const https = require('https');

let mainWindow;
let splashWindow;
let splashState = { percent: 8, status: 'Preparing MuxMelt', detail: 'Loading required components' };
let pythonProcess;
let PYTHON_PORT = 8765;
const crypto = require('crypto');
const SHUTDOWN_TOKEN = crypto.randomBytes(32).toString('hex');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
let isUpdateReady = false;

// Configure autoUpdater
autoUpdater.autoDownload = false; // We'll let the user click "Download" in the banner
autoUpdater.autoInstallOnAppQuit = true;

// ---------------------------------------------------------------------------
// Bundled app detection — find bundled Python and ffmpeg if available
// ---------------------------------------------------------------------------

const IS_PACKAGED = app.isPackaged;
const RESOURCES_PATH = IS_PACKAGED ? path.join(process.resourcesPath) : null;
const IS_WIN = process.platform === 'win32';
const FFMPEG_BIN = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

// Work around intermittent Windows compositor artifacts in Electron/Chromium
// by disabling occlusion tracking. Also allow completely disabling GPU hardware acceleration via settings.
if (IS_WIN) {
  let disableHardwareAcceleration = false;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    if (settings && settings.global && settings.global.disableHardwareAcceleration) {
      disableHardwareAcceleration = true;
    }
  } catch {}

  if (disableHardwareAcceleration) {
    const disabledChromiumFeatures = [
      'CalculateNativeWinOcclusion',
      'CanvasOopRasterization',
      'DCompPresenter',
      'DirectComposition',
      'DirectCompositionVideoOverlays',
      'HardwareOverlays',
      'UseSkiaRenderer'
    ].join(',');

    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-direct-composition');
    app.commandLine.appendSwitch('disable-features', disabledChromiumFeatures);
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
  } else {
    // Only disable window occlusion to prevent blank/black screen issues
    // while preserving full GPU acceleration for smooth performance.
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  }
}
// Standalone Python lives at python-env/python/bin/python3 (Unix) or python-env/python/python.exe (Win)
const BUNDLED_PYTHON = RESOURCES_PATH
  ? (IS_WIN
    ? path.join(RESOURCES_PATH, 'python-env', 'python', 'python.exe')
    : path.join(RESOURCES_PATH, 'python-env', 'python', 'bin', 'python3'))
  : null;
const DEV_PYTHON = !IS_PACKAGED
  ? (IS_WIN
    ? path.join(__dirname, 'build', 'bundle', 'python-env', 'python', 'python.exe')
    : path.join(__dirname, 'build', 'bundle', 'python-env', 'python', 'bin', 'python3'))
  : null;
const BUNDLED_FFMPEG = RESOURCES_PATH ? path.join(RESOURCES_PATH, 'ffmpeg') : null;
const DEV_FFMPEG = !IS_PACKAGED ? path.join(__dirname, 'build', 'bundle', 'ffmpeg') : null;
const IS_SLIM = BUNDLED_PYTHON && fs.existsSync(path.join(RESOURCES_PATH, 'python-env', '.slim'));
const SLIM_PYTHON_DIR = path.join(app.getPath('userData'), 'python-env');
const SLIM_PYTHON_EXE = IS_WIN
  ? path.join(SLIM_PYTHON_DIR, 'python.exe')
  : path.join(SLIM_PYTHON_DIR, 'bin', 'python3');

// Add bundled ffmpeg to PATH if available
const FFMPEG_PATH = BUNDLED_FFMPEG && fs.existsSync(BUNDLED_FFMPEG)
  ? BUNDLED_FFMPEG
  : (DEV_FFMPEG && fs.existsSync(DEV_FFMPEG) ? DEV_FFMPEG : null);
if (FFMPEG_PATH) {
  process.env.PATH = FFMPEG_PATH + path.delimiter + process.env.PATH;
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err.message);
  }
}

function clearChromiumGpuCaches() {
  if (!IS_WIN) return;

  for (const cacheDir of ['GPUCache', 'DawnCache']) {
    try {
      fs.rmSync(path.join(app.getPath('userData'), cacheDir), { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') {
        console.warn(`Failed to clear ${cacheDir}:`, err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Python version detection and selection
// ---------------------------------------------------------------------------

function findPython() {
  // Check for bundled Python (full build)
  const preparedPython = BUNDLED_PYTHON || DEV_PYTHON;
  if (preparedPython && fs.existsSync(preparedPython)) {
    try {
      const result = execSync(`"${preparedPython}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result.includes('Python 3.')) {
        return { cmd: preparedPython, args: [], version: result + ' (bundled)' };
      }
    } catch {}
  }

  // Check for slim build's installed Python
  if (fs.existsSync(SLIM_PYTHON_EXE)) {
    try {
      const result = execSync(`"${SLIM_PYTHON_EXE}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result.includes('Python 3.')) {
        return { cmd: SLIM_PYTHON_EXE, args: [], version: result + ' (auto-installed)' };
      }
    } catch {}
  }

  const isWin = process.platform === 'win32';

  // On Windows, try the py launcher with specific versions. Ask the launcher
  // which versions are installed in ONE quiet call first — probing each version
  // with `py -3.13 --version` makes the launcher print a noisy "[ERROR] No
  // runtime installed that matches 3.13" to stderr for every absent version.
  if (isWin) {
    let installed = null;
    try {
      const list = execSync('py --list', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      installed = [...list.matchAll(/-V:(\d+\.\d+)/g)].map((m) => m[1]);
    } catch { installed = null; }
    for (const ver of ['3.13', '3.12', '3.11', '3.10']) {
      // When we have a version list, skip absent ones to avoid the noise. If the
      // list call failed (older launcher), fall back to probing them all.
      if (installed && !installed.includes(ver)) continue;
      try {
        const result = execSync(`py -${ver} --version`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (result.includes('Python 3.')) {
          return { cmd: 'py', args: [`-${ver}`], version: result };
        }
      } catch {}
    }
  }

  // Fallback: try common Python commands
  const cmds = isWin ? ['python'] : ['python3', 'python'];
  for (const cmd of cmds) {
    try {
      const result = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const match = result.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1]);
        const minor = parseInt(match[2]);
        if (major === 3 && minor >= 10) {
          return { cmd, args: [], version: result };
        }
      }
    } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Python server management
// ---------------------------------------------------------------------------

let pythonInfo = null;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  const ports = [startPort, startPort + 1, startPort + 2, startPort + 10, startPort + 100];
  for (const port of ports) {
    if (await isPortAvailable(port)) return port;
  }
  // Dynamic fallback: bind to port 0 to get an OS-allocated random high port
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('listening', () => {
      const address = server.address();
      const allocatedPort = address ? address.port : startPort;
      server.close(() => resolve(allocatedPort));
    });
    server.once('error', () => {
      resolve(startPort);
    });
    server.listen(0, '127.0.0.1');
  });
}

function startPythonServer() {
  pythonInfo = findPython();

  if (!pythonInfo) {
    return Promise.reject(new Error(
      'No compatible Python found.\n\n' +
      'Install Python 3.10-3.13 from https://python.org/downloads\n' +
      'Python 3.14+ is not yet compatible with PyTorch.'
    ));
  }

  console.log(`Using ${pythonInfo.version} (${pythonInfo.cmd} ${pythonInfo.args.join(' ')})`);

  // Check if Python version is 3.14+ and warn
  const vMatch = pythonInfo.version.match(/Python 3\.(\d+)/);
  if (vMatch && parseInt(vMatch[1]) >= 14) {
    console.warn('WARNING: Python 3.14+ may not be compatible with PyTorch');
  }

  // In packaged builds, __dirname is inside the asar archive. External processes
  // (like Python) can't read from asar, so resolve to the unpacked path.
  const appDir = IS_PACKAGED ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;
  const serverScript = path.join(appDir, 'python', 'server.py');
  const pythonCwd = path.join(appDir, 'python');
  pythonProcess = spawn(
    pythonInfo.cmd,
    [...pythonInfo.args, serverScript, '--port', PYTHON_PORT.toString(), '--token', SHUTDOWN_TOKEN],
    {
      cwd: pythonCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: [pythonCwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      }
    }
  );

  pythonProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    console.log(`[Python] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  });

  pythonProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    console.error(`[Python] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  });

  pythonProcess.on('error', (err) => {
    console.error('Failed to start Python process:', err.message);
  });

  pythonProcess.on('exit', (code) => {
    console.log(`Python process exited with code ${code}`);
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0 && code !== null) {
      mainWindow.webContents.send('python-crashed', code);
    }
  });

  return waitForServer();
}

function waitForServer(retries = 90) {
  return new Promise((resolve, reject) => {
    const check = (attempt) => {
      const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/health`, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (attempt >= retries) {
          reject(new Error(`Python server failed to start after ${retries} seconds`));
        } else {
          setTimeout(() => check(attempt + 1), 1000);
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (attempt >= retries) {
          reject(new Error('Python server timed out'));
        } else {
          setTimeout(() => check(attempt + 1), 1000);
        }
      });
    };
    check(0);
  });
}

function killPython(immediate = false) {
  if (pythonProcess) {
    const proc = pythonProcess;
    pythonProcess = null;

    // Try graceful shutdown first
    try {
      const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/shutdown?token=${SHUTDOWN_TOKEN}`, () => {});
      req.on('error', () => {});
      req.setTimeout(800, () => req.destroy());
    } catch {}

    const forceKill = () => {
      try {
        if (!proc.killed) {
          if (process.platform !== 'win32') {
            proc.kill('SIGTERM');
            setTimeout(() => {
              try {
                if (!proc.killed) proc.kill('SIGKILL');
              } catch {}
            }, 1000);
          } else {
            proc.kill();
          }
        }
      } catch {}
    };

    if (immediate) {
      forceKill();
    } else {
      setTimeout(forceKill, 1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Folder scanning
// ---------------------------------------------------------------------------

const SUPPORTED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.gif', '.svg', '.heic', '.heif',
  '.mp4', '.avi', '.mkv', '.mov', '.webm'
]);

function scanFolder(dir, maxFiles = 1000) {
  const results = [];

  function walk(d) {
    if (results.length >= maxFiles) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) return;
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTS.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to scan directory ${d}: ${err.message}`);
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Update checker
// ---------------------------------------------------------------------------

function checkForUpdates() {
  const pkg = require('./package.json');
  const currentVersion = pkg.version;

  // 1. Check for local/network update folder first if configured
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

  // 2. Fallback to GitHub releases
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

function sendUpdateEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function emitManualUpdateResult(result) {
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

function compareVersions(v1, v2) {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((p1[i] || 0) > (p2[i] || 0)) return 1;
    if ((p1[i] || 0) < (p2[i] || 0)) return -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return Promise.resolve();

  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#101820',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  let resolved = false;
  const resolveWhenVisible = (resolve) => {
    if (resolved) return;
    resolved = true;
    resolve();
  };

  const visiblePromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
      }
      resolveWhenVisible(resolve);
    }, 1200);

    splashWindow.once('ready-to-show', () => {
      clearTimeout(timeout);
      if (!splashWindow || splashWindow.isDestroyed()) {
        resolveWhenVisible(resolve);
        return;
      }
      splashWindow.show();
      updateSplash(splashState.percent, splashState.status, splashState.detail);
      setTimeout(() => resolveWhenVisible(resolve), 120);
    });

    splashWindow.webContents.once('did-finish-load', () => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        updateSplash(splashState.percent, splashState.status, splashState.detail);
      }
    });
  });

  splashWindow.on('closed', () => { splashWindow = null; });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html')).catch(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });

  return visiblePromise;
}

function updateSplash(percent, status, detail = '') {
  splashState = { percent, status, detail };
  if (!splashWindow || splashWindow.isDestroyed()) return;

  const payload = JSON.stringify({ percent, status, detail });
  splashWindow.webContents.executeJavaScript(`window.setSplashProgress(${payload})`, true).catch(() => {});
}

async function playSplashFinish() {
  if (!splashWindow || splashWindow.isDestroyed()) return;

  try {
    await splashWindow.webContents.executeJavaScript(
      'window.playSplashFinish ? window.playSplashFinish() : Promise.resolve()',
      true
    );
  } catch {
    await delay(900);
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 540,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0f0f1a',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setTitle('MuxMelt');
  mainWindow.once('ready-to-show', async () => {
    updateSplash(100, 'Ready');
    await playSplashFinish();
    closeSplash();
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Output Directory'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-files', async (event, options) => {
  const defaultFilters = [
    { name: 'Images & Videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'avif', 'gif', 'svg', 'heic', 'heif', 'mp4', 'avi', 'mkv', 'mov', 'webm'] }
  ];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: (options && options.title) || 'Select Files',
    filters: (options && options.filters) || defaultFilters
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Folder to Scan'
  });
  if (result.canceled) return [];
  const files = scanFolder(result.filePaths[0]);
  if (files.length >= 1000 && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('python-log', 'Warning: folder scan hit 1000 file limit. Some files may not be shown.');
  }
  return files;
});

ipcMain.handle('get-python-port', () => PYTHON_PORT);

ipcMain.handle('open-external', async (event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

function isSafePath(filePath, expectDirectory = false) {
  if (typeof filePath !== 'string') return false;
  try {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) return false;
    
    const stat = fs.statSync(resolvedPath);
    if (expectDirectory && !stat.isDirectory()) return false;
    
    if (!expectDirectory) {
      const dangerousExtensions = new Set([
        '.exe', '.bat', '.cmd', '.msi', '.lnk', '.vbs', '.js', '.vbe', '.jse',
        '.wsf', '.wsh', '.msc', '.com', '.scr', '.pif', '.reg', '.sh', '.bash', '.app'
      ]);
      const ext = path.extname(resolvedPath).toLowerCase();
      if (dangerousExtensions.has(ext)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('open-folder', async (event, folderPath) => {
  if (isSafePath(folderPath, true)) {
    shell.openPath(folderPath);
  } else {
    console.warn(`Blocked potentially unsafe open-folder request for: ${folderPath}`);
  }
});

ipcMain.handle('open-path', async (event, filePath) => {
  if (isSafePath(filePath, false)) {
    shell.openPath(filePath);
  } else {
    console.warn(`Blocked potentially unsafe open-path request for: ${filePath}`);
  }
});

ipcMain.handle('load-settings', () => loadSettings());

ipcMain.handle('save-settings', (event, settings) => {
  saveSettings(settings);
});

ipcMain.handle('resolve-dropped-paths', async (event, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        results.push(...scanFolder(p));
      } else if (stat.isFile()) {
        results.push(p);
      }
    } catch (err) {
      console.warn(`Failed to stat path ${p}: ${err.message}`);
    }
  }
  return results;
});

ipcMain.handle('read-image-preview', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const data = fs.readFileSync(filePath).toString('base64');
    return `data:image/${mime};base64,${data}`;
  } catch (err) {
    console.warn(`Failed to read image preview ${filePath}: ${err.message}`);
    return null;
  }
});

ipcMain.handle('get-file-size', async (event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
});

ipcMain.handle('path-exists', async (event, filePath) => {
  try {
    return !!filePath && fs.existsSync(filePath);
  } catch {
    return false;
  }
});

ipcMain.handle('check-overwrite', async (event, filePath) => {
  if (!fs.existsSync(filePath)) return { proceed: true };
  try {
    const settings = loadSettings();
    if (settings.global && settings.global.skipOverwriteConfirm) return { proceed: true };
  } catch {}
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Overwrite', 'Skip', 'Always Overwrite'],
    defaultId: 0,
    title: 'File Exists',
    message: `"${path.basename(filePath)}" already exists.`,
    detail: 'Do you want to overwrite it?'
  });
  if (result.response === 2) {
    const settings = loadSettings();
    settings.global = settings.global || {};
    settings.global.skipOverwriteConfirm = true;
    saveSettings(settings);
    return { proceed: true };
  }
  return { proceed: result.response === 0 };
});

ipcMain.handle('show-notification', async (event, options) => {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: options.title || 'MuxMelt',
      body: options.body || '',
      silent: false
    });
    notification.show();
  }
});

// Auto-updater IPC handlers
ipcMain.handle('check-for-updates', async () => {
  try {
    sendUpdateEvent('update-status', 'Checking for updates...');

    const manualResult = await checkForUpdates();
    if (manualResult.isLocal || !app.isPackaged || manualResult.error || !manualResult.updateAvailable) {
      emitManualUpdateResult(manualResult);
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
      emitManualUpdateResult(manualResult);
      return {
        ...manualResult,
        warning: err.message
      };
    }
  } catch (err) {
    console.error('Update check failed:', err);
    const result = { error: err.message, upToDate: true, updateAvailable: false };
    emitManualUpdateResult(result);
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

function initAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', 'Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-not-available', info);
  });

  autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-error', err.message);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) mainWindow.webContents.send('update-download-progress', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
    isUpdateReady = true;
    if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
  });
}

let pythonRestartInProgress = false;
ipcMain.handle('restart-python', async () => {
  if (pythonRestartInProgress) {
    return { success: false, error: 'Restart already in progress' };
  }
  pythonRestartInProgress = true;
  killPython();
  try {
    await startPythonServer();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    pythonRestartInProgress = false;
  }
});

ipcMain.handle('set-progress', (event, value) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(value);
  }
});

ipcMain.handle('get-app-version', () => {
  const pkg = require('./package.json');
  const baseVersion = pkg.version;
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: __dirname, encoding: 'utf-8', timeout: 3000
    }).trim();
    const count = execSync('git rev-list --count HEAD', {
      cwd: __dirname, encoding: 'utf-8', timeout: 3000
    }).trim();
    const dirty = execSync('git status --porcelain', {
      cwd: __dirname, encoding: 'utf-8', timeout: 3000
    }).trim();
    return `${baseVersion} (build ${count}, ${hash})${dirty ? ' *' : ''}`;
  } catch {}
  return baseVersion;
});

ipcMain.handle('download-and-update', async (event, installerPath) => {
  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error('Installer not found at ' + installerPath);
  }

  const tempDir = app.getPath('temp');
  const targetPath = path.join(tempDir, path.basename(installerPath));

  // Copy to temp
  fs.copyFileSync(installerPath, targetPath);

  // Run installer
  const isWin = process.platform === 'win32';
  if (isWin) {
    spawn(targetPath, [], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  } else {
    shell.openPath(targetPath);
  }

  // Quit app
  app.quit();
  return true;
});

// ---------------------------------------------------------------------------
// Node-tool IPC registration
// ---------------------------------------------------------------------------

const getMainWindow = () => mainWindow;

try { require('./node-tools/format-converter').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load format-converter:', e.message); }
try { require('./node-tools/audio-extractor').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load audio-extractor:', e.message); }
try { require('./node-tools/gif-maker').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load gif-maker:', e.message); }
try { require('./node-tools/video-compressor').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load video-compressor:', e.message); }
try { require('./node-tools/url-downloader').registerIPC(ipcMain, getMainWindow, () => pythonInfo || findPython()); } catch (e) { console.error('Failed to load url-downloader:', e.message); }
try { require('./node-tools/bulk-imager').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load bulk-imager:', e.message); }
try { require('./node-tools/qr-studio').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load qr-studio:', e.message); }

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Slim build auto-setup: install Python + deps on first run
async function runSlimSetup() {
  const setupWindow = new BrowserWindow({
    width: 540, height: 340,
    resizable: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0f0f1a',
  });
  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWindow.show();

  const send = (channel, data) => {
    if (!setupWindow.isDestroyed()) setupWindow.webContents.send(channel, data);
  };

  // Retry loop — user can click Retry in the setup window after a failure
  while (true) {
    try {
      if (IS_WIN) {
        await runSlimSetupWindows(send);
      } else {
        await runSlimSetupUnix(send);
      }
      send('setup-progress', { percent: 100, status: 'Setup complete!' });
      send('setup-complete');
      await new Promise(r => setTimeout(r, 1500));
      if (!setupWindow.isDestroyed()) setupWindow.close();
      return;
    } catch (err) {
      send('setup-error', `Setup failed: ${err.message}`);
      // Wait for user to click Retry or close the window
      try {
        await new Promise((resolve, reject) => {
          const retryHandler = () => {
            ipcMain.removeListener('setup-retry', retryHandler);
            setupWindow.removeListener('closed', closeHandler);
            resolve();
          };
          const closeHandler = () => {
            ipcMain.removeListener('setup-retry', retryHandler);
            reject(new Error('Setup cancelled'));
          };
          ipcMain.once('setup-retry', retryHandler);
          setupWindow.once('closed', closeHandler);
        });
        // Reset progress for next attempt
        send('setup-progress', { percent: 0, status: 'Retrying...' });
        await new Promise(r => setTimeout(r, 300));
      } catch {
        // Window was closed — propagate original error
        if (!setupWindow.isDestroyed()) setupWindow.close();
        throw err;
      }
    }
  }
}

// Windows slim setup: download embeddable Python + install deps
async function runSlimSetupWindows(send) {
  const PYTHON_VERSION = '3.13.0';
  const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  const zipPath = path.join(app.getPath('temp'), 'python-embed.zip');

  // Step 1: Download Python
  send('setup-progress', { percent: 5, status: 'Downloading Python...', detail: PYTHON_URL });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    const request = (url) => {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { request(res.headers.location); return; }
        const total = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) send('setup-progress', { percent: 5 + Math.round((downloaded / total) * 20), status: 'Downloading Python...', detail: `${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` });
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    request(PYTHON_URL);
  });

  // Step 2: Extract Python
  send('setup-progress', { percent: 28, status: 'Extracting Python...' });
  fs.mkdirSync(SLIM_PYTHON_DIR, { recursive: true });
  try {
    execSync(`powershell -Command "Expand-Archive -Force '${zipPath}' '${SLIM_PYTHON_DIR}'"`, { timeout: 60000 });
  } catch {
    try {
      execSync(`python -c "import zipfile; zipfile.ZipFile('${zipPath.replace(/\\/g, '/')}').extractall('${SLIM_PYTHON_DIR.replace(/\\/g, '/')}')"`, { timeout: 60000 });
    } catch {
      execSync(`python3 -c "import zipfile; zipfile.ZipFile('${zipPath.replace(/\\/g, '/')}').extractall('${SLIM_PYTHON_DIR.replace(/\\/g, '/')}')"`, { timeout: 60000 });
    }
  }
  fs.rmSync(zipPath, { force: true });

  // Enable pip
  const pthFiles = fs.readdirSync(SLIM_PYTHON_DIR).filter(f => f.endsWith('._pth'));
  for (const pth of pthFiles) {
    const p = path.join(SLIM_PYTHON_DIR, pth);
    let c = fs.readFileSync(p, 'utf-8');
    c = c.replace('#import site', 'import site');
    if (!c.includes('Lib/site-packages')) c += '\nLib/site-packages\n';
    const reqDir = IS_PACKAGED ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;
    const pythonModuleDir = path.join(reqDir, 'python');
    if (!c.includes(pythonModuleDir)) c += `\n${pythonModuleDir}\n`;
    fs.writeFileSync(p, c);
  }

  // Step 3: Install pip
  send('setup-progress', { percent: 35, status: 'Installing pip...' });
  const getPipPath = path.join(SLIM_PYTHON_DIR, 'get-pip.py');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(getPipPath);
    https.get('https://bootstrap.pypa.io/get-pip.py', (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
  execSync(`"${SLIM_PYTHON_EXE}" get-pip.py --no-warn-script-location`, { cwd: SLIM_PYTHON_DIR, timeout: 120000 });
  fs.rmSync(getPipPath, { force: true });

  // Step 4: Install PyTorch with CUDA
  send('setup-progress', { percent: 40, status: 'Installing PyTorch with CUDA (this takes a few minutes)...', detail: 'Downloading ~2.5 GB' });
  execSync(`"${SLIM_PYTHON_EXE}" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 --no-warn-script-location`, { timeout: 600000 });

  // Step 5: Install remaining deps
  send('setup-progress', { percent: 75, status: 'Installing processing tools...' });
  const reqDir = IS_PACKAGED ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;
  const reqPath = path.join(reqDir, 'python', 'requirements.txt');
  execSync(`"${SLIM_PYTHON_EXE}" -m pip install -r "${reqPath}" --no-warn-script-location`, { timeout: 600000 });
}

// macOS / Linux slim setup: create venv from system Python + install deps
async function runSlimSetupUnix(send) {
  // Step 1: Find system Python 3.10+
  send('setup-progress', { percent: 5, status: 'Checking Python...' });

  let systemPython = null;
  for (const cmd of ['python3', 'python']) {
    try {
      const result = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      const match = result.match(/Python (\d+)\.(\d+)/);
      if (match && parseInt(match[1]) === 3 && parseInt(match[2]) >= 10) {
        systemPython = cmd;
        break;
      }
    } catch {}
  }

  if (!systemPython) {
    const isMac = process.platform === 'darwin';
    throw new Error(
      'Python 3.10+ is required.\n\n' +
      (isMac
        ? 'Install from https://python.org/downloads or: brew install python@3.12'
        : 'Install from https://python.org/downloads or: sudo apt install python3')
    );
  }

  // Step 2: Create virtual environment
  send('setup-progress', { percent: 10, status: 'Creating Python environment...', detail: systemPython });
  fs.mkdirSync(SLIM_PYTHON_DIR, { recursive: true });
  execSync(`"${systemPython}" -m venv "${SLIM_PYTHON_DIR}"`, { timeout: 60000 });

  // Step 3: Install PyTorch
  const isMac = process.platform === 'darwin';
  if (isMac) {
    send('setup-progress', { percent: 25, status: 'Installing PyTorch (MPS for Apple Silicon)...', detail: 'Downloading ~500 MB' });
    execSync(`"${SLIM_PYTHON_EXE}" -m pip install torch torchvision torchaudio --no-warn-script-location`, { timeout: 600000 });
  } else {
    // Linux: detect GPU
    let hasNvidia = false;
    try { execSync('nvidia-smi', { stdio: 'ignore', timeout: 5000 }); hasNvidia = true; } catch {}

    if (hasNvidia) {
      send('setup-progress', { percent: 25, status: 'Installing PyTorch with CUDA...', detail: 'Downloading ~2.5 GB' });
      execSync(`"${SLIM_PYTHON_EXE}" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 --no-warn-script-location`, { timeout: 600000 });
    } else {
      send('setup-progress', { percent: 25, status: 'Installing PyTorch (CPU)...', detail: 'Downloading ~200 MB' });
      execSync(`"${SLIM_PYTHON_EXE}" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu --no-warn-script-location`, { timeout: 600000 });
    }
  }

  // Step 4: Install remaining deps
  send('setup-progress', { percent: 70, status: 'Installing processing tools...' });
  const reqDir = IS_PACKAGED ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;
  const reqPath = path.join(reqDir, 'python', 'requirements.txt');
  execSync(`"${SLIM_PYTHON_EXE}" -m pip install -r "${reqPath}" --no-warn-script-location`, { timeout: 600000 });
}

function needsSlimSetup() {
  return IS_SLIM && !fs.existsSync(SLIM_PYTHON_EXE);
}

app.whenReady().then(async () => {
  try {
    await createSplashWindow();
    updateSplash(8, 'Preparing MuxMelt');
    await delay(100);
    clearChromiumGpuCaches();

    // Slim build: auto-install Python on first run
    if (needsSlimSetup()) {
      updateSplash(15, 'Preparing first-time setup');
      await runSlimSetup();
    }

    updateSplash(35, 'Finding an available backend port');
    PYTHON_PORT = await findAvailablePort(PYTHON_PORT);
    updateSplash(55, 'Starting media backend', `Port ${PYTHON_PORT}`);
    await startPythonServer();
    updateSplash(82, 'Loading workspace');
    createWindow();
    if (app.isPackaged) {
      updateSplash(92, 'Checking for updates');
      initAutoUpdater();
    } else {
      console.log('Skipping auto-updater in development mode.');
    }
  } catch (err) {
    console.error('Startup failed:', err.message);
    closeSplash();
    killPython(true);
    dialog.showErrorBox(
      'Startup Error',
      'Failed to start the Python backend.\n\n' +
      'This may happen if the app bundle is damaged or was\n' +
      'moved while running. Try re-downloading and reinstalling.\n\n' +
      `Error: ${err.message}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  killPython(true);
  app.quit();
});

app.on('before-quit', () => {
  killPython(true);
});
