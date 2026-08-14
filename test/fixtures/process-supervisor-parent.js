'use strict';

const path = require('path');
const { spawnSupervised } = require('../../src/main/process-supervisor');

const worker = process.env.MUXMELT_TEST_WORKER_PATH
  ? path.resolve(process.env.MUXMELT_TEST_WORKER_PATH)
  : path.join(__dirname, 'supervised-tree-worker.js');
const workerRuntime = process.env.MUXMELT_TEST_TARGET_NODE || process.execPath;
const supervised = spawnSupervised(workerRuntime, [worker], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

process.stdout.write(`${JSON.stringify({
  type: 'owners',
  parentPid: process.pid,
  supervisorPid: supervised.pid,
})}\n`);
supervised.stdout.pipe(process.stdout);
supervised.stderr.pipe(process.stderr);
supervised.once('error', (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
setInterval(() => {}, 1000);
