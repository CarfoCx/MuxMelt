const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

let pythonProcess = null;
let pythonInfo = null;
let PYTHON_PORT = 8765;

const MIN_PYTHON_MINOR = 11;
const MAX_PYTHON_MINOR = 13;

function isSupportedPythonVersion(output) {
  const match = String(output || '').match(/Python (\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return major === 3 && minor >= MIN_PYTHON_MINOR && minor <= MAX_PYTHON_MINOR;
}

function isPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close((err) => resolve(!err));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  const ports = [startPort, startPort + 1, startPort + 2, startPort + 10, startPort + 100]
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  for (const port of ports) {
    if (await isPortAvailable(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();
    server.once('listening', () => {
      const address = server.address();
      const allocatedPort = address ? address.port : startPort;
      server.close((err) => {
        if (err) reject(err);
        else resolve(allocatedPort);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
}

function findPython(options) {
  const { BUNDLED_PYTHON, DEV_PYTHON, SLIM_PYTHON_EXE } = options;

  const preparedPython = BUNDLED_PYTHON || DEV_PYTHON;
  if (preparedPython && fs.existsSync(preparedPython)) {
    try {
      const result = execFileSync(preparedPython, ['--version'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (isSupportedPythonVersion(result)) {
        return { cmd: preparedPython, args: [], version: result + ' (bundled)' };
      }
    } catch {}
  }

  if (fs.existsSync(SLIM_PYTHON_EXE)) {
    try {
      const result = execFileSync(SLIM_PYTHON_EXE, ['--version'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (isSupportedPythonVersion(result)) {
        return { cmd: SLIM_PYTHON_EXE, args: [], version: result + ' (auto-installed)' };
      }
    } catch {}
  }

  const isWin = process.platform === 'win32';

  if (isWin) {
    let installed = null;
    try {
      const list = execFileSync('py', ['--list'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      });
      installed = [...list.matchAll(/-V:(\d+\.\d+)/g)].map((m) => m[1]);
    } catch { installed = null; }
    for (const ver of ['3.13', '3.12', '3.11']) {
      if (installed && !installed.includes(ver)) continue;
      try {
        const result = execFileSync('py', [`-${ver}`, '--version'], {
          encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (isSupportedPythonVersion(result)) {
          return { cmd: 'py', args: [`-${ver}`], version: result };
        }
      } catch {}
    }
  }

  const cmds = isWin
    ? ['python']
    : ['python3.13', 'python3.12', 'python3.11', 'python3', 'python'];
  for (const cmd of cmds) {
    try {
      const result = execFileSync(cmd, ['--version'], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (isSupportedPythonVersion(result)) {
        return { cmd, args: [], version: result };
      }
    } catch {}
  }

  return null;
}

function startPythonServer(options, SHUTDOWN_TOKEN, getMainWindow) {
  if (pythonProcess && pythonProcess.exitCode === null && pythonProcess.signalCode === null) {
    return Promise.reject(new Error('Python backend is already running'));
  }

  pythonInfo = findPython(options);

  if (!pythonInfo) {
    return Promise.reject(new Error(
      'No compatible Python found.\n\n' +
      'Install Python 3.11-3.13 from https://python.org/downloads.\n' +
      'Python 3.10 and 3.14+ are not supported by the current media dependencies.'
    ));
  }

  console.log(`Using ${pythonInfo.version} (${pythonInfo.cmd} ${pythonInfo.args.join(' ')})`);

  const { appDir } = options;
  const serverScript = path.join(appDir, 'python', 'server.py');
  const pythonCwd = path.join(appDir, 'python');
  if (!fs.existsSync(serverScript)) {
    return Promise.reject(new Error(`Python server entry point not found: ${serverScript}`));
  }

  const spawnedProc = spawn(
    pythonInfo.cmd,
    [...pythonInfo.args, serverScript, '--port', PYTHON_PORT.toString(), '--token', SHUTDOWN_TOKEN],
    {
      cwd: pythonCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // On POSIX, give the backend (and every ffmpeg/model worker it starts)
      // an isolated process group so shutdown can reliably reap the whole tree.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PYTHONPATH: [pythonCwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        // Lets the backend cache downloaded LLM models under the app's userData
        // dir (same location Electron uses), so they persist and stay offline.
        ...(options.userDataDir ? { MUXMELT_DATA_DIR: options.userDataDir } : {})
      }
    }
  );
  pythonProcess = spawnedProc;

  spawnedProc.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (!msg) return;
    console.log(`[Python] ${msg}`);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  });

  spawnedProc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (!msg) return;
    console.error(`[Python] ${msg}`);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  });

  spawnedProc.on('error', (err) => {
    console.error('Failed to start Python process:', err.message);
  });

  // Capture this spawn's handle so the exit guard can tell an unexpected crash
  // apart from a kill we initiated ourselves (restart/quit force-kills exit
  // non-zero, which would otherwise raise a bogus "backend crashed" alert).
  spawnedProc.on('exit', (code, signal) => {
    console.log(`Python process exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
    if (pythonProcess === spawnedProc) pythonProcess = null;
    if (spawnedProc._intentionalKill) return;
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-crashed', code === null ? signal : code);
    }
  });

  return waitForServer(SHUTDOWN_TOKEN, 90, spawnedProc);
}

function waitForServer(SHUTDOWN_TOKEN, retries = 90, watchedProcess = pythonProcess) {
  const tokenQuery = SHUTDOWN_TOKEN ? `?token=${encodeURIComponent(SHUTDOWN_TOKEN)}` : '';
  const maxAttempts = Number.isInteger(retries) && retries > 0 ? retries : 1;

  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer = null;
    let activeRequest = null;

    const cleanup = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (activeRequest && !activeRequest.destroyed) activeRequest.destroy();
      activeRequest = null;
      if (watchedProcess) {
        watchedProcess.removeListener('error', onProcessError);
        watchedProcess.removeListener('exit', onProcessExit);
      }
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(message instanceof Error ? message : new Error(message));
    };

    function onProcessError(err) {
      fail(new Error(`Failed to start Python process: ${err.message}`));
    }

    function onProcessExit(code, signal) {
      if (watchedProcess && watchedProcess._intentionalKill) {
        fail(new Error('Python startup was cancelled'));
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      fail(new Error(`Python process exited before becoming ready (${reason})`));
    }

    const check = (attempt) => {
      if (settled) return;
      let attemptFinished = false;

      const retryOrFail = (message) => {
        if (attemptFinished || settled) return;
        attemptFinished = true;
        if (activeRequest && !activeRequest.destroyed) activeRequest.destroy();
        activeRequest = null;

        if (attempt + 1 >= maxAttempts) {
          fail(`${message} after ${maxAttempts} attempts`);
        } else {
          retryTimer = setTimeout(() => check(attempt + 1), 1000);
        }
      };

      const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/health${tokenQuery}`, (res) => {
        // Drain the body so the socket is released, and only treat a 2xx as
        // "ready" — a 500 from a half-initialized server is not ready yet.
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          attemptFinished = true;
          activeRequest = null;
          succeed();
        } else {
          retryOrFail(`Python server responded with HTTP ${res.statusCode}`);
        }
      });
      activeRequest = req;
      req.on('error', (err) => {
        retryOrFail(`Python server health check failed: ${err.message}`);
      });
      req.setTimeout(2000, () => {
        retryOrFail('Python server health check timed out');
      });
    };

    if (watchedProcess) {
      if (watchedProcess.exitCode !== null || watchedProcess.signalCode !== null) {
        onProcessExit(watchedProcess.exitCode, watchedProcess.signalCode);
        return;
      }
      watchedProcess.once('error', onProcessError);
      watchedProcess.once('exit', onProcessExit);
    }
    check(0);
  });
}

function killPython(SHUTDOWN_TOKEN, immediate = false) {
  if (pythonProcess) {
    const proc = pythonProcess;
    pythonProcess = null;
    // We are killing this on purpose — suppress the exit handler's crash alert.
    proc._intentionalKill = true;

    try {
      const req = http.get(
        `http://127.0.0.1:${PYTHON_PORT}/shutdown?token=${encodeURIComponent(SHUTDOWN_TOKEN || '')}`,
        (res) => res.resume()
      );
      req.on('error', () => {});
      req.setTimeout(800, () => req.destroy());
    } catch {}

    const forceKill = () => {
      try {
        if (process.platform === 'win32') {
          // proc.kill() only signals the direct child. uvicorn/torch worker
          // processes (and any ffmpeg the backend spawns) would be orphaned,
          // holding the port and VRAM. taskkill /T tears down the whole tree.
          if (proc.pid) {
            const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true
              });
            // spawn failures arrive asynchronously; without this listener they
            // become uncaught errors in the Electron main process.
            killer.once('error', () => {
              try { proc.kill(); } catch {}
            });
          }
        } else {
          if (!proc.pid) return;
          // The direct Python process may already have honored /shutdown while
          // ffmpeg or Demucs descendants are still running, so signal the
          // isolated group even when the direct child's exitCode is populated.
          try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
          setTimeout(() => {
            try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
          }, 1000);
        }
      } catch {}
    };

    if (immediate) {
      forceKill();
    } else {
      setTimeout(forceKill, 1000);
    }
  }
}

function getPythonPort() {
  return PYTHON_PORT;
}

function setPythonPort(port) {
  PYTHON_PORT = port;
}

function getPythonInfo() {
  return pythonInfo;
}

module.exports = {
  isPortAvailable,
  findAvailablePort,
  findPython,
  startPythonServer,
  waitForServer,
  killPython,
  getPythonPort,
  setPythonPort,
  getPythonInfo
};
