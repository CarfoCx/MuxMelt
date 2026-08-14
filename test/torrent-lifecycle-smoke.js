'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { registerIPC, __test } = require('../node-tools/torrent-downloader');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockClientClass(state, deferDestroy = false) {
  return class MockClient extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      state.constructed += 1;
      state.instances.push(this);
    }

    destroy(callback) {
      assert.strictEqual(this.destroyed, false, 'client must only be destroyed once');
      this.destroyed = true;
      state.destroyCalls += 1;
      if (deferDestroy) state.destroyCallbacks.push(callback);
      else setImmediate(callback);
    }
  };
}

async function testConcurrentColdStartIsSingleFlight() {
  const load = deferred();
  const state = { constructed: 0, destroyCalls: 0, destroyCallbacks: [], instances: [] };
  const MockClient = createMockClientClass(state);
  const controller = __test.createClientController(() => load.promise);

  const first = controller.getSession();
  const second = controller.getSession();
  load.resolve(MockClient);

  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(state.constructed, 1, 'concurrent startup constructed more than one client');
  assert.strictEqual(a.client, b.client, 'concurrent callers did not share the client');
  assert.strictEqual(a.generation, b.generation);

  await controller.shutdown();
  assert.strictEqual(state.destroyCalls, 1);
  assert.strictEqual(state.instances[0].listenerCount('error'), 0, 'client error listener leaked');
}

async function testShutdownDuringImportConstructsNothing() {
  const load = deferred();
  const state = { constructed: 0, destroyCalls: 0, destroyCallbacks: [], instances: [] };
  const MockClient = createMockClientClass(state);
  const controller = __test.createClientController(() => load.promise);

  const startup = controller.getSession();
  const shutdown = controller.shutdown();
  load.resolve(MockClient);

  await assert.rejects(startup, error => error.code === 'TORRENT_STARTUP_CANCELLED');
  await shutdown;
  assert.strictEqual(state.constructed, 0, 'shutdown during import created an unowned client');

  const restarted = await controller.getSession();
  assert.ok(restarted.client);
  assert.strictEqual(state.constructed, 1, 'controller did not recover after a clean cancellation');
  await controller.shutdown();
}

async function testShutdownInvalidatesSessionsAndAwaitsTeardown() {
  const state = { constructed: 0, destroyCalls: 0, destroyCallbacks: [], instances: [] };
  const MockClient = createMockClientClass(state, true);
  const controller = __test.createClientController(async () => MockClient);
  const session = await controller.getSession();
  const ownedWork = deferred();

  let shutdownSettled = false;
  const shutdown = controller.shutdown(() => ownedWork.promise).then(() => { shutdownSettled = true; });
  assert.throws(() => controller.assertCurrent(session), error => error.code === 'TORRENT_OPERATION_CANCELLED');
  await assert.rejects(controller.getSession(), error => error.code === 'TORRENT_STARTUP_CANCELLED');

  ownedWork.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(state.destroyCalls, 1);
  assert.strictEqual(shutdownSettled, false, 'shutdown resolved before the client destroy callback');
  assert.strictEqual(state.instances[0].listenerCount('error'), 1, 'error listener was removed before teardown');

  state.destroyCallbacks.shift()();
  await shutdown;
  assert.strictEqual(shutdownSettled, true);
  assert.strictEqual(state.instances[0].listenerCount('error'), 0, 'error listener remained after teardown');
  assert.throws(() => controller.assertCurrent(session), error => error.code === 'TORRENT_OPERATION_CANCELLED');
}

async function testIpcCancellationWaitsForTorrentAndDetachesListeners() {
  const handlers = new Map();
  const torrent = new EventEmitter();
  torrent.destroyed = false;
  torrent.ready = false;
  torrent.name = '';
  let finishTorrentDestroy = null;
  torrent.destroy = (callback) => {
    torrent.destroyed = true;
    finishTorrentDestroy = callback;
  };

  const client = {
    async get() { return null; },
    add() { return torrent; },
  };
  const lifecycle = {
    setErrorHandler() {},
    async getSession() { return { client, generation: 0 }; },
    assertCurrent() {},
    async shutdown(stopOwnedWork) { await stopOwnedWork(); },
  };
  let registeredShutdown = null;
  let registeredOptions = null;
  const jobRegistry = {
    assertCanStart() {},
    register(name, shutdown, options) {
      assert.strictEqual(name, 'torrent-downloader');
      registeredShutdown = shutdown;
      registeredOptions = options;
    },
  };
  const networkPolicy = { assertAllowed() {} };
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-torrent-lifecycle-'));

  try {
    registerIPC(
      { handle(name, handler) { handlers.set(name, handler); } },
      () => null,
      networkPolicy,
      jobRegistry,
      { clientController: lifecycle }
    );
    assert.deepStrictEqual(registeredOptions, { network: true });

    const started = await handlers.get('torrent-downloader-download')(null, {
      source: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      outputDir,
    });
    assert.strictEqual(started.success, true);
    assert.strictEqual(torrent.listenerCount('done'), 1);
    assert.strictEqual(torrent.listenerCount('error'), 1);

    let cancellationSettled = false;
    const cancellation = handlers.get('torrent-downloader-cancel')(null, started.id)
      .then(result => {
        cancellationSettled = true;
        return result;
      });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(cancellationSettled, false, 'cancel resolved before torrent.destroy completed');
    assert.strictEqual(torrent.listenerCount('done'), 0, 'done listener was not detached');
    assert.strictEqual(torrent.listenerCount('error'), 0, 'error listener was not detached');

    finishTorrentDestroy();
    const cancelled = await cancellation;
    assert.strictEqual(cancelled.success, true);
    await registeredShutdown();
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

async function main() {
  await testConcurrentColdStartIsSingleFlight();
  await testShutdownDuringImportConstructsNothing();
  await testShutdownInvalidatesSessionsAndAwaitsTeardown();
  await testIpcCancellationWaitsForTorrentAndDetachesListeners();
  console.log('Torrent lifecycle smoke passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
