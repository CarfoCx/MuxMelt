const { BrowserWindow } = require('electron');
const path = require('path');

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
      nodeIntegration: false
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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 540,
    webPreferences: {
      preload: path.join(appDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0f0f1a',
    icon: path.join(appDir, 'build', 'icon.png'),
    show: false
  });

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
