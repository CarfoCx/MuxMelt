'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testPath = path.join(root, 'test', 'backend-smoke.py');
const candidates = [
  process.env.MUXMELT_TEST_PYTHON,
  ...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])
].filter(Boolean);

for (const command of candidates) {
  const result = spawnSync(command, [testPath], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error && result.error.code === 'ENOENT') continue;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`Failed to run live backend smoke with ${command}: ${result.error.message}`);
    process.exit(1);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/\bSKIPPED:\s*core backend dependencies/i.test(output)) {
    console.error('Live backend smoke was skipped; release/CI dependency provisioning is incomplete.');
    process.exit(1);
  }
  process.exit(result.status === 0 ? 0 : 1);
}

console.error(`No Python interpreter found (tried: ${candidates.join(', ')})`);
process.exit(1);
