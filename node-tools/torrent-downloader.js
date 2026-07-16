'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { validateOutputDir } = require('./path-utils');
let WebTorrent;
let client = null;

async function getClient() {
  if (!client) {
    if (!WebTorrent) {
      const mod = await import('webtorrent');
      WebTorrent = mod.default || mod;
    }
    client = new WebTorrent();
    // Client-level errors (e.g. adding a duplicate torrent) are emitted on the
    // client, not the torrent. With no listener the EventEmitter throws and
    // takes down the whole main process.
    client.on('error', (err) => {
      console.error('WebTorrent client error:', err.message || err);
      if (onClientError) onClientError(err);
    });
  }
  return client;
}

let onClientError = null;

function registerIPC(ipcMain, getMainWindow) {
  const activeTorrents = new Map();
  const progressTimers = new Map();
  const metadataTimers = new Map();

  function validateSource(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Select a .torrent file or enter a magnet link.');
    const value = source.trim();
    if (value.length > 8192) throw new Error('Torrent source is too long.');
    if (/^magnet:\?/i.test(value)) {
      const parsed = new URL(value);
      const hasHash = parsed.searchParams.getAll('xt').some(xt =>
        /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt) ||
        /^urn:btmh:1220[a-f0-9]{64}$/i.test(xt)
      );
      if (!hasHash) {
        throw new Error('Invalid magnet link.');
      }
      return value;
    }
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      if (!parsed.hostname) throw new Error('Invalid torrent URL.');
      return parsed.href;
    }
    if (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.torrent') {
      throw new Error('Torrent file path must point to a .torrent file.');
    }
    const stat = fs.statSync(value);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) throw new Error('Invalid .torrent file.');
    return value;
  }

  function isSafeTorrentPath(root, filePath) {
    if (typeof filePath !== 'string' || !filePath || path.isAbsolute(filePath)) return false;
    const relative = path.relative(root, path.resolve(root, filePath));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  function destroyTorrent(torrent) {
    return new Promise((resolve) => {
      if (!torrent || torrent.destroyed) { resolve(); return; }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 5000);
      if (typeof timer.unref === 'function') timer.unref();
      try { torrent.destroy(finish); } catch { finish(); }
    });
  }

  function sendProgress(id, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('tool-progress', { tool: 'torrent-downloader', id, ...payload });
    }
  }

  onClientError = (err) => {
    sendProgress(null, { status: 'error', message: err.message || String(err) });
  };

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
    if (typeof interval.unref === 'function') interval.unref();
    progressTimers.set(id, interval);
  }

  function cleanupTorrent(id) {
    activeTorrents.delete(id);
    const timer = progressTimers.get(id);
    if (timer) {
      clearInterval(timer);
      progressTimers.delete(id);
    }
    const metadataTimer = metadataTimers.get(id);
    if (metadataTimer) {
      clearTimeout(metadataTimer);
      metadataTimers.delete(id);
    }
  }

  function clearMetadataTimer(id) {
    const timer = metadataTimers.get(id);
    if (timer) clearTimeout(timer);
    metadataTimers.delete(id);
  }

  ipcMain.handle('torrent-downloader-download', async (event, options = {}) => {
    options = options && typeof options === 'object' ? options : {};
    const { source, outputDir } = options;

    try {
      const torrentSource = validateSource(source);
      const outDir = validateOutputDir(outputDir);
      if (!outDir) throw new Error('Invalid output directory');
      
      fs.mkdirSync(outDir, { recursive: true });

      const c = await getClient();

      // Reject a duplicate before adding it. WebTorrent surfaces a duplicate
      // add as a *client*-level error with no link back to this request, which
      // would otherwise leave the new row stuck on "metadata" forever.
      let alreadyAdded = null;
      try { alreadyAdded = await c.get(torrentSource); } catch { alreadyAdded = null; }
      if (alreadyAdded) {
        return { success: false, error: 'That torrent is already in the download list.' };
      }

      const torrentId = crypto.randomUUID();
      sendProgress(torrentId, { status: 'metadata', progress: 0 });

      const torrent = c.add(torrentSource, { path: outDir }, (t) => {
        clearMetadataTimer(torrentId);
        if (t !== torrent) {
          cleanupTorrent(torrentId);
          sendProgress(torrentId, { status: 'error', message: 'That torrent is already in the download list.' });
          return;
        }
        if (!t.files.every(file => isSafeTorrentPath(outDir, file.path))) {
          cleanupTorrent(torrentId);
          sendProgress(torrentId, { status: 'error', message: 'Torrent metadata contains an unsafe file path.' });
          destroyTorrent(t);
          return;
        }
        const files = t.files.map(f => ({ name: f.name, length: f.length, path: f.path }));
        sendProgress(torrentId, { 
          status: 'metadata_fetched', 
          name: t.name,
          infoHash: t.infoHash,
          length: t.length,
          files: files
        });

        startProgressThrottle(torrentId, t);

      });

      torrent.once('done', () => {
        cleanupTorrent(torrentId);
        sendProgress(torrentId, {
          status: 'done',
          name: torrent.name,
          length: torrent.length,
          downloaded: torrent.downloaded,
          uploaded: torrent.uploaded
        });
        destroyTorrent(torrent);
      });

      torrent.once('error', (err) => {
        cleanupTorrent(torrentId);
        sendProgress(torrentId, { status: 'error', message: err.message || String(err) });
        destroyTorrent(torrent);
      });

      activeTorrents.set(torrentId, torrent);
      if (!torrent.ready) {
        const metadataTimer = setTimeout(() => {
          if (!torrent.ready && activeTorrents.has(torrentId)) {
            cleanupTorrent(torrentId);
            sendProgress(torrentId, { status: 'error', message: 'Timed out waiting for torrent metadata.' });
            destroyTorrent(torrent);
          }
        }, 5 * 60 * 1000);
        if (typeof metadataTimer.unref === 'function') metadataTimer.unref();
        metadataTimers.set(torrentId, metadataTimer);
      }

      // torrent.name is usually not known yet (metadata resolves asynchronously);
      // the authoritative name is delivered via the 'metadata_fetched' progress
      // event above. Return whatever is available so the caller has a fallback.
      return { success: true, id: torrentId, name: torrent.name || '' };

    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('torrent-downloader-cancel', async (event, id) => {
    const torrent = activeTorrents.get(id);
    if (torrent) {
      cleanupTorrent(id);
      await destroyTorrent(torrent);
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
        cleanupTorrent(id);
        await destroyTorrent(torrent);
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
