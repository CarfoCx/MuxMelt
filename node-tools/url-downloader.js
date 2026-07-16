'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { validateOutputDir, formatToolError } = require('./path-utils');
const { BrowserWindow, net } = require('electron');

function sendToolProgress(win, payload) {
  try {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    if (!win.webContents || (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed())) return;
    win.webContents.send('tool-progress', payload);
  } catch {}
}

function cancelledError() {
  const err = new Error('Download cancelled by user.');
  err.code = 'CANCELLED';
  return err;
}

// On POSIX, detached children lead a new process group. yt-dlp and pip can
// launch their own ffmpeg/helper descendants, so cancellation must target the
// whole group rather than only the Python leader. Windows uses taskkill /T
// below and therefore keeps its existing spawn behavior.
function spawnProcessTree(cmd, args, options = {}) {
  return spawn(cmd, args, process.platform === 'win32'
    ? options
    : { ...options, detached: true });
}

function terminateProcessTree(proc) {
  if (!proc || !Number.isSafeInteger(proc.pid) || proc.pid <= 0) return;
  if (process.platform === 'win32') {
    if (proc.exitCode !== null) return;
    try {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', () => { try { proc.kill('SIGKILL'); } catch {} });
      killer.once('close', (code) => { if (code !== 0) { try { proc.kill('SIGKILL'); } catch {} } });
    } catch {
      try { proc.kill('SIGKILL'); } catch {}
    }
    return;
  }

  const processGroupId = -proc.pid;
  try { process.kill(processGroupId, 'SIGTERM'); } catch {}
  // Always escalate against the group ID. The Python leader can exit on TERM
  // while an ffmpeg descendant remains alive in the same process group.
  const timer = setTimeout(() => {
    try { process.kill(processGroupId, 'SIGKILL'); } catch {}
  }, 3000);
  if (typeof timer.unref === 'function') timer.unref();
}

// Promise wrapper around spawn so long-running Python/pip calls never block the
// Electron main process (execFileSync freezes the entire UI for its timeout).
function execFileAsync(cmd, args, { timeout = 0, operation = null } = {}) {
  return new Promise((resolve, reject) => {
    if (operation && operation.cancelled) { reject(cancelledError()); return; }
    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;
    const MAX_OUTPUT = 16 * 1024 * 1024;
    const proc = spawnProcessTree(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (operation) operation.processes.add(proc);
    if (timeout > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateProcessTree(proc);
        if (operation) operation.processes.delete(proc);
        reject(new Error(`Process timed out after ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (next.length <= MAX_OUTPUT) return next;
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        terminateProcessTree(proc);
        if (operation) operation.processes.delete(proc);
        reject(new Error('Process output exceeded the safety limit.'));
      }
      return current;
    };
    proc.stdout.on('data', (c) => { stdout = append(stdout, c); });
    proc.stderr.on('data', (c) => { stderr = append(stderr, c); });
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (operation) operation.processes.delete(proc);
      reject(operation && operation.cancelled ? cancelledError() : err);
    });
    proc.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (operation) operation.processes.delete(proc);
      if (operation && operation.cancelled) { reject(cancelledError()); return; }
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`);
        err.code = code;
        reject(err);
      }
    });
  });
}

// Selectable quality presets -> max video height passed to yt-dlp's format
// selector. Keeping this as data avoids a copy-pasted if-ladder per resolution.
const RESOLUTION_FORMATS = {
  '2160p': 2160,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360,
};

function defaultOutputDir() {
  return path.join(os.homedir(), 'Downloads', 'MuxMelt Downloads');
}

function resolveOutputFile(candidate, outDir) {
  if (typeof candidate !== 'string' || !candidate.trim()) return '';
  const cleaned = candidate.trim().replace(/^"+|"+$/g, '');
  const resolved = path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(outDir, cleaned));
  const relative = path.relative(outDir, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
  try { return fs.statSync(resolved).isFile() ? resolved : ''; } catch { return ''; }
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isDirectVideoUrl(parsed) {
  return !!parsed && /\.(mp4|m4v|mov|webm|mkv|avi)(?:$|[?#])/i.test(parsed.pathname);
}

function isMotherlessUrl(parsed) {
  return !!parsed && /(^|\.)motherless(?:media)?\.com$/i.test(parsed.hostname);
}

function getSignedUrlExpiry(parsed) {
  if (!parsed) return null;
  const validTo = Number(parsed.searchParams.get('validto'));
  if (!Number.isFinite(validTo) || validTo <= 0) return null;
  return new Date(validTo * 1000);
}

function buildRequestHeaders(url, options = {}) {
  const parsed = parseUrl(url);
  const directVideo = isDirectVideoUrl(parsed);
  const motherless = isMotherlessUrl(parsed);
  const headers = [];

  const userAgent = typeof options.userAgent === 'string' && options.userAgent.trim() && !/[\r\n]/.test(options.userAgent)
    ? options.userAgent.slice(0, 1000)
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

  if (!options.impersonate) {
    headers.push(
      ['--user-agent', userAgent],
      ['--add-header', 'Accept-Language:en-US,en;q=0.9'],
    );
  }

  if (directVideo || !options.impersonate) {
    headers.push(['--add-header', directVideo ? 'Accept:*/*' : 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7']);
  }

  if (motherless) {
    headers.push(
      ['--referer', 'https://motherless.com/'],
      ['--add-header', 'Sec-Fetch-Site:cross-site'],
    );
  }

  if (typeof options.referer === 'string' && isHttpUrl(options.referer) && !/[\r\n]/.test(options.referer)) {
    headers.push(['--referer', options.referer]);
  }

  if (directVideo) {
    headers.push(
      ['--add-header', 'Sec-Fetch-Dest:video'],
      ['--add-header', 'Sec-Fetch-Mode:no-cors'],
    );
  }

  return headers.flat();
}

function parseProgressLine(line) {
  const percentMatch = line.match(/\[download\]\s+([\d.]+)%/i);
  if (!percentMatch) return null;

  const speedMatch = line.match(/\bat\s+([^\s]+\/s)/i);
  const etaMatch = line.match(/\bETA\s+([^\s]+)/i);
  const sizeMatch = line.match(/\bof\s+~?([^\s]+)/i);
  const percent = Math.max(0, Math.min(100, parseFloat(percentMatch[1]) || 0));

  return {
    percent,
    speed: speedMatch ? speedMatch[1] : '',
    eta: etaMatch ? etaMatch[1] : '',
    size: sizeMatch ? sizeMatch[1] : ''
  };
}

function extractDestination(line) {
  const patterns = [
    /\[download\]\s+Destination:\s+(.+)$/i,
    /\[Merger\]\s+Merging formats into\s+"(.+)"$/i,
    /\[MoveFiles\]\s+Moving file\s+"[^"]+"\s+to\s+"(.+)"$/i,
    /\[ExtractAudio\]\s+Destination:\s+(.+)$/i
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

function shouldRetryWithImpersonation(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return message.includes('403') ||
    message.includes('forbidden') ||
    message.includes('http error 404') ||
    message.includes('http error 410') ||
    message.includes('http error 503') ||
    message.includes('cloudflare') ||
    message.includes('just a moment') ||      // Cloudflare challenge page title
    message.includes('challenge') ||
    message.includes('unable to download webpage') ||
    message.includes('impersonat') ||
    message.includes('sign in') ||
    message.includes('confirm your age') ||
    message.includes('age-restricted') ||
    message.includes('login required') ||
    message.includes('requires login') ||
    message.includes('members only') ||
    message.includes('private video');
}

// A "we parsed the page but found no video" failure, as opposed to a block.
// yt-dlp emits these when a page embeds its stream in a way the generic
// extractor can't see (e.g. a base64-encoded iframe/player URL). Browser
// impersonation can't help here — only the in-app stream sniffer can — so
// these are routed straight to the sniffer fallback.
function isExtractionFailure(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return message.includes('unsupported url') ||
    message.includes('no video formats found') ||
    message.includes('no media formats found') ||
    message.includes('unable to extract') ||
    message.includes('no suitable formats');
}

const IMPERSONATION_BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari'];
// Cap how many browser-cookie attempts we make. Each spawns yt-dlp and can
// stall on a locked cookie DB (e.g. the browser is running), so trying all
// seven is slow; the selected browser plus a couple of common fallbacks covers
// the realistic cases.
const MAX_BROWSER_COOKIE_ATTEMPTS = 3;

/**
 * Build the ordered, bounded list of impersonation retry attempts.
 * Returns descriptors like { impersonate, cookieBrowser? , cookiesFile? }.
 * - A cookies file (if provided) is the single most reliable option, so it is
 *   used alone.
 * - Otherwise: impersonation without cookies first, then the user-selected
 *   browser, then a bounded set of other browsers.
 */
function orderedImpersonationAttempts(options = {}, cap = MAX_BROWSER_COOKIE_ATTEMPTS) {
  const cookiesFile = options.cookiesFile && typeof options.cookiesFile === 'string'
    ? options.cookiesFile.trim()
    : '';
  if (cookiesFile) {
    return [{ impersonate: true, cookiesFile }];
  }

  const attempts = [{ impersonate: true }];
  const selected = options.cookieBrowser;
  const ordered = [];
  if (selected && IMPERSONATION_BROWSERS.includes(selected)) ordered.push(selected);
  for (const b of IMPERSONATION_BROWSERS) {
    if (b !== selected) ordered.push(b);
  }
  for (const b of ordered.slice(0, Math.max(0, cap))) {
    attempts.push({ impersonate: true, cookieBrowser: b });
  }
  return attempts;
}

async function hasPythonModule(pythonInfo, moduleName, operation = null) {
  try {
    await execFileAsync(pythonInfo.cmd, [
      ...(pythonInfo.args || []),
      '-c',
      `import ${moduleName}`
    ], { timeout: 10000, operation });
    return true;
  } catch {
    return false;
  }
}

let ytDlpInstallPromise = null;

function waitForOperation(task, operation) {
  if (!operation) return task;
  if (operation.cancelled) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      operation.cancelWaiters.delete(cancelWaiter);
      callback(value);
    };
    const cancelWaiter = () => finish(reject, cancelledError());
    operation.cancelWaiters.add(cancelWaiter);
    task.then(
      value => finish(resolve, value),
      err => finish(reject, err)
    );
  });
}

async function installYtDlpImpersonationDeps(pythonInfo, operation = null) {
  if (!ytDlpInstallPromise) {
    const task = execFileAsync(pythonInfo.cmd, [
      ...(pythonInfo.args || []),
      '-m',
      'pip',
      'install',
      '--upgrade',
      'yt-dlp[default,curl-cffi]',
      '--no-warn-script-location'
    ], { timeout: 300000 });
    ytDlpInstallPromise = task;
    const clear = () => {
      if (ytDlpInstallPromise === task) ytDlpInstallPromise = null;
    };
    task.then(clear, clear);
  }
  return waitForOperation(ytDlpInstallPromise, operation);
}

function formatDownloadError(err, url) {
  const message = err && err.message ? err.message : String(err || '');
  const lower = message.toLowerCase();
  const parsed = parseUrl(url);
  const expires = getSignedUrlExpiry(parsed);

  if (expires && expires.getTime() <= Date.now()) {
    return `This direct video link expired on ${expires.toLocaleString()}. Open the video page again and paste a fresh link.`;
  }
  if (expires && (lower.includes('403') || lower.includes('forbidden') || lower.includes('404') || lower.includes('410'))) {
    return `The site rejected this signed video link. It may have expired or require a fresh link from the video page. Link expiry: ${expires.toLocaleString()}.`;
  }
  if (lower.includes('http error 410') || lower.includes('410: gone')) {
    return 'This video has been removed or permanently deleted by the site. The URL no longer exists.';
  }
  if (lower.includes('http error 404') || lower.includes('404: not found')) {
    return 'This video was not found. It may have been deleted or the URL is incorrect.';
  }
  if (lower.includes('video is unavailable') || lower.includes('this video is unavailable')) {
    return 'This video is unavailable. It may have been removed, made private, or restricted in your region.';
  }

  return formatToolError(err, 'Online Video Downloader');
}

function buildYtDlpArgs(pythonInfo, url, outDir, options = {}) {
  const args = [
    ...(pythonInfo.args || []),
    '-u',
    '-m', 'yt_dlp',
    '--newline',
    '--no-color',
    '--progress',
    '--paths', outDir,
    // Ask yt-dlp to print the final path directly. --exec shells out and is an
    // unnecessary command-execution surface when filenames come from a site.
    '--print', 'after_move:filepath',
  ];
  if (typeof options.tempDir === 'string' && path.isAbsolute(options.tempDir)) {
    args.push('--paths', `temp:${options.tempDir}`);
  }

  // Playlist options
  if (options.playlist) {
    args.push('--yes-playlist');
    const maxDownloads = Number(options.maxDownloads);
    if (Number.isFinite(maxDownloads) && maxDownloads > 0) {
      args.push('--max-downloads', String(Math.min(1000, Math.floor(maxDownloads))));
    }
  } else {
    args.push('--no-playlist');
  }

  // Output filename template
  const template = options.filenameTemplate || 'title-id';
  let outTemplate = '%(title).200B [%(id)s].%(ext)s'; // default
  if (template === 'title') {
    outTemplate = '%(title).200B.%(ext)s';
  } else if (template === 'uploader-title') {
    outTemplate = '%(uploader).100B - %(title).100B.%(ext)s';
  } else if (template === 'date-title') {
    outTemplate = '%(upload_date)s - %(title).200B.%(ext)s';
  } else if (template === 'uploader-title-id') {
    outTemplate = '%(uploader).100B - %(title).100B [%(id)s].%(ext)s';
  }
  args.push('-o', outTemplate);

  // Quality options
  const format = options.format || 'best';
  const maxHeight = RESOLUTION_FORMATS[format];
  if (format === 'audioonly') {
    const requestedAudioFormat = String(options.audioFormat || 'mp3').toLowerCase();
    const aFormat = ['best', 'mp3', 'm4a', 'opus', 'vorbis', 'wav', 'flac', 'aac', 'alac'].includes(requestedAudioFormat)
      ? requestedAudioFormat
      : 'mp3';
    args.push('-x', '--audio-format', aFormat, '--audio-quality', '0');
  } else if (maxHeight) {
    args.push(
      '-f',
      `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`,
      '--merge-output-format', 'mp4'
    );
  } else if (format === 'custom') {
    if (typeof options.customFormat === 'string' && options.customFormat.trim() && options.customFormat.length <= 1000 && !/[\r\n\0]/.test(options.customFormat)) {
      args.push('-f', options.customFormat.trim());
    } else {
      args.push('--merge-output-format', 'mp4');
    }
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  // Subtitles
  if (options.subtitles === 'embed') {
    args.push('--write-subs', '--embed-subs');
  } else if (options.subtitles === 'separate') {
    args.push('--write-subs');
  }
  if (options.subtitles && options.subtitles !== 'none') {
    if (typeof options.subLangs === 'string' && options.subLangs.trim() && options.subLangs.length <= 500 && !/[\r\n\0]/.test(options.subLangs)) {
      args.push('--sub-langs', options.subLangs.trim());
    } else {
      args.push('--sub-langs', 'all');
    }
  }

  // SponsorBlock
  if (options.skipSponsors) {
    args.push('--sponsorblock-remove', 'all');
  }

  // Metadata & Thumbnail
  if (options.embedMetadata) {
    args.push('--embed-metadata');
  }
  if (options.embedThumbnail) {
    args.push('--embed-thumbnail');
  }

  // Speed Limit
  if (typeof options.limitRate === 'string' && options.limitRate.trim()) {
    const limitRate = options.limitRate.trim();
    if (!/^\d+(?:\.\d+)?[kKmMgG]?$/.test(limitRate)) throw new Error('Invalid download speed limit.');
    args.push('--limit-rate', limitRate);
  }

  // Split Chapters
  if (options.splitChapters) {
    args.push('--split-chapters');
  }

  // Write Description/Thumbnail files
  if (options.writeDescription) {
    args.push('--write-description');
  }
  if (options.writeThumbnail) {
    args.push('--write-thumbnail');
  }

  // Auth & Network
  if (typeof options.proxy === 'string' && options.proxy.trim()) {
    const proxy = options.proxy.trim();
    if (/[\r\n\0]/.test(proxy) || proxy.length > 2000) throw new Error('Invalid proxy URL.');
    args.push('--proxy', proxy);
  }
  const credentials = [
    ['--username', options.username],
    ['--password', options.password],
    ['--video-password', options.videoPassword]
  ];
  for (const [flag, value] of credentials) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (value.length > 2000 || /[\r\n\0]/.test(value)) throw new Error('Invalid authentication value.');
    args.push(flag, value.trim());
  }
  if (options.geoBypass) {
    args.push('--geo-bypass');
  }

  // Performance & Processing
  const concurrentFragments = Number(options.concurrentFragments);
  if (Number.isFinite(concurrentFragments) && concurrentFragments > 0) {
    args.push('--concurrent-fragments', String(Math.min(16, Math.floor(concurrentFragments))));
  }
  if (typeof options.timeRange === 'string' && options.timeRange.trim()) {
    const timeRange = options.timeRange.trim();
    if (!/^[0-9:.+-]+$/.test(timeRange) || timeRange.length > 100) throw new Error('Invalid time range.');
    args.push('--download-sections', `*${timeRange}`);
  }
  if (options.writeAutoSubs) {
    args.push('--write-auto-subs');
  }

  // Impersonation
  if (options.impersonate) {
    args.push('--impersonate', 'chrome');
    args.push('--extractor-args', 'generic:impersonate');
  }

  if (IMPERSONATION_BROWSERS.includes(options.cookieBrowser)) {
    args.push('--cookies-from-browser', options.cookieBrowser);
  }

  if (typeof options.cookiesFile === 'string' && options.cookiesFile.trim()) {
    args.push('--cookies', options.cookiesFile.trim());
  }

  args.push(...buildRequestHeaders(url, options));
  args.push(url);
  return args;
}

function describeYtDlpStage(line, modeLabel) {
  if (/^\[download\]\s+Destination:/i.test(line)) {
    return `${modeLabel}Download started. Saving file...`;
  }
  if (/^\[download\]\s+100%/i.test(line)) {
    return `${modeLabel}Download received. Finalizing file...`;
  }
  if (/^\[info\]/i.test(line) || /^\[[^\]]+\]\s+.+?:\s+Downloading webpage/i.test(line)) {
    return `${modeLabel}Fetching video info...`;
  }
  if (/^\[[^\]]+\]\s+.+?:\s+Downloading/i.test(line)) {
    return `${modeLabel}Site accepted request. Preparing download...`;
  }
  return '';
}

// Extension of a URL's path (lowercased, no query/hash), or '' when none.
function urlPathExt(u) {
  try {
    const m = new URL(u).pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// HLS (.m3u8) and DASH (.mpd) manifests are the preferred capture target —
// they carry every quality and let yt-dlp mux audio + video.
function isManifestUrl(u) {
  const ext = urlPathExt(u);
  return ext === 'm3u8' || ext === 'mpd';
}

async function sniffVideoUrl(url, win, timeoutMs = 15000, operation = null) {
  if (win) {
    sendToolProgress(win, {
      tool: 'url-downloader',
      url,
      type: 'start',
      progress: 0.05,
      status: 'Universal fallback: Sniffing webpage for video streams...'
    });
  }

  return new Promise((resolve, reject) => {
    if (operation && operation.cancelled) { reject(cancelledError()); return; }
    const candidates = [];
    const candidateUrls = new Set();
    const addCandidate = (candidateUrl, size = 0) => {
      if (!candidateUrl || candidateUrls.has(candidateUrl) || candidates.length >= 500) return;
      candidateUrls.add(candidateUrl);
      candidates.push({ url: candidateUrl, size });
    };
    let isDone = false;
    const finishTimers = new Set();

    // Isolated, non-persistent session so the request listener and captured
    // cookies never touch the app's default session or other concurrent sniffs.
    const partition = `sniffer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const snifferWin = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // This window deliberately loads untrusted (often hostile) pages and
        // auto-clicks consent/play controls, so lock it down: sandbox the
        // renderer and never expose Node.
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
        partition
      }
    });
    const snifferSession = snifferWin.webContents.session;

    // The fallback loads untrusted pages only to observe media requests. It
    // never needs device/location/notification access and must not save files
    // as a side effect of the automated consent/play clicks below.
    const denyPermissionRequest = (_webContents, _permission, callback) => callback(false);
    const denyPermissionCheck = () => false;
    const denyDevicePermission = () => false;
    const blockDownload = (event, item) => {
      event.preventDefault();
      try { item.cancel(); } catch {}
    };
    try { snifferSession.setPermissionRequestHandler(denyPermissionRequest); } catch {}
    try { snifferSession.setPermissionCheckHandler(denyPermissionCheck); } catch {}
    try { snifferSession.setDevicePermissionHandler(denyDevicePermission); } catch {}
    try { snifferSession.on('will-download', blockDownload); } catch {}

    snifferWin.webContents.setWindowOpenHandler(() => {
      return { action: 'deny' };
    });

    // Keep the sniffer on http(s) pages only. The page-driving script below
    // clicks elements heuristically, which can trigger navigations to custom
    // protocol handlers (e.g. an installed-app scheme) — block anything that
    // isn't a normal web navigation.
    const blockNonHttpNav = (e, navUrl) => {
      if (!/^https?:\/\//i.test(navUrl)) e.preventDefault();
    };
    snifferWin.webContents.on('will-navigate', blockNonHttpNav);
    snifferWin.webContents.on('will-redirect', blockNonHttpNav);

    const standardUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
    snifferWin.webContents.setUserAgent(standardUa);

    const teardown = () => {
      for (const timer of finishTimers) clearTimeout(timer);
      finishTimers.clear();
      try { snifferSession.removeListener('will-download', blockDownload); } catch {}
      try { snifferSession.setPermissionRequestHandler(null); } catch {}
      try { snifferSession.setPermissionCheckHandler(null); } catch {}
      try { snifferSession.setDevicePermissionHandler(null); } catch {}
      try { snifferSession.webRequest.onHeadersReceived(null); } catch {}
      if (!snifferWin.isDestroyed()) snifferWin.destroy();
    };

    const abort = () => {
      if (isDone) return;
      isDone = true;
      if (operation && operation.abortSniffer === abort) operation.abortSniffer = null;
      teardown();
      reject(cancelledError());
    };
    if (operation) operation.abortSniffer = abort;

    const done = async () => {
      if (isDone) return;
      isDone = true;
      if (operation && operation.abortSniffer === abort) operation.abortSniffer = null;

      // Final DOM scrape: catch plain progressive players whose <video>/<source>
      // src or og:video tag never surfaced as a sniffable network response.
      try {
        if (!snifferWin.isDestroyed()) {
          const domUrls = await snifferWin.webContents.executeJavaScript(`
            (() => {
              const out = [];
              const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
              document.querySelectorAll('video[src], video source[src], source[src]').forEach(el => {
                const u = abs(el.getAttribute('src')); if (u) out.push(u);
              });
              document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').forEach(m => {
                const u = abs(m.getAttribute('content')); if (u) out.push(u);
              });
              return out;
            })();
          `).catch(() => []);
          for (const u of (domUrls || [])) {
            if (u && /^https?:/i.test(u)) addCandidate(u);
          }
        }
      } catch {}

      candidates.sort((a, b) => {
        const am = isManifestUrl(a.url);
        const bm = isManifestUrl(b.url);
        if (am && !bm) return -1;
        if (!am && bm) return 1;
        return b.size - a.size;
      });

      if (candidates.length === 0) {
        teardown();
        reject(new Error('Universal downloader could not find any video streams on this page.'));
        return;
      }

      let cookiesText;
      const userAgent = snifferWin.webContents.getUserAgent();
      try {
        const cookies = await snifferSession.cookies.get({});
        cookiesText = '# Netscape HTTP Cookie File\n';
        for (const c of cookies) {
          const domain = c.domain;
          const includeSubDomain = domain.startsWith('.') ? 'TRUE' : 'FALSE';
          const cookiePath = c.path || '/';
          const secure = c.secure ? 'TRUE' : 'FALSE';
          const expiration = c.expirationDate ? Math.round(c.expirationDate) : 0;
          cookiesText += `${domain}\t${includeSubDomain}\t${cookiePath}\t${secure}\t${expiration}\t${c.name}\t${c.value}\n`;
        }
      } catch {}

      teardown();
      resolve({ url: candidates[0].url, cookiesText, userAgent });
    };

    const scheduleDone = (delay) => {
      const timer = setTimeout(() => {
        finishTimers.delete(timer);
        done();
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
      finishTimers.add(timer);
    };

    snifferSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: false });

      const responseHeaders = details.responseHeaders || {};
      const type = (responseHeaders['content-type'] || responseHeaders['Content-Type'] || [])[0] || '';
      const sizeStr = (responseHeaders['content-length'] || responseHeaders['Content-Length'] || [])[0] || '0';
      const size = parseInt(sizeStr, 10) || 0;
      const ext = urlPathExt(details.url);

      const isManifest = ext === 'm3u8' || ext === 'mpd';
      const isVideoType = type.includes('video/') ||
        type.includes('mpegurl') ||        // HLS: application/(vnd.apple.)?mpegurl
        type.includes('dash+xml');         // DASH: application/dash+xml
      const isVideoUrl = isManifest || ext === 'mp4' || ext === 'm4v' || ext === 'webm' || ext === 'mov';

      // Skip obvious page/script/style assets that can share a video-ish MIME.
      if ((isVideoType || isVideoUrl) && !['js', 'mjs', 'html', 'css'].includes(ext)) {
        if (isManifest || size > 100000 || size === 0) {
          addCandidate(details.url, size);
          // A manifest is the ideal target — give late variants a brief window, then finish.
          if (isManifest || candidates.length >= 5) {
            scheduleDone(1500);
          }
        }
      }
    });

    snifferWin.loadURL(url).catch(() => {});

    snifferWin.webContents.on('did-finish-load', () => {
      snifferWin.webContents.executeJavaScript(`
        setInterval(() => {
          window.scrollBy(0, 500);
          document.querySelectorAll('video').forEach(el => {
            if (el.paused) { try { el.play(); } catch(e) {} }
          });
          document.querySelectorAll('button, a, div[class*="play"], div[id*="play"]').forEach(el => {
            const text = (el.innerText || '').trim().toLowerCase();
            // Only act on short, button-like labels. Matching innerHTML or long
            // text clicked unrelated containers (e.g. any block containing the
            // word "play"), which could trip downloads or popups.
            if (!text || text.length > 20) return;
            if (text === 'play' || text === 'continue' || text === 'enter' || text === 'yes' ||
                text.includes('agree') || text.includes('accept')) {
              try { el.click(); } catch(e) {}
            }
          });
          
          const x = window.innerWidth / 2;
          const y = window.innerHeight / 2;
          const element = document.elementFromPoint(x, y);
          if (element) {
            try { element.click(); } catch(e) {}
          }
        }, 1000);
      `).catch(() => {});
    });

    scheduleDone(timeoutMs);
  });
}

// Fetch a remote thumbnail in the main process and return it as a data: URL.
// The renderer's strict CSP (img-src 'self' data: file:) blocks remote https
// images, so we proxy the bytes here and hand back an inline data URL it can
// render. Many CDNs also gate thumbnails on a browser UA / page Referer, which
// the renderer's <img> can't set — we can.
function fetchThumbnailDataUrl(thumbUrl, referer, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const MAX_BYTES = 8 * 1024 * 1024; // thumbnails are small; cap to be safe
    let request;
    try {
      request = net.request({ url: thumbUrl, redirect: 'follow' });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { request.abort(); } catch {}
      finish(reject, new Error('Thumbnail request timed out'));
    }, timeoutMs);

    try {
      request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
      request.setHeader('Accept', 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8');
      if (referer && isHttpUrl(referer) && !/[\r\n]/.test(referer)) request.setHeader('Referer', referer);
    } catch (err) {
      try { request.abort(); } catch {}
      finish(reject, err);
      return;
    }

    request.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.on('data', () => {});
        response.on('end', () => finish(reject, new Error(`Thumbnail request failed (HTTP ${status})`)));
        response.on('error', () => finish(reject, new Error(`Thumbnail request failed (HTTP ${status})`)));
        return;
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
        try { request.abort(); } catch {}
        finish(reject, new Error('Thumbnail too large'));
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BYTES) {
          try { request.abort(); } catch {}
          finish(reject, new Error('Thumbnail too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        const buf = Buffer.concat(chunks);
        if (!buf.length) { finish(reject, new Error('Empty thumbnail')); return; }
        const isJpeg = buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
        const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        const isGif = buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'));
        const isWebp = buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
        const isAvif = buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(buf.subarray(8, 12).toString('ascii'));
        if (!isJpeg && !isPng && !isGif && !isWebp && !isAvif) {
          finish(reject, new Error('Thumbnail content is not a recognized image'));
          return;
        }
        const detectedMime = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isGif ? 'image/gif' : isWebp ? 'image/webp' : 'image/avif';
        finish(resolve, `data:${detectedMime};base64,${buf.toString('base64')}`);
      });
      response.on('error', (err) => finish(reject, err));
    });

    request.on('error', (err) => finish(reject, err));
    request.end();
  });
}

function registerIPC(ipcMain, getMainWindow, getPythonInfo) {
  const activeDownloadsByWindow = new Map();
  const activeInfoByWindow = new Map();
  const MAX_CONCURRENT_INFO_REQUESTS = 3;

  ipcMain.handle('url-downloader-download', async (event, options = {}) => {
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
    const url = String(options.url || '').trim();
    const operation = { cancelled: false, processes: new Set(), abortSniffer: null, cancelWaiters: new Set() };

    try {
      if (!isHttpUrl(url)) {
        return { success: false, error: 'Enter a valid http or https URL.' };
      }
      let windowOperations = activeDownloadsByWindow.get(winId);
      if (!windowOperations) {
        windowOperations = new Set();
        activeDownloadsByWindow.set(winId, windowOperations);
      }
      windowOperations.add(operation);

      const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
      if (!pythonInfo || !pythonInfo.cmd) {
        return { success: false, error: 'Python was not found. Online Video Downloader requires Python with yt-dlp installed.' };
      }

      const outDir = validateOutputDir(options.outputDir) || defaultOutputDir();
      fs.mkdirSync(outDir, { recursive: true });
      operation.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-ytdlp-'));
      options = { ...options, tempDir: operation.tempDir };
      const downloadStartedAt = Date.now();
      const filesBeforeDownload = new Set();
      try {
        for (const name of fs.readdirSync(outDir)) filesBeforeDownload.add(path.resolve(outDir, name));
      } catch {}

      const win = getMainWindow();
      if (win) {
        sendToolProgress(win, {
          tool: 'url-downloader',
          url,
          type: 'start',
          status: 'Starting download...'
        });
      }

      let stdout = '';
      let stderr = '';
      let outputPath = '';

      const runDownload = (args, runOptions = {}) => new Promise((resolve, reject) => {
        if (operation.cancelled) { reject(cancelledError()); return; }
        const statusPrefix = runOptions.statusPrefix || '';
        const modeLabel = runOptions.modeLabel ? `${runOptions.modeLabel} | ` : '';
        let lastStageStatus = '';
        
        // Smoothing state
        let overallProgress = 0;
        let currentStreamStart = 0;
        let lastRawPercent = 0;
        let smoothedEtaSeconds = -1;
        let lastSpeed = '';
        let stdoutRemainder = '';
        let stderrRemainder = '';
        let processSettled = false;

        const proc = spawnProcessTree(pythonInfo.cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1'
          },
          windowsHide: true
        });

        operation.processes.add(proc);

        const parseEtaToSeconds = (etaStr) => {
          if (!etaStr) return 0;
          const parts = etaStr.split(':').map(Number);
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          return 0;
        };

        const formatSecondsToEta = (sec) => {
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          const s = Math.floor(sec % 60);
          if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
          return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        };

        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          const progress = parseProgressLine(trimmed);
          const destination = extractDestination(trimmed);
          if (destination) outputPath = destination;

          const stageStatus = describeYtDlpStage(trimmed, modeLabel);
          if (stageStatus && stageStatus !== lastStageStatus && win) {
            lastStageStatus = stageStatus;
            sendToolProgress(win, {
              tool: 'url-downloader',
              url,
              type: 'start',
              progress: Math.max(0.02, runOptions.minProgress || 0),
              status: stageStatus
            });
          }

          // Extract final output path.
          if (!trimmed.startsWith('[') && /[\\/]/.test(trimmed)) {
            outputPath = trimmed.replace(/^"+|"+$/g, '');
          }

          if (progress && win) {
            // Fluent Progress Smoothing
            if (progress.percent < lastRawPercent && lastRawPercent - progress.percent > 50) {
              // A new stream started (e.g. audio track after video track)
              currentStreamStart = overallProgress;
            } else if (progress.percent < lastRawPercent) {
              // Minor regression (concurrent fragments jitter), enforce monotonicity
              progress.percent = lastRawPercent;
            }
            lastRawPercent = progress.percent;

            const remainingSpace = 100 - currentStreamStart;
            const scaledPercent = currentStreamStart + (progress.percent * remainingSpace * 0.9 / 100);
            
            if (scaledPercent > overallProgress) {
              overallProgress = scaledPercent;
            }

            // ETA Smoothing (Exponential Moving Average)
            const currentEtaSeconds = parseEtaToSeconds(progress.eta);
            if (currentEtaSeconds > 0) {
              if (smoothedEtaSeconds === -1) smoothedEtaSeconds = currentEtaSeconds;
              else smoothedEtaSeconds = smoothedEtaSeconds * 0.8 + currentEtaSeconds * 0.2;
            }
            const displayEta = smoothedEtaSeconds > 0 ? formatSecondsToEta(smoothedEtaSeconds) : '';
            
            if (progress.speed) lastSpeed = progress.speed;

            sendToolProgress(win, {
              tool: 'url-downloader',
              url,
              type: 'progress',
              progress: overallProgress / 100,
              status: [
                `${statusPrefix}Downloading... ${Math.round(overallProgress)}%`,
                lastSpeed,
                displayEta ? `ETA ${displayEta}` : ''
              ].filter(Boolean).join(' | '),
              size: progress.size
            });
          }
        };

        // Cap the retained buffers. Progress parsing happens per-line above, so
        // only the tail is needed afterwards (for error extraction / the output
        // path fallback). Without this, a long playlist or a very chatty
        // extractor grows these strings unbounded in the main process.
        const capBuffer = (s) => (s.length > 65536 ? s.slice(-32768) : s);
        const handleChunkLines = (text, stream) => {
          const combined = (stream === 'stdout' ? stdoutRemainder : stderrRemainder) + text;
          const lines = combined.split(/\r\n|\n|\r/);
          const remainder = (lines.pop() || '').slice(-65536);
          if (stream === 'stdout') stdoutRemainder = remainder;
          else stderrRemainder = remainder;
          lines.forEach(line => handleLine(line.length > 65536 ? line.slice(-65536) : line));
        };

        proc.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          stdout += text;
          stdout = capBuffer(stdout);
          handleChunkLines(text, 'stdout');
        });

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderr += text;
          stderr = capBuffer(stderr);
          handleChunkLines(text, 'stderr');
        });

        proc.once('error', (err) => {
          if (processSettled) return;
          processSettled = true;
          operation.processes.delete(proc);
          reject(operation.cancelled ? cancelledError() : err);
        });
        proc.once('close', (code) => {
          if (processSettled) return;
          processSettled = true;
          operation.processes.delete(proc);
          if (stdoutRemainder) handleLine(stdoutRemainder);
          if (stderrRemainder) handleLine(stderrRemainder);
          if (operation.cancelled) { reject(cancelledError()); return; }
          if (code === 0) resolve();
          else {
            const combined = `${stderr}\n${stdout}`.trim();
            const lines = combined.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const usefulLines = lines.filter(l => l && !l.startsWith('[download]'));
            let errorMessage = `yt-dlp exited with code ${code}`;
            const errorLine = usefulLines.find(l => l.toUpperCase().startsWith('ERROR:'));
            if (errorLine) {
              errorMessage = errorLine;
            } else {
              errorMessage = usefulLines.reverse().find(Boolean) || errorMessage;
            }
            const err = new Error(errorMessage);
            err.fullOutput = combined;
            reject(err);
          }
        });
      });

      const format = String(options.format || 'best');
      const cookiesFile = options.cookiesFile && typeof options.cookiesFile === 'string' ? options.cookiesFile.trim() : '';

      // Build once before entering the network-retry block so malformed user
      // options fail immediately instead of triggering installs and sniffer work.
      const initialArgs = buildYtDlpArgs(pythonInfo, url, outDir, options);
      try {
        await runDownload(initialArgs);
      } catch (err) {
        if (operation.cancelled) throw cancelledError();
        const extractionFailure = isExtractionFailure(err);
        // Universal fallback: don't give up on the first error. Whatever the
        // failure (403/blocked, 404 "not found", geo, or an unrecognised error),
        // fall through to browser-impersonation retries and then the in-app
        // stream sniffer below — if the page plays in a browser, we try to grab
        // it. (A genuinely dead link just fails a bit later, after we've tried.)
        if (!extractionFailure && !(await hasPythonModule(pythonInfo, 'curl_cffi', operation))) {
          if (operation.cancelled) throw cancelledError();
          if (win) {
            sendToolProgress(win, {
              tool: 'url-downloader',
              url,
              type: 'start',
              status: 'Installing browser impersonation support...'
            });
          }
          try {
            await installYtDlpImpersonationDeps(pythonInfo, operation);
          } catch (installErr) {
            if (operation.cancelled) throw cancelledError();
            // No network or a read-only install — don't abort. Impersonation may
            // already be available, or the retries will surface a clear error.
            if (win) {
              sendToolProgress(win, {
                tool: 'url-downloader',
                url,
                type: 'start',
                status: 'Could not install impersonation support; trying anyway...'
              });
            }
          }
        }

        const baseConfig = {
          ...options,
          format,
          cookiesFile: cookiesFile || undefined
        };

        const retryConfigs = extractionFailure ? [] : orderedImpersonationAttempts(options).map((attempt) => {
          const label = attempt.cookiesFile
            ? 'Cookies mode'
            : (attempt.cookieBrowser ? `Browser mode (${attempt.cookieBrowser})` : 'Browser mode');
          const statusMsg = attempt.cookiesFile
            ? 'Standard request blocked. Browser impersonation with cookies file is active...'
            : (attempt.cookieBrowser
              ? `Retrying with ${attempt.cookieBrowser} browser cookies...`
              : 'Standard request blocked. Browser impersonation is active...');
          return { ...baseConfig, ...attempt, statusMsg, label };
        });

        // Seed with the original error so that when there are no impersonation
        // attempts (extraction failure), the sniffer fallback below still runs.
        let lastRetryErr = err;
        for (const config of retryConfigs) {
          if (win) {
            sendToolProgress(win, {
              tool: 'url-downloader',
              url,
              type: 'start',
              progress: 0.02,
              status: config.statusMsg
            });
          }
          stdout = '';
          stderr = '';
          outputPath = '';
          try {
            await runDownload(buildYtDlpArgs(pythonInfo, url, outDir, config), {
              statusPrefix: `${config.label} | `,
              modeLabel: config.label,
              minProgress: 0.02
            });
            lastRetryErr = null;
            break;
          } catch (e) {
            if (operation.cancelled) throw cancelledError();
            lastRetryErr = e;
          }
        }
        // Before the (heavier) sniffer, try yt-dlp's GENERIC extractor on the
        // original page with impersonation. This frequently rescues a video
        // whose site-specific extractor returned 404/403 but whose page still
        // exposes an m3u8/og:video — and it's much faster than the sniffer.
        if (lastRetryErr) {
          if (win) {
            sendToolProgress(win, {
              tool: 'url-downloader', url, type: 'start', progress: 0.02,
              status: 'Site extractor failed — trying generic extractor...'
            });
          }
          stdout = ''; stderr = ''; outputPath = '';
          try {
            const genericArgs = buildYtDlpArgs(pythonInfo, url, outDir, { ...baseConfig, impersonate: true });
            const gi = genericArgs.lastIndexOf(url);
            if (gi !== -1) genericArgs.splice(gi, 0, '--use-extractors', 'generic');
            await runDownload(genericArgs, {
              statusPrefix: 'Generic | ', modeLabel: 'Generic | ', minProgress: 0.02
            });
            lastRetryErr = null;
          } catch (e) {
            if (operation.cancelled) throw cancelledError();
            lastRetryErr = e;
          }
        }

        if (lastRetryErr) {
          let sniffedData = null;
          try {
            sniffedData = await sniffVideoUrl(url, win, 30000, operation);
          } catch (sniffErr) {
            if (operation.cancelled) throw cancelledError();
            throw lastRetryErr;
          }
          
          if (sniffedData && sniffedData.url) {
            if (win) {
              sendToolProgress(win, {
                tool: 'url-downloader', url, type: 'start', progress: 0.1,
                status: 'Stream found! Downloading...'
              });
            }
            stdout = ''; stderr = ''; outputPath = '';
            
            let tempCookieDir = '';
            let tempCookieFile = '';
            if (sniffedData.cookiesText) {
              // Harvested session cookies are sensitive. Write them into a
              // private, unpredictable temp dir with owner-only permissions
              // rather than a predictably-named, world-readable file in the
              // shared temp root (which also collided on concurrent downloads).
              tempCookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxmelt-'));
              tempCookieFile = path.join(tempCookieDir, 'cookies.txt');
              fs.writeFileSync(tempCookieFile, sniffedData.cookiesText, { mode: 0o600 });
            }

            const sniffConfig = {
              ...options,
              format,
              cookiesFile: tempCookieFile || cookiesFile || undefined,
              userAgent: sniffedData.userAgent
            };

            // Build args for the captured stream, forcing the generic extractor
            // so a site-specific extractor can't re-trigger the original failure.
            let pageOrigin = '';
            try { pageOrigin = new URL(url).origin; } catch {}
            // `sendReferer` toggles the page Referer/Origin headers. Most CDNs
            // *require* them (hotlink protection), but some do the inverse and
            // reject a cross-origin Referer (404/403) while serving fine with
            // none — so we must try both ways, not assume one.
            const buildSniffedArgs = ({ impersonate, sendReferer }) => {
              const args = buildYtDlpArgs(pythonInfo, sniffedData.url, outDir, {
                ...sniffConfig,
                impersonate,
                referer: sendReferer ? url : undefined
              });
              const insert = ['--use-extractors', 'generic'];
              // Many HLS/DASH CDNs gate segments on Origin (not just Referer).
              if (sendReferer && pageOrigin) insert.push('--add-header', `Origin:${pageOrigin}`);
              const urlIndex = args.lastIndexOf(sniffedData.url);
              if (urlIndex !== -1) args.splice(urlIndex, 0, ...insert);
              return args;
            };

            // Try the realistic combinations in order of likelihood: page
            // Referer first (hotlink-protected CDNs), then without it (CDNs that
            // reject a cross-origin Referer); each both plain and impersonated.
            // Plain first within a pair — best for already-authenticated streams
            // via the captured cookies; impersonation second for CDNs that
            // demand a browser TLS fingerprint.
            const sniffAttempts = [
              { impersonate: false, sendReferer: true,  label: 'Universal' },
              { impersonate: true,  sendReferer: true,  label: 'Universal+' },
              { impersonate: false, sendReferer: false, label: 'Universal (no-referer)' },
              { impersonate: true,  sendReferer: false, label: 'Universal+ (no-referer)' }
            ];
            try {
              let sniffErr = null;
              let downloaded = false;
              for (let i = 0; i < sniffAttempts.length; i++) {
                const attempt = sniffAttempts[i];
                if (i > 0 && win) {
                  sendToolProgress(win, {
                    tool: 'url-downloader', url, type: 'start', progress: 0.1,
                    status: `Stream blocked the previous request — retrying (${attempt.label})...`
                  });
                }
                stdout = ''; stderr = ''; outputPath = '';
                try {
                  await runDownload(buildSniffedArgs(attempt), {
                    statusPrefix: `${attempt.label} | `, modeLabel: `${attempt.label} | `, minProgress: 0.1
                  });
                  downloaded = true;
                  break;
                } catch (e) {
                  if (operation.cancelled) throw cancelledError();
                  sniffErr = e;
                }
              }
              if (!downloaded) throw sniffErr || lastRetryErr;
            } finally {
              if (tempCookieDir) {
                try { fs.rmSync(tempCookieDir, { recursive: true, force: true }); } catch(e) {}
              }
            }
          } else {
            throw lastRetryErr;
          }
        }
      }

      outputPath = resolveOutputFile(outputPath, outDir);
      const concurrentOperations = activeDownloadsByWindow.get(winId);
      if (!outputPath && (!concurrentOperations || concurrentOperations.size <= 1)) {
        const candidates = fs.readdirSync(outDir)
          .map(name => {
            const file = path.resolve(outDir, name);
            try { return { file, stat: fs.statSync(file) }; } catch { return null; }
          })
          .filter(file => {
            if (!file || !file.stat.isFile() || /\.(part|ytdl|tmp)$/i.test(file.file)) return false;
            return !filesBeforeDownload.has(file.file) || file.stat.mtimeMs >= downloadStartedAt - 2000;
          })
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        outputPath = candidates[0] ? candidates[0].file : '';
      }
      if (!outputPath) throw new Error('Download finished, but the output file could not be located.');

      if (win) {
        sendToolProgress(win, {
          tool: 'url-downloader',
          url,
          type: 'complete',
          progress: 1,
          status: 'Complete',
          output: outputPath
        });
      }

      return { success: true, output: outputPath, outputDir: outDir };
    } catch (err) {
      if (operation.cancelled || (err && err.code === 'CANCELLED')) {
        return { success: false, cancelled: true, error: 'Download cancelled by user.' };
      }
      if ((err.message || '').toLowerCase().includes('no module named')) {
        return { success: false, error: 'yt-dlp is not installed in Python. Run setup again or install Python dependencies from python/requirements.txt.' };
      }
      if ((err.message || '').toLowerCase().includes('impersonate') || (err.message || '').toLowerCase().includes('curl_cffi')) {
        return { success: false, error: 'This site blocks standard downloads. Install the bundled Python dependencies again so yt-dlp can use browser impersonation (curl_cffi).' };
      }
      return { success: false, error: formatDownloadError(err, url) };
    } finally {
      operation.cancelWaiters.clear();
      if (operation.tempDir) {
        try { fs.rmSync(operation.tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
      }
      const windowOperations = activeDownloadsByWindow.get(winId);
      if (windowOperations) {
        windowOperations.delete(operation);
        if (windowOperations.size === 0) activeDownloadsByWindow.delete(winId);
      }
    }
  });

  ipcMain.handle('url-downloader-cancel', async (event) => {
    const winId = event.sender.id;
    const operations = activeDownloadsByWindow.get(winId);
    if (operations && operations.size > 0) {
      for (const operation of operations) {
        operation.cancelled = true;
        if (typeof operation.abortSniffer === 'function') operation.abortSniffer();
        for (const cancelWaiter of [...operation.cancelWaiters]) cancelWaiter();
        for (const proc of operation.processes) terminateProcessTree(proc);
      }
      return { success: true, cancelled: operations.size };
    }
    return { success: false, error: 'No active URL download to cancel' };
  });

  ipcMain.handle('url-downloader-info', async (event, options = {}) => {
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
    const url = String(options.url || '').trim();
    const suppliedRequestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
    if (suppliedRequestId && (!/^[A-Za-z0-9._:-]+$/.test(suppliedRequestId) || suppliedRequestId.length > 200)) {
      return { success: false, error: 'Invalid video information request ID.' };
    }
    const requestId = suppliedRequestId || `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const cancelledInfoResponse = () => ({
      success: false,
      cancelled: true,
      requestId,
      error: 'Video information request cancelled.'
    });
    if (!isHttpUrl(url)) {
      return { success: false, requestId, error: 'Enter a valid http or https URL.' };
    }

    const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
    if (!pythonInfo || !pythonInfo.cmd) {
      return { success: false, requestId, error: 'Python environment not found.' };
    }

    let windowRequests = activeInfoByWindow.get(winId);
    if (!windowRequests) {
      windowRequests = new Map();
      activeInfoByWindow.set(winId, windowRequests);
    }
    if (windowRequests.has(requestId)) {
      return { success: false, requestId, error: 'This video information request is already running.' };
    }
    if (windowRequests.size >= MAX_CONCURRENT_INFO_REQUESTS) {
      return { success: false, requestId, error: 'Too many video information requests are running.' };
    }
    const operation = { cancelled: false, processes: new Set(), cancelWaiters: new Set() };
    windowRequests.set(requestId, operation);

    try {
    const runInfo = (args) => new Promise((resolve, reject) => {
      if (operation.cancelled) { reject(cancelledError()); return; }
      const MAX_INFO_OUTPUT = 16 * 1024 * 1024;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const proc = spawnProcessTree(pythonInfo.cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1'
        },
        windowsHide: true
      });
      operation.processes.add(proc);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateProcessTree(proc);
        operation.processes.delete(proc);
        reject(new Error('Timed out while fetching video information.'));
      }, 60000);
      if (typeof timer.unref === 'function') timer.unref();

      const append = (current, chunk) => {
        const next = current + chunk.toString();
        if (next.length > MAX_INFO_OUTPUT) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            terminateProcessTree(proc);
            operation.processes.delete(proc);
            reject(new Error('Video information response was too large.'));
          }
          return current;
        }
        return next;
      };

      proc.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });

      proc.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });

      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation.processes.delete(proc);
        reject(operation.cancelled ? cancelledError() : err);
      });
      proc.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation.processes.delete(proc);
        if (operation.cancelled) { reject(cancelledError()); return; }
        if (code === 0) {
          resolve(stdout);
        } else {
          const err = new Error(stderr.trim() || `Process exited with code ${code}`);
          err.fullOutput = `${stderr}\n${stdout}`;
          reject(err);
        }
      });
    });

    const buildInfoArgs = (config) => {
      const args = [
        ...(pythonInfo.args || []),
        '-u',
        '-m', 'yt_dlp',
        '--dump-json',
        '--no-playlist',
      ];
      if (config.impersonate) {
        args.push('--impersonate', 'chrome', '--extractor-args', 'generic:impersonate');
      }
      if (config.cookieBrowser) {
        if (IMPERSONATION_BROWSERS.includes(config.cookieBrowser)) args.push('--cookies-from-browser', config.cookieBrowser);
      }
      if (typeof config.cookiesFile === 'string' && config.cookiesFile.trim()) {
        args.push('--cookies', config.cookiesFile.trim());
      }
      args.push(...buildRequestHeaders(url, config));
      args.push(url);
      return args;
    };

    const parseJsonFromStdout = (str) => {
      const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const jsonLine = lines.find(line => line.startsWith('{'));
      if (!jsonLine) throw new Error('No JSON output found in stdout');
      return JSON.parse(jsonLine);
    };

    try {
      const stdout = await runInfo(buildInfoArgs({ cookiesFile: options.cookiesFile, cookieBrowser: options.cookieBrowser }));
      const info = parseJsonFromStdout(stdout);
      return { success: true, requestId, info };
    } catch (err) {
      if (operation.cancelled || (err && err.code === 'CANCELLED')) {
        return cancelledInfoResponse();
      }
      if (!shouldRetryWithImpersonation(err)) {
        return { success: false, requestId, error: err.message || 'Failed to fetch video info.' };
      }

      if (!(await hasPythonModule(pythonInfo, 'curl_cffi', operation))) {
        if (operation.cancelled) return cancelledInfoResponse();
        try {
          await installYtDlpImpersonationDeps(pythonInfo, operation);
        } catch (e) {
          if (operation.cancelled || (e && e.code === 'CANCELLED')) {
            return cancelledInfoResponse();
          }
          console.error('Failed to install impersonation dependencies during info fetch:', e);
        }
      }

      const retryConfigs = orderedImpersonationAttempts(options);

      let lastErr = err;
      for (const config of retryConfigs) {
        if (operation.cancelled) return cancelledInfoResponse();
        try {
          const stdout = await runInfo(buildInfoArgs(config));
          const info = parseJsonFromStdout(stdout);
          return { success: true, requestId, info };
        } catch (e) {
          if (operation.cancelled || (e && e.code === 'CANCELLED')) {
            return cancelledInfoResponse();
          }
          lastErr = e;
        }
      }

      return { success: false, requestId, error: lastErr.message || 'Failed to fetch video info.' };
    }
    } catch (err) {
      if (operation.cancelled || (err && err.code === 'CANCELLED')) {
        return cancelledInfoResponse();
      }
      return { success: false, requestId, error: err.message || 'Failed to fetch video info.' };
    } finally {
      operation.cancelWaiters.clear();
      const requests = activeInfoByWindow.get(winId);
      if (requests) {
        requests.delete(requestId);
        if (requests.size === 0) activeInfoByWindow.delete(winId);
      }
    }
  });

  ipcMain.handle('url-downloader-info-cancel', async (event, requestId) => {
    const id = typeof requestId === 'string' ? requestId.trim() : '';
    if (!id) return { success: false, error: 'A video information request ID is required.' };
    const requests = activeInfoByWindow.get(event.sender.id);
    const operation = requests && requests.get(id);
    if (!operation) return { success: false, error: 'Video information request is not active.' };
    operation.cancelled = true;
    for (const cancelWaiter of [...operation.cancelWaiters]) cancelWaiter();
    for (const proc of operation.processes) terminateProcessTree(proc);
    return { success: true, requestId: id };
  });

  ipcMain.handle('url-downloader-thumbnail', async (event, options = {}) => {
    options = options && typeof options === 'object' ? options : {};
    const url = String(options.url || '').trim();
    const referer = String(options.referer || '').trim();
    if (!isHttpUrl(url)) {
      return { success: false, error: 'Invalid thumbnail URL.' };
    }
    try {
      const dataUrl = await fetchThumbnailDataUrl(url, referer);
      return { success: true, dataUrl };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('url-downloader-update-ytdlp', async (event) => {
    const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
    if (!pythonInfo || !pythonInfo.cmd) {
      return { success: false, error: 'Python environment not found.' };
    }

    try {
      const { stdout } = await installYtDlpImpersonationDeps(pythonInfo);
      return { success: true, message: stdout.trim() };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
}

module.exports = { registerIPC, buildYtDlpArgs, orderedImpersonationAttempts };
