'use strict';

// Cross-platform launcher for the backend smoke test. Finds a Python
// interpreter and runs test/backend-smoke.py, forwarding its exit code.
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'backend-smoke.py');
const candidates = process.platform === 'win32'
  ? ['py', 'python', 'python3']
  : ['python3', 'python'];

for (const cmd of candidates) {
  const res = spawnSync(cmd, [script], { stdio: 'inherit' });
  if (res.error && res.error.code === 'ENOENT') continue; // not found, try next
  if (res.error) {
    console.error(`Failed to run smoke test with ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status === null ? 1 : res.status);
}

console.error('No Python interpreter found (tried: ' + candidates.join(', ') + ').');
process.exit(1);
