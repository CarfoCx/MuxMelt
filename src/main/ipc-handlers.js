const { ipcMain, dialog, shell, Notification, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function registerIpcHandlers(options) {
  const { 
    getMainWindow, 
    scanFolder, 
    getPythonPort, 
    loadSettings, 
    saveSettings, 
    restartPythonCallback 
  } = options;

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
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: (opts && opts.title) || 'Select Files',
      filters: (opts && opts.filters) || defaultFilters
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: 'Select Folder to Scan'
    });
    if (result.canceled) return [];
    const files = scanFolder(result.filePaths[0]);
    const mainWindow = getMainWindow();
    if (files.length >= 1000 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', 'Warning: folder scan hit 1000 file limit. Some files may not be shown.');
    }
    return files;
  });

  ipcMain.handle('get-python-port', () => getPythonPort());

  ipcMain.handle('open-external', async (event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  function isSafePath(filePath, expectDirectory = false) {
    if (typeof filePath !== 'string') return false;
    try {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) return false;
      
      const stat = fs.statSync(resolvedPath);
      if (expectDirectory && !stat.isDirectory()) return false;
      
      if (!expectDirectory) {
        const dangerousExtensions = new Set([
          '.exe', '.bat', '.cmd', '.msi', '.lnk', '.vbs', '.js', '.vbe', '.jse',
          '.wsf', '.wsh', '.msc', '.com', '.scr', '.pif', '.reg', '.sh', '.bash', '.app'
        ]);
        const ext = path.extname(resolvedPath).toLowerCase();
        if (dangerousExtensions.has(ext)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  ipcMain.handle('open-folder', async (event, folderPath) => {
    if (isSafePath(folderPath, true)) {
      shell.openPath(folderPath);
    } else {
      console.warn(`Blocked potentially unsafe open-folder request for: ${folderPath}`);
    }
  });

  ipcMain.handle('open-path', async (event, filePath) => {
    if (isSafePath(filePath, false)) {
      shell.openPath(filePath);
    } else {
      console.warn(`Blocked potentially unsafe open-path request for: ${filePath}`);
    }
  });

  ipcMain.handle('load-settings', () => loadSettings());

  ipcMain.handle('save-settings', (event, settings) => {
    saveSettings(settings);
  });

  ipcMain.handle('resolve-dropped-paths', async (event, paths) => {
    const results = [];
    for (const p of paths) {
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          results.push(...scanFolder(p));
        } else if (stat.isFile()) {
          results.push(p);
        }
      } catch (err) {
        console.warn(`Failed to stat path ${p}: ${err.message}`);
      }
    }
    return results;
  });

  ipcMain.handle('read-image-preview', async (event, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      const data = fs.readFileSync(filePath).toString('base64');
      return `data:image/${mime};base64,${data}`;
    } catch (err) {
      console.warn(`Failed to read image preview ${filePath}: ${err.message}`);
      return null;
    }
  });

  ipcMain.handle('get-file-size', async (event, filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  });

  ipcMain.handle('path-exists', async (event, filePath) => {
    try {
      return !!filePath && fs.existsSync(filePath);
    } catch {
      return false;
    }
  });

  ipcMain.handle('check-overwrite', async (event, filePath) => {
    if (!fs.existsSync(filePath)) return { proceed: true };
    try {
      const settings = loadSettings();
      if (settings.global && settings.global.skipOverwriteConfirm) return { proceed: true };
    } catch {}
    const mainWindow = getMainWindow();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Overwrite', 'Skip', 'Always Overwrite'],
      defaultId: 0,
      title: 'File Exists',
      message: `"${path.basename(filePath)}" already exists.`,
      detail: 'Do you want to overwrite it?'
    });
    if (result.response === 2) {
      const settings = loadSettings();
      settings.global = settings.global || {};
      settings.global.skipOverwriteConfirm = true;
      saveSettings(settings);
      return { proceed: true };
    }
    return { proceed: result.response === 0 };
  });

  ipcMain.handle('show-notification', async (event, opts) => {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: opts.title || 'MuxMelt',
        body: opts.body || '',
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
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(value);
    }
  });

  ipcMain.handle('get-app-version', () => {
    const pkg = require('../../package.json');
    const baseVersion = pkg.version;
    const appDir = path.join(__dirname, '..', '..');
    try {
      const hash = execSync('git rev-parse --short HEAD', {
        cwd: appDir, encoding: 'utf-8', timeout: 3000
      }).trim();
      const count = execSync('git rev-list --count HEAD', {
        cwd: appDir, encoding: 'utf-8', timeout: 3000
      }).trim();
      const dirty = execSync('git status --porcelain', {
        cwd: appDir, encoding: 'utf-8', timeout: 3000
      }).trim();
      return `${baseVersion} (build ${count}, ${hash})${dirty ? ' *' : ''}`;
    } catch {}
    return baseVersion;
  });
}

module.exports = { registerIpcHandlers };
