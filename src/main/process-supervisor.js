'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

const SUPERVISOR_ENTRY = path.join(__dirname, 'process-supervisor-entry.js');
const CONTROL_MAX_BYTES = 4 * 1024 * 1024;

function normalizeStdio(stdio) {
  if (stdio === undefined || stdio === 'pipe') return ['pipe', 'pipe', 'pipe'];
  if (stdio === 'ignore') return ['ignore', 'ignore', 'ignore'];
  if (stdio === 'inherit') return ['inherit', 'inherit', 'inherit'];
  if (!Array.isArray(stdio)) {
    throw new TypeError('Supervised processes require string or array stdio options');
  }
  return [stdio[0] ?? 'pipe', stdio[1] ?? 'pipe', stdio[2] ?? 'pipe'];
}

function parseStatusStream(proc, stream) {
  if (!stream) {
    proc._markStatusDone?.();
    return;
  }
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer = (buffer + chunk).slice(-CONTROL_MAX_BYTES);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === 'spawned' && Number.isSafeInteger(message.pid) && message.pid > 0) {
          proc.supervisedPid = message.pid;
          proc.supervisedSpawned = true;
        } else if (message.type === 'complete') {
          proc.supervisorCompleted = true;
          proc.supervisorCleanupResult = {
            cleaned: message.cleaned === true,
            reason: typeof message.reason === 'string' ? message.reason : null,
            spawned: message.spawned === true,
          };
        }
      } catch {}
    }
  });
  // A broken status channel must not crash the Electron main process. The
  // supervisor's exit and stderr still carry the operation result.
  stream.on('end', () => proc._markStatusDone?.());
  stream.on('close', () => proc._markStatusDone?.());
  stream.on('error', () => proc._markStatusDone?.());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function posixGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function emergencyTerminateKnownTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { cleaned: false, reason: 'target-pid-unavailable' };
  }
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    const deadline = Date.now() + 1000;
    while (posixGroupAlive(pid) && Date.now() < deadline) await delay(25);
    const cleaned = !posixGroupAlive(pid);
    return { cleaned, reason: cleaned ? null : 'posix-group-survived' };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (cleaned) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ cleaned, reason: cleaned ? null : 'taskkill-unconfirmed' });
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      timer = setTimeout(() => {
        try { killer.kill('SIGKILL'); } catch {}
        finish(false);
      }, 5000);
      killer.once('error', () => finish(false));
      // taskkill /T /F does not exit until its target tree has been processed.
      // A missing root is ambiguous after watchdog failure, so only success is
      // reported as a confirmed cleanup.
      killer.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

function createProcessFacade(rawProc, hooks = null) {
  const proc = new EventEmitter();
  proc.stdin = rawProc.stdin;
  proc.stdout = rawProc.stdout;
  proc.stderr = rawProc.stderr;
  proc.stdio = rawProc.stdio;
  proc.pid = rawProc.pid;
  proc.supervisedPid = null;
  proc.supervisedSpawned = false;
  proc.supervisorCompleted = false;
  proc.supervisorCleanupResult = null;
  proc.cleanupResult = null;
  proc.isMuxMeltSupervisor = true;

  for (const property of ['exitCode', 'signalCode', 'killed']) {
    Object.defineProperty(proc, property, {
      enumerable: true,
      get: () => rawProc[property],
    });
  }
  proc.kill = (signal) => rawProc.kill(signal);
  proc.ref = () => { rawProc.ref(); return proc; };
  proc.unref = () => { rawProc.unref(); return proc; };

  let resolveCleanup;
  proc.cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
  let resolveStatusDone;
  proc._statusDone = new Promise((resolve) => { resolveStatusDone = resolve; });
  proc._markStatusDone = () => {
    if (!resolveStatusDone) return;
    resolveStatusDone();
    resolveStatusDone = null;
  };
  let watchdogSpawned = false;
  let pendingRawError = null;
  rawProc.on('spawn', () => {
    watchdogSpawned = true;
    proc.emit('spawn');
  });
  let watchdogSpawnFailed = false;
  rawProc.on('error', (error) => {
    watchdogSpawnFailed = !watchdogSpawned;
    if (watchdogSpawnFailed) {
      // No watchdog (and therefore no target) could have started. Preserving
      // ChildProcess' immediate spawn-error behavior is safe in this case.
      proc.emit('error', error);
    } else {
      // A post-spawn error is not an owner-visible teardown boundary. Delay it
      // until the watchdog/fallback cleanup result is known so callers cannot
      // remove process tracking while descendants may still be alive.
      pendingRawError = error;
    }
  });
  let cleanupTask = null;
  const finalizeCleanup = () => {
    if (cleanupTask) return cleanupTask;
    cleanupTask = (async () => {
      // fd 3 is owned only by the watchdog. Give its final `complete` record a
      // chance to drain before classifying an otherwise orderly exit as a
      // crash. This does not wait on target-inherited stdout/stderr handles.
      await Promise.race([proc._statusDone, delay(100)]);
      let result = {
        cleaned: proc.supervisorCleanupResult?.cleaned === true,
        orderly: proc.supervisorCompleted,
        reason: proc.supervisorCleanupResult?.reason || null,
        spawned: proc.supervisorCleanupResult?.spawned === true || proc.supervisedSpawned,
      };
      if (!result.cleaned) {
        const cleanup = watchdogSpawnFailed
          ? { cleaned: true, reason: 'watchdog-not-started' }
          : await (hooks?.emergencyCleanup || emergencyTerminateKnownTree)(proc.supervisedPid);
        result = {
          ...cleanup,
          orderly: false,
          spawned: proc.supervisedSpawned,
        };
      }
      proc.cleanupResult = result;
      resolveCleanup(result);
      return result;
    })().catch((error) => {
      const result = {
        cleaned: false,
        orderly: false,
        reason: error?.message || 'cleanup-check-failed',
        spawned: proc.supervisedSpawned,
      };
      proc.cleanupResult = result;
      resolveCleanup(result);
      return result;
    });
    return cleanupTask;
  };
  rawProc.on('exit', (code, signal) => {
    proc.emit('exit', code, signal);
    // Start emergency cleanup on `exit`, not `close`: the real target may have
    // inherited stdout/stderr and can keep raw ChildProcess.close from firing.
    finalizeCleanup().catch(() => {});
  });
  rawProc.on('close', async (code, signal) => {
    await finalizeCleanup();
    // `close` is the public teardown boundary. Callers may remove registry
    // entries or temporary data only after fallback tree cleanup has finished.
    proc.emit('close', code, signal);
    if (pendingRawError) proc.emit('error', pendingRawError);
  });
  return proc;
}

/**
 * Spawn an external command behind a tiny watchdog process.
 *
 * The command and its arguments are delivered over a private stdin pipe, not
 * appended to the watchdog command line. This avoids exposing a second copy of
 * URLs, temporary credential-file paths, or other operation details in process
 * listings. The pipe remains open as a parent-liveness signal and cancellation
 * control channel for the lifetime of the command.
 */
function spawnSupervised(command, args = [], options = {}) {
  if (typeof command !== 'string' || !command) {
    throw new TypeError('The supervised command must be a non-empty string');
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new TypeError('Supervised process arguments must be strings');
  }
  const payload = JSON.stringify({ command, args });
  if (Buffer.byteLength(payload, 'utf8') > CONTROL_MAX_BYTES) {
    throw new Error('Supervised command payload exceeds the safety limit');
  }

  const requestedStdio = normalizeStdio(options.stdio);
  if (requestedStdio[0] !== 'ignore') {
    throw new Error('Supervised tools must not require interactive stdin');
  }

  const targetEnvironment = options.env ? { ...options.env } : { ...process.env };
  const supervisorEnvironment = {
    ...targetEnvironment,
    ELECTRON_RUN_AS_NODE: '1',
    MUXMELT_SUPERVISOR_PARENT_PID: String(process.pid),
  };

  const rawProc = spawn(process.execPath, [SUPERVISOR_ENTRY], {
    cwd: options.cwd,
    env: supervisorEnvironment,
    windowsHide: options.windowsHide !== false,
    // stdin is the private command/control channel; fd 3 is a private status
    // channel. stdout/stderr remain byte-for-byte streams from the real tool.
    stdio: ['pipe', requestedStdio[1], requestedStdio[2], 'pipe'],
  });
  const proc = createProcessFacade(rawProc, options[PROCESS_SUPERVISOR_TEST_HOOK] || null);
  parseStatusStream(proc, proc.stdio && proc.stdio[3]);
  if (proc.stdin) proc.stdin.on('error', () => {});

  proc.requestTreeTermination = (graceMs = 1000) => {
    if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
    const boundedGrace = Math.max(0, Math.min(10000, Number(graceMs) || 0));
    try {
      // Writable.write() returning false means backpressure, not failure; the
      // message is already queued and must not trigger a direct watchdog kill.
      proc.stdin.write(`${JSON.stringify({ type: 'terminate', graceMs: boundedGrace })}\n`);
      return true;
    } catch {
      return false;
    }
  };

  try {
    proc.stdin.write(`${payload}\n`);
  } catch (error) {
    try { proc.kill('SIGTERM'); } catch {}
    throw error;
  }

  return proc;
}

/**
 * Ask the watchdog to terminate its complete owned process tree. Killing the
 * watchdog directly is deliberately a last resort because doing so first could
 * strand the command it owns.
 */
function terminateSupervisedProcess(proc, graceMs = 1000) {
  if (!proc) return false;
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  if (typeof proc.requestTreeTermination === 'function'
      && proc.requestTreeTermination(graceMs)) {
    return true;
  }

  // If the control pipe broke, a live watchdog still handles SIGTERM by
  // cleaning its child tree before exiting.
  try {
    return proc.kill('SIGTERM');
  } catch {
    return false;
  }
}

function supervisedCleanupError(proc, label = 'External process') {
  if (proc?.cleanupResult?.cleaned === true) return null;
  const error = new Error(`${label} process tree cleanup could not be confirmed. Restart MuxMelt before modifying its files.`);
  error.code = 'PROCESS_CLEANUP_FAILED';
  error.cleanupResult = proc?.cleanupResult || null;
  return error;
}

const PROCESS_SUPERVISOR_TEST_HOOK = Symbol('processSupervisorTestHook');

module.exports = {
  spawnSupervised,
  terminateSupervisedProcess,
  supervisedCleanupError,
  __test: { PROCESS_SUPERVISOR_TEST_HOOK },
};
