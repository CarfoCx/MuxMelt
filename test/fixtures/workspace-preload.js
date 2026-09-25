'use strict';

// UI-only fixture: no production preload, filesystem access, network, or tools.
const { contextBridge } = require('electron');
let settings = { global: { theme: 'mono-dark', lastTool: 'chat', logCollapsed: true } };
const calls = [];
const errors = [];
let filePickCount = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const subscribe = () => () => {};
const forbidden = name => async () => {
  calls.push(name);
  throw new Error(`UI smoke must not invoke ${name}`);
};
const status = () => ({
  media: { installed: false, installing: false, optional: true },
  backend: { state: 'setup-required', detail: 'Optional media pack is not installed' },
  offlineMode: false,
});

window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack || event.reason)));

contextBridge.exposeInMainWorld('api', {
  system: {
    loadSettings: async () => clone(settings),
    saveSettings: async next => { settings = clone(next); return true; },
    getAppVersion: async () => '1.3.0',
    getDownloadsDir: async () => 'C:\\UI-fixture\\Downloads',
    selectFiles: async () => { filePickCount += 1; return ['C:\\UI-fixture\\sample.mp4']; },
    selectFolder: async () => [],
    selectOutputDir: async () => '',
    getFileSize: async () => 1024 * 1024,
    pathExists: async () => false,
    readImagePreview: async () => '',
    resolveDroppedPaths: async paths => paths,
    getPathForFile: () => '',
    getStorageSummary: async () => ({ totalBytes: 0, cachesBytes: 0, packs: [] }),
    setProgress: async () => {},
    showNotification: forbidden('showNotification'),
    openFolder: forbidden('openFolder'),
    openPath: forbidden('openPath'),
    openExternal: forbidden('openExternal'),
    openDataFolder: forbidden('openDataFolder'),
    clearPrivateData: forbidden('clearPrivateData'),
    exportDiagnostics: forbidden('exportDiagnostics'),
    setOfflineMode: forbidden('setOfflineMode'),
  },
  windowControls: {
    minimize: forbidden('minimize'), maximizeToggle: forbidden('maximizeToggle'),
    close: forbidden('close'), isMaximized: async () => false, onMaximizeChange: subscribe,
  },
  python: {
    getPythonPort: async () => null, getPythonToken: async () => '', getStatus: async () => status(),
    onStatus: subscribe, onBackendStatus: subscribe, onPythonCrashed: subscribe, onPythonLog: subscribe,
    installMediaPack: forbidden('installMediaPack'), removePack: forbidden('removePack'),
    restartPython: forbidden('restartPython'),
  },
  updater: {
    getLocalUpdateFolder: async () => '',
    onUpdateAvailable: subscribe, onUpdateDownloaded: subscribe,
    onUpdateDownloadProgress: subscribe, onUpdateError: subscribe,
    checkForUpdates: forbidden('checkForUpdates'), downloadUpdate: forbidden('downloadUpdate'),
    selectLocalUpdateFolder: forbidden('selectLocalUpdateFolder'),
    clearLocalUpdateFolder: forbidden('clearLocalUpdateFolder'),
  },
  tools: {
    onToolProgress: subscribe,
    formatConverter: {}, audioExtractor: {}, gifMaker: {}, videoCompressor: {},
    urlDownloader: {}, torrentDownloader: {}, bulkImager: {}, qrStudio: {},
  },
});
contextBridge.exposeInMainWorld('uiFixture', {
  readCalls: () => [...calls], readErrors: () => [...errors], readSettings: () => clone(settings),
  readFilePickCount: () => filePickCount,
});
