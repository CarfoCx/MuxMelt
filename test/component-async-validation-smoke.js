const assert = require('assert');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

async function testEnvironmentValidationRunsOffThread() {
  const originalSpawn = childProcess.spawn;
  const calls = [];

  childProcess.spawn = (command, args, options = {}) => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdio = [proc.stdin, proc.stdout, proc.stderr, new PassThrough()];
    proc.exitCode = null;
    proc.signalCode = null;
    proc.pid = 40000 + calls.length;
    proc.kill = () => true;
    const call = { command, args, options, payload: '' };
    proc.stdin.on('data', (chunk) => { call.payload += chunk.toString(); });
    calls.push(call);
    setTimeout(() => {
      proc.stdio[3].write(`${JSON.stringify({ type: 'spawned', pid: proc.pid + 1000 })}\n`);
      proc.stdio[3].write(`${JSON.stringify({ type: 'complete', cleaned: true })}\n`);
      proc.exitCode = 0;
      proc.emit('close', 0);
    }, 20);
    return proc;
  };

  let setupManager;
  try {
    delete require.cache[require.resolve('../src/main/process-supervisor')];
    delete require.cache[require.resolve('../src/main/setup-manager')];
    setupManager = require('../src/main/setup-manager');
  } finally {
    childProcess.spawn = originalSpawn;
  }

  const poisonedEnvironment = {
    PIP_CONFIG_FILE: process.env.PIP_CONFIG_FILE,
    PIP_EXTRA_INDEX_URL: process.env.PIP_EXTRA_INDEX_URL,
    PIP_TRUSTED_HOST: process.env.PIP_TRUSTED_HOST,
    PYTHONHOME: process.env.PYTHONHOME,
    PYTHONPATH: process.env.PYTHONPATH,
    VIRTUAL_ENV: process.env.VIRTUAL_ENV,
  };
  process.env.PIP_CONFIG_FILE = 'C:\\attacker\\pip.ini';
  process.env.PIP_EXTRA_INDEX_URL = 'https://attacker.invalid/simple';
  process.env.PIP_TRUSTED_HOST = 'attacker.invalid';
  process.env.PYTHONHOME = 'C:\\attacker\\python';
  process.env.PYTHONPATH = 'C:\\attacker\\modules';
  process.env.VIRTUAL_ENV = 'C:\\attacker\\venv';

  const restoreEnvironment = () => {
    for (const [key, value] of Object.entries(poisonedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const validation = setupManager.hasCompleteEnvironmentAsync(
    process.execPath,
    path.join(__dirname, '..', 'python', 'requirements.txt')
  );
  let eventLoopAdvanced = false;
  await new Promise((resolve) => setTimeout(() => {
    eventLoopAdvanced = true;
    resolve();
  }, 0));

  assert.strictEqual(eventLoopAdvanced, true, 'validation must not block the event loop');
  assert.strictEqual(calls.length, 1, 'pip check must wait for the import/version probe');
  assert.strictEqual(await validation, true);
  assert.strictEqual(calls.length, 2);
  const firstPayload = JSON.parse(calls[0].payload.trim());
  const secondPayload = JSON.parse(calls[1].payload.trim());
  assert.deepStrictEqual(secondPayload.args, [
    '-m', 'pip',
    '--isolated', '--disable-pip-version-check', '--no-input',
    'check',
  ]);
  assert.ok(firstPayload.args[1].includes('sys.version_info'));
  assert.ok(firstPayload.args[1].includes('importlib.metadata.version'));
  const childEnvironment = calls[0].options.env;
  assert.strictEqual(childEnvironment.PIP_CONFIG_FILE, process.platform === 'win32' ? 'nul' : '/dev/null');
  assert.strictEqual(childEnvironment.PIP_INDEX_URL, 'https://pypi.org/simple');
  assert.strictEqual(childEnvironment.PIP_DISABLE_PIP_VERSION_CHECK, '1');
  assert.strictEqual(childEnvironment.PIP_NO_INPUT, '1');
  assert.strictEqual(childEnvironment.PYTHONNOUSERSITE, '1');
  assert.strictEqual(childEnvironment.PYTHONSAFEPATH, '1');
  assert.strictEqual(childEnvironment.PIP_EXTRA_INDEX_URL, undefined);
  assert.strictEqual(childEnvironment.PIP_TRUSTED_HOST, undefined);
  assert.strictEqual(childEnvironment.PYTHONHOME, undefined);
  assert.strictEqual(childEnvironment.PYTHONPATH, undefined);
  assert.strictEqual(childEnvironment.VIRTUAL_ENV, undefined);

  const controller = new AbortController();
  const cancelledValidation = setupManager.hasCompleteEnvironmentAsync(
    process.execPath,
    path.join(__dirname, '..', 'python', 'requirements.txt'),
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(cancelledValidation, (error) => error?.code === 'SETUP_CANCELLED');
  assert.strictEqual(calls.length, 3, 'cancellation must prevent the pip check from starting');
  const controlMessages = calls[2].payload.trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(
    controlMessages.some((message) => message.type === 'terminate'),
    'cancellation must reach the supervised process tree'
  );
  restoreEnvironment();

  const setupSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'setup-manager.js'),
    'utf8'
  );
  assert.strictEqual(
    (setupSource.match(/\['-m', 'pip'\]/g) || []).length,
    1,
    'pip commands must be built through the controlled argument helper'
  );
  assert.strictEqual(setupSource.includes('download.pytorch.org/whl'), false);
  assert.ok((setupSource.match(/controlledPipArgs\('install'/g) || []).length >= 5);
}

async function testComponentAwaitsAndCancelsValidation() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-component-test-'));
  const handlers = new Map();
  let cancelComponentInstalls = null;
  let startBackendCalls = 0;
  let runSetupCalls = 0;
  let signalSeen = null;
  let markValidationStarted;
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });

  try {
    const { createComponentManager } = require('../src/main/component-manager');
    createComponentManager({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      app: { getPath: () => tempRoot },
      shell: { openPath: async () => '' },
      dialog: {},
      getMainWindow: () => null,
      loadSettings: () => ({ global: {} }),
      saveSettings: () => true,
      networkPolicy: {
        isOffline: () => false,
        assertAllowed: () => {},
      },
      runSlimSetup: async () => { runSetupCalls += 1; },
      hasCurrentSetupMarker: () => true,
      needsSlimSetup: (...args) => new Promise((resolve, reject) => {
        signalSeen = args[5]?.signal || null;
        markValidationStarted();
        signalSeen?.addEventListener('abort', () => {
          const error = new Error('Setup cancelled');
          error.code = 'SETUP_CANCELLED';
          reject(error);
        }, { once: true });
      }),
      startBackend: async () => {
        startBackendCalls += 1;
        return { success: true };
      },
      isSlim: true,
      appDir: tempRoot,
      pythonAppDir: path.join(__dirname, '..'),
      slimPythonDir: path.join(tempRoot, 'python-env'),
      slimPythonExe: path.join(tempRoot, 'python-env', 'python.exe'),
      slimSetupMarker: path.join(tempRoot, 'python-env', '.setup-complete'),
      llamaDir: path.join(tempRoot, 'llama'),
      isWin: process.platform === 'win32',
      isPackaged: false,
      jobRegistry: {
        register: (_id, cancel) => { cancelComponentInstalls = cancel; },
        assertCanStart: () => {},
      },
    });

    const install = handlers.get('install-media-pack')();
    await validationStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(signalSeen, 'Install/Repair must pass its AbortSignal to validation');
    assert.strictEqual(startBackendCalls, 0, 'backend must wait for validation');
    assert.strictEqual(runSetupCalls, 0, 'setup must wait for the validation result');

    await cancelComponentInstalls();
    const result = await install;
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'SETUP_CANCELLED');
    assert.strictEqual(signalSeen.aborted, true);
    assert.strictEqual(startBackendCalls, 0);
    assert.strictEqual(runSetupCalls, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

(async () => {
  await testEnvironmentValidationRunsOffThread();
  await testComponentAwaitsAndCancelsValidation();
  console.log('Component async validation smoke test passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
