'use strict';

// Focused process-tree checks for URL Downloader. Everything is mocked so the
// suite is cross-platform and never launches Python, pip, yt-dlp, or ffmpeg.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const realKill = process.kill;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realLoad = Module._load;
const escalationCallbacks = [];
let outputDir = null;

Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
global.setTimeout = (callback, delay, ...args) => {
  if (delay === 3000) {
    escalationCallbacks.push(callback);
    return { unref() {} };
  }
  return realSetTimeout(callback, delay, ...args);
};
global.clearTimeout = timer => {
  if (timer && typeof timer === 'object' && typeof timer.unref === 'function'
      && !('_idleTimeout' in timer)) return;
  return realClearTimeout(timer);
};

let nextPid = 7200;
const spawned = [];
const liveByPid = new Map();
const killCalls = [];
const modes = { info: 'hold', download: 'hold', module: 'fail', pip: 'hold' };

class FakeProcess extends EventEmitter {
  constructor(kind, command, args, options) {
    super();
    this.kind = kind;
    this.command = command;
    this.args = args;
    this.options = options;
    this.pid = nextPid++;
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.directKills = [];
    liveByPid.set(this.pid, this);
  }

  finish(code, stdout = '', stderr = '') {
    if (this.exitCode !== null) return;
    if (stdout) this.stdout.emit('data', Buffer.from(stdout));
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.exitCode = code;
    liveByPid.delete(this.pid);
    this.emit('close', code);
  }

  kill(signal) {
    this.directKills.push(signal);
    this.finish(143);
    return true;
  }
}

function classify(command, args) {
  if (command === 'taskkill') return 'taskkill';
  if (args.includes('--dump-json')) return 'info';
  if (args.includes('-c')) return 'module';
  if (args.includes('pip')) return 'pip';
  if (args.includes('yt_dlp')) return 'download';
  return 'other';
}

function fakeSpawn(command, args = [], options = {}) {
  const kind = classify(command, args);
  const proc = new FakeProcess(kind, command, args, options);
  spawned.push(proc);

  if (kind === 'taskkill') {
    const pid = Number(args[args.indexOf('/pid') + 1]);
    setImmediate(() => {
      const target = liveByPid.get(pid);
      if (target) target.finish(143);
      proc.finish(0);
    });
    return proc;
  }

  const mode = modes[kind] || 'hold';
  if (mode === 'success') {
    setImmediate(() => proc.finish(
      0, kind === 'info' ? '{"title":"ok"}\n' : 'ok'
    ));
  } else if (mode === 'fail') {
    setImmediate(() => proc.finish(
      1, '', kind === 'info' ? 'HTTP Error 403: Forbidden' : 'missing'
    ));
  } else if (mode === 'fail-once') {
    modes[kind] = 'hold';
    setImmediate(() => proc.finish(1, '', 'HTTP Error 403: Forbidden'));
  }
  return proc;
}

process.kill = (pid, signal) => {
  killCalls.push({ pid, signal });
  const target = liveByPid.get(Math.abs(pid));
  // Simulate the Python group leader exiting immediately on TERM. Descendants
  // conceptually remain until the delayed group KILL assertion below.
  if (signal === 'SIGTERM' && target) target.finish(143);
  return true;
};

Module._load = function(request, parent, isMain) {
  if (request === 'child_process') {
    return { ...realLoad(request, parent, isMain), spawn: fakeSpawn };
  }
  if (request === 'electron') {
    return {
      BrowserWindow: { fromWebContents: () => null },
      net: { request() { throw new Error('Network fallback should not run'); } },
    };
  }
  return realLoad(request, parent, isMain);
};

const urlDownloader = require('../node-tools/url-downloader');
Module._load = realLoad;

const handlers = new Map();
urlDownloader.registerIPC(
  { handle(name, handler) { handlers.set(name, handler); } },
  () => null,
  () => ({ cmd: 'python', args: [] })
);

const event = id => ({ sender: { id } });
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Mock condition timed out');
};

async function main() {
  // Info root: TERM the negative group ID, allow the leader to exit, and then
  // prove escalation still KILLs that same group ID.
  const infoPromise = handlers.get('url-downloader-info')(
    event(1), { url: 'https://example.test/watch', requestId: 'posix-info' }
  );
  const infoProc = spawned.find(proc => proc.kind === 'info');
  assert.ok(infoProc);
  assert.strictEqual(infoProc.options.detached, true);
  await handlers.get('url-downloader-info-cancel')(event(1), 'posix-info');
  assert.deepStrictEqual(killCalls.at(-1), {
    pid: -infoProc.pid, signal: 'SIGTERM',
  });
  assert.strictEqual((await infoPromise).cancelled, true);
  assert.notStrictEqual(infoProc.exitCode, null);
  escalationCallbacks[0]();
  assert.deepStrictEqual(killCalls.at(-1), {
    pid: -infoProc.pid, signal: 'SIGKILL',
  });
  assert.deepStrictEqual(infoProc.directKills, []);

  // Full yt-dlp roots must use the same detached group behavior.
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-posix-tree-'));
  const downloadPromise = handlers.get('url-downloader-download')(event(2), {
    url: 'https://example.test/watch', outputDir, format: 'best',
  });
  const downloadProc = spawned.find(proc => proc.kind === 'download');
  assert.ok(downloadProc);
  assert.strictEqual(downloadProc.options.detached, true);
  await handlers.get('url-downloader-cancel')(event(2));
  assert.strictEqual((await downloadPromise).cancelled, true);
  assert.ok(killCalls.some(call => (
    call.pid === -downloadProc.pid && call.signal === 'SIGTERM'
  )));
  assert.notStrictEqual(downloadProc.exitCode, null);
  escalationCallbacks[1]();
  assert.deepStrictEqual(killCalls.at(-1), {
    pid: -downloadProc.pid, signal: 'SIGKILL',
  });

  // The pip task is global/shared. Cancelling one info waiter must not signal
  // the detached pip group that Update yt-dlp is also awaiting.
  const updatePromise = handlers.get('url-downloader-update-ytdlp')(event(3));
  await waitFor(() => spawned.some(proc => proc.kind === 'pip'));
  const pipProc = spawned.find(proc => proc.kind === 'pip');
  assert.strictEqual(pipProc.options.detached, true);

  modes.info = 'fail-once';
  const waiterPromise = handlers.get('url-downloader-info')(
    event(4), { url: 'https://example.test/blocked', requestId: 'shared-waiter' }
  );
  await waitFor(() => spawned.some(proc => (
    proc.kind === 'module' && proc.exitCode !== null
  )));
  const moduleProc = spawned.filter(proc => proc.kind === 'module').at(-1);
  assert.strictEqual(moduleProc.options.detached, true);
  await handlers.get('url-downloader-info-cancel')(event(4), 'shared-waiter');
  assert.strictEqual((await waiterPromise).cancelled, true);
  assert.strictEqual(pipProc.exitCode, null);
  assert.strictEqual(killCalls.some(call => call.pid === -pipProc.pid), false);
  pipProc.finish(0, 'installed');
  assert.strictEqual((await updatePromise).success, true);

  // Windows must retain taskkill /T /F and must not gain detached spawn flags.
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor, value: 'win32',
  });
  modes.info = 'hold';
  const windowsPromise = handlers.get('url-downloader-info')(
    event(5), { url: 'https://example.test/watch', requestId: 'windows-info' }
  );
  const windowsProc = spawned.filter(proc => proc.kind === 'info').at(-1);
  assert.strictEqual(Object.hasOwn(windowsProc.options, 'detached'), false);
  const posixSignalCount = killCalls.length;
  await handlers.get('url-downloader-info-cancel')(event(5), 'windows-info');
  assert.strictEqual((await windowsPromise).cancelled, true);
  const taskkill = spawned.filter(proc => proc.kind === 'taskkill').at(-1);
  assert.ok(taskkill);
  assert.deepStrictEqual(taskkill.args, [
    '/pid', String(windowsProc.pid), '/T', '/F',
  ]);
  assert.strictEqual(killCalls.length, posixSignalCount);

  console.log(
    'URL process-tree smoke passed: POSIX groups, escalation, shared pip, and Windows taskkill.'
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = realLoad;
  process.kill = realKill;
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  Object.defineProperty(process, 'platform', platformDescriptor);
  if (outputDir) {
    try {
      fs.rmSync(outputDir, {
        recursive: true, force: true, maxRetries: 3, retryDelay: 50,
      });
    } catch {}
  }
});
