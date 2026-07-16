'use strict';

// Fast, dependency-free checks for failures that otherwise appear only after a
// user opens a tool in Electron. This intentionally inspects source text rather
// than booting Electron so it remains useful on build machines and clean clones.
const fs = require('fs');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const rendererDir = path.join(root, 'renderer');
const toolsDir = path.join(rendererDir, 'tools');
const failures = [];
let assertions = 0;

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function check(condition, message) {
  assertions += 1;
  if (!condition) failures.push(message);
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function walkJavaScript(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScript(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

function htmlIds(source) {
  const ids = new Set();
  const idPattern = /\bid\s*=\s*(["'])([^"'<>]+)\1/gi;
  let match;
  while ((match = idPattern.exec(source)) !== null) {
    // Ignore template-generated IDs such as id="row-${row.id}". Matching
    // getElementById calls for those are dynamic too and are excluded below.
    if (!match[2].includes('${')) ids.add(match[2]);
  }
  return ids;
}

function literalGetElementByIds(source) {
  const ids = new Set();
  const callPattern = /\bdocument\.getElementById\s*\(\s*(["'`])([^"'`$\s<>]+)\1\s*\)/g;
  let match;
  while ((match = callPattern.exec(source)) !== null) ids.add(match[2]);
  return ids;
}

function addAll(target, source) {
  for (const item of source) target.add(item);
  return target;
}

const indexPath = path.join(rendererDir, 'index.html');
const appPath = path.join(rendererDir, 'app.js');
check(fs.existsSync(indexPath), 'renderer/index.html is missing');
check(fs.existsSync(appPath), 'renderer/app.js is missing');

if (!fs.existsSync(indexPath) || !fs.existsSync(appPath)) {
  console.error(failures.join('\n'));
  process.exit(1);
}

const indexSource = read(indexPath);
const appSource = read(appPath);
const declaredTools = [];
const declarationPattern = /\bdata-tool\s*=\s*(["'])([^"']+)\1/g;
let declaration;
while ((declaration = declarationPattern.exec(indexSource)) !== null) {
  declaredTools.push(declaration[2]);
}

check(declaredTools.length > 0, 'renderer/index.html declares no sidebar tools');
check(
  new Set(declaredTools).size === declaredTools.length,
  'renderer/index.html contains duplicate data-tool declarations'
);

const toolDirectories = fs.readdirSync(toolsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const declaredSet = new Set(declaredTools);
const directorySet = new Set(toolDirectories);

for (const toolId of declaredTools) {
  check(/^[a-z0-9-]+$/.test(toolId), `Invalid sidebar tool ID: ${toolId}`);
  check(directorySet.has(toolId), `Sidebar tool "${toolId}" has no renderer/tools/${toolId} directory`);
}
for (const toolId of toolDirectories) {
  check(declaredSet.has(toolId), `Tool directory "${toolId}" is not declared in the sidebar`);
}

const shellIds = addAll(htmlIds(indexSource), htmlIds(appSource));
const allToolIds = new Set();

for (const toolId of toolDirectories) {
  const directory = path.join(toolsDir, toolId);
  const htmlPath = path.join(directory, `${toolId}.html`);
  const jsPath = path.join(directory, `${toolId}.js`);
  const cssPath = path.join(directory, `${toolId}.css`);

  for (const assetPath of [htmlPath, jsPath, cssPath]) {
    check(fs.existsSync(assetPath), `${relative(assetPath)} is missing`);
  }
  if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) continue;

  const htmlSource = read(htmlPath);
  const jsSource = read(jsPath);
  const registrationPattern = /\b(?:window\.)?registerTool\s*\(\s*(["'`])([^"'`$]+)\1\s*,/g;
  const registrations = [];
  let registration;
  while ((registration = registrationPattern.exec(jsSource)) !== null) {
    registrations.push(registration[2]);
  }

  check(
    registrations.length === 1,
    `${relative(jsPath)} must contain exactly one literal registerTool call (found ${registrations.length})`
  );
  if (registrations.length === 1) {
    check(
      registrations[0] === toolId,
      `${relative(jsPath)} registers "${registrations[0]}" instead of "${toolId}"`
    );
  }

  const validIds = new Set(shellIds);
  addAll(validIds, htmlIds(htmlSource));
  addAll(validIds, htmlIds(jsSource));
  addAll(allToolIds, htmlIds(htmlSource));
  addAll(allToolIds, htmlIds(jsSource));

  for (const id of literalGetElementByIds(jsSource)) {
    check(
      validIds.has(id),
      `${relative(jsPath)} looks up #${id}, but that ID is absent from its HTML, generated markup, and the app shell`
    );
  }
}

// app.js sometimes targets the active tool (for example, the shared Ctrl+O
// shortcut), so its valid DOM is the shell plus markup from every tool.
const appIds = new Set(shellIds);
addAll(appIds, allToolIds);
for (const id of literalGetElementByIds(appSource)) {
  check(
    appIds.has(id),
    `renderer/app.js looks up #${id}, but that ID is absent from the app shell and all tool markup`
  );
}

// A "Send to..." suggestion is only useful when the destination consumes the
// paste-files event. Requiring active-tool gating also prevents cached tools
// from all ingesting the same handoff.
const suggestionsSource = (appSource.match(/function getSendToSuggestions\b[\s\S]*?\n}/) || [''])[0];
const suggestedTools = new Set();
const suggestionPattern = /\btoolId\s*:\s*(["'])([^"']+)\1/g;
let suggestion;
while ((suggestion = suggestionPattern.exec(suggestionsSource)) !== null) {
  suggestedTools.add(suggestion[2]);
}
for (const toolId of suggestedTools) {
  const toolSource = read(path.join(toolsDir, toolId, `${toolId}.js`));
  check(
    /addEventListener\s*\(\s*(["'])paste-files\1/.test(toolSource),
    `Send-to destination "${toolId}" does not listen for paste-files`
  );
  check(
    new RegExp(`isToolActive\\s*\\(\\s*(["'])${toolId}\\1`).test(toolSource),
    `Send-to destination "${toolId}" does not gate paste-files to the active tool`
  );
}

// Execute the preload in a tiny Electron stub and verify every renderer API
// path actually exists. This catches silent preload/renderer drift without
// launching a BrowserWindow.
const preloadPath = path.join(root, 'preload.js');
let exposedApi = null;
try {
  const electronStub = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        if (name === 'api') exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke() { return Promise.resolve(); },
      on() {},
      removeListener() {},
    },
    webUtils: { getPathForFile() { return ''; } },
  };
  const sandbox = {
    require(moduleName) {
      if (moduleName === 'electron') return electronStub;
      throw new Error(`Unexpected preload dependency: ${moduleName}`);
    },
  };
  new vm.Script(read(preloadPath), { filename: relative(preloadPath) }).runInNewContext(sandbox);
  check(exposedApi && typeof exposedApi === 'object', 'preload.js did not expose window.api');
} catch (error) {
  check(false, `preload.js could not be evaluated in the API stub: ${error.message}`);
}

if (exposedApi) {
  const rendererFiles = walkJavaScript(rendererDir);
  const apiPathPattern = /\bwindow\.api((?:\.[A-Za-z_$][A-Za-z0-9_$]*){1,4})/g;
  for (const filePath of rendererFiles) {
    const source = read(filePath);
    let apiUse;
    while ((apiUse = apiPathPattern.exec(source)) !== null) {
      const segments = apiUse[1].slice(1).split('.');
      let value = exposedApi;
      for (const segment of segments) value = value == null ? undefined : value[segment];
      check(value !== undefined, `${relative(filePath)} uses missing preload API window.api.${segments.join('.')}`);
    }
  }
}

// Every invoke channel exposed by either preload must have a main-process
// handler somewhere in the shipped sources.
const setupPreloadPath = path.join(root, 'setup-preload.js');
const invokeChannels = new Set();
for (const preloadSource of [read(preloadPath), read(setupPreloadPath)]) {
  const invokePattern = /\bipcRenderer\.invoke\s*\(\s*(["'])([^"']+)\1/g;
  let invocation;
  while ((invocation = invokePattern.exec(preloadSource)) !== null) invokeChannels.add(invocation[2]);
}
const handlerChannels = new Set();
const handlerFiles = [
  path.join(root, 'main.js'),
  ...walkJavaScript(path.join(root, 'src')),
  ...walkJavaScript(path.join(root, 'node-tools')),
];
for (const handlerFile of handlerFiles) {
  const source = read(handlerFile);
  const handlerPattern = /\bipcMain\.handle\s*\(\s*(["'])([^"']+)\1/g;
  let handler;
  while ((handler = handlerPattern.exec(source)) !== null) handlerChannels.add(handler[2]);
}
for (const channel of invokeChannels) {
  check(handlerChannels.has(channel), `Preload invokes "${channel}", but no ipcMain.handle is registered`);
}

const parseTargets = new Set([
  path.join(root, 'main.js'),
  path.join(root, 'preload.js'),
  path.join(root, 'setup-preload.js'),
  ...walkJavaScript(rendererDir),
  ...walkJavaScript(path.join(root, 'src')),
  ...walkJavaScript(path.join(root, 'node-tools')),
]);

for (const filePath of [...parseTargets].sort()) {
  check(fs.existsSync(filePath), `${relative(filePath)} is missing`);
  if (!fs.existsSync(filePath)) continue;
  try {
    const source = read(filePath).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
    // Main-process and node-tool files run as CommonJS modules (main.js has a
    // deliberate top-level return), while renderer files execute as browser
    // scripts. Parse each source in the same grammatical context it uses.
    const parseSource = filePath.startsWith(`${rendererDir}${path.sep}`)
      ? source
      : Module.wrap(source);
    new vm.Script(parseSource, { filename: relative(filePath), displayErrors: true });
    check(true, `${relative(filePath)} parses`);
  } catch (error) {
    check(false, `${relative(filePath)} has invalid JavaScript: ${error.message}`);
  }
}

// Progress producers use `percent` on a 0-100 scale and `progress` on a 0-1
// scale. Exercise the real per-tool normalizers so a one-percent update can
// never be mistaken for 100% again.
const progressNormalizerFiles = [
  'renderer/tools/audio-extractor/audio-extractor.js',
  'renderer/tools/format-converter/format-converter.js',
  'renderer/tools/video-compressor/video-compressor.js',
  'renderer/tools/gif-maker/gif-maker.js',
];
for (const relativePath of progressNormalizerFiles) {
  const source = read(path.join(root, relativePath));
  const match = source.match(/function normalizeProgress\(data\)\s*\{[\s\S]*?\r?\n\}/);
  check(match, `${relativePath} is missing normalizeProgress`);
  if (!match) continue;
  try {
    const normalize = new vm.Script(`(${match[0]})`).runInNewContext();
    const cases = [
      [{ percent: 1 }, 0.01, 'percent=1'],
      [{ percent: 50 }, 0.5, 'percent=50'],
      [{ percent: 100 }, 1, 'percent=100'],
      [{ progress: 0.25 }, 0.25, 'fractional progress'],
      [{ progress: 50 }, 1, 'progress clamp without percent conversion'],
      [{ progress: 0.2, percent: 80 }, 0.2, 'progress precedence'],
    ];
    for (const [payload, expected, label] of cases) {
      check(
        normalize(payload) === expected,
        `${relativePath} violates progress contract for ${label}`
      );
    }
  } catch (error) {
    check(false, `${relativePath} normalizeProgress could not be exercised: ${error.message}`);
  }
}

const gifMakerSource = read(path.join(root, 'node-tools', 'gif-maker.js'));
const probeIndex = gifMakerSource.indexOf('ffmpeg.probeVideoInfo(inputPath)');
const firstGifRunIndex = gifMakerSource.indexOf('ffmpeg.run({');
check(probeIndex >= 0, 'GIF Maker must probe dimensions with probeVideoInfo');
check(
  probeIndex < firstGifRunIndex,
  'GIF Maker reverse-memory preflight must happen before ffmpeg.run'
);
check(
  gifMakerSource.includes('MAX_REVERSE_MEMORY_BYTES')
    && gifMakerSource.includes('REVERSE_MEMORY_OVERHEAD'),
  'GIF Maker is missing its bounded reverse-memory estimate'
);
check(
  /Shorten the clip or reduce width\/FPS/.test(gifMakerSource),
  'GIF Maker reverse-memory rejection is not actionable'
);

const formatConverterSource = read(path.join(root, 'node-tools', 'format-converter.js'));
check(
  formatConverterSource.includes("args.push('-map_metadata', metadataInput, '-map_chapters', metadataInput)"),
  'Format Converter must explicitly map or strip FFmpeg metadata and chapters'
);

const processTreeSmokePath = path.join(root, 'test', 'url-downloader-process-tree-smoke.js');
check(fs.existsSync(processTreeSmokePath), 'URL process-tree smoke test is missing');
if (fs.existsSync(processTreeSmokePath)) {
  const processTreeResult = require('child_process').spawnSync(
    process.execPath,
    [processTreeSmokePath],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  );
  check(
    processTreeResult.status === 0,
    `URL process-tree smoke failed: ${(processTreeResult.stderr || processTreeResult.stdout || '').trim()}`
  );
}

const bulkImagerSource = read(path.join(root, 'node-tools', 'bulk-imager.js'));
check(
  bulkImagerSource.includes("sharp(inputPath, { animated: true }).metadata()")
    && bulkImagerSource.includes('Number(inputMetadata.pages || 1) > 1'),
  'Bulk Imager must explicitly reject animated or multi-page inputs'
);
check(
  /_tmp_chain_[\s\S]*?crypto\.randomUUID\(\)[\s\S]*?\.png/.test(bulkImagerSource),
  'Bulk Imager chain intermediates must use a lossless PNG format'
);

const videoCompressorSource = read(path.join(root, 'node-tools', 'video-compressor.js'));
check(
  /ext === '\.webm'\s*\|\|\s*ext === '\.avi'/.test(videoCompressorSource),
  'Video Compressor must emit MP4 for WebM/AVI sources when using H.264 or H.265'
);

const updaterSource = read(path.join(root, 'src', 'main', 'updater.js'));
check(
  updaterSource.includes("ipcMain.handle('select-local-update-folder'")
    && updaterSource.includes("ipcMain.handle('clear-local-update-folder'"),
  'Local update source must be owned by dedicated main-process IPC'
);
check(
  updaterSource.includes('version.json must contain the installer SHA-256 value'),
  'Local updater must require an installer hash'
);
check(
  updaterSource.includes("buttons: ['Cancel', 'Run Installer']")
    && updaterSource.includes('defaultId: 0')
    && updaterSource.includes('dialog.showMessageBox'),
  'Local updater must show a native default-Cancel launch confirmation'
);
const ipcHandlersSource = read(path.join(root, 'src', 'main', 'ipc-handlers.js'));
check(
  ipcHandlersSource.includes('delete sanitized.global.updateFolderPath'),
  'Generic renderer settings must not control local update provenance'
);

const chatRendererSource = read(path.join(root, 'renderer', 'tools', 'chat', 'chat.js'));
check(
  chatRendererSource.includes("isDownloading ? 'Cancel download'")
    && chatRendererSource.includes("ws.send(JSON.stringify({ action: 'cancel' }))"),
  'Chat model downloads must expose a cancellation control'
);

if (failures.length > 0) {
  console.error(`Static smoke test failed with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Static smoke test passed: ${toolDirectories.length} tools, ${parseTargets.size} JavaScript files, ${assertions} assertions.`
);
