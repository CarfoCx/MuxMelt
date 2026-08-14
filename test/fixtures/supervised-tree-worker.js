'use strict';

const { spawn } = require('child_process');

if (process.argv[2] === 'descendant') {
  setInterval(() => {}, 1000);
} else {
  const descendant = spawn(process.execPath, [__filename, 'descendant'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  process.stdout.write(`${JSON.stringify({
    type: 'tree',
    leaderPid: process.pid,
    descendantPid: descendant.pid,
  })}\n`);
  setInterval(() => {}, 1000);
}
