'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComponentManager } = require('../src/main/component-manager');

function harness(overrides = {}) {
  const handlers = new Map();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-offline-test-'));
  let settings = { global: { offlineMode: false } };
  const events = [];
  const options = {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: (name) => name === 'temp' ? os.tmpdir() : tempRoot },
    shell: { openPath: async () => '' },
    dialog: {},
    getMainWindow: () => null,
    loadSettings: () => JSON.parse(JSON.stringify(settings)),
    saveSettings: (next) => { events.push('save'); settings = next; return true; },
    networkPolicy: { isOffline: () => settings.global.offlineMode === true, assertAllowed: () => true },
    runSlimSetup: async () => {},
    ensureLlamaServer: async () => {},
    hasCompleteLlamaSetup: () => false,
    hasCurrentSetupMarker: () => true,
    needsSlimSetup: () => false,
    startBackend: async () => { events.push('start'); return { success: true }; },
    restartBackend: async () => ({ success: true }),
    stopBackend: async () => { events.push('stop'); return { success: true }; },
    getBackendStatus: () => ({ state: 'ready', detail: '' }),
    isSlim: false,
    appDir: tempRoot,
    pythonAppDir: tempRoot,
    slimPythonDir: path.join(tempRoot, 'python-env'),
    slimPythonExe: path.join(tempRoot, 'python-env', 'python.exe'),
    slimSetupMarker: path.join(tempRoot, 'python-env', '.setup-complete'),
    llamaDir: path.join(tempRoot, 'llama'),
    isWin: process.platform === 'win32',
    isPackaged: true,
    backendLogPath: () => null,
    flushBackendLogs: async () => {},
    cancelActiveJobs: async () => ({ timedOut: false, failures: [] }),
    jobRegistry: {
      register: () => {},
      runNetworkTransition: async (operation) => operation(),
    },
    ...overrides,
  };
  createComponentManager(options);
  return {
    invoke: (enabled) => handlers.get('set-offline-mode')({}, enabled),
    invokeChannel: (name, ...args) => handlers.get(name)({}, ...args),
    events,
    getSettings: () => settings,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

(async () => {
  const blocked = Object.assign(new Error('maintenance already active'), { code: 'APP_MAINTENANCE' });
  const duringMaintenance = harness({
    jobRegistry: {
      register: () => {},
      runNetworkTransition: async () => { throw blocked; },
    },
  });
  try {
    const result = await duringMaintenance.invoke(true);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.offlineMode, false);
    assert.deepStrictEqual(duringMaintenance.events, []);
    assert.strictEqual(duringMaintenance.getSettings().global.offlineMode, false);
  } finally { duringMaintenance.cleanup(); }

  const failedStop = harness({
    stopBackend: async () => ({ success: false, error: 'tree still alive' }),
  });
  try {
    const result = await failedStop.invoke(true);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.offlineMode, false);
    assert.deepStrictEqual(failedStop.events, []);
    assert.strictEqual(failedStop.getSettings().global.offlineMode, false);
  } finally { failedStop.cleanup(); }

  let cancelComponentInstall = null;
  let validationSignal = null;
  let markValidationStarted;
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  const uncleanInstall = harness({
    isSlim: true,
    jobRegistry: {
      register: (name, cancel) => {
        if (name === 'component-installs') cancelComponentInstall = cancel;
      },
      assertCanStart: () => {},
      runNetworkTransition: async (operation) => {
        await cancelComponentInstall();
        return operation();
      },
    },
    needsSlimSetup: (...args) => new Promise((_resolve, reject) => {
      validationSignal = args[5]?.signal || null;
      markValidationStarted();
      validationSignal?.addEventListener('abort', () => {
        const error = new Error('installer tree survived cancellation');
        error.code = 'PROCESS_CLEANUP_FAILED';
        reject(error);
      }, { once: true });
    }),
  });
  try {
    const install = uncleanInstall.invokeChannel('install-media-pack');
    await validationStarted;
    await assert.rejects(
      cancelComponentInstall(),
      (error) => error?.code === 'PROCESS_CLEANUP_FAILED',
    );
    const installResult = await install;
    assert.strictEqual(validationSignal.aborted, true);
    assert.strictEqual(installResult.code, 'PROCESS_CLEANUP_FAILED');
    const transition = await uncleanInstall.invoke(true);
    assert.strictEqual(transition.success, false);
    assert.strictEqual(transition.code, 'PROCESS_CLEANUP_FAILED');
    assert.strictEqual(transition.offlineMode, false);
    assert.strictEqual(uncleanInstall.getSettings().global.offlineMode, false);
    assert.deepStrictEqual(uncleanInstall.events, []);
  } finally { uncleanInstall.cleanup(); }

  const success = harness();
  try {
    const result = await success.invoke(true);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.offlineMode, true);
    assert.deepStrictEqual(success.events, ['stop', 'save', 'start']);
    assert.strictEqual(success.getSettings().global.offlineMode, true);
  } finally { success.cleanup(); }

  console.log('Component Offline Mode transition smoke passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
