const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execSync, spawn } = require('child_process');

// Long-running installs (PyTorch alone can take 10 minutes) must not use
// execSync: that freezes the main process, so the setup window stops
// receiving progress events and the retry/close handlers can't fire.
function runCommand(cmd, args, { timeout, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    let timer = null;
    if (timeout) {
      timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        reject(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
    });
  });
}

function runSlimSetup(options) {
  const { appDir, SLIM_PYTHON_DIR, SLIM_PYTHON_EXE, IS_WIN, IS_PACKAGED } = options;

  return new Promise(async (resolvePromise, rejectPromise) => {
    const setupWindow = new BrowserWindow({
      width: 540, height: 340,
      resizable: false,
      frame: false,
      webPreferences: {
        preload: path.join(appDir, 'setup-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      },
      backgroundColor: '#0f0f1a',
    });
    setupWindow.loadFile(path.join(appDir, 'renderer', 'setup.html'));
    setupWindow.show();

    const send = (channel, data) => {
      if (!setupWindow.isDestroyed()) setupWindow.webContents.send(channel, data);
    };

    while (true) {
      try {
        if (IS_WIN) {
          await runSlimSetupWindows(send, options);
        } else {
          await runSlimSetupUnix(send, options);
        }
        send('setup-progress', { percent: 100, status: 'Setup complete!' });
        send('setup-complete');
        await new Promise(r => setTimeout(r, 1500));
        if (!setupWindow.isDestroyed()) setupWindow.close();
        resolvePromise();
        return;
      } catch (err) {
        send('setup-error', `Setup failed: ${err.message}`);
        try {
          await new Promise((resolve, reject) => {
            const retryHandler = () => {
              ipcMain.removeListener('setup-retry', retryHandler);
              setupWindow.removeListener('closed', closeHandler);
              resolve();
            };
            const closeHandler = () => {
              ipcMain.removeListener('setup-retry', retryHandler);
              reject(new Error('Setup cancelled'));
            };
            ipcMain.once('setup-retry', retryHandler);
            setupWindow.once('closed', closeHandler);
          });
          send('setup-progress', { percent: 0, status: 'Retrying...' });
          await new Promise(r => setTimeout(r, 300));
        } catch {
          if (!setupWindow.isDestroyed()) setupWindow.close();
          rejectPromise(err);
          return;
        }
      }
    }
  });
}

async function runSlimSetupWindows(send, options) {
  const { appDir, SLIM_PYTHON_DIR, SLIM_PYTHON_EXE, IS_PACKAGED } = options;
  const PYTHON_VERSION = '3.13.0';
  const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  const zipPath = path.join(app.getPath('temp'), 'python-embed.zip');

  send('setup-progress', { percent: 5, status: 'Downloading Python...', detail: PYTHON_URL });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    const request = (url) => {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { request(res.headers.location); return; }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Python download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) send('setup-progress', { percent: 5 + Math.round((downloaded / total) * 20), status: 'Downloading Python...', detail: `${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` });
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    request(PYTHON_URL);
  });

  send('setup-progress', { percent: 28, status: 'Extracting Python...' });
  fs.mkdirSync(SLIM_PYTHON_DIR, { recursive: true });
  const unzipScript = `import zipfile; zipfile.ZipFile(r'${zipPath}').extractall(r'${SLIM_PYTHON_DIR}')`;
  try {
    await runCommand('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' '${SLIM_PYTHON_DIR}'`], { timeout: 60000 });
  } catch {
    try {
      await runCommand('python', ['-c', unzipScript], { timeout: 60000 });
    } catch {
      await runCommand('python3', ['-c', unzipScript], { timeout: 60000 });
    }
  }
  fs.rmSync(zipPath, { force: true });

  const pthFiles = fs.readdirSync(SLIM_PYTHON_DIR).filter(f => f.endsWith('._pth'));
  for (const pth of pthFiles) {
    const p = path.join(SLIM_PYTHON_DIR, pth);
    let c = fs.readFileSync(p, 'utf-8');
    c = c.replace('#import site', 'import site');
    if (!c.includes('Lib/site-packages')) c += '\nLib/site-packages\n';
    const reqDir = appDir;
    const pythonModuleDir = path.join(reqDir, 'python');
    if (!c.includes(pythonModuleDir)) c += `\n${pythonModuleDir}\n`;
    fs.writeFileSync(p, c);
  }

  send('setup-progress', { percent: 35, status: 'Installing pip...' });
  const getPipPath = path.join(SLIM_PYTHON_DIR, 'get-pip.py');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(getPipPath);
    https.get('https://bootstrap.pypa.io/get-pip.py', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`get-pip.py download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
  await runCommand(SLIM_PYTHON_EXE, ['get-pip.py', '--no-warn-script-location'], { cwd: SLIM_PYTHON_DIR, timeout: 120000 });
  fs.rmSync(getPipPath, { force: true });

  send('setup-progress', { percent: 40, status: 'Installing PyTorch with CUDA (this takes a few minutes)...', detail: 'Downloading ~2.5 GB' });
  await runCommand(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu124', '--no-warn-script-location'], { timeout: 600000 });

  send('setup-progress', { percent: 75, status: 'Installing processing tools...' });
  const reqDir = appDir;
  const reqPath = path.join(reqDir, 'python', 'requirements.txt');
  await runCommand(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', '-r', reqPath,
    '--extra-index-url', 'https://abetlen.github.io/llama-cpp-python/whl/cpu',
    '--prefer-binary', '--no-warn-script-location'], { timeout: 600000 });
}

async function runSlimSetupUnix(send, options) {
  const { appDir, SLIM_PYTHON_DIR, SLIM_PYTHON_EXE, IS_PACKAGED } = options;

  send('setup-progress', { percent: 5, status: 'Checking Python...' });

  let systemPython = null;
  for (const cmd of ['python3', 'python']) {
    try {
      const result = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      const match = result.match(/Python (\d+)\.(\d+)/);
      if (match && parseInt(match[1]) === 3 && parseInt(match[2]) >= 10) {
        systemPython = cmd;
        break;
      }
    } catch {}
  }

  if (!systemPython) {
    const isMac = process.platform === 'darwin';
    throw new Error(
      'Python 3.10+ is required.\n\n' +
      (isMac
        ? 'Install from https://python.org/downloads or: brew install python@3.12'
        : 'Install from https://python.org/downloads or: sudo apt install python3')
    );
  }

  send('setup-progress', { percent: 10, status: 'Creating Python environment...', detail: systemPython });
  fs.mkdirSync(SLIM_PYTHON_DIR, { recursive: true });
  await runCommand(systemPython, ['-m', 'venv', SLIM_PYTHON_DIR], { timeout: 60000 });

  const isMac = process.platform === 'darwin';
  if (isMac) {
    send('setup-progress', { percent: 25, status: 'Installing PyTorch (MPS for Apple Silicon)...', detail: 'Downloading ~500 MB' });
    await runCommand(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--no-warn-script-location'], { timeout: 600000 });
  } else {
    let hasNvidia = false;
    try { execSync('nvidia-smi', { stdio: 'ignore', timeout: 5000 }); hasNvidia = true; } catch {}

    if (hasNvidia) {
      send('setup-progress', { percent: 25, status: 'Installing PyTorch with CUDA...', detail: 'Downloading ~2.5 GB' });
      await runCommand(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu124', '--no-warn-script-location'], { timeout: 600000 });
    } else {
      send('setup-progress', { percent: 25, status: 'Installing PyTorch (CPU)...', detail: 'Downloading ~200 MB' });
      await runCommand(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cpu', '--no-warn-script-location'], { timeout: 600000 });
    }
  }

  send('setup-progress', { percent: 70, status: 'Installing processing tools...' });
  const reqDir = appDir;
  const reqPath = path.join(reqDir, 'python', 'requirements.txt');
  await runCommand(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', '-r', reqPath,
    '--extra-index-url', 'https://abetlen.github.io/llama-cpp-python/whl/cpu',
    '--prefer-binary', '--no-warn-script-location'], { timeout: 600000 });
}

function needsSlimSetup(IS_SLIM, SLIM_PYTHON_EXE) {
  return IS_SLIM && !fs.existsSync(SLIM_PYTHON_EXE);
}

module.exports = {
  runSlimSetup,
  needsSlimSetup
};
