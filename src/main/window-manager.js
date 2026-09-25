const { BrowserWindow, shell, session } = require('electron');
const path = require('path');

// The renderer is a local page; it never legitimately needs camera, mic,
// geolocation, etc. Clipboard write is the one permission the UI uses
// ("Copy Path" in the file context menu). Deny everything else.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
let permissionHandlerInstalled = false;
function installPermissionHandler() {
  if (permissionHandlerInstalled) return;
  permissionHandlerInstalled = true;
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });
}

function openExternalUrl(url, networkPolicy = null) {
  if (!/^https?:\/\//i.test(url)) return;
  try { networkPolicy?.assertAllowed?.('Opening external links'); }
  catch { return; }
  shell.openExternal(url).catch((err) => {
    console.warn(`Failed to open external URL: ${err.message}`);
  });
}

let mainWindow = null;
let splashWindow = null;
let splashState = { percent: 8, status: 'Preparing MuxMelt', detail: 'Loading required components' };

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSplashWindow(appDir) {
  if (splashWindow && !splashWindow.isDestroyed()) return Promise.resolve();

  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#111315',
    icon: path.join(appDir, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false
    }
  });

  splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splashWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  splashWindow.webContents.on('will-redirect', (event) => event.preventDefault());

  let resolved = false;
  const resolveWhenVisible = (resolve) => {
    if (resolved) return;
    resolved = true;
    resolve();
  };

  const visiblePromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
      }
      resolveWhenVisible(resolve);
    }, 1200);

    splashWindow.once('ready-to-show', () => {
      clearTimeout(timeout);
      if (!splashWindow || splashWindow.isDestroyed()) {
        resolveWhenVisible(resolve);
        return;
      }
      splashWindow.show();
      updateSplash(splashState.percent, splashState.status, splashState.detail);
      resolveWhenVisible(resolve);
    });

    splashWindow.webContents.once('did-finish-load', () => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        updateSplash(splashState.percent, splashState.status, splashState.detail);
      }
    });
  });

  splashWindow.on('closed', () => { splashWindow = null; });
  splashWindow.loadFile(path.join(appDir, 'renderer', 'splash.html')).catch(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });

  return visiblePromise;
}

function updateSplash(percent, status, detail = '') {
  splashState = { percent, status, detail };
  if (!splashWindow || splashWindow.isDestroyed()) return;

  const payload = JSON.stringify({ percent, status, detail });
  splashWindow.webContents.executeJavaScript(`window.setSplashProgress(${payload})`, true).catch(() => {});
}

async function playSplashFinish() {
  if (!splashWindow || splashWindow.isDestroyed()) return;

  try {
    await splashWindow.webContents.executeJavaScript(
      'window.playSplashFinish ? window.playSplashFinish() : Promise.resolve()',
      true
    );
  } catch { /* A failed splash update must not delay the ready application. */ }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

async function createWindow(appDir, networkPolicy = null) {
  installPermissionHandler();
  const createdWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 540,
    // Frameless: the OS title bar (which looks like Win11) is removed and the
    // app draws its own themeable title bar in the renderer. The window stays
    // resizable from its edges.
    frame: false,
    webPreferences: {
      preload: path.join(appDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false
    },
    backgroundColor: '#111315',
    icon: path.join(appDir, 'build', 'icon.png'),
    show: false
  });
  mainWindow = createdWindow;

  // Keep the renderer's maximize/restore button glyph in sync with real state
  // (the user can still maximize via Win+Up, snap, or a double-click).
  const sendMaxState = () => {
    if (!createdWindow.isDestroyed()) {
      createdWindow.webContents.send('window-maximized', createdWindow.isMaximized());
    }
  };
  createdWindow.on('maximize', sendMaxState);
  createdWindow.on('unmaximize', sendMaxState);

  // The app is a single local page that swaps tool HTML in-place via fetch; it
  // never legitimately navigates the top frame or opens new windows. Deny both
  // so injected markup or a stray link can't repoint the app or spawn a
  // node-less child window. External http(s) links open in the real browser.
  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, networkPolicy);
    return { action: 'deny' };
  });
  const blockRendererNavigation = (event, url) => {
    // loadFile() does not emit will-navigate. Any renderer-initiated top-frame
    // navigation is therefore unexpected, including navigation to another
    // local file which would otherwise retain this window's privileged preload.
    event.preventDefault();
    openExternalUrl(url, networkPolicy);
  };
  createdWindow.webContents.on('will-navigate', blockRendererNavigation);
  createdWindow.webContents.on('will-redirect', blockRendererNavigation);

  createdWindow.setMenuBarVisibility(false);
  createdWindow.setTitle('MuxMelt');
  createdWindow.once('ready-to-show', async () => {
    updateSplash(100, 'Ready');
    await playSplashFinish();
    closeSplash();
    if (!createdWindow.isDestroyed()) createdWindow.show();
  });
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });

  try {
    await createdWindow.loadFile(path.join(appDir, 'renderer', 'index.html'));
  } catch (err) {
    if (!createdWindow.isDestroyed()) createdWindow.destroy();
    throw new Error(`Failed to load the application window: ${err.message}`);
  }

  return createdWindow;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  createSplashWindow,
  updateSplash,
  playSplashFinish,
  closeSplash,
  createWindow,
  getMainWindow,
  delay
};
