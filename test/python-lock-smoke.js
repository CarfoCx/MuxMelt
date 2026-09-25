'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const lockPath = path.join(root, 'python', 'requirements-win-cp313-x64.lock');
const lockSource = fs.readFileSync(lockPath, 'utf8');
const setupSource = fs.readFileSync(
  path.join(root, 'src', 'main', 'setup-manager.js'),
  'utf8'
);

const canonicalName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const packages = new Map();
for (const rawLine of lockSource.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const match = line.match(
    /^([A-Za-z0-9_.-]+)==([^\s]+) --hash=sha256:([a-f0-9]{64})  # ([^\s]+\.whl)$/
  );
  assert(match, `invalid or unhashed dependency-lock line: ${line}`);
  const [, displayName, version, hash, wheel] = match;
  const name = canonicalName(displayName);
  assert(!packages.has(name), `duplicate locked package: ${name}`);
  assert(
    /-(?:py2\.py3|py3)-none-any\.whl$/.test(wheel)
      || /-(?:cp313-cp313|cp\d+-abi3)-win_amd64\.whl$/.test(wheel),
    `wheel is not compatible with the CPython 3.13 / win_amd64 lock target: ${wheel}`
  );
  packages.set(name, { version, hash, wheel });
}

assert.strictEqual(packages.size, 78, 'the reviewed Windows wheel graph changed');
const requiredDirectVersions = {
  torch: '2.6.0',
  torchvision: '0.21.0',
  torchaudio: '2.6.0',
  'opencv-python': '4.13.0.92',
  fastapi: '0.136.3',
  uvicorn: '0.48.0',
  numpy: '2.4.4',
  pillow: '12.2.0',
  'nvidia-ml-py': '13.610.43',
  demucs: '4.1.0',
  rembg: '2.0.75',
  'onnxruntime-gpu': '1.26.0',
  'yt-dlp': '2026.8.19',
  'curl-cffi': '0.14.0',
};
for (const [name, version] of Object.entries(requiredDirectVersions)) {
  assert.strictEqual(packages.get(name)?.version, version, `${name} direct pin drifted`);
}
assert.strictEqual(packages.get('pip')?.version, '26.2.1');

const windowsSetupStart = setupSource.indexOf('async function runSlimSetupWindows');
const unixSetupStart = setupSource.indexOf('async function runSlimSetupUnix');
assert(windowsSetupStart >= 0 && unixSetupStart > windowsSetupStart);
const windowsSetup = setupSource.slice(windowsSetupStart, unixSetupStart);
assert(windowsSetup.includes("'--require-hashes'"));
assert(windowsSetup.includes("'--only-binary=:all:'"));
assert(windowsSetup.includes("'-r', dependencyLockPath"));
assert(windowsSetup.includes('zipappPath: pipZipappPath'));
assert.strictEqual(
  (windowsSetup.match(/controlledPipArgs\('install'/g) || []).length,
  1,
  'Windows must use one hash-gated transaction for pip and the whole media pack'
);
assert(!windowsSetup.includes("'--prefer-binary'"));
assert(setupSource.includes('windowsDependencyLock'));
assert(setupSource.includes('requirements-win-cp313-x64.lock'));
assert(setupSource.includes('? pinnedRequirementVersions(lockPath)'));

console.log(`Windows Python dependency lock smoke passed (${packages.size} hashed wheels).`);
