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
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
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
    backgroundColor: '#101820',
    icon: path.join(appDir, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

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
      setTimeout(() => resolveWhenVisible(resolve), 120);
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
  } catch {
    await delay(900);
  }
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

function createWindow(appDir) {
  installPermissionHandler();
  mainWindow = new BrowserWindow({
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
      sandbox: true
    },
    backgroundColor: '#0f0f1a',
    icon: path.join(appDir, 'build', 'icon.png'),
    show: false
  });

  // Keep the renderer's maximize/restore button glyph in sync with real state
  // (the user can still maximize via Win+Up, snap, or a double-click).
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  // The app is a single local page that swaps tool HTML in-place via fetch; it
  // never legitimately navigates the top frame or opens new windows. Deny both
  // so injected markup or a stray link can't repoint the app or spawn a
  // node-less child window. External http(s) links open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const blockOffAppNavigation = (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  };
  mainWindow.webContents.on('will-navigate', blockOffAppNavigation);
  mainWindow.webContents.on('will-redirect', blockOffAppNavigation);

  mainWindow.loadFile(path.join(appDir, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setTitle('MuxMelt');
  mainWindow.once('ready-to-show', async () => {
    updateSplash(100, 'Ready');
    await playSplashFinish();
    closeSplash();
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  
  return mainWindow;
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
