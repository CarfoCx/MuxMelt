'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebTorrent = require('webtorrent');
const { validateOutputDir } = require('./path-utils');

let client = null;

function getClient() {
  if (!client) {
    client = new WebTorrent();
  }
  return client;
}

function registerIPC(ipcMain, getMainWindow) {
  const activeTorrents = new Map();
  const progressTimers = new Map();

  function sendProgress(id, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('tool-progress', { tool: 'torrent-downloader', id, ...payload });
    }
  }

  function startProgressThrottle(id, torrent) {
    if (progressTimers.has(id)) return;
    const interval = setInterval(() => {
      if (!activeTorrents.has(id)) {
        clearInterval(interval);
        progressTimers.delete(id);
        return;
      }
      sendProgress(id, {
        status: 'downloading',
        progress: torrent.progress,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        downloaded: torrent.downloaded,
        uploaded: torrent.uploaded,
        length: torrent.length,
        numPeers: torrent.numPeers,
        timeRemaining: torrent.timeRemaining
      });
    }, 500);
    progressTimers.set(id, interval);
  }

  function cleanupTorrent(id) {
    activeTorrents.delete(id);
    const timer = progressTimers.get(id);
    if (timer) {
      clearInterval(timer);
      progressTimers.delete(id);
    }
  }

  ipcMain.handle('torrent-downloader-download', async (event, options) => {
    const { source, outputDir } = options;

    try {
      const outDir = validateOutputDir(outputDir);
      if (!outDir) throw new Error('Invalid output directory');
      
      fs.mkdirSync(outDir, { recursive: true });

      const torrentId = crypto.randomUUID();
      sendProgress(torrentId, { status: 'metadata', progress: 0 });

      const c = getClient();
      
      const torrent = c.add(source, { path: outDir }, (t) => {
        const files = t.files.map(f => ({ name: f.name, length: f.length, path: f.path }));
        sendProgress(torrentId, { 
          status: 'metadata_fetched', 
          name: t.name,
          infoHash: t.infoHash,
          length: t.length,
          files: files
        });

        startProgressThrottle(torrentId, t);

        t.on('done', () => {
          cleanupTorrent(torrentId);
          sendProgress(torrentId, {
            status: 'done',
            name: t.name,
            length: t.length,
            downloaded: t.downloaded,
            uploaded: t.uploaded
          });
          t.destroy();
        });
      });

      torrent.on('error', (err) => {
        cleanupTorrent(torrentId);
        sendProgress(torrentId, { status: 'error', message: err.message });
        torrent.destroy();
      });

      activeTorrents.set(torrentId, torrent);
      
      return { success: true, id: torrentId, name: torrent.name };

    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('torrent-downloader-cancel', async (event, id) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
      torrent.destroy();
      cleanupTorrent(id);
      sendProgress(id, { status: 'cancelled' });
      return { success: true };
    }
    return { success: false, error: 'Torrent not found' };
  });

  ipcMain.handle('torrent-downloader-cancel-all', async () => {
    const ids = [...activeTorrents.keys()];
    for (const id of ids) {
      const torrent = activeTorrents.get(id);
      if (torrent) {
        torrent.destroy();
        cleanupTorrent(id);
        sendProgress(id, { status: 'cancelled' });
      }
    }
    return { success: true, cancelled: ids.length };
  });

  ipcMain.handle('torrent-downloader-pause', async (event, id) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
      torrent.pause();
      return { success: true };
    }
    return { success: false, error: 'Torrent not found' };
  });

  ipcMain.handle('torrent-downloader-resume', async (event, id) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
      torrent.resume();
      return { success: true };
    }
    return { success: false, error: 'Torrent not found' };
  });
}

module.exports = { registerIPC };
