const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};

  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('api', {
  system: {
    selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
    getDownloadsDir: () => ipcRenderer.invoke('get-downloads-dir'),
    selectFiles: (options) => ipcRenderer.invoke('select-files', options),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
    openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    getFileSize: (filePath) => ipcRenderer.invoke('get-file-size', filePath),
    pathExists: (filePath) => ipcRenderer.invoke('path-exists', filePath),
    showNotification: (options) => ipcRenderer.invoke('show-notification', options),
    loadSettings: () => ipcRenderer.invoke('load-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    resolveDroppedPaths: (paths) => ipcRenderer.invoke('resolve-dropped-paths', paths),
    saveClipboardImage: (bytes, mimeType) => {
      const byteLength = bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0;
      if (byteLength <= 0 || byteLength > 32 * 1024 * 1024) {
        return Promise.reject(new Error('Clipboard image must be between 1 byte and 32 MB'));
      }
      return ipcRenderer.invoke('save-clipboard-image', { bytes, mimeType });
    },
    // File.path was removed in Electron 32; this is the only way for the
    // renderer to get a filesystem path from a dropped/pasted File object.
    getPathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return ''; }
    },
    readImagePreview: (filePath) => ipcRenderer.invoke('read-image-preview', filePath),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    setProgress: (value) => ipcRenderer.invoke('set-progress', value),
    checkOverwrite: (filePath) => ipcRenderer.invoke('check-overwrite', filePath),
    getStorageSummary: () => ipcRenderer.invoke('get-storage-summary'),
    clearPrivateData: (options) => ipcRenderer.invoke('clear-private-data', options),
    openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
    exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
    setOfflineMode: (enabled) => ipcRenderer.invoke('set-offline-mode', enabled),
  },

  windowControls: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
    close: () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizeChange: (callback) => subscribe('window-maximized', callback),
  },

  python: {
    getPythonPort: () => ipcRenderer.invoke('get-python-port'),
    getPythonToken: () => ipcRenderer.invoke('get-python-token'),
    getStatus: () => ipcRenderer.invoke('component-status'),
    installMediaPack: () => ipcRenderer.invoke('install-media-pack'),
    installChatPack: () => ipcRenderer.invoke('install-chat-pack'),
    removePack: (id) => ipcRenderer.invoke('remove-component-pack', id),
    restartPython: () => ipcRenderer.invoke('restart-python'),
    onStatus: (callback) => subscribe('component-status', callback),
    onBackendStatus: (callback) => subscribe('python-status', callback),
    onPythonCrashed: (callback) => subscribe('python-crashed', callback),
    onPythonLog: (callback) => subscribe('python-log', callback),
  },

  updater: {
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    downloadAndUpdate: (installerPath) => ipcRenderer.invoke('download-and-update', installerPath),
    getLocalUpdateFolder: () => ipcRenderer.invoke('get-local-update-folder'),
    selectLocalUpdateFolder: () => ipcRenderer.invoke('select-local-update-folder'),
    clearLocalUpdateFolder: () => ipcRenderer.invoke('clear-local-update-folder'),
    restartToUpdate: () => ipcRenderer.invoke('restart-to-update'),
    onUpdateStatus: (callback) => subscribe('update-status', callback),
    onUpdateAvailable: (callback) => subscribe('update-available', callback),
    onUpdateNotAvailable: (callback) => subscribe('update-not-available', callback),
    onUpdateError: (callback) => subscribe('update-error', callback),
    onUpdateDownloadProgress: (callback) => subscribe('update-download-progress', callback),
    onUpdateDownloaded: (callback) => subscribe('update-downloaded', callback)
  },

  tools: {
    onToolProgress: (callback) => subscribe('tool-progress', callback),
    
    formatConverter: {
      convertFormat: (options) => ipcRenderer.invoke('format-converter-convert', options),
      cancelFormatConversion: () => ipcRenderer.invoke('format-converter-cancel'),
      getFormats: () => ipcRenderer.invoke('format-converter-formats'),
    },

    audioExtractor: {
      extractAudio: (options) => ipcRenderer.invoke('audio-extractor-extract', options),
      cancelAudioExtraction: () => ipcRenderer.invoke('audio-extractor-cancel'),
      probeAudio: (filePath) => ipcRenderer.invoke('audio-extractor-probe', filePath),
    },

    gifMaker: {
      makeGif: (options) => ipcRenderer.invoke('gif-maker-create', options),
      cancelGifMaker: () => ipcRenderer.invoke('gif-maker-cancel'),
    },

    videoCompressor: {
      compressVideo: (options) => ipcRenderer.invoke('video-compressor-compress', options),
      cancelVideoCompression: () => ipcRenderer.invoke('video-compressor-cancel'),
      estimateCompression: (options) => ipcRenderer.invoke('video-compressor-estimate', options),
      probeVideo: (filePath) => ipcRenderer.invoke('video-compressor-probe', filePath),
    },

    urlDownloader: {
      downloadVideoUrl: (options) => ipcRenderer.invoke('url-downloader-download', options),
      cancelUrlDownload: () => ipcRenderer.invoke('url-downloader-cancel'),
      getVideoInfo: (options) => ipcRenderer.invoke('url-downloader-info', options),
      cancelVideoInfo: (requestId) => ipcRenderer.invoke('url-downloader-info-cancel', requestId),
    },

    torrentDownloader: {
      downloadTorrent: (options) => ipcRenderer.invoke('torrent-downloader-download', options),
      cancelTorrent: (id) => ipcRenderer.invoke('torrent-downloader-cancel', id),
      cancelAllTorrents: () => ipcRenderer.invoke('torrent-downloader-cancel-all'),
      pauseTorrent: (id) => ipcRenderer.invoke('torrent-downloader-pause', id),
      resumeTorrent: (id) => ipcRenderer.invoke('torrent-downloader-resume', id),
    },

    bulkImager: {
      bulkProcess: (options) => ipcRenderer.invoke('bulk-imager-process', options),
      bulkProcessChain: (options) => ipcRenderer.invoke('bulk-imager-process-chain', options),
      cancelBulkImager: () => ipcRenderer.invoke('bulk-imager-cancel'),
      getImageInfo: (filePath) => ipcRenderer.invoke('bulk-imager-info', filePath),
    },

    qrStudio: {
      generateQR: (options) => ipcRenderer.invoke('qr-studio-generate', options),
      previewQR: (options) => ipcRenderer.invoke('qr-studio-preview', options),
      scanQR: (filePath) => ipcRenderer.invoke('qr-studio-scan', { inputPath: filePath }),
      batchScanQR: (inputPaths) => ipcRenderer.invoke('qr-studio-batch-scan', { inputPaths }),
      cancelBatchScanQR: () => ipcRenderer.invoke('qr-studio-cancel-batch'),
    }
  }
});
