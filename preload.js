const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  system: {
    selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
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
    // File.path was removed in Electron 32; this is the only way for the
    // renderer to get a filesystem path from a dropped/pasted File object.
    getPathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return ''; }
    },
    readImagePreview: (filePath) => ipcRenderer.invoke('read-image-preview', filePath),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    setProgress: (value) => ipcRenderer.invoke('set-progress', value),
    checkOverwrite: (filePath) => ipcRenderer.invoke('check-overwrite', filePath),
  },

  windowControls: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
    close: () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizeChange: (callback) => {
      const handler = (_, isMax) => callback(isMax);
      ipcRenderer.on('window-maximized', handler);
      return () => ipcRenderer.removeListener('window-maximized', handler);
    },
  },

  python: {
    getPythonPort: () => ipcRenderer.invoke('get-python-port'),
    getPythonToken: () => ipcRenderer.invoke('get-python-token'),
    restartPython: () => ipcRenderer.invoke('restart-python'),
    onPythonCrashed: (callback) => {
      const handler = (_, code) => callback(code);
      ipcRenderer.on('python-crashed', handler);
      return () => ipcRenderer.removeListener('python-crashed', handler);
    },
    onPythonLog: (callback) => {
      const handler = (_, msg) => callback(msg);
      ipcRenderer.on('python-log', handler);
      return () => ipcRenderer.removeListener('python-log', handler);
    },
  },

  updater: {
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    downloadAndUpdate: (installerPath) => ipcRenderer.invoke('download-and-update', installerPath),
    restartToUpdate: () => ipcRenderer.invoke('restart-to-update'),
    onUpdateStatus: (callback) => {
      const handler = (_, status) => callback(status);
      ipcRenderer.on('update-status', handler);
      return () => ipcRenderer.removeListener('update-status', handler);
    },
    onUpdateAvailable: (callback) => {
      const handler = (_, info) => callback(info);
      ipcRenderer.on('update-available', handler);
      return () => ipcRenderer.removeListener('update-available', handler);
    },
    onUpdateNotAvailable: (callback) => {
      const handler = (_, info) => callback(info);
      ipcRenderer.on('update-not-available', handler);
      return () => ipcRenderer.removeListener('update-not-available', handler);
    },
    onUpdateError: (callback) => {
      const handler = (_, err) => callback(err);
      ipcRenderer.on('update-error', handler);
      return () => ipcRenderer.removeListener('update-error', handler);
    },
    onUpdateDownloadProgress: (callback) => {
      const handler = (_, progress) => callback(progress);
      ipcRenderer.on('update-download-progress', handler);
      return () => ipcRenderer.removeListener('update-download-progress', handler);
    },
    onUpdateDownloaded: (callback) => {
      const handler = (_, info) => callback(info);
      ipcRenderer.on('update-downloaded', handler);
      return () => ipcRenderer.removeListener('update-downloaded', handler);
    }
  },

  tools: {
    onToolProgress: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('tool-progress', handler);
      return () => ipcRenderer.removeListener('tool-progress', handler);
    },
    
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
      getThumbnail: (options) => ipcRenderer.invoke('url-downloader-thumbnail', options),
      updateYtDlp: () => ipcRenderer.invoke('url-downloader-update-ytdlp'),
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
