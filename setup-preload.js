const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  onProgress: (callback) => ipcRenderer.on('setup-progress', (_, data) => callback(data)),
  onComplete: (callback) => ipcRenderer.on('setup-complete', () => callback()),
  onError: (callback) => ipcRenderer.on('setup-error', (_, msg) => callback(msg)),
});
