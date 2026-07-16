const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};

  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('setup', {
  onProgress: (callback) => subscribe('setup-progress', callback),
  onComplete: (callback) => subscribe('setup-complete', callback),
  onError: (callback) => subscribe('setup-error', callback),
  requestRetry: () => ipcRenderer.send('setup-retry'),
  requestCancel: () => ipcRenderer.send('setup-cancel'),
});
