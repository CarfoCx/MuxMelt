const { app, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { registerUpdaterIpcHandlers } = require('./src/main/updater');
const { registerIpcHandlers } = require('./src/main/ipc-handlers');
const {
  createSplashWindow,
  updateSplash,
  closeSplash,
  createWindow,
  getMainWindow,
  delay
} = require('./src/main/window-manager');
const {
  isPortAvailable,
  findAvailablePort,
  startPythonServer,
  waitForServer,
  killPython,
  getPythonPort,
  getPythonInfo,
  findPython,
  isPythonRunning,
  getBackendLogPath,
  flushBackendLogs,
} = require('./src/main/python-manager');
const {
  runSlimSetup,
  needsSlimSetup,
  hasCurrentSetupMarker,
} = require('./src/main/setup-manager');
const { scanFolder } = require('./src/main/folder-scan');
const { createNetworkPolicy } = require('./src/main/network-policy');
const { createComponentManager } = require('./src/main/component-manager');
const { createJobRegistry } = require('./src/main/job-registry');

const SHUTDOWN_TOKEN = crypto.randomBytes(32).toString('hex');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const IS_PACKAGED = app.isPackaged;
const RESOURCES_PATH = IS_PACKAGED ? path.join(process.resourcesPath) : null;
const IS_WIN = process.platform === 'win32';
// Electron can load renderer/preload files from app.asar, but an external
// Python interpreter needs the unpacked Python tree.
const APP_DIR = __dirname;
const PYTHON_APP_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'app.asar.unpacked')
  : __dirname;

if (IS_WIN) {
  let disableHardwareAcceleration = false;
  try {
    const settings = loadSettings();
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
const SLIM_SETUP_MARKER = path.join(SLIM_PYTHON_DIR, '.setup-complete');
const LLAMA_DIR = path.join(app.getPath('userData'), 'llama');
const REQUIREMENTS_PATH = path.join(PYTHON_APP_DIR, 'python', 'requirements.txt');

const FFMPEG_PATH = BUNDLED_FFMPEG && fs.existsSync(BUNDLED_FFMPEG)
  ? BUNDLED_FFMPEG
  : (DEV_FFMPEG && fs.existsSync(DEV_FFMPEG) ? DEV_FFMPEG : null);
if (FFMPEG_PATH) {
  process.env.PATH = [FFMPEG_PATH, process.env.PATH].filter(Boolean).join(path.delimiter);
}

function loadSettings({ strict = false } = {}) {
  const failClosedSettings = () => ({ global: { offlineMode: true } });
  try {
    if (fs.statSync(SETTINGS_PATH).size > 5 * 1024 * 1024) {
      if (strict) throw new Error('Settings file exceeds the 5 MB safety limit');
      return failClosedSettings();
    }
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings;
    if (strict) throw new Error('Settings file must contain a JSON object');
    return failClosedSettings();
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    if (strict) throw err;
    return failClosedSettings();
  }
}

function saveSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    console.warn('Refusing to save invalid settings payload.');
    return false;
  }

  // Write-then-rename so a crash mid-write can't truncate settings.json —
  // it is read before app.whenReady() to decide GPU configuration.
  const tmpPath = SETTINGS_PATH + '.tmp';
  try {
    const serialized = JSON.stringify(settings, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > 5 * 1024 * 1024) {
      throw new Error('Settings payload exceeds the 5 MB limit');
    }
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, SETTINGS_PATH);
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err.message);
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    return false;
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

function sendUpdateEvent(channel, payload) {
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) mw.webContents.send(channel, payload);
}

const networkPolicy = createNetworkPolicy(() => loadSettings({ strict: true }));
const jobRegistry = createJobRegistry();
let componentManager = null;
let backendStatus = {
  state: 'stopped',
  detail: 'The optional media backend is not running.',
  port: getPythonPort(),
};

function setBackendStatus(state, detail = '') {
  backendStatus = { state, detail, port: getPythonPort() };
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('python-status', backendStatus);
  }
  if (componentManager) componentManager.emitStatus();
}

function getBackendStatus() {
  return { ...backendStatus };
}

function pythonStartOptions(startupSignal = null) {
  return {
    BUNDLED_PYTHON,
    DEV_PYTHON,
    SLIM_PYTHON_EXE,
    isPackaged: IS_PACKAGED,
    appDir: PYTHON_APP_DIR,
    userDataDir: app.getPath('userData'),
    offline: networkPolicy.isOffline(),
    startupSignal,
    onExit: ({ code, signal }) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      setBackendStatus('error', `The local media backend stopped unexpectedly (${reason}).`);
    },
  };
}

let backendLifecycleQueue = Promise.resolve();
let applicationQuitting = false;
let backendStartController = null;

function cancelBackendStart() {
  if (backendStartController && !backendStartController.signal.aborted) {
    backendStartController.abort();
  }
}

function enqueueBackendLifecycle(operation) {
  const pending = backendLifecycleQueue.catch(() => {}).then(operation);
  backendLifecycleQueue = pending.catch(() => {});
  return pending;
}

async function startBackendInternal(allowDuringMaintenance = false) {
  if (applicationQuitting) {
    return { success: false, error: 'MuxMelt is shutting down.' };
  }
  if (!allowDuringMaintenance) {
    try { jobRegistry.assertCanStart('Local media backend'); }
    catch (err) { return { success: false, error: err.message, code: err.code || null }; }
  }
  if (isPythonRunning()) {
    try {
      await waitForServer(SHUTDOWN_TOKEN, 1);
      setBackendStatus('ready', getPythonInfo()?.version || 'Media backend is running.');
      return { success: true, alreadyRunning: true, port: getPythonPort() };
    } catch {
      const stopped = await killPython(SHUTDOWN_TOKEN, true);
      if (!stopped.exited) {
        const error = 'The unhealthy local media backend could not be stopped safely.';
        setBackendStatus('error', error);
        return { success: false, error };
      }
    }
  }
  setBackendStatus('starting', 'Starting the optional local media backend...');
  const startupController = new AbortController();
  backendStartController = startupController;
  try {
    const port = await findAvailablePort(getPythonPort());
    if (applicationQuitting || startupController.signal.aborted) {
      throw Object.assign(new Error('Python startup was cancelled'), { code: 'BACKEND_START_CANCELLED' });
    }
    require('./src/main/python-manager').setPythonPort(port);
    setBackendStatus('starting', `Starting the optional local media backend on port ${port}...`);
    await flushBackendLogs();
    await startPythonServer(pythonStartOptions(startupController.signal), SHUTDOWN_TOKEN, getMainWindow);
    setBackendStatus('ready', getPythonInfo()?.version || `Ready on port ${port}`);
    return { success: true, port };
  } catch (err) {
    setBackendStatus('error', err.message);
    return { success: false, error: err.message };
  } finally {
    if (backendStartController === startupController) backendStartController = null;
  }
}

function startBackendCallback() {
  return enqueueBackendLifecycle(() => startBackendInternal(false));
}

function startBackendForMaintenance() {
  return enqueueBackendLifecycle(() => startBackendInternal(true));
}

async function stopBackendInternal() {
  const stopped = await killPython(SHUTDOWN_TOKEN, true);
  if (!stopped.exited) {
    const error = 'The local media backend did not stop in time.';
    setBackendStatus('error', error);
    return { success: false, error };
  }
  setBackendStatus('stopped', 'The optional media backend is stopped.');
  return { success: true };
}

function stopBackendCallback() {
  cancelBackendStart();
  return enqueueBackendLifecycle(stopBackendInternal);
}

async function restartBackendInternal(allowDuringMaintenance = false) {
  if (applicationQuitting) return { success: false, error: 'MuxMelt is shutting down.' };
  if (!allowDuringMaintenance) {
    try { jobRegistry.assertCanStart('Backend restart'); }
    catch (err) { return { success: false, error: err.message, code: err.code || null }; }
  }
  setBackendStatus('restarting', 'Restarting the local media backend...');
  // Force-kill right away — a restart usually means the backend is wedged.
  const stopped = await killPython(SHUTDOWN_TOKEN, true);
  try {
    if (!stopped.exited) throw new Error('The previous backend process did not stop in time');
    // Wait for the old process to actually release the port before respawning
    // (taskkill is async). Keep the same port: the renderer caches it.
    for (let i = 0; i < 20 && !(await isPortAvailable(getPythonPort())); i++) {
      await new Promise(r => setTimeout(r, 250));
    }
    if (!(await isPortAvailable(getPythonPort()))) {
      throw new Error(`Backend port ${getPythonPort()} is still in use after stopping the old process`);
    }
    const result = await startBackendInternal(allowDuringMaintenance);
    return result;
  } catch (err) {
    setBackendStatus('error', err.message);
    return { success: false, error: err.message };
  }
}

function restartPythonCallback() {
  cancelBackendStart();
  return enqueueBackendLifecycle(() => restartBackendInternal(false));
}

function restartBackendForMaintenance() {
  cancelBackendStart();
  return enqueueBackendLifecycle(() => restartBackendInternal(true));
}

// Only allow a single running instance. A second launch would spawn a second
// backend and could race the first on the per-user slim-Python setup directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    if (mw.isMinimized()) mw.restore();
    mw.focus();
  }
});

registerIpcHandlers({
  getMainWindow,
  scanFolder,
  getPythonPort,
  getPythonToken: () => SHUTDOWN_TOKEN,
  loadSettings,
  saveSettings,
  restartPythonCallback,
  networkPolicy,
});

// Tools that only need (ipcMain, getMainWindow). Loaded in a loop so a single
// broken module logs and is skipped without taking the others down.
for (const name of [
  'format-converter',
  'audio-extractor',
  'gif-maker',
  'video-compressor',
  'bulk-imager',
  'qr-studio',
  'torrent-downloader'
]) {
  try {
    const toolModule = require(`./node-tools/${name}`);
    if (name === 'torrent-downloader') {
      toolModule.registerIPC(ipcMain, getMainWindow, networkPolicy, jobRegistry);
    } else {
      toolModule.registerIPC(ipcMain, getMainWindow, jobRegistry);
    }
  } catch (e) {
    console.error(`Failed to load ${name}:`, e.message);
  }
}
// url-downloader additionally needs the resolved Python interpreter.
try {
  require('./node-tools/url-downloader').registerIPC(
    ipcMain,
    getMainWindow,
    () => getPythonInfo() || findPython(pythonStartOptions()),
    networkPolicy,
    jobRegistry
  );
} catch (e) {
  console.error('Failed to load url-downloader:', e.message);
}

componentManager = createComponentManager({
  ipcMain,
  app,
  shell,
  dialog,
  getMainWindow,
  loadSettings,
  saveSettings,
  networkPolicy,
  runSlimSetup,
  hasCurrentSetupMarker,
  needsSlimSetup,
  startBackend: startBackendForMaintenance,
  restartBackend: restartBackendForMaintenance,
  stopBackend: stopBackendCallback,
  getBackendStatus,
  isSlim: IS_SLIM,
  appDir: APP_DIR,
  pythonAppDir: PYTHON_APP_DIR,
  slimPythonDir: SLIM_PYTHON_DIR,
  slimPythonExe: SLIM_PYTHON_EXE,
  slimSetupMarker: SLIM_SETUP_MARKER,
  llamaDir: LLAMA_DIR,
  isWin: IS_WIN,
  isPackaged: IS_PACKAGED,
  backendLogPath: getBackendLogPath,
  flushBackendLogs,
  cancelActiveJobs: () => jobRegistry.cancelAll(5000),
  jobRegistry,
});

app.whenReady().then(async () => {
  try {
    await createSplashWindow(__dirname);
    updateSplash(8, 'Preparing MuxMelt');
    await delay(100);
    // Only clear the Chromium GPU/shader caches when the user has opted in (or
    // disabled hardware acceleration because of GPU trouble). Doing it on every
    // launch threw away the shader cache and slowed cold starts.
    const startupSettings = loadSettings();
    const startupGlobal = startupSettings.global || {};
    if (startupGlobal.disableHardwareAcceleration || startupGlobal.clearGpuCacheOnStart) {
      clearChromiumGpuCaches();
    }

    // Register update IPC before loading renderer code. GitHub checks are
    // opt-in and every external action is guarded by Offline Mode.
    registerUpdaterIpcHandlers(sendUpdateEvent, networkPolicy, jobRegistry);

    // The Core workspace opens before Python. Node/FFmpeg tools
    // remain useful even if the optional media pack is absent or broken.
    updateSplash(45, 'Loading private media workspace');
    await createWindow(APP_DIR, networkPolicy);
    componentManager.emitStatus();
    componentManager.clearStaleTemporaryFiles().catch((err) => {
      console.warn('Failed to clean stale MuxMelt temporary files:', err.message);
    });

    const canStartSlimBackend = !IS_SLIM || hasCurrentSetupMarker(
      SLIM_PYTHON_EXE,
      SLIM_SETUP_MARKER,
      REQUIREMENTS_PATH
    );
    if (!canStartSlimBackend) {
      setBackendStatus(
        'setup-required',
        'Install the optional local media pack to use AI media tools.'
      );
    } else {
      // Start in the background after the shell is responsive. A failure is
      // surfaced as a repairable capability error rather than quitting Core.
      startBackendCallback().then((result) => {
        if (!result.success) console.warn(`Optional media backend unavailable: ${result.error}`);
      });
    }

    // Warm the ffmpeg lookup off the UI thread so the first convert/probe
    // doesn't block on a synchronous PATH probe when the user clicks.
    require('./node-tools/ffmpeg-runner').findFfmpegAsync().catch(() => {});

  } catch (err) {
    if (err && err.code === 'SETUP_CANCELLED') {
      closeSplash();
      await killPython(SHUTDOWN_TOKEN, true);
      app.quit();
      return;
    }
    console.error('Startup failed:', err.message);
    closeSplash();
    await killPython(SHUTDOWN_TOKEN, true);
    dialog.showErrorBox(
      'Startup Error',
      'MuxMelt could not finish starting.\n\n' +
      'This may happen if the app bundle is damaged or was\n' +
      'moved while running. Try re-downloading and reinstalling.\n\n' +
      `Error: ${err.message}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!getMainWindow()) {
    createWindow(APP_DIR, networkPolicy).then(() => componentManager.emitStatus()).catch((err) => {
      console.error('Failed to recreate the main window:', err.message);
    });
  }
});

let shutdownInProgress = false;
let shutdownComplete = false;
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  applicationQuitting = true;
  cancelBackendStart();
  jobRegistry.shutdownAll(10000).then(() => stopBackendCallback()).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
