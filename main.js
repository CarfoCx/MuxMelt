const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { initAutoUpdater, registerUpdaterIpcHandlers } = require('./src/main/updater');
const { registerIpcHandlers } = require('./src/main/ipc-handlers');
const { 
  createSplashWindow, 
  updateSplash, 
  playSplashFinish, 
  closeSplash, 
  createWindow, 
  getMainWindow, 
  delay 
} = require('./src/main/window-manager');
const { 
  findAvailablePort, 
  startPythonServer, 
  killPython, 
  getPythonPort, 
  getPythonInfo
} = require('./src/main/python-manager');
const { runSlimSetup, needsSlimSetup } = require('./src/main/setup-manager');

const SHUTDOWN_TOKEN = crypto.randomBytes(32).toString('hex');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const IS_PACKAGED = app.isPackaged;
const RESOURCES_PATH = IS_PACKAGED ? path.join(process.resourcesPath) : null;
const IS_WIN = process.platform === 'win32';
const APP_DIR = IS_PACKAGED ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;

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
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  }
}

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

const FFMPEG_PATH = BUNDLED_FFMPEG && fs.existsSync(BUNDLED_FFMPEG)
  ? BUNDLED_FFMPEG
  : (DEV_FFMPEG && fs.existsSync(DEV_FFMPEG) ? DEV_FFMPEG : null);
if (FFMPEG_PATH) {
  process.env.PATH = FFMPEG_PATH + path.delimiter + process.env.PATH;
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch { return {}; }
}

function saveSettings(settings) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch (err) { console.error('Failed to save settings:', err.message); }
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

function sendUpdateEvent(channel, payload) {
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) mw.webContents.send(channel, payload);
}

let pythonRestartInProgress = false;
async function restartPythonCallback() {
  if (pythonRestartInProgress) {
    return { success: false, error: 'Restart already in progress' };
  }
  pythonRestartInProgress = true;
  killPython(SHUTDOWN_TOKEN);
  try {
    await startPythonServer({ 
      BUNDLED_PYTHON, DEV_PYTHON, SLIM_PYTHON_EXE, isPackaged: IS_PACKAGED, appDir: APP_DIR 
    }, SHUTDOWN_TOKEN, getMainWindow);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    pythonRestartInProgress = false;
  }
}

registerIpcHandlers({
  getMainWindow,
  scanFolder,
  getPythonPort,
  loadSettings,
  saveSettings,
  restartPythonCallback
});

try { require('./node-tools/format-converter').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load format-converter:', e.message); }
try { require('./node-tools/audio-extractor').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load audio-extractor:', e.message); }
try { require('./node-tools/gif-maker').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load gif-maker:', e.message); }
try { require('./node-tools/video-compressor').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load video-compressor:', e.message); }
try { require('./node-tools/url-downloader').registerIPC(ipcMain, getMainWindow, () => getPythonInfo()); } catch (e) { console.error('Failed to load url-downloader:', e.message); }
try { require('./node-tools/bulk-imager').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load bulk-imager:', e.message); }
try { require('./node-tools/qr-studio').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load qr-studio:', e.message); }
try { require('./node-tools/torrent-downloader').registerIPC(ipcMain, getMainWindow); } catch (e) { console.error('Failed to load torrent-downloader:', e.message); }

app.whenReady().then(async () => {
  try {
    await createSplashWindow(__dirname);
    updateSplash(8, 'Preparing MuxMelt');
    await delay(100);
    clearChromiumGpuCaches();

    if (needsSlimSetup(IS_SLIM, SLIM_PYTHON_EXE)) {
      updateSplash(15, 'Preparing first-time setup');
      await runSlimSetup({
        appDir: APP_DIR, SLIM_PYTHON_DIR, SLIM_PYTHON_EXE, IS_WIN, IS_PACKAGED
      });
    }

    updateSplash(35, 'Finding an available backend port');
    const port = await findAvailablePort(getPythonPort());
    require('./src/main/python-manager').setPythonPort(port);
    
    updateSplash(55, 'Starting media backend', `Port ${port}`);
    await startPythonServer({ 
      BUNDLED_PYTHON, DEV_PYTHON, SLIM_PYTHON_EXE, isPackaged: IS_PACKAGED, appDir: APP_DIR 
    }, SHUTDOWN_TOKEN, getMainWindow);

    updateSplash(82, 'Loading workspace');
    createWindow(__dirname);

    if (app.isPackaged) {
      updateSplash(92, 'Checking for updates');
      initAutoUpdater(sendUpdateEvent);
      registerUpdaterIpcHandlers(sendUpdateEvent);
    } else {
      console.log('Skipping auto-updater in development mode.');
      // Register them anyway so dev tools don't throw errors when UI calls it
      registerUpdaterIpcHandlers(sendUpdateEvent);
    }
  } catch (err) {
    console.error('Startup failed:', err.message);
    closeSplash();
    killPython(SHUTDOWN_TOKEN, true);
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
  killPython(SHUTDOWN_TOKEN, true);
  app.quit();
});

app.on('before-quit', () => {
  killPython(SHUTDOWN_TOKEN, true);
});
