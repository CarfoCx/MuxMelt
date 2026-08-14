'use strict';

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  spawnSupervised,
  terminateSupervisedProcess,
  supervisedCleanupError,
  __test: processSupervisorTest,
} = require('../src/main/process-supervisor');

const root = path.join(__dirname, '..');
const fakeParentScript = path.join(__dirname, 'fixtures', 'process-supervisor-parent.js');
const workerScript = path.join(__dirname, 'fixtures', 'supervised-tree-worker.js');
const trackedPids = new Set();

function forgetPids(...pids) {
  for (const pid of pids) trackedPids.delete(pid);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function collectJsonLines(stream, onMessage) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      try { onMessage(JSON.parse(line)); } catch {}
    }
  });
}

function closePromise(proc) {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function forceCleanup(pid) {
  if (!processAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function verifyForwardedCancellation() {
  const messages = [];
  const proc = spawnSupervised(process.execPath, [workerScript], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackedPids.add(proc.pid);
  collectJsonLines(proc.stdout, (message) => messages.push(message));
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const closed = closePromise(proc);
  await waitFor(
    () => messages.some((message) => message.type === 'tree'),
    5000,
    `Supervised worker did not start: ${stderr}`
  );
  const tree = messages.find((message) => message.type === 'tree');
  trackedPids.add(tree.leaderPid);
  trackedPids.add(tree.descendantPid);
  assert.strictEqual(terminateSupervisedProcess(proc, 100), true);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation did not close the supervisor')), 5000)),
  ]);
  assert.strictEqual(proc.cleanupResult?.cleaned, true);
  assert.strictEqual(processAlive(tree.leaderPid), false, 'Leader was live after cancellation close');
  assert.strictEqual(processAlive(tree.descendantPid), false, 'Descendant was live after cancellation close');
  await waitFor(
    () => !processAlive(tree.leaderPid) && !processAlive(tree.descendantPid),
    5000,
    'Forwarded cancellation left a child or descendant running'
  );
  forgetPids(proc.pid, tree.leaderPid, tree.descendantPid);
}

async function verifyWatchdogCrashFallback() {
  const messages = [];
  const proc = spawnSupervised(process.execPath, [workerScript], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackedPids.add(proc.pid);
  collectJsonLines(proc.stdout, (message) => messages.push(message));
  const closed = closePromise(proc);
  await waitFor(
    () => messages.some((message) => message.type === 'tree') && proc.supervisedPid,
    5000,
    'Watchdog-crash worker did not start'
  );
  const tree = messages.find((message) => message.type === 'tree');
  trackedPids.add(tree.leaderPid);
  trackedPids.add(tree.descendantPid);

  // This simulates a watchdog failure while Electron is still alive. The
  // owner-side emergency fallback uses the privately reported target PID.
  proc.kill('SIGKILL');
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Killed watchdog did not close')), 3000)),
  ]);
  assert.strictEqual(proc.cleanupResult?.orderly, false);
  assert.strictEqual(processAlive(tree.leaderPid), false, 'Leader was live after watchdog close');
  assert.strictEqual(processAlive(tree.descendantPid), false, 'Descendant was live after watchdog close');
  await waitFor(
    () => !processAlive(tree.leaderPid) && !processAlive(tree.descendantPid),
    5000,
    'Watchdog crash fallback left a child or descendant running'
  );
  forgetPids(proc.pid, tree.leaderPid, tree.descendantPid);
}

async function verifyInjectedCleanupFailure() {
  const proc = spawnSupervised(process.execPath, [workerScript], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
    [processSupervisorTest.PROCESS_SUPERVISOR_TEST_HOOK]: {
      emergencyCleanup: async () => ({
        cleaned: false,
        reason: 'injected-test-failure',
      }),
    },
  });
  trackedPids.add(proc.pid);
  const closed = closePromise(proc);
  await waitFor(
    () => proc.supervisedSpawned && Number.isSafeInteger(proc.supervisedPid),
    5000,
    'Injected-failure worker did not start'
  );
  trackedPids.add(proc.supervisedPid);
  proc.kill('SIGKILL');
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Injected cleanup failure did not close')), 3000)),
  ]);
  assert.deepStrictEqual(proc.cleanupResult, {
    cleaned: false,
    reason: 'injected-test-failure',
    orderly: false,
    spawned: true,
  });
  const cleanupError = supervisedCleanupError(proc, 'Injected worker');
  assert.strictEqual(cleanupError.code, 'PROCESS_CLEANUP_FAILED');
  assert.strictEqual(cleanupError.cleanupResult, proc.cleanupResult);

  // The injected hook deliberately left the target running; bound and verify
  // test cleanup so this negative-path assertion never leaks a real process.
  forceCleanup(proc.supervisedPid);
  await waitFor(
    () => !processAlive(proc.supervisedPid),
    5000,
    'Injected cleanup-failure fixture could not be reaped'
  );
  forgetPids(proc.pid, proc.supervisedPid);
}

async function verifyHardParentDeath({
  runtime = process.execPath,
  parentScript = fakeParentScript,
  env = process.env,
} = {}) {
  const messages = [];
  const fakeParent = spawn(runtime, [parentScript], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackedPids.add(fakeParent.pid);
  collectJsonLines(fakeParent.stdout, (message) => messages.push(message));
  let stderr = '';
  fakeParent.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const parentClosed = closePromise(fakeParent);
  await waitFor(
    () => messages.some((message) => message.type === 'owners')
      && messages.some((message) => message.type === 'tree'),
    5000,
    `Fake parent tree did not start: ${stderr}`
  );
  const owners = messages.find((message) => message.type === 'owners');
  const tree = messages.find((message) => message.type === 'tree');
  for (const pid of [owners.supervisorPid, tree.leaderPid, tree.descendantPid]) trackedPids.add(pid);

  // Kill only the Electron stand-in. Its watchdog must remain alive long
  // enough to notice the closed control pipe and reap the owned process tree.
  fakeParent.kill('SIGKILL');
  await Promise.race([
    parentClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fake parent did not exit')), 3000)),
  ]);
  await waitFor(
    () => !processAlive(owners.supervisorPid)
      && !processAlive(tree.leaderPid)
      && !processAlive(tree.descendantPid),
    7000,
    'Hard parent death left the supervisor, child, or descendant running'
  );
  forgetPids(fakeParent.pid, owners.supervisorPid, tree.leaderPid, tree.descendantPid);
}

async function verifyPackagedElectronAsar() {
  let electronPath;
  let asar;
  try {
    electronPath = require('electron');
    asar = await import('@electron/asar');
  } catch (error) {
    throw new Error(`Packaged Electron watchdog validation dependencies are unavailable: ${error.message}`);
  }
  assert.strictEqual(typeof electronPath, 'string');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-supervisor-asar-'));
  const sourceRoot = path.join(tempRoot, 'source');
  const archivePath = path.join(tempRoot, 'app.asar');
  try {
    const mainDir = path.join(sourceRoot, 'src', 'main');
    const fixtureDir = path.join(sourceRoot, 'test', 'fixtures');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(fixtureDir, { recursive: true });
    for (const name of ['process-supervisor.js', 'process-supervisor-entry.js']) {
      fs.copyFileSync(path.join(root, 'src', 'main', name), path.join(mainDir, name));
    }
    fs.copyFileSync(fakeParentScript, path.join(fixtureDir, 'process-supervisor-parent.js'));
    await asar.createPackage(sourceRoot, archivePath);

    await verifyHardParentDeath({
      runtime: electronPath,
      parentScript: path.join(archivePath, 'test', 'fixtures', 'process-supervisor-parent.js'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MUXMELT_TEST_TARGET_NODE: process.execPath,
        MUXMELT_TEST_WORKER_PATH: workerScript,
      },
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function main() {
  try {
    await verifyForwardedCancellation();
    await verifyWatchdogCrashFallback();
    await verifyInjectedCleanupFailure();
    await verifyHardParentDeath();
    await verifyPackagedElectronAsar();
    console.log(`Process supervisor smoke passed on ${process.platform}: cancellation, watchdog failure, fail-closed reporting, parent death, and packaged Electron/ASAR execution.`);
  } finally {
    // Explicit bounded cleanup protects developer machines even when an
    // assertion fails halfway through the lifecycle test.
    for (const pid of [...trackedPids].reverse()) forceCleanup(pid);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
