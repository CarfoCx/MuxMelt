'use strict';

// This file runs in a separate Node-compatible process (Electron with
// ELECTRON_RUN_AS_NODE=1 in production). Keep it dependency-free and small:
// its only job is to own one external process tree and reap it if Electron dies.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 1000;
const FORCE_WAIT_MS = 750;
const PARENT_CHECK_MS = 250;

const expectedParentPid = Number(process.env.MUXMELT_SUPERVISOR_PARENT_PID);
delete process.env.MUXMELT_SUPERVISOR_PARENT_PID;
delete process.env.ELECTRON_RUN_AS_NODE;

let statusStream = null;
try {
  statusStream = fs.createWriteStream(null, { fd: 3, autoClose: false });
  statusStream.on('error', () => { statusStream = null; });
} catch {}

function sendStatus(message) {
  try { statusStream?.write(`${JSON.stringify(message)}\n`); } catch {}
}

function boundedGrace(value) {
  const numeric = Number(value);
  return Math.max(0, Math.min(10000, Number.isFinite(numeric) ? numeric : DEFAULT_GRACE_MS));
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

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!predicate()) return true;
    await delay(40);
  }
  return !predicate();
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
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
      killer.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

let child = null;
let childSpawned = false;
let childClosed = false;
let childCode = null;
let childSignal = null;
let terminating = null;
let exited = false;

function exitNow(code, cleanup = { cleaned: true }) {
  if (exited) return;
  exited = true;
  clearInterval(parentTimer);
  try { process.stdin.destroy(); } catch {}
  const finalCode = Number.isInteger(code) ? Math.max(0, Math.min(255, code)) : 1;
  const exit = () => process.exit(finalCode);
  if (!statusStream) {
    exit();
    return;
  }
  // Flush the orderly-completion marker before exiting. The owner uses it to
  // distinguish a successful watchdog shutdown from a watchdog crash that
  // needs parent-side emergency tree cleanup.
  const fallback = setTimeout(exit, 200);
  try {
    statusStream.end(`${JSON.stringify({
      type: 'complete',
      cleaned: cleanup.cleaned === true,
      reason: cleanup.reason || null,
      spawned: childSpawned,
    })}\n`, () => {
      clearTimeout(fallback);
      exit();
    });
  } catch {
    clearTimeout(fallback);
    exit();
  }
}

function childExitCode() {
  if (Number.isInteger(childCode)) return childCode;
  const signalNumbers = os.constants.signals || {};
  const signalNumber = childSignal && signalNumbers[childSignal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

async function terminatePosixTree(pid, graceMs) {
  if (!posixGroupAlive(pid)) return true;
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  if (await waitUntil(() => posixGroupAlive(pid), graceMs)) return true;
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  return waitUntil(() => posixGroupAlive(pid), FORCE_WAIT_MS);
}

async function terminateWindowsTree(pid) {
  const killed = await runTaskkill(pid);
  if (!killed && child && !childClosed) {
    try { child.kill('SIGKILL'); } catch {}
  }
  const directChildClosed = await waitUntil(() => !childClosed, FORCE_WAIT_MS);
  // A direct kill after taskkill failure cannot prove that descendants were
  // reaped. Report failure even when the leader itself subsequently closes.
  return killed && directChildClosed;
}

async function terminateTree(graceMs) {
  if (!child) return true;
  // Cancellation can race the asynchronous spawn event. Do not exit the
  // watchdog while a target is still being created: wait for either `spawn`
  // (which gives us a real tree root) or `error`/`close`.
  if (!childSpawned && !childClosed) {
    await waitUntil(() => !childSpawned && !childClosed, FORCE_WAIT_MS);
  }
  if (childClosed && !childSpawned) return true;
  if (!childSpawned || !Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  if (process.platform === 'win32') {
    return terminateWindowsTree(child.pid);
  }
  return terminatePosixTree(child.pid, graceMs);
}

function beginTermination(reason, graceMs = DEFAULT_GRACE_MS, finalCode = 143) {
  if (exited) return Promise.resolve();
  if (terminating) return terminating;
  sendStatus({ type: 'terminating', reason });
  terminating = (async () => {
    const treeCleaned = await terminateTree(boundedGrace(graceMs));
    // The direct child is normally reaped by its close event. Bound the wait;
    // group/taskkill cleanup above is the security property that matters.
    const directChildClosed = childClosed
      || await waitUntil(() => !childClosed, FORCE_WAIT_MS);
    const cleaned = treeCleaned && directChildClosed;
    exitNow(cleaned ? finalCode : 125, { cleaned, reason });
  })().catch(() => exitNow(125, { cleaned: false, reason }));
  return terminating;
}

function parentAlive() {
  if (!Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 0) return false;
  // The private pipe is the primary liveness signal. Checking both ppid and
  // PID protects against a pipe inherited accidentally by an unrelated child.
  if (process.ppid !== expectedParentPid) return false;
  try {
    process.kill(expectedParentPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

const parentTimer = setInterval(() => {
  if (!parentAlive()) beginTermination('parent-lost');
}, PARENT_CHECK_MS);

function launch(payload) {
  if (child || terminating) throw new Error('A command is already active');
  if (!payload || typeof payload.command !== 'string' || !payload.command
      || !Array.isArray(payload.args)
      || !payload.args.every((arg) => typeof arg === 'string')) {
    throw new Error('Invalid supervised command payload');
  }

  child = spawn(payload.command, payload.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('spawn', () => {
    childSpawned = true;
    sendStatus({ type: 'spawned', pid: child.pid });
  });

  child.once('error', (error) => {
    try { process.stderr.write(`MuxMelt could not start the supervised process: ${error.message}\n`); } catch {}
    childClosed = true;
    childCode = 127;
    if (!terminating) exitNow(127, { cleaned: true, reason: 'spawn-error' });
  });
  child.once('close', (code, signal) => {
    childClosed = true;
    childCode = code;
    childSignal = signal;
    if (terminating) return;

    // On POSIX, also reap helpers that outlived a normally exiting leader.
    // They remain in the leader's dedicated process group.
    if (process.platform !== 'win32' && posixGroupAlive(child.pid)) {
      beginTermination('leader-exited', 100, childExitCode()).then(() => {});
      return;
    }
    exitNow(childExitCode(), { cleaned: true, reason: 'leader-exited' });
  });
}

let input = '';
let launched = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input, 'utf8') > MAX_CONTROL_BYTES) {
    beginTermination('control-limit', 0);
    return;
  }
  const lines = input.split('\n');
  input = lines.pop() || '';
  for (const line of lines) {
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (!launched) {
        launched = true;
        launch(message);
      } else if (message && message.type === 'terminate') {
        beginTermination('requested', message.graceMs);
      }
    } catch (error) {
      try { process.stderr.write(`MuxMelt supervisor rejected its control message: ${error.message}\n`); } catch {}
      beginTermination('invalid-control', 0);
    }
  }
});
process.stdin.on('end', () => beginTermination('parent-pipe-closed'));
process.stdin.on('close', () => beginTermination('parent-pipe-closed'));
process.stdin.on('error', () => beginTermination('parent-pipe-error'));

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try { process.on(signal, () => beginTermination(`signal-${signal}`, 250)); } catch {}
}
process.on('uncaughtException', (error) => {
  try { process.stderr.write(`MuxMelt supervisor error: ${error.message}\n`); } catch {}
  beginTermination('uncaught-error', 0);
});

if (!parentAlive()) beginTermination('invalid-parent', 0);
