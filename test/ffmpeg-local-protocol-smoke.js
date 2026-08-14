'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');
const runner = require('../node-tools/ffmpeg-runner');

const protocols = new Set(runner.LOCAL_PROTOCOLS.split(','));
for (const required of ['file', 'pipe', 'fd', 'crypto', 'data', 'concat', 'subfile']) {
  assert(protocols.has(required), `missing required local FFmpeg protocol: ${required}`);
}
for (const network of ['http', 'https', 'tcp', 'tls', 'udp', 'ftp', 'sftp', 'rtmp', 'srt', 'ipfs', 'ipns']) {
  assert(!protocols.has(network), `network protocol must not be allowed: ${network}`);
}

const source = fs.readFileSync(path.join(__dirname, '..', 'node-tools', 'ffmpeg-runner.js'), 'utf8');
assert.deepStrictEqual(
  runner.restrictEveryInput(['-i', 'one.mp4', '-filter_complex', 'x', '-i', 'two.png']),
  [
    '-protocol_whitelist', runner.LOCAL_PROTOCOLS, '-i', 'one.mp4',
    '-filter_complex', 'x',
    '-protocol_whitelist', runner.LOCAL_PROTOCOLS, '-i', 'two.png'
  ]
);
assert(source.includes("const fullArgs = ['-y', ...restrictEveryInput(args)]"));
assert(source.includes("[...LOCAL_PROTOCOL_ARGS, '-i', filePath]"));
assert((source.match(/\.\.\.LOCAL_PROTOCOL_ARGS/g) || []).length >= 4);

async function verifyCleanupFailurePropagation() {
  const runnerPath = require.resolve('../node-tools/ffmpeg-runner');
  const audioPath = require.resolve('../node-tools/audio-extractor');
  const originalRunnerModule = require.cache[runnerPath];
  const originalAudioModule = require.cache[audioPath];
  const realLoad = Module._load;
  let resolveCleanup;

  const fakeProcess = new EventEmitter();
  fakeProcess.stdin = null;
  fakeProcess.stdout = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.exitCode = null;
  fakeProcess.signalCode = null;
  fakeProcess.cleanupResult = null;
  fakeProcess.cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });

  try {
    delete require.cache[runnerPath];
    delete require.cache[audioPath];
    Module._load = function(request, parent, isMain) {
      if (request === 'child_process') {
        return { ...realLoad(request, parent, isMain), spawnSync: () => ({ status: 0, error: null }) };
      }
      if (request === '../src/main/process-supervisor') {
        return {
          spawnSupervised: () => fakeProcess,
          terminateSupervisedProcess(proc) {
            proc.cleanupResult = { cleaned: false, reason: 'injected-test-failure' };
            resolveCleanup(proc.cleanupResult);
            setImmediate(() => proc.emit('close', 143));
            return true;
          },
          supervisedCleanupError(proc, label) {
            if (proc.cleanupResult?.cleaned === true) return null;
            const error = new Error(`${label} cleanup was not confirmed`);
            error.code = 'PROCESS_CLEANUP_FAILED';
            error.cleanupResult = proc.cleanupResult;
            return error;
          },
        };
      }
      return realLoad(request, parent, isMain);
    };

    const injectedRunner = require('../node-tools/ffmpeg-runner');
    const execution = injectedRunner.run({ args: ['-i', 'input.mp4', 'output.mp4'] });
    const executionError = execution.promise.then(() => null, error => error);
    await assert.rejects(
      execution.cancel(),
      error => error && error.code === 'PROCESS_CLEANUP_FAILED'
    );
    assert.strictEqual((await executionError).code, 'PROCESS_CLEANUP_FAILED');
    assert.throws(
      () => injectedRunner.throwIfCleanupFailed(),
      error => error && error.code === 'PROCESS_CLEANUP_FAILED'
    );

    let registryCancel = null;
    require('../node-tools/audio-extractor').registerIPC(
      { handle() {} },
      () => null,
      { register(name, cancel) {
        assert.strictEqual(name, 'audio-extractor');
        registryCancel = cancel;
      } }
    );
    await assert.rejects(
      registryCancel(),
      error => error && error.code === 'PROCESS_CLEANUP_FAILED'
    );
  } finally {
    Module._load = realLoad;
    delete require.cache[runnerPath];
    delete require.cache[audioPath];
    if (originalRunnerModule) require.cache[runnerPath] = originalRunnerModule;
    if (originalAudioModule) require.cache[audioPath] = originalAudioModule;
  }
}

verifyCleanupFailurePropagation().then(() => {
  console.log('FFmpeg local-protocol and fail-closed cleanup smoke passed.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
