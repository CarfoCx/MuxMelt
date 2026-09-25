'use strict';

// Exercise the real renderer DOM with controlled telemetry responses. No
// production main process, backend, files, or network access is required.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 30000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status === null ? 1 : result.status);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-performance-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

let window;
let checks = 0;
const evaluate = source => window.webContents.executeJavaScript(source, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function verify(expression, message) {
  assert.ok(await evaluate(expression), message);
  checks += 1;
}
async function waitFor(expression) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(15);
  }
  throw new Error(`Timed out: ${expression}`);
}
const nextFrame = () => evaluate('new Promise(resolve => requestAnimationFrame(resolve))');

app.whenReady().then(async () => {
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'workspace-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      offscreen: true, backgroundThrottling: false,
    },
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^(https?|wss?):/.test(details.url) });
  });
  await window.loadFile(path.join(root, 'renderer', 'index.html'));
  await waitFor("typeof toolCache !== 'undefined' && toolCache.home?.initialized");
  await evaluate(`
    window.__testHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__testHidden });
    setLogCollapsed(true);
    window.clearLog();
    window.__logMutations = 0;
    window.__logObserver = new MutationObserver(records => { window.__logMutations += records.length; });
    window.__logObserver.observe(document.getElementById('logEntries'), { childList: true });
    for (let i = 0; i < 1000; i++) window.log('Line ' + i);
  `);
  await nextFrame();
  await verify('window.__logMutations === 0 && logRenderFrame === null && logsByTool.home.length === 200',
    'Collapsed logs retain a bounded buffer without DOM work or render callbacks');
  await evaluate('setLogCollapsed(false)');
  await nextFrame();
  await verify(`document.querySelectorAll('#logEntries > .log-entry').length === 200
    && logEntries.firstElementChild.textContent.includes('Line 800')
    && logEntries.lastElementChild.textContent.includes('Line 999')
    && window.__logMutations === 1`, 'Opening logs renders the latest entries in one DOM batch');

  await evaluate('window.__logMutations = 0; for (let i = 0; i < 1000; i++) window.log("Burst " + i)');
  await nextFrame();
  await verify('window.__logMutations === 1 && logEntries.children.length === 200 && logEntries.lastElementChild.textContent.includes("Burst 999")',
    'A visible log burst commits once and keeps the DOM bounded');
  await evaluate('window.__logMutations = 0; window.clearLog("tts"); window.log("Other tool", "info", "tts")');
  await nextFrame();
  await verify('window.__logMutations === 0 && logEntries.lastElementChild.textContent.includes("Burst 999")',
    'Background tools cannot clear or render over the active log');
  await evaluate('window.__testHidden = true; document.dispatchEvent(new Event("visibilitychange")); window.log("While hidden <b>plain text</b>")');
  await nextFrame();
  await verify('window.__logMutations === 0 && logRenderFrame === null', 'Hidden windows perform no log DOM work');
  await evaluate('window.__testHidden = false; document.dispatchEvent(new Event("visibilitychange"))');
  await nextFrame();
  await verify('logEntries.lastElementChild.textContent.includes("While hidden <b>plain text</b>") && !logEntries.querySelector("b")',
    'Restoring the window renders buffered text safely');

  await evaluate(`
    window.__queueRoot = document.createElement('div');
    window.__queueRoot.innerHTML = '<div class="tool-footer-left"></div>';
    window.updateQueueSummary([{ state: 'processing' }], window.__queueRoot);
    window.__queueMutations = 0;
    window.__queueObserver = new MutationObserver(records => { window.__queueMutations += records.length; });
    window.__queueObserver.observe(window.__queueRoot, { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 200; i++) window.updateQueueSummary([{ state: 'processing', progress: i / 200 }], window.__queueRoot);
  `);
  await verify('window.__queueMutations === 0', 'Progress ticks do not rebuild unchanged queue counts');
  await evaluate('window.updateQueueSummary([{ state: "complete" }], window.__queueRoot)');
  await verify('window.__queueRoot.textContent.includes("Done 1") && !window.__queueRoot.textContent.includes("Working")',
    'Queue counts still update when a job changes state');
  await evaluate('window.__queueObserver.disconnect()');

  await evaluate(`
    window.__vramRequests = [];
    window.__realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (!String(url).includes('/vram?')) return window.__realFetch(url, options);
      return new Promise(resolve => window.__vramRequests.push({ signal: options.signal, resolve }));
    };
    window.__completeVram = index => window.__vramRequests[index].resolve({
      ok: true, json: async () => ({ available: true, gpu_util: 12, temperature: 40, used: 1024, total: 2048 })
    });
    systemStatus.open = false;
    startGpuPolling();
  `);
  await delay(40);
  await verify('window.__vramRequests.length === 0 && _vramTimer === null && _vramController === null',
    'Collapsed processing status has no telemetry requests or polling timers');
  await evaluate('systemStatus.open = true; systemStatus.dispatchEvent(new Event("toggle"))');
  await waitFor('window.__vramRequests.length === 1');
  await evaluate('startGpuPolling(); syncGpuPolling(); window.__completeVram(0)');
  await waitFor('_vramController === null');
  await verify('window.__vramRequests.length === 1 && _vramTimer !== null && gpuUtilStat.textContent === "GPU 12%"',
    'Expanding status refreshes immediately with a single telemetry request');
  await evaluate('systemStatus.open = false; systemStatus.dispatchEvent(new Event("toggle"))');
  await verify('_vramTimer === null && _vramController === null', 'Collapsing status removes the polling timer');

  await evaluate('systemStatus.open = true; systemStatus.dispatchEvent(new Event("toggle"))');
  await waitFor('window.__vramRequests.length === 2');
  await evaluate('stopGpuPolling(); window.__completeVram(1)');
  await delay(25);
  await verify('window.__vramRequests[1].signal.aborted && _vramTimer === null && _vramController === null && !gpuStats.classList.contains("active")',
    'Stopping telemetry aborts in-flight work and late responses cannot restart it');

  await evaluate('startGpuPolling()');
  await waitFor('window.__vramRequests.length === 3');
  await evaluate('window.__testHidden = true; document.dispatchEvent(new Event("visibilitychange")); window.__completeVram(2)');
  await delay(25);
  await verify('window.__vramRequests[2].signal.aborted && _vramTimer === null && _vramController === null',
    'Hiding the app aborts telemetry without scheduling background wakeups');
  await evaluate('window.__testHidden = false; document.dispatchEvent(new Event("visibilitychange"))');
  await waitFor('window.__vramRequests.length === 4');
  await verify('_vramController !== null', 'Returning to visible expanded status refreshes telemetry');
  await evaluate('stopGpuPolling(); window.__completeVram(3); window.__logObserver.disconnect()');

  await evaluate('document.getElementById("toolSearchBtn").click(); window.__firstSearchNode = document.getElementById("tool-result-home"); document.getElementById("toolSearchInput").value = "crop"; document.getElementById("toolSearchInput").dispatchEvent(new Event("input")); document.getElementById("toolSearchInput").value = ""; document.getElementById("toolSearchInput").dispatchEvent(new Event("input"))');
  await verify('document.getElementById("tool-result-home") === window.__firstSearchNode && !document.querySelector("#toolSearchResults svg") && document.querySelectorAll("#toolSearchResults [aria-selected=true]").length === 1',
    'Tool search reuses plain result rows and maintains one selected result');
  await verify('window.uiFixture.readErrors().length === 0', 'Renderer has no errors after aborts, late responses, and search updates');
  console.log(`Renderer performance smoke test passed (${checks} checks).`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, path.resolve(userData));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(userData).startsWith('muxmelt-performance-')) {
    await fs.promises.rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  app.exit(process.exitCode || 0);
});
