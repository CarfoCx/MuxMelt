const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

let pythonProcess = null;
let pythonInfo = null;
let PYTHON_PORT = 8765;
let backendLogPath = null;
let backendLogQueue = Promise.resolve();

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

  // Packaged builds must only execute the interpreter shipped with the app or
  // the managed optional media pack. Falling back to PATH could load arbitrary
  // user-site packages/sitecustomize code and escape the app's storage and
  // dependency boundary. Development keeps the convenient system fallback.
  if (options.isPackaged) return null;

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
  if (typeof SHUTDOWN_TOKEN !== 'string' || !/^[a-f0-9]{64}$/i.test(SHUTDOWN_TOKEN)) {
    return Promise.reject(new Error('The local backend authentication token is invalid'));
  }

  pythonInfo = findPython(options);

  if (!pythonInfo) {
    return Promise.reject(new Error(
      options.isPackaged
        ? 'The managed local media runtime is missing or unsupported. Open Settings → Components and choose Install or Repair; reinstall MuxMelt if the bundled runtime is damaged.'
        : 'No compatible Python found.\n\n' +
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

  const managedCacheDir = options.userDataDir
    ? path.join(options.userDataDir, 'cache')
    : null;
  const managedModelsDir = options.userDataDir
    ? path.join(options.userDataDir, 'models')
    : null;
  if (managedCacheDir) fs.mkdirSync(managedCacheDir, { recursive: true, mode: 0o700 });
  if (managedModelsDir) fs.mkdirSync(managedModelsDir, { recursive: true, mode: 0o700 });

  if (options.userDataDir) {
    const logDir = path.join(options.userDataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    backendLogPath = path.join(logDir, 'backend.log');
    try {
      const stat = fs.statSync(backendLogPath);
      if (stat.size > 512 * 1024) {
        const previousPath = path.join(logDir, 'backend.previous.log');
        fs.rmSync(previousPath, { force: true });
        fs.renameSync(backendLogPath, previousPath);
      }
    } catch {}
  }

  const appendBackendLog = (level, message) => {
    if (!backendLogPath) return;
    const homePath = process.env.USERPROFILE || process.env.HOME || '';
    let redacted = String(message || '');
    for (const [sensitiveValue, replacement] of [
      [SHUTDOWN_TOKEN, '[redacted-token]'],
      [options.userDataDir, '[app-data]'],
      [homePath, '[home]']
    ]) {
      if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, replacement);
    }
    redacted = redacted
      .replace(/(["'])(?:[A-Za-z]:\\|\/)[^"'\r\n]+\1/g, '$1[local-path]$1')
      .replace(/\\\\[^\\\s"']+\\[^\s"']+/g, '[local-path]')
      .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[local-path]')
      .replace(/(^|[\s(=])\/(?!\/)[^\s"'<>]+/g, '$1[local-path]');
    redacted = redacted.slice(0, 8000);
    const line = `${new Date().toISOString()} ${level} ${redacted}\n`;
    const targetPath = backendLogPath;
    // Serialize asynchronous writes across restarts so noisy backend output
    // cannot block Electron's UI thread or race rotation on the same files.
    backendLogQueue = backendLogQueue.catch(() => {}).then(async () => {
      const logDir = path.dirname(targetPath);
      await fs.promises.mkdir(logDir, { recursive: true, mode: 0o700 });
      let currentBytes = 0;
      try { currentBytes = (await fs.promises.stat(targetPath)).size; } catch {}
      if (currentBytes + Buffer.byteLength(line, 'utf8') > 512 * 1024) {
        const previousPath = path.join(logDir, 'backend.previous.log');
        await fs.promises.rm(previousPath, { force: true });
        try { await fs.promises.rename(targetPath, previousPath); } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      await fs.promises.appendFile(targetPath, line, { encoding: 'utf8', mode: 0o600 });
    });
  };

  const spawnedProc = spawn(
    pythonInfo.cmd,
    [
      ...pythonInfo.args,
      serverScript,
      '--port', PYTHON_PORT.toString(),
      '--parent-pid', String(process.pid)
    ],
    {
      cwd: pythonCwd,
      // Pass the bearer secret over an inherited pipe, never argv (which is
      // exposed by process listings and /proc/<pid>/cmdline on many systems).
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX, give the backend (and every ffmpeg/model worker it starts)
      // an isolated process group so shutdown can reliably reap the whole tree.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PYTHONPATH: [pythonCwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        // Lets the backend cache downloaded LLM models under the app's userData
        // dir (same location Electron uses), so they persist and stay offline.
        ...(options.userDataDir ? { MUXMELT_DATA_DIR: options.userDataDir } : {}),
        ...(managedCacheDir ? {
          XDG_CACHE_HOME: managedCacheDir,
          TORCH_HOME: path.join(managedCacheDir, 'torch'),
          HF_HOME: path.join(managedCacheDir, 'huggingface')
        } : {}),
        ...(managedModelsDir ? {
          U2NET_HOME: path.join(managedModelsDir, 'rembg')
        } : {}),
        MUXMELT_OFFLINE: options.offline ? '1' : '0'
      }
    }
  );
  pythonProcess = spawnedProc;
  // Do not send the bearer token to the selected TCP port until this exact
  // child proves on its inherited stdout pipe that it successfully bound the
  // listener. This closes the free-port-check/bind race where another local
  // process could otherwise receive the first authenticated health request.
  const expectedReadinessProof = crypto
    .createHmac('sha256', SHUTDOWN_TOKEN)
    .update(`muxmelt-ready-v1:${PYTHON_PORT}`)
    .digest('hex');
  spawnedProc._readinessProof = false;
  if (spawnedProc.stdin) {
    spawnedProc.stdin.on('error', () => {});
    spawnedProc.stdin.end(`${SHUTDOWN_TOKEN}\n`);
  }

  let stdoutBuffer = '';
  const handleStdoutLine = (line) => {
    const msg = String(line || '').trim();
    if (!msg) return;
    const readiness = /^MUXMELT_READY ([a-f0-9]{64})$/i.exec(msg);
    if (readiness) {
      const provided = Buffer.from(readiness[1], 'hex');
      const expected = Buffer.from(expectedReadinessProof, 'hex');
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        spawnedProc._readinessProof = true;
        spawnedProc.emit('muxmelt-ready');
      } else {
        spawnedProc.emit('muxmelt-ready-invalid');
      }
      return;
    }
    console.log(`[Python] ${msg}`);
    appendBackendLog('INFO', msg);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-log', msg);
    }
  };

  spawnedProc.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      handleStdoutLine(stdoutBuffer.slice(0, newline).replace(/\r$/, ''));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  spawnedProc.stdout.on('end', () => {
    if (stdoutBuffer) handleStdoutLine(stdoutBuffer);
    stdoutBuffer = '';
  });

  spawnedProc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (!msg) return;
    console.error(`[Python] ${msg}`);
    appendBackendLog('ERROR', msg);
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
    if (!spawnedProc._intentionalKill && process.platform !== 'win32' && spawnedProc.pid) {
      // The Python leader is gone, but its isolated POSIX process group may
      // still contain ffmpeg/model workers. Reap the surviving group.
      try { process.kill(-spawnedProc.pid, 'SIGTERM'); } catch {}
      const reapTimer = setTimeout(() => {
        try { process.kill(-spawnedProc.pid, 'SIGKILL'); } catch {}
      }, 1000);
      if (typeof reapTimer.unref === 'function') reapTimer.unref();
    }
    if (pythonProcess === spawnedProc) {
      pythonProcess = null;
      pythonInfo = null;
    }
    if (spawnedProc._intentionalKill) return;
    if (typeof options.onExit === 'function') {
      try { options.onExit({ code, signal }); } catch {}
    }
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-crashed', code === null ? signal : code);
    }
  });

  return waitForServer(SHUTDOWN_TOKEN, 90, spawnedProc, options.startupSignal).catch(async (err) => {
    // A readiness failure must not leave a late-starting or unhealthy backend
    // behind for the next retry to mistake as usable.
    if (pythonProcess === spawnedProc) await killPython(SHUTDOWN_TOKEN, true);
    throw err;
  });
}

function waitForServer(SHUTDOWN_TOKEN, retries = 90, watchedProcess = pythonProcess, startupSignal = null) {
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
        watchedProcess.removeListener('muxmelt-ready-invalid', onInvalidReadinessProof);
      }
      if (startupSignal) startupSignal.removeEventListener('abort', onAbort);
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

    function onAbort() {
      const error = new Error('Python startup was cancelled');
      error.code = 'BACKEND_START_CANCELLED';
      fail(error);
    }

    function onInvalidReadinessProof() {
      fail(new Error('The local backend returned an invalid readiness proof'));
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

      // The proof arrives over the child-only stdout pipe after Uvicorn has
      // bound the port. Until then, never disclose the bearer token over HTTP.
      if (watchedProcess && watchedProcess._readinessProof !== true) {
        retryOrFail('Python server did not produce a valid readiness proof');
        return;
      }

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
      watchedProcess.once('muxmelt-ready-invalid', onInvalidReadinessProof);
    }
    if (startupSignal) {
      if (startupSignal.aborted) {
        onAbort();
        return;
      }
      startupSignal.addEventListener('abort', onAbort, { once: true });
    }
    check(0);
  });
}

function waitForProcessExit(proc, timeoutMs = 7000) {
  if (!proc) return Promise.resolve(true);
  const streamsClosed = () => [proc.stdout, proc.stderr]
    .filter(Boolean)
    .every((stream) => stream.destroyed || stream.readableEnded);
  if ((proc.exitCode !== null || proc.signalCode !== null) && streamsClosed()) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      proc.removeListener('exit', onExit);
      proc.removeListener('close', onClose);
      proc.removeListener('error', onError);
      resolve(exited);
    };
    const onExit = () => {
      if (streamsClosed()) finish(true);
    };
    const onClose = () => finish(true);
    const onError = () => {
      if (!proc.pid) finish(true);
    };
    proc.once('exit', onExit);
    proc.once('close', onClose);
    proc.once('error', onError);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (proc.exitCode !== null || proc.signalCode !== null) onExit();
  });
}

function requestAuthenticatedShutdown(proc, shutdownToken) {
  // Until the exact child proves that it owns the selected listener, another
  // local process could have won the port race. Never disclose the bearer
  // token to that untrusted listener; pre-proof shutdown is process-tree only.
  if (!proc || proc._readinessProof !== true
      || proc.exitCode !== null || proc.signalCode !== null) return false;
  try {
    const req = http.get(
      `http://127.0.0.1:${PYTHON_PORT}/shutdown?token=${encodeURIComponent(shutdownToken || '')}`,
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.setTimeout(800, () => req.destroy());
    return true;
  } catch {
    return false;
  }
}

function killPython(SHUTDOWN_TOKEN, immediate = false) {
  if (!pythonProcess) return Promise.resolve({ exited: true });

  const proc = pythonProcess;
  // We are killing this on purpose — suppress the exit handler's crash alert.
  proc._intentionalKill = true;

  requestAuthenticatedShutdown(proc, SHUTDOWN_TOKEN);

  const forceKill = async () => {
    try {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          let settled = false;
          let timer = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve();
          };
          if (!proc.pid) {
            try { proc.kill(); } catch {}
            finish();
            return;
          }
          // taskkill /T waits until the backend and its descendant tree have
          // been targeted, which prevents deletion/restart racing live files.
          const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true
          });
          timer = setTimeout(() => {
            try { killer.kill('SIGKILL'); } catch {}
            // The backend owns a mandatory kill-on-close Job Object on
            // Windows, so terminating its leader also reaps its descendants.
            try { proc.kill('SIGKILL'); } catch {}
            finish();
          }, 5000);
          killer.once('close', finish);
          killer.once('error', () => {
            try { proc.kill(); } catch {}
            finish();
          });
        });
      } else if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      } else {
        try { proc.kill('SIGTERM'); } catch {}
      }
    } catch {}
  };

  return (async () => {
    if (!immediate) await new Promise((resolve) => setTimeout(resolve, 1000));
    const [, exited] = await Promise.all([
      forceKill(),
      waitForProcessExit(proc),
    ]);
    if (exited) {
      if (pythonProcess === proc) pythonProcess = null;
      pythonInfo = null;
      await backendLogQueue.catch(() => {});
    } else {
      proc._intentionalKill = false;
    }
    // Preserve the live handle on timeout. A later stop/removal attempt must
    // retry this exact process instead of treating the orphan as already gone.
    return { exited };
  })();
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

function isPythonRunning() {
  return !!(pythonProcess && pythonProcess.exitCode === null && pythonProcess.signalCode === null);
}

function getBackendLogPath() {
  return backendLogPath;
}

async function flushBackendLogs() {
  await backendLogQueue.catch(() => {});
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
  getPythonInfo,
  isPythonRunning,
  getBackendLogPath,
  flushBackendLogs,
  __test: { requestAuthenticatedShutdown }
};
