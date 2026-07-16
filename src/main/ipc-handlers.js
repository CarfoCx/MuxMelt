const { ipcMain, dialog, shell, Notification, app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const MAX_RESOLVED_PATHS = 1000;
const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024;
const CLIPBOARD_IMAGE_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/tiff', '.tiff']
]);

function detectImageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return '.gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return '.bmp';
  if (buffer.length >= 4) {
    const signature = buffer.subarray(0, 4).toString('hex');
    if (signature === '49492a00' || signature === '4d4d002a') return '.tiff';
  }
  return null;
}

function normalizeClipboardBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return null;
}

const IMAGE_PREVIEW_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.gif', '.svg', '.heic', '.heif'
]);

// Allowlist of file types the renderer may ask the OS to open. The app only
// ever opens its own outputs (media) and tool sidecars (subtitles, metadata),
// so an allowlist is safer than trying to enumerate every dangerous extension.
const OPENABLE_EXTS = new Set([
  // images
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.gif', '.svg', '.heic', '.heif', '.ico',
  // video
  '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.flv', '.wmv', '.mpg', '.mpeg',
  // audio
  '.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma', '.opus',
  // sidecar/metadata files tools can produce
  '.txt', '.srt', '.vtt', '.ass', '.json', '.pdf', '.nfo', '.description'
]);

function registerIpcHandlers(options) {
  const {
    getMainWindow,
    scanFolder,
    getPythonPort,
    getPythonToken,
    loadSettings,
    saveSettings,
    restartPythonCallback
  } = options;

  let clipboardTempDir = null;
  app.once('will-quit', () => {
    if (!clipboardTempDir) return;
    try { fs.rmSync(clipboardTempDir, { recursive: true, force: true }); } catch {}
  });

  ipcMain.handle('select-output-dir', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: 'Select Output Directory'
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('select-files', async (event, opts) => {
    const defaultFilters = [
      { name: 'Images & Videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'avif', 'gif', 'svg', 'heic', 'heif', 'mp4', 'avi', 'mkv', 'mov', 'webm'] }
    ];
    const requestedFilters = Array.isArray(opts && opts.filters)
      ? opts.filters.slice(0, 20).map((filter) => {
        if (!filter || typeof filter !== 'object') return null;
        const extensions = Array.isArray(filter.extensions)
          ? filter.extensions
            .filter((ext) => typeof ext === 'string' && /^[a-z0-9]+$/i.test(ext))
            .slice(0, 50)
          : [];
        if (extensions.length === 0) return null;
        return {
          name: typeof filter.name === 'string' ? filter.name.slice(0, 100) : 'Files',
          extensions
        };
      }).filter(Boolean)
      : [];
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: typeof (opts && opts.title) === 'string' ? opts.title.slice(0, 200) : 'Select Files',
      filters: requestedFilters.length > 0 ? requestedFilters : defaultFilters
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: 'Select Folder to Scan'
    });
    if (result.canceled) return [];
    const files = await scanFolder(result.filePaths[0]);
    const mainWindow = getMainWindow();
    if (files.length >= 1000 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', 'Warning: folder scan hit 1000 file limit. Some files may not be shown.');
    }
    return files;
  });

  // ---- Custom window-frame controls (the window is frameless) ----
  ipcMain.handle('window-minimize', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.minimize();
  });

  ipcMain.handle('window-maximize-toggle', () => {
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });

  ipcMain.handle('window-close', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.close();
  });

  ipcMain.handle('window-is-maximized', () => {
    const w = getMainWindow();
    return !!(w && !w.isDestroyed() && w.isMaximized());
  });

  ipcMain.handle('get-python-port', () => getPythonPort());

  ipcMain.handle('get-python-token', () => (getPythonToken ? getPythonToken() : null));

  ipcMain.handle('open-external', async (event, url) => {
    if (typeof url !== 'string' || url.length > 4096) return false;
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) return false;
      await shell.openExternal(parsed.href);
      return true;
    } catch (err) {
      console.warn(`Failed to open external URL: ${err.message}`);
      return false;
    }
  });

  async function resolveSafePath(filePath, expectDirectory = false) {
    if (typeof filePath !== 'string' || !filePath) return null;
    try {
      const resolvedPath = path.resolve(filePath);
      const realPath = await fs.promises.realpath(resolvedPath);
      const stat = await fs.promises.stat(realPath);
      if (expectDirectory) return stat.isDirectory() ? realPath : null;

      // Reject a final symlink and validate the extension of the resolved
      // target, not just the renderer-provided path. Otherwise an allowed
      // name such as output.png could point at an executable.
      if ((await fs.promises.lstat(resolvedPath)).isSymbolicLink() || !stat.isFile()) return null;
      if (!expectDirectory) {
        const ext = path.extname(realPath).toLowerCase();
        if (!OPENABLE_EXTS.has(ext)) {
          return null;
        }
      }
      return realPath;
    } catch {
      return null;
    }
  }

  ipcMain.handle('open-folder', async (event, folderPath) => {
    const safePath = await resolveSafePath(folderPath, true);
    if (safePath) {
      const error = await shell.openPath(safePath);
      return error ? { success: false, error } : { success: true };
    } else {
      console.warn(`Blocked potentially unsafe open-folder request for: ${folderPath}`);
      return { success: false, error: 'Invalid or unavailable folder path' };
    }
  });

  ipcMain.handle('open-path', async (event, filePath) => {
    const safePath = await resolveSafePath(filePath, false);
    if (safePath) {
      const error = await shell.openPath(safePath);
      return error ? { success: false, error } : { success: true };
    } else {
      console.warn(`Blocked potentially unsafe open-path request for: ${filePath}`);
      return { success: false, error: 'Invalid or disallowed file path' };
    }
  });

  ipcMain.handle('load-settings', () => loadSettings());

  ipcMain.handle('save-settings', (event, settings) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return false;
    }
    // The generic renderer-writable settings document is not trusted
    // provenance for native-code launch paths. Local update sources are owned
    // by updater.js and can only be changed through its native folder picker.
    const sanitized = { ...settings };
    if (settings.global && typeof settings.global === 'object' && !Array.isArray(settings.global)) {
      sanitized.global = { ...settings.global };
      delete sanitized.global.updateFolderPath;
    }
    return saveSettings(sanitized);
  });

  ipcMain.handle('resolve-dropped-paths', async (event, paths) => {
    if (!Array.isArray(paths)) return [];
    const results = [];
    const seen = new Set();
    for (const p of paths.slice(0, MAX_RESOLVED_PATHS)) {
      if (results.length >= MAX_RESOLVED_PATHS) break;
      if (typeof p !== 'string') continue;
      try {
        const resolvedPath = path.resolve(p);
        const stat = await fs.promises.stat(resolvedPath);
        if (stat.isDirectory()) {
          const scanned = await scanFolder(resolvedPath, MAX_RESOLVED_PATHS - results.length);
          for (const filePath of scanned) {
            if (!seen.has(filePath)) {
              seen.add(filePath);
              results.push(filePath);
            }
          }
        } else if (stat.isFile()) {
          if (!seen.has(resolvedPath)) {
            seen.add(resolvedPath);
            results.push(resolvedPath);
          }
        }
      } catch (err) {
        console.warn(`Failed to stat path ${p}: ${err.message}`);
      }
    }
    return results;
  });

  ipcMain.handle('save-clipboard-image', async (event, payload) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('Clipboard image request came from an untrusted window');
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid clipboard image payload');
    }

    const mimeType = typeof payload.mimeType === 'string'
      ? payload.mimeType.toLowerCase().split(';', 1)[0].trim()
      : '';
    const expectedExtension = CLIPBOARD_IMAGE_TYPES.get(mimeType);
    if (!expectedExtension) throw new Error(`Unsupported clipboard image type: ${mimeType || '(missing)'}`);

    const imageBytes = normalizeClipboardBytes(payload.bytes);
    if (!imageBytes || imageBytes.length === 0) throw new Error('Clipboard image is empty');
    if (imageBytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new Error('Clipboard image exceeds the 32 MB limit');
    }
    const detectedExtension = detectImageExtension(imageBytes);
    if (!detectedExtension || detectedExtension !== expectedExtension) {
      throw new Error('Clipboard image contents do not match the declared image type');
    }

    if (!clipboardTempDir) {
      clipboardTempDir = path.join(app.getPath('temp'), 'muxmelt-clipboard', crypto.randomUUID());
      await fs.promises.mkdir(clipboardTempDir, { recursive: true, mode: 0o700 });
    }
    const imagePath = path.join(clipboardTempDir, `${crypto.randomUUID()}${detectedExtension}`);
    await fs.promises.writeFile(imagePath, imageBytes, { flag: 'wx', mode: 0o600 });
    return imagePath;
  });

  ipcMain.handle('read-image-preview', async (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return null;
      const resolved = path.resolve(filePath);
      const linkStat = await fs.promises.lstat(resolved);
      if (linkStat.isSymbolicLink()) return null;
      const realPath = await fs.promises.realpath(resolved);
      const ext = path.extname(realPath).toLowerCase();
      // Only ever expose image files — never read arbitrary paths back to the
      // renderer, and never read non-image content.
      if (!IMAGE_PREVIEW_EXTS.has(ext)) return null;
      const stat = await fs.promises.stat(realPath);
      if (!stat.isFile()) return null;
      // Serve via file:// (allowed by the CSP img-src) rather than encoding the
      // whole file as base64 over IPC — avoids ~33% bloat and a synchronous
      // main-process read, and no file bytes ever transit the IPC channel.
      return pathToFileURL(realPath).href;
    } catch (err) {
      console.warn(`Failed to resolve image preview ${filePath}: ${err.message}`);
      return null;
    }
  });

  ipcMain.handle('get-file-size', async (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return 0;
    try {
      const stat = await fs.promises.stat(path.resolve(filePath));
      return stat.isFile() ? stat.size : 0;
    } catch {
      return 0;
    }
  });

  ipcMain.handle('path-exists', async (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return false;
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('check-overwrite', async (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { proceed: false, error: 'Invalid output path' };
    }
    const resolvedPath = path.resolve(filePath);
    try {
      await fs.promises.access(resolvedPath);
    } catch {
      return { proceed: true };
    }

    const settings = loadSettings();
    const globalSettings = settings.global && typeof settings.global === 'object' && !Array.isArray(settings.global)
      ? settings.global
      : {};
    if (globalSettings.skipOverwriteConfirm) return { proceed: true };
    const mainWindow = getMainWindow();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Overwrite', 'Skip', 'Always Overwrite'],
      defaultId: 0,
      title: 'File Exists',
      message: `"${path.basename(resolvedPath)}" already exists.`,
      detail: 'Do you want to overwrite it?'
    });
    if (result.response === 2) {
      settings.global = globalSettings;
      settings.global.skipOverwriteConfirm = true;
      return saveSettings(settings)
        ? { proceed: true }
        : { proceed: false, error: 'Failed to save overwrite preference' };
    }
    return { proceed: result.response === 0 };
  });

  ipcMain.handle('show-notification', async (event, opts) => {
    opts = (opts && typeof opts === 'object') ? opts : {};
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: typeof opts.title === 'string' ? opts.title.slice(0, 200) : 'MuxMelt',
        body: typeof opts.body === 'string' ? opts.body.slice(0, 2000) : '',
        silent: false
      });
      notification.show();
    }
  });

  ipcMain.handle('restart-python', async () => {
    if (restartPythonCallback) {
      return await restartPythonCallback();
    }
    return { success: false, error: 'Restart callback not implemented' };
  });

  ipcMain.handle('set-progress', (event, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      // -1 clears the taskbar progress; anything else is a 0-1 fraction.
      mainWindow.setProgressBar(value < 0 ? -1 : Math.min(value, 1));
    }
  });

  let cachedAppVersion = null;
  ipcMain.handle('get-app-version', () => {
    if (cachedAppVersion !== null) return cachedAppVersion;

    const pkg = require('../../package.json');
    const baseVersion = pkg.version;

    // In a packaged build there is no git repo (and git may not be installed),
    // so don't spawn git at all. Only enrich with build metadata in dev, and
    // compute it once per process rather than shelling out on every call.
    if (app.isPackaged) {
      cachedAppVersion = baseVersion;
      return cachedAppVersion;
    }

    const appDir = path.join(__dirname, '..', '..');
    try {
      const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: appDir, encoding: 'utf-8', timeout: 3000
      }).trim();
      const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: appDir, encoding: 'utf-8', timeout: 3000
      }).trim();
      const dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: appDir, encoding: 'utf-8', timeout: 3000
      }).trim();
      cachedAppVersion = `${baseVersion} (build ${count}, ${hash})${dirty ? ' *' : ''}`;
    } catch {
      cachedAppVersion = baseVersion;
    }
    return cachedAppVersion;
  });
}

module.exports = { registerIpcHandlers };
