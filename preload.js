const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Shared
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getPythonPort: () => ipcRenderer.invoke('get-python-port'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getFileSize: (filePath) => ipcRenderer.invoke('get-file-size', filePath),
  pathExists: (filePath) => ipcRenderer.invoke('path-exists', filePath),
  showNotification: (options) => ipcRenderer.invoke('show-notification', options),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  resolveDroppedPaths: (paths) => ipcRenderer.invoke('resolve-dropped-paths', paths),
  readImagePreview: (filePath) => ipcRenderer.invoke('read-image-preview', filePath),
  restartPython: () => ipcRenderer.invoke('restart-python'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  restartToUpdate: () => ipcRenderer.invoke('restart-to-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setProgress: (value) => ipcRenderer.invoke('set-progress', value),
  checkOverwrite: (filePath) => ipcRenderer.invoke('check-overwrite', filePath),
  openPdfEditor: (options) => ipcRenderer.invoke('open-pdf-editor', options),
  getPdfEditorSession: (sessionId) => ipcRenderer.invoke('get-pdf-editor-session', sessionId),

  // Format converter
  convertFormat: (options) => ipcRenderer.invoke('format-converter-convert', options),
  cancelFormatConversion: () => ipcRenderer.invoke('format-converter-cancel'),
  getFormats: () => ipcRenderer.invoke('format-converter-formats'),

  // Audio extractor
  extractAudio: (options) => ipcRenderer.invoke('audio-extractor-extract', options),
  cancelAudioExtraction: () => ipcRenderer.invoke('audio-extractor-cancel'),
  probeAudio: (filePath) => ipcRenderer.invoke('audio-extractor-probe', filePath),

  // GIF maker
  makeGif: (options) => ipcRenderer.invoke('gif-maker-create', options),
  cancelGifMaker: () => ipcRenderer.invoke('gif-maker-cancel'),

  // Video compressor
  compressVideo: (options) => ipcRenderer.invoke('video-compressor-compress', options),
  cancelVideoCompression: () => ipcRenderer.invoke('video-compressor-cancel'),
  estimateCompression: (options) => ipcRenderer.invoke('video-compressor-estimate', options),
  probeVideo: (filePath) => ipcRenderer.invoke('video-compressor-probe', filePath),

  // URL downloader
  downloadVideoUrl: (options) => ipcRenderer.invoke('url-downloader-download', options),
  cancelUrlDownload: () => ipcRenderer.invoke('url-downloader-cancel'),

  // Bulk imager
  bulkProcess: (options) => ipcRenderer.invoke('bulk-imager-process', options),
  bulkProcessChain: (options) => ipcRenderer.invoke('bulk-imager-process-chain', options),
  cancelBulkImager: () => ipcRenderer.invoke('bulk-imager-cancel'),
  getImageInfo: (filePath) => ipcRenderer.invoke('bulk-imager-info', filePath),

  // PDF toolkit
  pdfOperation: (options) => {
    const op = options.operation;
    if (op === 'merge') return ipcRenderer.invoke('pdf-toolkit-merge', { inputPaths: options.files, outputDir: options.outputDir, outputName: options.outputName });
    if (op === 'split') return ipcRenderer.invoke('pdf-toolkit-split', { inputPath: options.files[0], outputDir: options.outputDir });
    if (op === 'extract') return ipcRenderer.invoke('pdf-toolkit-extract', { inputPath: options.files[0], outputDir: options.outputDir, pages: options.pageRange });
    if (op === 'edit') return ipcRenderer.invoke('pdf-toolkit-edit', { inputPath: options.files[0], outputDir: options.outputDir, rects: options.rects, covers: options.covers, edits: options.edits });
    if (op === 'render') return ipcRenderer.invoke('pdf-toolkit-render', { inputPath: options.files[0], dpi: options.dpi });
    if (op === 'text-map') return ipcRenderer.invoke('pdf-toolkit-text-map', { inputPath: options.files[0], ocr: options.ocr });
    if (op === 'rotate') return ipcRenderer.invoke('pdf-toolkit-rotate', { inputPath: options.inputPath, pageIndex: options.pageIndex, degrees: options.degrees });
    if (op === 'delete') return ipcRenderer.invoke('pdf-toolkit-delete', { inputPath: options.inputPath, pageIndex: options.pageIndex });
    if (op === 'reorder') return ipcRenderer.invoke('pdf-toolkit-reorder', { inputPath: options.inputPath, order: options.order });
    return Promise.resolve({ success: false, error: 'Unknown operation' });
  },
  pdfInfo: (filePath) => ipcRenderer.invoke('pdf-toolkit-info', filePath),
  readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),

  // QR studio
  generateQR: (options) => ipcRenderer.invoke('qr-studio-generate', options),
  previewQR: (options) => ipcRenderer.invoke('qr-studio-preview', options),
  scanQR: (filePath) => ipcRenderer.invoke('qr-studio-scan', { inputPath: filePath }),
  batchScanQR: (inputPaths) => ipcRenderer.invoke('qr-studio-batch-scan', { inputPaths }),
  cancelBatchScanQR: () => ipcRenderer.invoke('qr-studio-cancel-batch'),

  // Progress events from Node tools
  onToolProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-progress', handler);
    return () => ipcRenderer.removeListener('tool-progress', handler);
  },

  // Event listeners from main process
  onPythonCrashed: (callback) => ipcRenderer.on('python-crashed', (_, code) => callback(code)),
  onPythonLog: (callback) => ipcRenderer.on('python-log', (_, msg) => callback(msg)),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, status) => callback(status)),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, info) => callback(info)),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', (_, info) => callback(info)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_, err) => callback(err)),
  onUpdateDownloadProgress: (callback) => ipcRenderer.on('update-download-progress', (_, progress) => callback(progress)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_, info) => callback(info)),
});
