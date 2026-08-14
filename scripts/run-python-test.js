'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const requested = process.argv[2];
if (!requested) {
  console.error('Usage: node scripts/run-python-test.js <repo-relative-test.py>');
  process.exit(2);
}

const script = path.resolve(root, requested);
const relative = path.relative(root, script);
if (relative.startsWith('..') || path.isAbsolute(relative) || !script.endsWith('.py')) {
  console.error(`Refusing Python test outside the repository: ${requested}`);
  process.exit(2);
}
if (!fs.existsSync(script)) {
  console.error(`Python test does not exist: ${relative}`);
  process.exit(2);
}

const candidates = [
  process.env.MUXMELT_TEST_PYTHON,
  ...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])
].filter(Boolean);

for (const command of candidates) {
  const result = spawnSync(command, [script], { cwd: root, stdio: 'inherit' });
  if (result.error && result.error.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`Failed to run ${relative} with ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

console.error(`No Python interpreter found (tried: ${candidates.join(', ')})`);
process.exit(1);
