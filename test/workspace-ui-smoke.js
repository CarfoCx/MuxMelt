'use strict';

// Run with Node; launch the repository's Electron while clearing the host's
// ELECTRON_RUN_AS_NODE flag. This app never imports production main.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 120000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status === null ? 1 : result.status);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'ui');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-ui-smoke-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

let window;
let assertions = 0;
const screenshots = [];
const verify = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const evaluate = script => window.webContents.executeJavaScript(script, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(expression, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(30);
  }
  throw new Error(`Timed out: ${message}`);
}

async function key(keyCode, modifiers = []) {
  keyCode = ({ ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right' })[keyCode] || keyCode;
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(35);
}

async function openTool(id) {
  const result = await evaluate(`window.openTool(${JSON.stringify(id)})`);
  verify(result === true, `${id} must initialize successfully`);
  verify(await evaluate(`document.querySelector('#toolContent > .tool-instance')?.dataset.tool === ${JSON.stringify(id)}
    && document.querySelector('.sidebar-item[aria-current="page"]')?.dataset.tool === ${JSON.stringify(id)}`),
  `${id} must own both content and current navigation`);
  await waitFor('document.getElementById("toolStylesheet").sheet !== null', `${id} stylesheet`);
}

async function screenshot(name) {
  await evaluate('document.querySelectorAll("#toolContent, .home-page").forEach(element => { element.scrollTop = 0; })');
  await delay(350);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const image = await window.webContents.capturePage();
  verify(!image.isEmpty(), `${name} screenshot is not empty`);
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  screenshots.push(name);
}

async function checkLayout(label) {
  const metrics = await evaluate(`(() => {
    const content = document.getElementById('toolContent');
    const sidebar = document.getElementById('sidebar').getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      contentWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      sidebarBottom: sidebar.bottom,
      height: window.innerHeight,
    };
  })()`);
  verify(metrics.pageWidth <= metrics.viewport + 1, `${label}: page overflows horizontally ${JSON.stringify(metrics)}`);
  verify(metrics.contentScrollWidth <= metrics.contentWidth + 1, `${label}: tool overflows horizontally ${JSON.stringify(metrics)}`);
  verify(metrics.sidebarBottom <= metrics.height + 1, `${label}: sidebar exceeds the viewport`);
  verify(await evaluate('Array.from(document.querySelectorAll(".processing-indicator:not(.active)")).every(element => getComputedStyle(element).display === "none")'), `${label}: idle tools must not display a processing message`);
  const effects = await evaluate(`Array.from(document.querySelectorAll('body *')).flatMap(element => {
    const style = getComputedStyle(element);
    return style.animationName !== 'none' || style.transitionDuration !== '0s'
      || style.backdropFilter !== 'none' || style.boxShadow !== 'none'
      ? [element.id || element.className || element.tagName] : [];
  })`);
  verify(effects.length === 0, `${label}: decorative rendering effects remain: ${effects.join(', ')}`);
  verify(await evaluate('document.getAnimations().length === 0'), `${label}: no continuous UI animations`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  window = new BrowserWindow({
    width: 1360, height: 900, useContentSize: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'workspace-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      offscreen: true, backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const networkAttempts = [];
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const isNetwork = /^(https?|wss?):/.test(details.url);
    if (isNetwork) networkAttempts.push(details.url);
    callback({ cancel: isNetwork });
  });
  await window.loadFile(path.join(root, 'renderer', 'index.html'));
  await waitFor("typeof toolCache !== 'undefined' && toolCache.home?.initialized", 'initial home route');
  verify(await evaluate('window.isToolActive("home")'), 'Retired saved chat route falls back to Home');
  const ids = await evaluate('window.WORKSPACE_TOOLS.map(tool => tool.id)');
  verify(ids.length === 14 && !ids.includes('chat'), 'Exactly 14 supported routes exclude Chat');
  verify(await evaluate('window.openTool("chat")') === false, 'Direct chat navigation is blocked');
  verify(await evaluate('window.openTool("../chat")') === false, 'Unknown tool paths are blocked');
  verify(await evaluate('!document.querySelector("[data-tool=chat]") && !window.api.python.installChatPack'), 'Chat has no navigation or install API');
  await screenshot('home-dark');

  for (const [filter, count] of Object.entries({ all: 12, image: 5, video: 5, audio: 4, downloads: 2 })) {
    await evaluate(`document.querySelector('[data-home-filter="${filter}"]').click()`);
    verify(await evaluate(`document.querySelectorAll('#homeToolGrid [data-home-tool]').length === ${count}
      && document.querySelector('[data-home-filter="${filter}"]').getAttribute('aria-pressed') === 'true'
      && document.getElementById('homeToolCount').textContent === '${count} tools'`), `Home ${filter} filter has the expected count and pressed state`);
  }
  await evaluate('document.querySelector("[data-home-filter=all]").click(); document.getElementById("homeToolSearch").value = "no-such-task-xyz"; document.getElementById("homeToolSearch").dispatchEvent(new Event("input", { bubbles: true }))');
  verify(await evaluate('!document.getElementById("homeCatalogEmpty").hidden && document.querySelectorAll("#homeToolGrid button").length === 0'), 'Home empty search gives a reset action');
  await evaluate('document.getElementById("homeResetSearchBtn").click()');
  verify(await evaluate('document.querySelectorAll("#homeToolGrid button").length === 12 && document.activeElement.id === "homeToolSearch"'), 'Reset restores all Home tools and input focus');

  // Search is exercised with Chromium keyboard events, including native dialog
  // cancellation and focus restoration; no calls to its private functions.
  await evaluate('document.getElementById("toolSearchBtn").focus()');
  await key('k', ['control']);
  verify(await evaluate('document.getElementById("toolSearchDialog").open && document.activeElement.id === "toolSearchInput"'), 'Ctrl+K opens focused tool search');
  verify(await evaluate('document.querySelectorAll(".tool-search-result").length === 14'), 'Unfiltered search lists each supported tool');
  await key('ArrowDown');
  verify(await evaluate('document.getElementById("toolSearchInput").getAttribute("aria-activedescendant") === "tool-result-format-converter"'), 'ArrowDown selects the next search result');
  await key('ArrowUp');
  verify(await evaluate('document.getElementById("toolSearchInput").getAttribute("aria-activedescendant") === "tool-result-home"'), 'ArrowUp selects the previous search result');
  await evaluate('document.getElementById("toolSearchInput").value = "no-such-task-xyz"; document.getElementById("toolSearchInput").dispatchEvent(new Event("input", { bubbles: true }))');
  verify(await evaluate('!document.getElementById("toolSearchEmpty").hidden && !document.getElementById("toolSearchInput").hasAttribute("aria-activedescendant")'), 'Empty search shows helpful text and clears the active descendant');
  await key('Escape');
  const escapeState = await evaluate('({ open: document.getElementById("toolSearchDialog").open, focus: document.activeElement.id, query: document.getElementById("toolSearchInput").value })');
  verify(!escapeState.open && escapeState.focus === 'toolSearchBtn', `Escape closes search and restores trigger focus: ${JSON.stringify(escapeState)}`);
  await key('k', ['control']);
  await evaluate('document.getElementById("toolSearchInput").value = "crop"; document.getElementById("toolSearchInput").dispatchEvent(new Event("input", { bubbles: true }))');
  await key('Enter');
  await waitFor('window.isToolActive("bulk-imager") && document.activeElement.id === "toolContent"', 'keyboard search navigation');
  verify(await evaluate('!document.getElementById("toolSearchDialog").open'), 'Enter opens the chosen task and dismisses search');

  for (const id of ids) {
    await openTool(id);
    await checkLayout(`${id} at 1360 x 900`);
  }
  verify(await evaluate('!document.getElementById("installChatPackBtn") && document.getElementById("legacyChatStorage").hidden'), 'Settings contains no chat install option or empty legacy storage row');
  await evaluate('document.getElementById("settingsTabGeneral").focus()');
  await key('ArrowRight');
  verify(await evaluate('document.activeElement.id === "settingsTabPrivacy" && !document.getElementById("settingsPanelPrivacy").hidden && document.getElementById("settingsPanelGeneral").hidden'), 'Settings arrow navigation focuses and selects the next tab');
  await key('End');
  verify(await evaluate('document.activeElement.id === "settingsTabAbout" && !document.getElementById("settingsPanelAbout").hidden'), 'Settings End key opens the last category');
  await key('Home');
  verify(await evaluate('document.activeElement.id === "settingsTabGeneral" && !document.getElementById("settingsPanelGeneral").hidden'), 'Settings Home key returns to General');
  await screenshot('settings-dark');
  await evaluate('document.getElementById("settingsTabPrivacy").click()');
  await screenshot('settings-privacy-dark');

  // State must survive cached navigation, while a single script/DOM instance
  // prevents duplicate subscriptions and queue additions.
  await openTool('tts');
  await evaluate('document.getElementById("ttsText").value = "Keep this draft"; window.__draftNode = document.getElementById("ttsText")');
  await openTool('home');
  await openTool('tts');
  verify(await evaluate('document.getElementById("ttsText") === window.__draftNode && document.getElementById("ttsText").value === "Keep this draft"'), 'Cached navigation preserves the same draft node and text');
  verify(await evaluate('document.querySelectorAll("#toolScript-tts").length === 1'), 'Cached tool script is loaded only once');

  await openTool('home');
  await evaluate('document.getElementById("browseBtn").click()');
  await waitFor('!document.getElementById("homeSuggestions").hidden', 'Home selected-file suggestions');
  verify(await evaluate('document.getElementById("selectedFileSummary").textContent.includes("sample.mp4")'), 'Home describes the selected fixture file');
  await evaluate(`Array.from(document.querySelectorAll('#suggestionGrid button')).find(button => /convert/i.test(button.textContent)).click()`);
  await waitFor('window.isToolActive("format-converter") && document.querySelector("#fileList .file-name")?.textContent.includes("sample.mp4")', 'Home handoff to converter queue');
  verify(await evaluate('document.querySelectorAll("#fileList .file-name").length === 1 && !document.getElementById("convertBtn").disabled'), 'Home handoff adds exactly one file and enables the converter');
  // Catch any accidental primary action before the real tool listener, keeping
  // the regression test safe even if the keyboard guard breaks in the future.
  await evaluate(`window.__unexpectedPrimaryClicks = 0;
    window.__blockPrimaryForSmoke = event => { window.__unexpectedPrimaryClicks += 1; event.preventDefault(); event.stopImmediatePropagation(); };
    document.getElementById('convertBtn').addEventListener('click', window.__blockPrimaryForSmoke, true);
    document.getElementById('toolSearchBtn').focus()`);
  await key('k', ['control']);
  await evaluate('document.getElementById("toolSearchInput").value = "format converter"; document.getElementById("toolSearchInput").dispatchEvent(new Event("input", { bubbles: true }))');
  await key('Enter');
  await waitFor('!document.getElementById("toolSearchDialog").open && document.activeElement.id === "toolContent"', 'search returns to ready converter');
  verify(await evaluate('window.__unexpectedPrimaryClicks === 0'), 'Choosing a search result with Enter must not start a ready tool');

  await evaluate('document.getElementById("shortcutsBtn").focus(); document.getElementById("shortcutsBtn").click()');
  verify(await evaluate('document.getElementById("shortcutsOverlay").getAttribute("aria-hidden") === "false"'), 'Shortcuts opens its modal');
  const picksBeforeModal = await evaluate('window.uiFixture.readFilePickCount()');
  await key('k', ['control']);
  verify(await evaluate('!document.getElementById("toolSearchDialog").open'), 'Tool search cannot stack over the shortcuts modal');
  await key('Enter');
  await key('o', ['control']);
  verify(await evaluate('window.__unexpectedPrimaryClicks === 0'), 'Enter inside a modal cannot start background processing');
  verify(await evaluate('window.uiFixture.readFilePickCount()') === picksBeforeModal, 'Ctrl+O inside a modal cannot open the background file picker');
  await key('Escape');
  verify(await evaluate('document.getElementById("shortcutsOverlay").getAttribute("aria-hidden") === "true" && getComputedStyle(document.getElementById("shortcutsOverlay")).visibility === "hidden" && document.activeElement.id === "shortcutsBtn"'), 'Escape hides shortcuts and restores focus');
  await evaluate('document.getElementById("convertBtn").removeEventListener("click", window.__blockPrimaryForSmoke, true)');
  await screenshot('converter-dark');

  await evaluate('document.getElementById("clearBtn").click()');
  await evaluate(`window.openFilesInTool('format-converter', ['C:\\\\UI-fixture\\\\large-image.png'])`);
  await waitFor('document.querySelector("#fileList .file-name")?.textContent === "large-image.png"', 'image queue');
  verify(await evaluate('!document.querySelector("#fileList img") && document.querySelector("#fileList .file-type")?.textContent === "PNG"'), 'Queuing an image uses a text type label without decoding a thumbnail');

  await openTool('home');
  await evaluate('document.getElementById("clearSelectionBtn").click(); document.getElementById("themeToggleBtn").click()');
  verify(await evaluate('document.documentElement.dataset.theme === "mono-light"'), 'Theme toggle activates the light design');
  await screenshot('home-light');
  window.setContentSize(900, 650);
  await delay(100);
  for (const id of ids) {
    await openTool(id);
    await checkLayout(`${id} at 900 x 650`);
    if (id === 'url-downloader' || id === 'video-compressor') await screenshot(`${id}-light-900`);
  }
  await evaluate('document.getElementById("settingsTabGeneral").click()');
  await screenshot('settings-light-900');
  await evaluate('document.getElementById("settingsTabComponents").click()');
  await screenshot('settings-components-light-900');
  await openTool('home');
  await screenshot('home-light-900');
  for (const [width, height] of [[820, 540], [960, 700]]) {
    window.setContentSize(width, height);
    await delay(100);
    for (const id of ['url-downloader', 'qr-studio', 'settings']) {
      await openTool(id);
      await checkLayout(`${id} at ${width} x ${height}`);
    }
    for (const tab of ['General', 'Privacy', 'Components', 'About']) {
      await evaluate(`document.getElementById('settingsTab${tab}').click()`);
      await checkLayout(`Settings ${tab} at ${width} x ${height}`);
    }
  }
  const fixtureErrors = await evaluate('window.uiFixture.readErrors()');
  verify(fixtureErrors.length === 0, `Renderer errors: ${fixtureErrors.join('\n')}`);
  verify((await evaluate('window.uiFixture.readCalls()')).length === 0, 'No destructive, network, install, or real-tool API was invoked');
  verify(networkAttempts.length === 0, `No network request expected: ${networkAttempts.join(', ')}`);
  fs.writeFileSync(path.join(outputDir, 'smoke-report.json'), JSON.stringify({ assertions, routes: ids, screenshots, sizes: [[1360, 900], [900, 650], [820, 540], [960, 700]] }, null, 2));
  console.log(`Workspace UI smoke passed (${assertions} checks, ${ids.length} routes, 4 viewport sizes). Screenshots: ${outputDir}`);
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  // This target is constructed by mkdtemp under the OS temp root, never from
  // preferences or real app-data. Validate the absolute containment explicitly.
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, path.resolve(userData));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(userData).startsWith('muxmelt-ui-smoke-')) {
    await fs.promises.rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  app.exit(process.exitCode || 0);
});
