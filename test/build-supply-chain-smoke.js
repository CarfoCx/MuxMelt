'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = require('../build/download-manifest.json');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const {
  assertAllowedDownloadUrl,
  validateDownloadManifest
} = require('../build/prepare-python');

function packageRoot(resolvedEntry) {
  let current = path.dirname(resolvedEntry);
  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not find package root for ${resolvedEntry}`);
    current = parent;
  }
}

assert.strictEqual(validateDownloadManifest(manifest), manifest);
assert.deepStrictEqual(
  [...manifest.allowedHosts].sort(),
  ['github.com', 'release-assets.githubusercontent.com']
);

const supportedTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64'
];
const requiredAssets = supportedTargets.flatMap((target) => [
  `ffmpeg-${target}`,
  `ffprobe-${target}`,
  `ffmpeg-license-${target}`,
  `ffmpeg-readme-${target}`,
  `python-${target}`
]);
for (const name of requiredAssets) {
  const asset = manifest.assets[name];
  assert(asset, `missing pinned asset ${name}`);
  assert.strictEqual(asset.maxBytes, asset.size, `${name} must have an exact size cap`);
  assert(!/\/latest\/|getrelease/i.test(asset.url), `${name} URL must be immutable`);
  assertAllowedDownloadUrl(asset.url);
}

assert.throws(
  () => assertAllowedDownloadUrl('http://github.com/example/file'),
  /non-HTTPS/
);
assert.throws(
  () => assertAllowedDownloadUrl('https://example.com/file'),
  /unapproved host/
);
assert.throws(
  () => validateDownloadManifest({
    schemaVersion: 1,
    allowedHosts: ['github.com'],
    assets: {
      bad: { url: 'https://github.com/file', sha256: '0'.repeat(63), size: 1, maxBytes: 1 }
    }
  }),
  /sha256/
);

assert(packageLock.lockfileVersion >= 3, 'npm lockfile v3 or newer is required');
assert.strictEqual(packageLock.packages[''].version, packageJson.version);
assert.strictEqual(packageJson.devDependencies['ffmpeg-static'], undefined);
assert.strictEqual(packageJson.overrides.ip, 'npm:neoip@2.1.0');
assert.strictEqual(packageJson.overrides['ip-address'], '10.5.0');
const trackerRoot = path.join(root, 'node_modules', 'bittorrent-tracker');
const ipPath = require.resolve('ip', { paths: [trackerRoot] });
const ipPackage = require(path.join(packageRoot(ipPath), 'package.json'));
const ip = require(ipPath);
assert.strictEqual(ipPackage.name, 'neoip');
assert.strictEqual(ipPackage.version, '2.1.0');
assert.strictEqual(ip.isPrivate('127.0.0.1'), true);
assert.strictEqual(ip.isPrivate('8.8.8.8'), false);

for (const configName of ['slim.json', 'web.json']) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'build', configName), 'utf8'));
  assert.strictEqual(config.extends, 'build/base.json');
}

const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'release-builds.yml'),
  'utf8'
);
assert(/\bnpm ci\b/.test(releaseWorkflow), 'release workflow must use npm ci');
assert(!/\bnpm install\b/.test(releaseWorkflow), 'release workflow must not mutate the lockfile');

console.log(`Build supply-chain smoke passed (${Object.keys(manifest.assets).length} pinned assets).`);
