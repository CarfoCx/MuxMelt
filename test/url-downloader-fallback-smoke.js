'use strict';

// Focused, offline retry-policy checks for URL Downloader. The mocked process
// emits realistic yt-dlp output, but no Python process or network request runs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const realLoad = Module._load;
const realTmpdir = os.tmpdir;
const testRoot = fs.mkdtempSync(path.join(realTmpdir(), 'muxmelt-url-fallback-test-'));
const outputDir = path.join(testRoot, 'output');

let scenario = null;
const spawned = [];

class FakeProcess extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.exitCode = null;
    this.signalCode = null;
    this.cleanupResult = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  finish({ code = 0, stdout = '', stderr = '' } = {}) {
    if (this.exitCode !== null) return;
    if (stdout) this.stdout.emit('data', Buffer.from(stdout));
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.exitCode = code;
    this.cleanupResult = { cleaned: true, reason: null };
    this.emit('close', code);
  }
}

function isGenericAttempt(args) {
  const index = args.indexOf('--use-extractors');
  return index !== -1 && args[index + 1] === 'generic';
}

function fakeSpawn(command, args = [], options = {}) {
  const proc = new FakeProcess(command, args, options);
  const kind = args.includes('-c')
    ? 'module'
    : (isGenericAttempt(args) ? 'generic' : 'site');
  spawned.push({ kind, proc });

  const response = kind === 'module'
    ? { code: 1, stderr: "ModuleNotFoundError: No module named 'curl_cffi'\n" }
    : scenario[kind];
  assert.ok(response, `Unexpected ${kind} process in ${scenario.name}`);
  setImmediate(() => proc.finish(response));
  return proc;
}

Module._load = function(request, parent, isMain) {
  if (request === '../src/main/process-supervisor') {
    return {
      spawnSupervised: fakeSpawn,
      terminateSupervisedProcess() { return true; },
      supervisedCleanupError(proc, label = 'External process') {
        if (proc?.cleanupResult?.cleaned === true) return null;
        const error = new Error(`${label} cleanup was not confirmed`);
        error.code = 'PROCESS_CLEANUP_FAILED';
        return error;
      },
    };
  }
  return realLoad(request, parent, isMain);
};

const downloader = require('../node-tools/url-downloader');
Module._load = realLoad;

const handlers = new Map();
const progressEvents = [];
const windowStub = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send(channel, payload) {
      if (channel === 'tool-progress') progressEvents.push(payload);
    },
  },
};

// Keep all temporary downloader state inside this test's isolated directory.
os.tmpdir = () => testRoot;
downloader.registerIPC(
  { handle(name, handler) { handlers.set(name, handler); } },
  () => windowStub,
  () => ({ cmd: 'python', args: [] }),
);

const event = id => ({ sender: { id } });

async function runScenario(nextScenario, id) {
  scenario = nextScenario;
  spawned.length = 0;
  progressEvents.length = 0;
  return handlers.get('url-downloader-download')(event(id), {
    url: nextScenario.url,
    outputDir,
    format: 'best',
    playlist: false,
  });
}

async function main() {
  const youtubeUrl = 'https://www.youtube.com/watch?v=ZuWtavv8vQQ&list=PLQ-hugFoIAaPEBX9mykIUiFr2nT7tdP7r&index=18';
  const transferFailure = await runScenario({
    name: 'mid-transfer HTTP 403',
    url: youtubeUrl,
    site: {
      code: 1,
      stderr: [
        `${downloader.__progress.prefix}\tdownloading\t${5 * 1024 * 1024}\t${100 * 1024 * 1024}\tNA\t0.250\t19.000`,
        `${downloader.__progress.prefix}\tdownloading\t${13 * 1024 * 1024}\t${100 * 1024 * 1024}\tNA\t2.250\t17.000`,
        'ERROR: unable to download video data: HTTP Error 403: Forbidden',
        '',
      ].join('\n'),
    },
  }, 1);

  assert.strictEqual(transferFailure.success, false);
  assert.match(transferFailure.error, /403|forbidden/i);
  assert.doesNotMatch(transferFailure.error, /unsupported url/i);
  assert.strictEqual(
    spawned.filter(entry => entry.kind === 'generic').length,
    0,
    'a transfer/network failure must not be retried with the generic extractor',
  );
  const siteAttempt = spawned.find(entry => entry.kind === 'site');
  assert.ok(siteAttempt, 'the site-specific extractor was not invoked');
  assert.strictEqual(
    siteAttempt.proc.args.at(-1),
    youtubeUrl,
    'playlist/list/index query parameters must remain one intact process argument',
  );
  assert.ok(
    progressEvents.some(update => update.type === 'progress' && update.progress > 0),
    'the fixture must exercise failure after transfer progress has started',
  );
  assert.ok(
    progressEvents.some(update => update.type === 'progress' && /Avg 4\.0 MiB\/s/.test(update.status)),
    'the UI should display the cumulative measured average, not yt-dlp instantaneous bursts',
  );

  const extractionUrl = 'https://example.test/video/embedded-player';
  const extractionFailure = await runScenario({
    name: 'site extraction failure followed by generic unsupported URL',
    url: extractionUrl,
    site: {
      code: 1,
      stderr: 'ERROR: [example] No video formats found in the embedded player\n',
    },
    generic: {
      code: 1,
      stderr: `ERROR: Unsupported URL: ${extractionUrl}\n`,
    },
  }, 2);

  assert.strictEqual(extractionFailure.success, false);
  assert.match(extractionFailure.error, /no video formats found/i);
  assert.doesNotMatch(extractionFailure.error, /unsupported url/i);
  assert.strictEqual(
    spawned.filter(entry => entry.kind === 'generic').length,
    1,
    'a genuine extraction failure should receive exactly one generic fallback',
  );
  const genericAttempt = spawned.find(entry => entry.kind === 'generic');
  assert.ok(genericAttempt);
  assert.strictEqual(genericAttempt.proc.args.at(-1), extractionUrl);

  console.log('URL Downloader fallback smoke passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = realLoad;
  os.tmpdir = realTmpdir;
  try {
    fs.rmSync(testRoot, {
      recursive: true, force: true, maxRetries: 3, retryDelay: 50,
    });
  } catch {}
});
