const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

function setupCancelledError() {
  const error = new Error('Setup cancelled');
  error.code = 'SETUP_CANCELLED';
  return error;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(setupCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Long-running installs (PyTorch alone can take 10 minutes) must not use
// synchronous process execution: that freezes the main process, so the setup window stops
// receiving progress events and the retry/close handlers can't fire.
function runCommand(cmd, args, { timeout, cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let stderr = '';
    let settled = false;
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const terminate = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        });
        killer.once('error', () => {
          try { proc.kill(); } catch {}
        });
      } else {
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
          else proc.kill('SIGTERM');
        } catch {
          try { proc.kill('SIGTERM'); } catch {}
        }
        const forceTimer = setTimeout(() => {
          try {
            // The group leader may exit on SIGTERM while a pip/compiler child
            // ignores it. Always target the process group after the grace
            // period; ESRCH simply means every descendant already exited.
            if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
            else if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
          } catch {}
        }, 1000);
        forceTimer.unref();
      }
    };

    let timer = null;
    const onAbort = () => {
      terminate();
      finish(setupCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeout) {
      timer = setTimeout(() => {
        terminate();
        finish(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }
    proc.on('error', (err) => {
      finish(err);
    });
    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
    });
  });
}

function downloadFile(url, destination, options = {}) {
  const {
    timeout = 60000,
    maxBytes = 100 * 1024 * 1024,
    maxRedirects = 5,
    onProgress,
    signal
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    let settled = false;
    let activeRequest = null;
    let output = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (activeRequest && !activeRequest.destroyed) activeRequest.destroy();
      if (output) output.destroy();
      try { fs.rmSync(destination, { force: true }); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const requestUrl = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        fail(new Error(`Invalid download URL: ${currentUrl}`));
        return;
      }
      if (parsed.protocol !== 'https:') {
        fail(new Error('Refusing to download setup files over a non-HTTPS connection'));
        return;
      }

      const request = https.get(parsed, (res) => {
        const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);
        if (isRedirect) {
          const location = res.headers.location;
          res.resume();
          if (!location || redirectsLeft <= 0) {
            fail(new Error('Setup download exceeded the redirect limit'));
            return;
          }
          try {
            requestUrl(new URL(location, parsed).href, redirectsLeft - 1);
          } catch (err) {
            fail(new Error(`Setup download returned an invalid redirect: ${err.message}`));
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Setup download failed: HTTP ${res.statusCode}`));
          return;
        }

        const declaredSize = Number(res.headers['content-length'] || 0);
        if (declaredSize > maxBytes) {
          res.resume();
          fail(new Error(`Setup download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`));
          return;
        }

        let downloaded = 0;
        output = fs.createWriteStream(destination, { mode: 0o600 });
        output.once('error', fail);
        res.once('error', fail);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (downloaded > maxBytes) {
            res.destroy(new Error('Setup download exceeded its size limit'));
            return;
          }
          if (typeof onProgress === 'function') {
            try {
              onProgress(downloaded, declaredSize);
            } catch (err) {
              res.destroy(err);
            }
          }
        });
        output.once('finish', () => {
          output.close((err) => {
            if (err) {
              fail(err);
              return;
            }
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        res.pipe(output);
      });
      activeRequest = request;
      request.once('error', fail);
      request.setTimeout(timeout, () => {
        request.destroy(new Error('Setup download timed out'));
      });
    };

    const onAbort = () => fail(setupCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    requestUrl(url, maxRedirects);
  });
}

async function runSlimSetup(options) {
  const { appDir, IS_WIN, SLIM_SETUP_MARKER } = options;
  const setupAbort = new AbortController();
  if (SLIM_SETUP_MARKER) {
    fs.rmSync(SLIM_SETUP_MARKER, { force: true });
  }
  const setupWindow = new BrowserWindow({
    width: 540,
    height: 340,
    resizable: false,
    // A failed/offline first-time setup must never trap the user in an
    // always-on-top window. Alt+F4 / Cmd+W remains available even though the
    // window is frameless, and the error UI also exposes an explicit Quit.
    closable: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(appDir, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false
    },
    backgroundColor: '#0f0f1a'
  });
  const setupContents = setupWindow.webContents;
  const cancelSetup = () => {
    if (!setupAbort.signal.aborted) setupAbort.abort();
  };
  const cancelFromRenderer = (event) => {
    if (event.sender !== setupContents) return;
    cancelSetup();
    if (!setupWindow.isDestroyed()) setupWindow.close();
  };
  const cancelFromWindow = () => cancelSetup();

  // These handlers remain active for the entire setup lifecycle, including
  // downloads, extraction, pip installs, failure/retry, and the success delay.
  ipcMain.on('setup-cancel', cancelFromRenderer);
  setupWindow.on('closed', cancelFromWindow);

  setupContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupContents.on('will-navigate', (event) => event.preventDefault());
  setupContents.on('will-redirect', (event) => event.preventDefault());

  try {
    await setupWindow.loadFile(path.join(appDir, 'renderer', 'setup.html'));
    if (setupWindow.isDestroyed()) throw new Error('Setup window closed before loading');
    setupWindow.show();
    setupWindow.moveTop();

    const send = (channel, data) => {
      if (!setupWindow.isDestroyed() && !setupContents.isDestroyed()) {
        setupContents.send(channel, data);
      }
    };

    while (true) {
      try {
        if (IS_WIN) {
          await runSlimSetupWindows(send, { ...options, setupSignal: setupAbort.signal });
        } else {
          await runSlimSetupUnix(send, { ...options, setupSignal: setupAbort.signal });
        }

        const markerPath = SLIM_SETUP_MARKER || path.join(options.SLIM_PYTHON_DIR, '.setup-complete');
        fs.writeFileSync(markerPath, JSON.stringify({ completedAt: new Date().toISOString() }), {
          encoding: 'utf8', mode: 0o600
        });
        send('setup-progress', { percent: 100, status: 'Setup complete!' });
        send('setup-complete');
        await abortableDelay(1500, setupAbort.signal);
        if (!setupWindow.isDestroyed()) setupWindow.destroy();
        return;
      } catch (err) {
        send('setup-error', `Setup failed: ${err.message}`);
        if (setupWindow.isDestroyed()) throw err;

        try {
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              ipcMain.removeListener('setup-retry', retryHandler);
              setupAbort.signal.removeEventListener('abort', cancelHandler);
            };
            const retryHandler = (event) => {
              if (event.sender !== setupContents) return;
              cleanup();
              resolve();
            };
            const cancelHandler = () => {
              cleanup();
              reject(setupCancelledError());
            };
            ipcMain.on('setup-retry', retryHandler);
            setupAbort.signal.addEventListener('abort', cancelHandler, { once: true });
            if (setupAbort.signal.aborted) cancelHandler();
          });
          send('setup-progress', { percent: 0, status: 'Retrying...' });
          await abortableDelay(300, setupAbort.signal);
        } catch (waitError) {
          if (waitError && waitError.code === 'SETUP_CANCELLED') throw waitError;
          throw err;
        }
      }
    }
  } catch (err) {
    if (!setupWindow.isDestroyed()) setupWindow.destroy();
    if (setupAbort.signal.aborted && (!err || err.code !== 'SETUP_CANCELLED')) {
      throw setupCancelledError();
    }
    throw err;
  } finally {
    ipcMain.removeListener('setup-cancel', cancelFromRenderer);
    setupWindow.removeListener('closed', cancelFromWindow);
  }
}

async function runSlimSetupWindows(send, options) {
  const {
    appDir, pythonAppDir = appDir, SLIM_PYTHON_DIR, SLIM_PYTHON_EXE,
    setupSignal,
  } = options;
  const run = (cmd, args, runOptions = {}) => (
    runCommand(cmd, args, { ...runOptions, signal: setupSignal })
  );
  const download = (url, destination, downloadOptions = {}) => (
    downloadFile(url, destination, { ...downloadOptions, signal: setupSignal })
  );
  const PYTHON_VERSION = '3.13.0';
  const pythonArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${pythonArch}.zip`;
  const zipPath = path.join(app.getPath('temp'), `muxmelt-python-embed-${process.pid}.zip`);

  send('setup-progress', { percent: 5, status: 'Downloading Python...', detail: PYTHON_URL });
  await download(PYTHON_URL, zipPath, {
    maxBytes: 50 * 1024 * 1024,
    onProgress: (downloaded, total) => {
      if (total > 0) {
        send('setup-progress', {
          percent: 5 + Math.round((downloaded / total) * 20),
          status: 'Downloading Python...',
          detail: `${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
        });
      }
    }
  });

  send('setup-progress', { percent: 28, status: 'Extracting Python...' });
  fs.mkdirSync(SLIM_PYTHON_DIR, { recursive: true });
  const unzipScript = `import zipfile; zipfile.ZipFile(${JSON.stringify(zipPath)}).extractall(${JSON.stringify(SLIM_PYTHON_DIR)})`;
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  try {
    try {
      const command = `Expand-Archive -Force -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(SLIM_PYTHON_DIR)}`;
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 60000 });
    } catch {
      try {
        await run('python', ['-c', unzipScript], { timeout: 60000 });
      } catch {
        await run('python3', ['-c', unzipScript], { timeout: 60000 });
      }
    }
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  const pthFiles = fs.readdirSync(SLIM_PYTHON_DIR).filter(f => f.endsWith('._pth'));
  for (const pth of pthFiles) {
    const p = path.join(SLIM_PYTHON_DIR, pth);
    let c = fs.readFileSync(p, 'utf-8');
    c = c.replace('#import site', 'import site');
    if (!c.includes('Lib/site-packages')) c += '\nLib/site-packages\n';
    const pythonModuleDir = path.join(pythonAppDir, 'python');
    if (!c.includes(pythonModuleDir)) c += `\n${pythonModuleDir}\n`;
    fs.writeFileSync(p, c);
  }

  send('setup-progress', { percent: 35, status: 'Installing pip...' });
  const getPipPath = path.join(SLIM_PYTHON_DIR, 'get-pip.py');
  await download('https://bootstrap.pypa.io/get-pip.py', getPipPath, {
    maxBytes: 10 * 1024 * 1024
  });
  try {
    await run(SLIM_PYTHON_EXE, ['get-pip.py', '--no-warn-script-location'], { cwd: SLIM_PYTHON_DIR, timeout: 120000 });
  } finally {
    fs.rmSync(getPipPath, { force: true });
  }

  let hasNvidia = false;
  try {
    execFileSync('nvidia-smi', [], { stdio: 'ignore', timeout: 5000 });
    hasNvidia = true;
  } catch {}
  const torchIndex = hasNvidia
    ? 'https://download.pytorch.org/whl/cu124'
    : 'https://download.pytorch.org/whl/cpu';
  send('setup-progress', {
    percent: 40,
    status: hasNvidia ? 'Installing PyTorch with CUDA...' : 'Installing PyTorch (CPU)...',
    detail: hasNvidia ? 'Downloading ~2.5 GB' : 'Downloading ~200 MB'
  });
  await run(SLIM_PYTHON_EXE, [
    '-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio',
    '--index-url', torchIndex, '--no-warn-script-location'
  ], { timeout: 600000 });

  send('setup-progress', { percent: 75, status: 'Installing processing tools...' });
  const reqPath = path.join(pythonAppDir, 'python', 'requirements.txt');
  await run(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', '-r', reqPath,
    '--extra-index-url', 'https://abetlen.github.io/llama-cpp-python/whl/cpu',
    '--prefer-binary', '--no-warn-script-location'], { timeout: 600000 });
}

async function runSlimSetupUnix(send, options) {
  const {
    appDir, pythonAppDir = appDir, SLIM_PYTHON_DIR, SLIM_PYTHON_EXE,
    setupSignal,
  } = options;
  const run = (cmd, args, runOptions = {}) => (
    runCommand(cmd, args, { ...runOptions, signal: setupSignal })
  );

  send('setup-progress', { percent: 5, status: 'Checking Python...' });

  let systemPython = null;
  for (const cmd of ['python3.13', 'python3.12', 'python3.11', 'python3', 'python']) {
    try {
      const result = execFileSync(cmd, ['--version'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const match = result.match(/Python (\d+)\.(\d+)/);
      const minor = match ? Number.parseInt(match[2], 10) : 0;
      if (match && Number.parseInt(match[1], 10) === 3 && minor >= 11 && minor <= 13) {
        systemPython = cmd;
        break;
      }
    } catch {}
  }

  if (!systemPython) {
    const isMac = process.platform === 'darwin';
    throw new Error(
      'Python 3.11 through 3.13 is required.\n\n' +
      (isMac
        ? 'Install from https://python.org/downloads or: brew install python@3.12'
        : 'Install a supported version from https://python.org/downloads (Python 3.12 is recommended).')
    );
  }

  send('setup-progress', { percent: 10, status: 'Creating Python environment...', detail: systemPython });
  fs.mkdirSync(SLIM_PYTHON_DIR, { recursive: true });
  await run(systemPython, ['-m', 'venv', SLIM_PYTHON_DIR], { timeout: 60000 });

  const isMac = process.platform === 'darwin';
  if (isMac) {
    send('setup-progress', { percent: 25, status: 'Installing PyTorch (MPS for Apple Silicon)...', detail: 'Downloading ~500 MB' });
    await run(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--no-warn-script-location'], { timeout: 600000 });
  } else {
    let hasNvidia = false;
    try {
      execFileSync('nvidia-smi', [], { stdio: 'ignore', timeout: 5000 });
      hasNvidia = true;
    } catch {}

    if (hasNvidia) {
      send('setup-progress', { percent: 25, status: 'Installing PyTorch with CUDA...', detail: 'Downloading ~2.5 GB' });
      await run(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu124', '--no-warn-script-location'], { timeout: 600000 });
    } else {
      send('setup-progress', { percent: 25, status: 'Installing PyTorch (CPU)...', detail: 'Downloading ~200 MB' });
      await run(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cpu', '--no-warn-script-location'], { timeout: 600000 });
    }
  }

  send('setup-progress', { percent: 70, status: 'Installing processing tools...' });
  const reqPath = path.join(pythonAppDir, 'python', 'requirements.txt');
  await run(SLIM_PYTHON_EXE, ['-m', 'pip', 'install', '-r', reqPath,
    '--extra-index-url', 'https://abetlen.github.io/llama-cpp-python/whl/cpu',
    '--prefer-binary', '--no-warn-script-location'], { timeout: 600000 });
}

function hasCompleteEnvironment(pythonExe) {
  try {
    const version = execFileSync(pythonExe, ['--version'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const match = version.match(/Python (\d+)\.(\d+)/);
    const major = match ? Number.parseInt(match[1], 10) : 0;
    const minor = match ? Number.parseInt(match[2], 10) : 0;
    if (major !== 3 || minor < 11 || minor > 13) return false;
  } catch {
    return false;
  }

  const envRoot = process.platform === 'win32'
    ? path.dirname(pythonExe)
    : path.dirname(path.dirname(pythonExe));
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(envRoot, 'Lib', 'site-packages'));
  } else {
    const libDir = path.join(envRoot, 'lib');
    try {
      for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('python')) {
          candidates.push(path.join(libDir, entry.name, 'site-packages'));
        }
      }
    } catch {}
  }

  const requiredPackages = [
    'torch', 'fastapi', 'demucs', 'rembg', 'onnxruntime',
    'edge_tts', 'yt_dlp', 'llama_cpp'
  ];
  return candidates.some((sitePackages) => {
    return requiredPackages.every((packageName) => fs.existsSync(path.join(sitePackages, packageName)));
  });
}

function needsSlimSetup(IS_SLIM, SLIM_PYTHON_EXE, setupMarker) {
  if (!IS_SLIM) return false;
  if (!fs.existsSync(SLIM_PYTHON_EXE)) return true;
  if (!setupMarker) return false;
  if (fs.existsSync(setupMarker)) return !hasCompleteEnvironment(SLIM_PYTHON_EXE);

  // Older releases did not create a completion marker. Avoid forcing those
  // users through a multi-gigabyte reinstall when the full dependency set is
  // already present, while still retrying genuinely partial installations.
  if (hasCompleteEnvironment(SLIM_PYTHON_EXE)) {
    try {
      fs.writeFileSync(setupMarker, JSON.stringify({ migratedAt: new Date().toISOString() }), {
        encoding: 'utf8', mode: 0o600
      });
    } catch {}
    return false;
  }
  return true;
}

module.exports = {
  runSlimSetup,
  needsSlimSetup
};
