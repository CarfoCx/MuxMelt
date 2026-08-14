'use strict';

// Focused, offline privacy/security checks for URL Downloader. No external
// request, browser, Python process, or package installer is started here.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const downloader = require('../node-tools/url-downloader');
const privacy = downloader.__privacy;

async function main() {
  // "None" means exactly no browser profile access. A selected browser adds
  // only that browser, never a silent Chrome/Edge/Firefox probe sequence.
  assert.deepStrictEqual(downloader.orderedImpersonationAttempts({}), [
    { impersonate: true },
  ]);
  assert.deepStrictEqual(downloader.orderedImpersonationAttempts({ cookieBrowser: 'firefox' }), [
    { impersonate: true },
    { impersonate: true, cookieBrowser: 'firefox' },
  ]);
  assert.deepStrictEqual(downloader.orderedImpersonationAttempts({ cookieBrowser: 'not-a-browser' }), [
    { impersonate: true },
  ]);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-privacy-test-'));
  try {
    const secrets = {
      proxy: 'https://proxy-user:proxy-pass@example.test:8443',
      username: 'private user',
      password: 'p@ss # with spaces',
      videoPassword: 'video secret',
    };
    const authConfigPath = privacy.writePrivateAuthConfig(secrets, tempDir);
    const args = downloader.buildYtDlpArgs(
      { args: [] }, 'https://example.test/watch', tempDir,
      { ...secrets, authConfigPath }
    );
    const commandLine = args.join(' ');
    assert.ok(args.includes('--ignore-config'));
    for (const secret of Object.values(secrets)) assert.ok(!commandLine.includes(secret));
    for (const flag of ['--proxy', '--username', '--password', '--video-password']) {
      assert.ok(!args.includes(flag));
    }
    assert.strictEqual(args[args.indexOf('--config-locations') + 1], authConfigPath);
    const config = fs.readFileSync(authConfigPath, 'utf8');
    assert.ok(config.includes('--proxy'));
    assert.ok(config.includes('proxy-pass'));
    assert.ok(config.includes('--video-password'));
    assert.ok(privacy.redactSensitiveText(`failed via ${secrets.proxy}`, secrets).includes('[redacted]'));
    assert.throws(() => downloader.buildYtDlpArgs(
      { args: [] }, 'https://example.test/watch', tempDir, { password: 'must-not-leak' }
    ), /Secure temporary storage/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-cleanup-test-'));
  try {
    const stale = fs.mkdtempSync(path.join(cleanupRoot, 'muxmelt-ytdlp-'));
    const recent = fs.mkdtempSync(path.join(cleanupRoot, 'muxmelt-url-cookie-'));
    const unrelated = fs.mkdtempSync(path.join(cleanupRoot, 'other-app-'));
    const now = Date.now();
    fs.utimesSync(stale, new Date(now - (2 * 86400000)), new Date(now - (2 * 86400000)));
    const removed = privacy.cleanupStalePrivateTempDirs(cleanupRoot, now);
    assert.strictEqual(removed, 1);
    assert.strictEqual(fs.existsSync(stale), false);
    assert.strictEqual(fs.existsSync(recent), true);
    assert.strictEqual(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
  }

  // The optional policy boundary is consulted before handlers can perform an
  // external operation, and the shared shutdown registry receives a canceller.
  const handlers = new Map();
  const checkedFeatures = [];
  let registeredCancel = null;
  downloader.registerIPC(
    { handle(name, handler) { handlers.set(name, handler); } },
    () => null,
    () => ({ cmd: 'python', args: [] }),
    {
      isOffline: () => false,
      assertAllowed(feature) {
        checkedFeatures.push(feature);
        throw new Error('blocked by test policy');
      },
    },
    { register(name, cancel) { assert.strictEqual(name, 'url-downloader'); registeredCancel = cancel; } }
  );
  const blocked = await handlers.get('url-downloader-download')(
    { sender: { id: 1 } }, { url: 'https://example.test/watch' }
  );
  assert.strictEqual(blocked.success, false);
  assert.ok(checkedFeatures.includes('url-downloader.download'));
  assert.strictEqual(typeof registeredCancel, 'function');
  await registeredCancel();

  const source = fs.readFileSync(path.join(__dirname, '..', 'node-tools', 'url-downloader.js'), 'utf8');
  for (const forbidden of [
    'BrowserWindow', 'url-downloader-thumbnail', 'validatePublicThumbnailUrl',
    'allowHiddenBrowserFallback', 'url-downloader-update-ytdlp', "'-m', 'pip'",
  ]) assert.ok(!source.includes(forbidden), `backend still exposes ${forbidden}`);

  const rendererSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'tools', 'url-downloader', 'url-downloader.js'),
    'utf8'
  );
  const savedSettings = rendererSource.slice(
    rendererSource.indexOf('function saveToolSettings()'),
    rendererSource.indexOf("window.registerTool('url-downloader'"),
  );
  assert.ok(!savedSettings.includes('cookiesFile:'), 'cookie-file paths must stay session-only');
  assert.ok(!savedSettings.includes('cookieBrowser:'), 'browser-cookie choices must stay session-only');
  assert.ok(rendererSource.includes('delete saved.cookiesFile'));
  assert.ok(rendererSource.includes('delete saved.cookieBrowser'));
  for (const forbidden of ['getThumbnail', 'loadThumbnailForRow', 'hiddenBrowserFallback', 'updateYtDlp']) {
    assert.ok(!rendererSource.includes(forbidden), `renderer still exposes ${forbidden}`);
  }

  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(!preloadSource.includes('url-downloader-thumbnail'));
  assert.ok(!preloadSource.includes('url-downloader-update-ytdlp'));
  const htmlSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'tools', 'url-downloader', 'url-downloader.html'),
    'utf8'
  );
  assert.ok(!htmlSource.includes('hiddenBrowserFallbackCheckbox'));
  assert.ok(!htmlSource.includes('updateYtDlpBtn'));

  console.log('URL Downloader privacy smoke passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
