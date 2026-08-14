'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { validateOutputDir } = require('./path-utils');

function cancelledStartupError() {
  const error = new Error('Torrent startup was cancelled.');
  error.code = 'TORRENT_STARTUP_CANCELLED';
  return error;
}

function createClientController(loadConstructor = async () => {
  const mod = await import('webtorrent');
  return mod.default || mod;
}) {
  let WebTorrent = null;
  let client = null;
  let clientErrorListener = null;
  let clientGeneration = 0;
  let clientStartupPromise = null;
  let clientTeardownPromise = null;
  let lifecycleFailure = null;
  let onClientError = null;

  function removeClientErrorListener(target, listener) {
    if (target && listener && typeof target.removeListener === 'function') {
      target.removeListener('error', listener);
    }
  }

  function destroyClient(target, listener) {
    return new Promise((resolve, reject) => {
      if (!target || target.destroyed) {
        removeClientErrorListener(target, listener);
        resolve();
        return;
      }

      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else {
          removeClientErrorListener(target, listener);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('Timed out while stopping the torrent network client.'));
      }, 5000);

      try { target.destroy(finish); }
      catch (error) { finish(error); }
    });
  }

  async function getSession() {
    if (lifecycleFailure) {
      const error = new Error('The torrent network client did not stop cleanly. Restart MuxMelt before downloading again.');
      error.code = 'TORRENT_CLIENT_UNSAFE';
      error.cause = lifecycleFailure;
      throw error;
    }
    if (clientTeardownPromise) throw cancelledStartupError();
    if (client && !client.destroyed) {
      return { client, generation: clientGeneration };
    }

    if (!clientStartupPromise) {
      const generation = clientGeneration;
      clientStartupPromise = (async () => {
        if (!WebTorrent) WebTorrent = await loadConstructor();
        if (generation !== clientGeneration || clientTeardownPromise) {
          throw cancelledStartupError();
        }

        const candidate = new WebTorrent();
        const errorListener = (error) => {
          console.error('WebTorrent client error:', error.message || error);
          if (onClientError) onClientError(error);
        };
        candidate.on('error', errorListener);

        // No JavaScript can interleave between construction and this check,
        // but retaining it makes ownership explicit if construction ever
        // becomes asynchronous in a future adapter.
        if (generation !== clientGeneration || clientTeardownPromise) {
          await destroyClient(candidate, errorListener);
          throw cancelledStartupError();
        }

        client = candidate;
        clientErrorListener = errorListener;
        return { client: candidate, generation };
      })();
    }

    const startup = clientStartupPromise;
    try {
      return await startup;
    } finally {
      if (clientStartupPromise === startup) clientStartupPromise = null;
    }
  }

  function assertCurrent(session) {
    if (
      !session ||
      clientTeardownPromise ||
      session.generation !== clientGeneration ||
      session.client !== client ||
      session.client.destroyed
    ) {
      const error = new Error('Torrent operation was cancelled before it could start.');
      error.code = 'TORRENT_OPERATION_CANCELLED';
      throw error;
    }
  }

  function shutdown(stopOwnedWork = async () => {}) {
    if (clientTeardownPromise) return clientTeardownPromise;
    if (lifecycleFailure) return Promise.reject(lifecycleFailure);

    // Invalidate every in-flight session before yielding. This closes the
    // maintenance race where a request could resume after Offline Mode had
    // already stopped and then restarted the shared client.
    clientGeneration += 1;
    const pendingStartup = clientStartupPromise;
    const run = (async () => {
      const failures = [];
      if (pendingStartup) {
        try { await pendingStartup; } catch {}
      }

      try { await stopOwnedWork(); }
      catch (error) { failures.push(error); }

      const oldClient = client;
      const oldErrorListener = clientErrorListener;
      if (oldClient) {
        try {
          await destroyClient(oldClient, oldErrorListener);
          if (client === oldClient) client = null;
          if (clientErrorListener === oldErrorListener) clientErrorListener = null;
        }
        catch (error) { failures.push(error); }
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Torrent shutdown did not complete.');
    })();

    const tracked = run
      .catch((error) => {
        lifecycleFailure = error;
        throw error;
      })
      .finally(() => {
        if (clientTeardownPromise === tracked) clientTeardownPromise = null;
      });
    clientTeardownPromise = tracked;
    return tracked;
  }

  return {
    getSession,
    assertCurrent,
    shutdown,
    setErrorHandler(handler) { onClientError = typeof handler === 'function' ? handler : null; },
  };
}

const clientController = createClientController();

function registerIPC(ipcMain, getMainWindow, networkPolicy = null, jobRegistry = null, dependencies = {}) {
  const assertJobStart = () => jobRegistry?.assertCanStart?.('Torrent operation');
  const lifecycle = dependencies.clientController || clientController;
  const activeTorrents = new Map();
  const progressTimers = new Map();
  const metadataTimers = new Map();
  const torrentListeners = new WeakMap();

  function validateSource(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Select a .torrent file or enter a magnet link.');
    const value = source.trim();
    if (value.length > 8192) throw new Error('Torrent source is too long.');
    // A bare info-hash (40-char hex or 32-char base32) is a valid way to
    // identify a torrent; normalize it to a magnet link.
    if (/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(value)) {
      return `magnet:?xt=urn:btih:${value}`;
    }
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
    return new Promise((resolve, reject) => {
      if (!torrent || torrent.destroyed) { resolve(); return; }
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error('Timed out while stopping a torrent download.'));
      }, 5000);
      try { torrent.destroy(finish); } catch (error) { finish(error); }
    });
  }

  function destroyTorrentInBackground(torrent) {
    destroyTorrent(torrent).catch((error) => {
      console.warn('Failed to finish torrent cleanup:', error.message || error);
    });
  }

  function sendProgress(id, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('tool-progress', { tool: 'torrent-downloader', id, ...payload });
    }
  }

  lifecycle.setErrorHandler((err) => {
    sendProgress(null, { status: 'error', message: err.message || String(err) });
  });

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
    const torrent = activeTorrents.get(id);
    activeTorrents.delete(id);
    const listeners = torrent && torrentListeners.get(torrent);
    if (listeners) {
      torrent.removeListener('done', listeners.onDone);
      torrent.removeListener('error', listeners.onError);
      torrentListeners.delete(torrent);
    }
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
      assertJobStart();
      if (networkPolicy) networkPolicy.assertAllowed('Torrent downloads');
      const torrentSource = validateSource(source);
      const outDir = validateOutputDir(outputDir);
      if (!outDir) throw new Error('Invalid output directory');

      const session = await lifecycle.getSession();
      assertJobStart();
      if (networkPolicy) networkPolicy.assertAllowed('Torrent downloads');
      lifecycle.assertCurrent(session);
      const c = session.client;

      // Reject a duplicate before adding it. WebTorrent surfaces a duplicate
      // add as a *client*-level error with no link back to this request, which
      // would otherwise leave the new row stuck on "metadata" forever.
      let alreadyAdded = null;
      try { alreadyAdded = await c.get(torrentSource); } catch { alreadyAdded = null; }
      assertJobStart();
      if (networkPolicy) networkPolicy.assertAllowed('Torrent downloads');
      lifecycle.assertCurrent(session);
      if (alreadyAdded) {
        return { success: false, error: 'That torrent is already in the download list.' };
      }

      // Keep directory creation and client.add in the same synchronous turn as
      // the final policy/generation check. Shutdown therefore either sees and
      // owns the torrent, or invalidates this operation before it is added.
      fs.mkdirSync(outDir, { recursive: true });
      const torrentId = crypto.randomUUID();
      sendProgress(torrentId, { status: 'metadata', progress: 0 });

      const torrent = c.add(torrentSource, { path: outDir }, (t) => {
        if (!activeTorrents.has(torrentId) || t.destroyed) return;
        clearMetadataTimer(torrentId);
        if (t !== torrent) {
          cleanupTorrent(torrentId);
          sendProgress(torrentId, { status: 'error', message: 'That torrent is already in the download list.' });
          return;
        }
        if (!t.files.every(file => isSafeTorrentPath(outDir, file.path))) {
          cleanupTorrent(torrentId);
          sendProgress(torrentId, { status: 'error', message: 'Torrent metadata contains an unsafe file path.' });
          destroyTorrentInBackground(t);
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

      const onDone = () => {
        cleanupTorrent(torrentId);
        sendProgress(torrentId, {
          status: 'done',
          name: torrent.name,
          length: torrent.length,
          downloaded: torrent.downloaded,
          uploaded: torrent.uploaded
        });
        destroyTorrentInBackground(torrent);
      };

      const onError = (err) => {
        cleanupTorrent(torrentId);
        sendProgress(torrentId, { status: 'error', message: err.message || String(err) });
        destroyTorrentInBackground(torrent);
      };
      torrent.once('done', onDone);
      torrent.once('error', onError);
      torrentListeners.set(torrent, { onDone, onError });

      activeTorrents.set(torrentId, torrent);
      if (!torrent.ready) {
        const metadataTimer = setTimeout(() => {
          if (!torrent.ready && activeTorrents.has(torrentId)) {
            cleanupTorrent(torrentId);
            sendProgress(torrentId, { status: 'error', message: 'Timed out waiting for torrent metadata.' });
            destroyTorrentInBackground(torrent);
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
      try {
        await destroyTorrent(torrent);
        sendProgress(id, { status: 'cancelled' });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message || String(error) };
      }
    }
    return { success: false, error: 'Torrent not found' };
  });

  ipcMain.handle('torrent-downloader-cancel-all', async () => {
    const ids = [...activeTorrents.keys()];
    const cancellations = ids.map(async (id) => {
      const torrent = activeTorrents.get(id);
      if (torrent) {
        cleanupTorrent(id);
        await destroyTorrent(torrent);
        sendProgress(id, { status: 'cancelled' });
      }
    });
    const results = await Promise.allSettled(cancellations);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) {
      return { success: false, error: `${failures.length} torrent download(s) did not stop cleanly.` };
    }
    return { success: true, cancelled: ids.length };
  });

  ipcMain.handle('torrent-downloader-pause', async (event, id) => {
    const torrent = activeTorrents.get(id);
    if (!torrent) return { success: false, error: 'Torrent not found' };
    if (!torrent.ready || !torrent.pieces || torrent.pieces.length === 0) {
      return { success: false, error: 'Torrent is still fetching metadata' };
    }
    // pause() only blocks NEW peer connections; peers that are already
    // connected keep transferring, so on its own it merely freezes the UI.
    // Deselecting every piece stops data requests on the open connections
    // while keeping them alive, which makes resume instant (destroying the
    // wires instead would leave resume waiting on a tracker re-announce).
    torrent.pause();
    torrent.deselect(0, torrent.pieces.length - 1);
    return { success: true };
  });

  ipcMain.handle('torrent-downloader-resume', async (event, id) => {
    assertJobStart();
    if (networkPolicy) {
      try { networkPolicy.assertAllowed('Torrent downloads'); }
      catch (err) { return { success: false, error: err.message, code: err.code || null }; }
    }
    const torrent = activeTorrents.get(id);
    if (!torrent) return { success: false, error: 'Torrent not found' };
    torrent.resume();
    if (torrent.ready && torrent.pieces && torrent.pieces.length > 0) {
      torrent.select(0, torrent.pieces.length - 1);
    }
    return { success: true };
  });

  const shutdown = async () => {
    return lifecycle.shutdown(async () => {
      const torrents = [...activeTorrents.entries()];
      for (const [id] of torrents) cleanupTorrent(id);
      const results = await Promise.allSettled(
        torrents.map(([, torrent]) => destroyTorrent(torrent))
      );
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Torrent downloads did not stop cleanly.');
    });
  };
  if (jobRegistry && typeof jobRegistry.register === 'function') {
    jobRegistry.register('torrent-downloader', shutdown, { network: true });
  }
  return { shutdown };
}

module.exports = {
  registerIPC,
  __test: { createClientController },
};
