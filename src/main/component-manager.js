const path = require('path');
const fs = require('fs');

const MAX_STORAGE_ENTRIES = 250000;

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directorySize(rootPath) {
  let total = 0;
  let visited = 0;
  const pending = [rootPath];
  while (pending.length > 0 && visited < MAX_STORAGE_ENTRIES) {
    const current = pending.pop();
    let stat;
    try { stat = await fs.promises.lstat(current); } catch { continue; }
    visited += 1;
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      total += stat.size;
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try { entries = await fs.promises.readdir(current); } catch { continue; }
    for (const entry of entries) pending.push(path.join(current, entry));
  }
  return total;
}

function createComponentManager(options) {
  const {
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
    startBackend,
    restartBackend,
    stopBackend,
    getBackendStatus,
    isSlim,
    appDir,
    pythonAppDir,
    slimPythonDir,
    slimPythonExe,
    slimSetupMarker,
    llamaDir,
    isWin,
    isPackaged,
    backendLogPath,
    flushBackendLogs,
    cancelActiveJobs,
    jobRegistry,
  } = options;

  const userDataDir = path.resolve(app.getPath('userData'));
  const modelsDir = path.join(userDataDir, 'models');
  const cacheDir = path.join(userDataDir, 'cache');
  const logsDir = path.join(userDataDir, 'logs');
  const requirementsPath = path.join(pythonAppDir, 'python', 'requirements.txt');
  const installState = {
    media: { installing: false, detail: '' },
  };
  const installControllers = { media: null };
  const installPromises = { media: null };
  let componentCleanupFailure = null;

  function rememberCleanupFailure(result) {
    if (result?.code !== 'PROCESS_CLEANUP_FAILED') return;
    const error = new Error(
      result.error || 'A component installer process tree could not be stopped safely.'
    );
    error.code = 'PROCESS_CLEANUP_FAILED';
    componentCleanupFailure = error;
  }

  async function cancelComponentInstalls() {
    for (const controller of Object.values(installControllers)) controller?.abort();
    const results = await Promise.allSettled(Object.values(installPromises).filter(Boolean));
    for (const result of results) {
      if (result.status === 'rejected') {
        rememberCleanupFailure(result.reason);
        throw componentCleanupFailure || result.reason;
      }
      if (result.value?.success === false) rememberCleanupFailure(result.value);
    }
    // Keep cleanup uncertainty latched even after the install Promise leaves
    // the active map. Otherwise a later Offline/data transition could claim
    // success while the previously unconfirmed network process still exists.
    if (componentCleanupFailure) throw componentCleanupFailure;
  }
  if (jobRegistry?.register) {
    jobRegistry.register('component-installs', cancelComponentInstalls, { network: true });
  }

  const emitStatus = () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('component-status', getStatus());
    }
  };

  const mediaInstalled = () => {
    if (!isSlim) return true;
    if (typeof hasCurrentSetupMarker === 'function') {
      return hasCurrentSetupMarker(slimPythonExe, slimSetupMarker, requirementsPath);
    }
    return fs.existsSync(slimPythonExe) && fs.existsSync(slimSetupMarker);
  };

  const getStatus = () => {
    const backend = typeof getBackendStatus === 'function'
      ? getBackendStatus()
      : { state: 'unknown', detail: '' };
    const isMediaInstalled = mediaInstalled();
    return ({
    media: {
      installed: isMediaInstalled,
      repairable: !!isSlim && isMediaInstalled && backend.state === 'error',
      installing: installState.media.installing,
      detail: installState.media.detail,
      optional: true,
    },
    backend,
    offlineMode: networkPolicy.isOffline(),
  });
  };

  const setupOptions = (setupSignal = null) => ({
    appDir,
    pythonAppDir,
    SLIM_PYTHON_DIR: slimPythonDir,
    SLIM_PYTHON_EXE: slimPythonExe,
    SLIM_SETUP_MARKER: slimSetupMarker,
    IS_WIN: isWin,
    IS_PACKAGED: isPackaged,
    requirementsPath,
    setupSignal,
  });

  async function performMediaPackInstall(controller) {
    if (!isSlim) return { success: true, alreadyInstalled: true };
    if (installState.media.installing) {
      return { success: false, error: 'The media pack is already being installed.' };
    }
    try {
      jobRegistry?.assertCanStart?.('Media pack installation');
      networkPolicy.assertAllowed('Media pack installation');
      installState.media.installing = true;
      installState.media.detail = 'Preparing pinned components';
      emitStatus();
      const setupNeeded = await needsSlimSetup(
        true,
        slimPythonExe,
        slimSetupMarker,
        null,
        requirementsPath,
        { signal: controller.signal }
      );
      if (setupNeeded) {
        await runSlimSetup(setupOptions(controller.signal));
      }
      const started = await startBackend();
      if (started && started.success === false) {
        throw new Error(started.error || 'The local media backend could not start.');
      }
      installState.media.detail = 'Installed and import-checked';
      return { success: true };
    } catch (err) {
      installState.media.detail = err.message;
      const failure = { success: false, error: err.message, code: err.code || null };
      rememberCleanupFailure(failure);
      return failure;
    } finally {
      installState.media.installing = false;
      emitStatus();
    }
  }

  function installMediaPack() {
    if (installPromises.media) {
      return Promise.resolve({ success: false, error: 'The media pack is already being installed.' });
    }
    const controller = new AbortController();
    installControllers.media = controller;
    const operation = performMediaPackInstall(controller).finally(() => {
      if (installControllers.media === controller) installControllers.media = null;
      if (installPromises.media === operation) installPromises.media = null;
    });
    installPromises.media = operation;
    return operation;
  }

  function assertManagedTarget(target) {
    const resolved = path.resolve(target);
    if (!pathIsInside(userDataDir, resolved)) {
      throw new Error('Refusing to remove data outside the MuxMelt data directory');
    }
    return resolved;
  }

  async function runMaintenance(operation) {
    if (jobRegistry?.runMaintenance) return jobRegistry.runMaintenance(operation, 15000);
    if (typeof cancelActiveJobs === 'function') {
      const cancelled = await cancelActiveJobs();
      if (cancelled?.timedOut || cancelled?.failures?.length) {
        throw new Error('Active work could not be stopped; no app data was changed.');
      }
    }
    return operation();
  }

  async function runNetworkTransition(enabled, operation) {
    if (jobRegistry?.runNetworkTransition) {
      return jobRegistry.runNetworkTransition(operation, 15000, enabled);
    }
    if (enabled && typeof cancelActiveJobs === 'function') {
      const cancelled = await cancelActiveJobs();
      if (cancelled?.timedOut || cancelled?.failures?.length) {
        throw new Error('Active network work could not be stopped cleanly.');
      }
    }
    return operation();
  }

  async function removeManagedDirectory(target) {
    const resolved = assertManagedTarget(target);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  }

  async function requireBackendStopped() {
    if (typeof stopBackend !== 'function') return;
    const stopped = await stopBackend();
    if (stopped && stopped.success === false) {
      throw new Error(stopped.error || 'The local media backend could not be stopped safely.');
    }
    if (typeof flushBackendLogs === 'function') await flushBackendLogs();
  }

  async function removePack(id) {
    if (typeof id !== 'string') return { success: false, error: 'Invalid component id' };
    try {
      const backendWasRunning = typeof getBackendStatus === 'function'
        && ['ready', 'starting', 'restarting'].includes(getBackendStatus().state);
      let restartWarning = '';
      if (id === 'media') {
        if (!isSlim) throw new Error('The bundled media runtime cannot be removed separately.');
        await requireBackendStopped();
        await removeManagedDirectory(slimPythonDir);
        await removeManagedDirectory(`${slimPythonDir}.staging`);
        await removeManagedDirectory(`${slimPythonDir}.backup`);
      } else if (id === 'chat') {
        // Keep manual cleanup available for components installed by older builds.
        await requireBackendStopped();
        await removeManagedDirectory(llamaDir);
      } else if (id === 'models') {
        await requireBackendStopped();
        await removeManagedDirectory(modelsDir);
      } else if (id === 'cache') {
        await requireBackendStopped();
        await removeManagedDirectory(cacheDir);
      } else if (id === 'logs') {
        await requireBackendStopped();
        await removeManagedDirectory(logsDir);
      } else {
        throw new Error('Unknown or non-removable component');
      }
      if (id !== 'media' && backendWasRunning && mediaInstalled()) {
        const restarted = await startBackend();
        if (restarted && restarted.success === false) {
          restartWarning = restarted.error || 'The local media backend did not restart.';
        }
      }
      emitStatus();
      return { success: true, ...(restartWarning ? { warning: restartWarning } : {}) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function getStorageSummary() {
    const settingsPath = path.join(userDataDir, 'settings.json');
    const packs = [
      { id: 'media', label: 'Local media pack', target: slimPythonDir, removable: !!isSlim },
      ...(fs.existsSync(llamaDir)
        ? [{ id: 'chat', label: 'Legacy chat files (unused)', target: llamaDir, removable: true }]
        : []),
      { id: 'models', label: 'Downloaded AI models', target: modelsDir, removable: true },
      { id: 'cache', label: 'Download and model caches', target: cacheDir, removable: true },
      { id: 'logs', label: 'Local diagnostic logs', target: logsDir, removable: true },
    ];
    const results = await Promise.all(packs.map(async (pack) => ({
      id: pack.id,
      label: pack.label,
      bytes: await directorySize(pack.target),
      removable: pack.removable,
      installed: fs.existsSync(pack.target),
    })));
    let settingsBytes = 0;
    try { settingsBytes = (await fs.promises.stat(settingsPath)).size; } catch {}
    return {
      totalBytes: results.reduce((sum, pack) => sum + pack.bytes, settingsBytes),
      packs: results,
      cachesBytes: results.find((pack) => pack.id === 'cache')?.bytes || 0,
      settingsBytes,
    };
  }

  async function clearStaleTemporaryFiles(options = {}) {
    const tempRoot = path.resolve(app.getPath('temp'));
    const minimumAgeMs = Number.isFinite(options.minimumAgeMs)
      ? Math.max(0, options.minimumAgeMs)
      : 24 * 60 * 60 * 1000;
    // Local update installers have their own seven-day, age-aware cleanup in
    // updater.js. A freshly relaunched app must never delete the directory a
    // detached installer may still be executing from.
    const prefixes = ['muxmelt-clipboard', 'muxmelt-sniffer-'];
    let entries = [];
    try { entries = await fs.promises.readdir(tempRoot, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) return;
      const candidate = path.join(tempRoot, entry.name);
      if (!pathIsInside(tempRoot, candidate)) return;
      try {
        const stat = await fs.promises.lstat(candidate);
        if (stat.isSymbolicLink()) return;
        if (Date.now() - stat.mtimeMs < minimumAgeMs) return;
        await fs.promises.rm(candidate, { recursive: stat.isDirectory(), force: true });
      } catch {}
    }));
  }

  async function clearPrivateData(clearOptions = {}) {
    const selected = clearOptions && typeof clearOptions === 'object' ? clearOptions : {};
    const clearingRuntimeData = !!(
      selected.temporaryFiles || selected.caches || selected.models || selected.logs
    );
    const backendWasRunning = clearingRuntimeData
      && typeof getBackendStatus === 'function'
      && ['ready', 'starting', 'restarting'].includes(getBackendStatus().state);
    if (clearingRuntimeData) await requireBackendStopped();

    if (selected.recentFiles) {
      const settings = loadSettings();
      settings.global = settings.global && typeof settings.global === 'object'
        ? settings.global : {};
      settings.global.recentFiles = [];
      if (!saveSettings(settings)) throw new Error('Could not clear recent-file history');
    }
    if (selected.temporaryFiles) await clearStaleTemporaryFiles({ minimumAgeMs: 0 });
    if (selected.caches) await removeManagedDirectory(cacheDir);
    if (selected.models) await removeManagedDirectory(modelsDir);
    if (selected.logs) await removeManagedDirectory(logsDir);
    if (backendWasRunning && mediaInstalled() && typeof startBackend === 'function') {
      await startBackend().catch(() => {});
    }
    return { success: true, storage: await getStorageSummary() };
  }

  async function setOfflineMode(enabled) {
    if (typeof enabled !== 'boolean') return { success: false, error: 'Offline Mode must be true or false' };
    const originalOfflineMode = networkPolicy.isOffline();
    if (originalOfflineMode === enabled) {
      return { success: true, offlineMode: enabled, unchanged: true };
    }
    try {
      const result = await runNetworkTransition(enabled, async () => {
        const backendWasRunning = typeof getBackendStatus === 'function'
          && ['ready', 'starting', 'restarting'].includes(getBackendStatus().state);

        // The old backend must be conclusively gone before persisting a new
        // privacy state. In particular, never claim Offline Mode is enabled
        // while a process launched with MUXMELT_OFFLINE=0 remains alive.
        await requireBackendStopped();

        const settings = loadSettings();
        settings.global = settings.global && typeof settings.global === 'object'
          ? settings.global : {};
        settings.global.offlineMode = enabled;
        if (!saveSettings(settings)) {
          if (backendWasRunning && typeof startBackend === 'function') {
            await startBackend().catch(() => {});
          }
          throw new Error('Could not save Offline Mode');
        }

        let warning = '';
        if (backendWasRunning && mediaInstalled() && typeof startBackend === 'function') {
          const started = await startBackend();
          if (started && started.success === false) {
            warning = `Offline Mode was saved, but the local media backend did not restart: ${started.error || 'unknown error'}`;
          }
        }
        return { success: true, saved: true, offlineMode: enabled, ...(warning ? { warning } : {}) };
      });
      emitStatus();
      return result;
    } catch (err) {
      emitStatus();
      return {
        success: false,
        saved: false,
        offlineMode: networkPolicy.isOffline(),
        error: `Offline Mode was not changed: ${err.message}`,
        code: err.code || null,
      };
    }
  }

  async function exportDiagnostics(event) {
    if (typeof flushBackendLogs === 'function') await flushBackendLogs();
    const sourcePath = typeof backendLogPath === 'function' ? backendLogPath() : null;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { success: false, error: 'No local diagnostic log is available yet.' };
    }
    const owner = getMainWindow();
    const result = await dialog.showSaveDialog(owner, {
      title: 'Export Local Diagnostics',
      defaultPath: `MuxMelt-diagnostics-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    if (path.resolve(sourcePath) === path.resolve(result.filePath)) {
      return { success: false, error: 'Choose a location outside MuxMelt\'s active log folder.' };
    }
    // The native save dialog already handles overwrite confirmation.
    await fs.promises.copyFile(sourcePath, result.filePath);
    return { success: true, path: result.filePath };
  }

  ipcMain.handle('component-status', () => getStatus());
  ipcMain.handle('install-media-pack', () => installMediaPack());
  ipcMain.handle('remove-component-pack', async (_event, id) => {
    try { return await runMaintenance(() => removePack(id)); }
    catch (err) { return { success: false, error: err.message, code: err.code || null }; }
  });
  ipcMain.handle('get-storage-summary', () => getStorageSummary());
  ipcMain.handle('clear-private-data', async (_event, clearOptions) => {
    try { return await runMaintenance(() => clearPrivateData(clearOptions)); }
    catch (err) { return { success: false, error: err.message, code: err.code || null }; }
  });
  ipcMain.handle('set-offline-mode', (_event, enabled) => setOfflineMode(enabled));
  ipcMain.handle('open-data-folder', async () => {
    await fs.promises.mkdir(userDataDir, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(userDataDir);
    return error ? { success: false, error } : { success: true };
  });
  ipcMain.handle('export-diagnostics', (event) => exportDiagnostics(event));

  return { getStatus, emitStatus, clearStaleTemporaryFiles };
}

module.exports = { createComponentManager, directorySize, pathIsInside };
