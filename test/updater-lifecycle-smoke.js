'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const handlers = new Map();
let resolveFolderDialog;
let dialogOpened = false;
const fakeElectron = {
  app: {
    isPackaged: true,
    getPath(name) {
      if (name === 'temp') return os.tmpdir();
      if (name === 'userData') return path.join(os.tmpdir(), 'muxmelt-updater-test-data');
      throw new Error(`unexpected app path: ${name}`);
    },
    quit() {},
  },
  BrowserWindow: { fromWebContents() { return null; } },
  dialog: {
    showOpenDialog() {
      dialogOpened = true;
      return new Promise((resolve) => { resolveFolderDialog = resolve; });
    },
  },
  ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
  shell: { openPath: async () => '' },
};

const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return realLoad(request, parent, isMain);
};
const updater = require('../src/main/updater');
Module._load = realLoad;

async function main() {
  let cancelUpdater;
  let admissionChecks = 0;
  updater.registerUpdaterIpcHandlers(
    () => {},
    { isOffline: () => false, assertAllowed() {} },
    {
      assertCanStart() { admissionChecks += 1; },
      register(name, cancel, options) {
        assert.strictEqual(name, 'app-updater');
        assert.strictEqual(options.network, true);
        cancelUpdater = cancel;
      },
    },
  );

  const selection = handlers.get('select-local-update-folder')({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(dialogOpened, true);
  assert(admissionChecks >= 1);

  let cancellationFinished = false;
  const cancellation = cancelUpdater().then(() => { cancellationFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(
    cancellationFinished,
    false,
    'Offline transition must wait for an in-flight update-source dialog',
  );
  resolveFolderDialog({ canceled: true, filePaths: [] });
  await Promise.all([selection, cancellation]);
  assert.strictEqual(cancellationFinished, true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-updater-abort-'));
  try {
    const source = path.join(tempDir, 'source.bin');
    const target = path.join(tempDir, 'target.bin');
    fs.writeFileSync(source, Buffer.alloc(1024 * 1024, 7));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      updater.copyFileAbortable(source, target, controller.signal),
      (error) => error && error.name === 'AbortError',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Updater lifecycle smoke passed (2 checks).');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = realLoad;
});
