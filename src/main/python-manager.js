const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

let pythonProcess = null;
let pythonInfo = null;
let PYTHON_PORT = 8765;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  const ports = [startPort, startPort + 1, startPort + 2, startPort + 10, startPort + 100];
  for (const port of ports) {
    if (await isPortAvailable(port)) return port;
  }
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('listening', () => {
      const address = server.address();
      const allocatedPort = address ? address.port : startPort;
      server.close(() => resolve(allocatedPort));
    });
    server.once('error', () => {
      resolve(startPort);
    });
    server.listen(0, '127.0.0.1');
  });
}

function findPython(options) {
  const { BUNDLED_PYTHON, DEV_PYTHON, SLIM_PYTHON_EXE } = options;

  const preparedPython = BUNDLED_PYTHON || DEV_PYTHON;
  if (preparedPython && fs.existsSync(preparedPython)) {
    try {
      const result = execSync(`"${preparedPython}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result.includes('Python 3.')) {
        return { cmd: preparedPython, args: [], version: result + ' (bundled)' };
      }
    } catch {}
  }

  if (fs.existsSync(SLIM_PYTHON_EXE)) {
    try {
      const result = execSync(`"${SLIM_PYTHON_EXE}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result.includes('Python 3.')) {
        return { cmd: SLIM_PYTHON_EXE, args: [], version: result + ' (auto-installed)' };
      }
    } catch {}
  }

  const isWin = process.platform === 'win32';

  if (isWin) {
    let installed = null;
    try {
      const list = execSync('py --list', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      installed = [...list.matchAll(/-V:(\d+\.\d+)/g)].map((m) => m[1]);
    } catch { installed = null; }
    for (const ver of ['3.13', '3.12', '3.11', '3.10']) {
      if (installed && !installed.includes(ver)) continue;
      try {
        const result = execSync(`py -${ver} --version`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (result.includes('Python 3.')) {
          return { cmd: 'py', args: [`-${ver}`], version: result };
        }
      } catch {}
    }
  }

  const cmds = isWin ? ['python'] : ['python3', 'python'];
  for (const cmd of cmds) {
    try {
      const result = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const match = result.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1]);
        const minor = parseInt(match[2]);
        if (major === 3 && minor >= 10) {
          return { cmd, args: [], version: result };
        }
      }
    } catch {}
  }

  return null;
}

function startPythonServer(options, SHUTDOWN_TOKEN, getMainWindow) {
  pythonInfo = findPython(options);

  if (!pythonInfo) {
    return Promise.reject(new Error(
      'No compatible Python found.\n\n' +
      'Install Python 3.10-3.13 from https://python.org/downloads\n' +
      'Python 3.14+ is not yet compatible with PyTorch.'
    ));
  }

  console.log(`Using ${pythonInfo.version} (${pythonInfo.cmd} ${pythonInfo.args.join(' ')})`);

  const vMatch = pythonInfo.version.match(/Python 3\.(\d+)/);
  if (vMatch && parseInt(vMatch[1]) >= 14) {
    console.warn('WARNING: Python 3.14+ may not be compatible with PyTorch');
  }

  const { isPackaged, appDir } = options;
  const serverScript = path.join(appDir, 'python', 'server.py');
  const pythonCwd = path.join(appDir, 'python');
  
  pythonProcess = spawn(
    pythonInfo.cmd,
    [...pythonInfo.args, serverScript, '--port', PYTHON_PORT.toString(), '--token', SHUTDOWN_TOKEN],
    {
      cwd: pythonCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: [pythonCwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        // Lets the backend cache downloaded LLM models under the app's userData
        // dir (same location Electron uses), so they persist and stay offline.
        ...(options.userDataDir ? { MUXMELT_DATA_DIR: options.userDataDir } : {})
      }
    }
  );

  pythonProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    console.log(`[Python] ${msg}`);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  });

  pythonProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    console.error(`[Python] ${msg}`);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  });

  pythonProcess.on('error', (err) => {
    console.error('Failed to start Python process:', err.message);
  });

  // Capture this spawn's handle so the exit guard can tell an unexpected crash
  // apart from a kill we initiated ourselves (restart/quit force-kills exit
  // non-zero, which would otherwise raise a bogus "backend crashed" alert).
  const spawnedProc = pythonProcess;
  spawnedProc.on('exit', (code) => {
    console.log(`Python process exited with code ${code}`);
    if (spawnedProc._intentionalKill) return;
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0 && code !== null) {
      mainWindow.webContents.send('python-crashed', code);
    }
  });

  return waitForServer(SHUTDOWN_TOKEN);
}

function waitForServer(SHUTDOWN_TOKEN, retries = 90) {
  const tokenQuery = SHUTDOWN_TOKEN ? `?token=${encodeURIComponent(SHUTDOWN_TOKEN)}` : '';
  return new Promise((resolve, reject) => {
    const check = (attempt) => {
      const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/health${tokenQuery}`, (res) => {
        // Drain the body so the socket is released, and only treat a 2xx as
        // "ready" — a 500 from a half-initialized server is not ready yet.
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else if (attempt >= retries) {
          reject(new Error(`Python server responded with HTTP ${res.statusCode} after ${retries} seconds`));
        } else {
          setTimeout(() => check(attempt + 1), 1000);
        }
      });
      req.on('error', () => {
        if (attempt >= retries) {
          reject(new Error(`Python server failed to start after ${retries} seconds`));
        } else {
          setTimeout(() => check(attempt + 1), 1000);
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (attempt >= retries) {
          reject(new Error('Python server timed out'));
        } else {
          setTimeout(() => check(attempt + 1), 1000);
        }
      });
    };
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
      const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/shutdown?token=${SHUTDOWN_TOKEN}`, () => {});
      req.on('error', () => {});
      req.setTimeout(800, () => req.destroy());
    } catch {}

    const forceKill = () => {
      try {
        if (proc.killed || proc.exitCode !== null) return;
        if (process.platform === 'win32') {
          // proc.kill() only signals the direct child. uvicorn/torch worker
          // processes (and any ffmpeg the backend spawns) would be orphaned,
          // holding the port and VRAM. taskkill /T tears down the whole tree.
          if (proc.pid) {
            try {
              spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true
              });
            } catch {
              proc.kill();
            }
          }
        } else {
          proc.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (!proc.killed) proc.kill('SIGKILL');
            } catch {}
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
  killPython,
  getPythonPort,
  setPythonPort,
  getPythonInfo
};
