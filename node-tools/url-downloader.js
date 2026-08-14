'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  spawnSupervised,
  terminateSupervisedProcess,
  supervisedCleanupError,
} = require('../src/main/process-supervisor');
const { validateOutputDir, formatToolError } = require('./path-utils');

const PRIVATE_TEMP_PREFIXES = ['muxmelt-ytdlp-', 'muxmelt-url-cookie-'];
const PRIVATE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupStalePrivateTempDirs(tempRoot = os.tmpdir(), now = Date.now()) {
  const root = path.resolve(tempRoot);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!PRIVATE_TEMP_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const candidate = path.resolve(root, entry.name);
    if (path.dirname(candidate) !== root) continue;
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < PRIVATE_TEMP_MAX_AGE_MS) continue;
      fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      removed++;
    } catch {}
  }
  return removed;
}

async function assertNetworkAllowed(networkPolicy, feature) {
  if (!networkPolicy) return;
  if (typeof networkPolicy.isOffline === 'function' && await networkPolicy.isOffline()) {
    throw new Error('Offline mode is enabled. This action requires network access.');
  }
  if (typeof networkPolicy.assertAllowed === 'function') {
    const allowed = await networkPolicy.assertAllowed(feature);
    if (allowed === false) throw new Error('Network access is disabled for this action.');
  }
}

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

// The intermediary watchdog owns yt-dlp and every ffmpeg/helper it may
// launch. It also reaps the tree if the Electron process disappears abruptly.
function spawnProcessTree(cmd, args, options = {}) {
  return spawnSupervised(cmd, args, options);
}

function terminateProcessTree(proc) {
  terminateSupervisedProcess(proc, 3000);
}

// Promise wrapper around spawn so long-running Python checks never block the
// Electron main process (execFileSync freezes the entire UI for its timeout).
function execFileAsync(cmd, args, { timeout = 0, operation = null } = {}) {
  return new Promise((resolve, reject) => {
    if (operation && operation.cancelled) { reject(cancelledError()); return; }
    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;
    let terminationError = null;
    const MAX_OUTPUT = 16 * 1024 * 1024;
    const proc = spawnProcessTree(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (operation) operation.processes.add(proc);
    const requestTermination = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      if (timer) clearTimeout(timer);
      // Keep the watchdog in operation.processes until `close`: it exits only
      // after its complete child tree has been reaped.
      terminateProcessTree(proc);
    };
    if (timeout > 0) {
      timer = setTimeout(() => {
        requestTermination(new Error(`Process timed out after ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (next.length <= MAX_OUTPUT) return next;
      requestTermination(new Error('Process output exceeded the safety limit.'));
      return current;
    };
    proc.stdout.on('data', (c) => { stdout = append(stdout, c); });
    proc.stderr.on('data', (c) => { stderr = append(stderr, c); });
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (operation) operation.processes.delete(proc);
      reject(operation && operation.cancelled ? cancelledError() : (terminationError || err));
    });
    proc.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (operation) operation.processes.delete(proc);
      const cleanupError = supervisedCleanupError(proc, cmd);
      if (cleanupError) {
        if (operation) operation.cleanupErrors.push(cleanupError);
        reject(cleanupError);
        return;
      }
      if (operation && operation.cancelled) { reject(cancelledError()); return; }
      if (terminationError) { reject(terminationError); return; }
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
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username && !parsed.password;
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
// Retrying browser impersonation cannot help these extraction failures, so we
// skip directly to yt-dlp's generic extractor and then report the error.
function isExtractionFailure(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return message.includes('unsupported url') ||
    message.includes('no video formats found') ||
    message.includes('no media formats found') ||
    message.includes('unable to extract') ||
    message.includes('no suitable formats');
}

const IMPERSONATION_BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari'];

/**
 * Build the ordered list of impersonation retry attempts.
 * Returns descriptors like { impersonate, cookieBrowser? , cookiesFile? }.
 * - A cookies file (if provided) is the single most reliable option, so it is
 *   used alone.
 * - Otherwise: impersonation without cookies first, then only the browser the
 *   user explicitly selected. "None" never probes installed browser profiles.
 */
function orderedImpersonationAttempts(options = {}) {
  const cookiesFile = options.cookiesFile && typeof options.cookiesFile === 'string'
    ? options.cookiesFile.trim()
    : '';
  if (cookiesFile) {
    return [{ impersonate: true, cookiesFile }];
  }

  const attempts = [{ impersonate: true }];
  const selected = options.cookieBrowser;
  if (selected && IMPERSONATION_BROWSERS.includes(selected)) {
    attempts.push({ impersonate: true, cookieBrowser: selected });
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
  } catch (error) {
    if (error?.code === 'PROCESS_CLEANUP_FAILED') throw error;
    return false;
  }
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

function validateSensitiveOption(value, label, { trim = false } = {}) {
  if (typeof value !== 'string' || !value) return '';
  const normalized = trim ? value.trim() : value;
  if (!normalized) return '';
  if (normalized.length > 2000 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function quoteYtDlpConfigValue(value) {
  // yt-dlp configuration files use shell-like quoting but are parsed directly,
  // not executed. One quoted value per line safely preserves spaces and #.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function writePrivateAuthConfig(options, tempDir) {
  const proxy = validateSensitiveOption(options.proxy, 'proxy URL', { trim: true });
  if (proxy) {
    let parsedProxy;
    try { parsedProxy = new URL(proxy); } catch { throw new Error('Invalid proxy URL.'); }
    if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(parsedProxy.protocol)) {
      throw new Error('Proxy must use http, https, socks4, socks5, or socks5h.');
    }
  }
  const username = validateSensitiveOption(options.username, 'username');
  const password = validateSensitiveOption(options.password, 'password');
  const videoPassword = validateSensitiveOption(options.videoPassword, 'video password');
  const entries = [
    ['--proxy', proxy],
    ['--username', username],
    ['--password', password],
    ['--video-password', videoPassword],
  ].filter(([, value]) => value);
  if (entries.length === 0) return '';

  if (typeof tempDir !== 'string' || !path.isAbsolute(tempDir)) {
    throw new Error('Secure temporary storage is unavailable for credentials.');
  }
  const resolvedTemp = path.resolve(tempDir);
  try {
    if (!fs.statSync(resolvedTemp).isDirectory()) throw new Error();
  } catch {
    throw new Error('Secure temporary storage is unavailable for credentials.');
  }
  try { fs.chmodSync(resolvedTemp, 0o700); } catch {}
  const configPath = path.join(resolvedTemp, 'private-auth.conf');
  const content = entries.map(([flag, value]) => `${flag} ${quoteYtDlpConfigValue(value)}`).join('\n') + '\n';
  fs.writeFileSync(configPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(configPath, 0o600); } catch {}
  return configPath;
}

function redactSensitiveText(value, options = {}) {
  let redacted = String(value || '');
  for (const secret of [options.proxy, options.username, options.password, options.videoPassword]) {
    if (typeof secret === 'string' && secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
}

function buildYtDlpArgs(pythonInfo, url, outDir, options = {}) {
  const args = [
    ...(pythonInfo.args || []),
    '-u',
    '-m', 'yt_dlp',
    // User/global yt-dlp config could silently enable browser cookies, a proxy,
    // or other network behavior that contradicts the visible app controls.
    '--ignore-config',
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

  // Authentication values never go on the child process command line. The IPC
  // handler writes them to a private, short-lived yt-dlp config instead.
  const hasRawSecrets = [options.proxy, options.username, options.password, options.videoPassword]
    .some(value => typeof value === 'string' && value.length > 0);
  if (hasRawSecrets && !options.authConfigPath) {
    throw new Error('Secure temporary storage is required for authentication values.');
  }
  if (typeof options.authConfigPath === 'string' && path.isAbsolute(options.authConfigPath)) {
    args.push('--config-locations', options.authConfigPath);
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

function registerIPC(ipcMain, getMainWindow, getPythonInfo, networkPolicy = null, jobRegistry = null) {
  cleanupStalePrivateTempDirs();
  const activeDownloadsByWindow = new Map();
  const activeInfoByWindow = new Map();
  const MAX_CONCURRENT_INFO_REQUESTS = 3;
  // Once a tree cleanup cannot be confirmed, keep the module fail-closed for
  // the rest of the app session. The original operation may already have
  // returned to its renderer, but Offline/maintenance transitions must still
  // learn that files could be in use by an orphaned process.
  let cleanupFailureLatch = null;
  const assertJobStart = (label) => {
    if (cleanupFailureLatch) throw cleanupFailureLatch;
    jobRegistry?.assertCanStart?.(label);
  };

  const createOperation = (extra = {}) => {
    let resolveDone;
    const cleanupErrors = [];
    const done = new Promise((resolve) => { resolveDone = resolve; });
    return {
      cancelled: false,
      processes: new Set(),
      cleanupErrors,
      ...extra,
      done,
      finish: () => {
        if (!cleanupFailureLatch && cleanupErrors.length > 0) {
          cleanupFailureLatch = cleanupErrors[0];
        }
        resolveDone();
      },
    };
  };

  const cancelOperation = (operation) => {
    if (!operation) return;
    operation.cancelled = true;
    for (const proc of operation.processes || []) terminateProcessTree(proc);
  };

  const cancelAllActive = async () => {
    const operationsToWait = [];
    const trackedOperations = [];
    for (const operations of activeDownloadsByWindow.values()) {
      for (const operation of operations) {
        trackedOperations.push(operation);
        operationsToWait.push(operation.done);
        cancelOperation(operation);
      }
    }
    for (const requests of activeInfoByWindow.values()) {
      for (const operation of requests.values()) {
        trackedOperations.push(operation);
        operationsToWait.push(operation.done);
        cancelOperation(operation);
      }
    }
    await Promise.all(operationsToWait);
    const deadline = Date.now() + 5000;
    while (trackedOperations.some((operation) => operation.processes.size > 0)
           && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (trackedOperations.some((operation) => operation.processes.size > 0)) {
      throw new Error('Downloader processes did not stop in time.');
    }
    const cleanupFailures = trackedOperations.flatMap((operation) => operation.cleanupErrors);
    if (!cleanupFailureLatch && cleanupFailures.length > 0) cleanupFailureLatch = cleanupFailures[0];
    if (cleanupFailureLatch) throw cleanupFailureLatch;
  };
  if (jobRegistry && typeof jobRegistry.register === 'function') {
    jobRegistry.register('url-downloader', cancelAllActive, { network: true });
  }

  ipcMain.handle('url-downloader-download', async (event, options = {}) => {
    assertJobStart('Online media download');
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
    const url = String(options.url || '').trim();
    const operation = createOperation();

    try {
      if (!isHttpUrl(url)) {
        return { success: false, error: 'Enter a valid http or https URL without embedded credentials.' };
      }
      await assertNetworkAllowed(networkPolicy, 'url-downloader.download');
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
      try { fs.chmodSync(operation.tempDir, 0o700); } catch {}
      const authConfigPath = writePrivateAuthConfig(options, operation.tempDir);
      options = { ...options, tempDir: operation.tempDir, authConfigPath: authConfigPath || undefined };
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
          const cleanupError = supervisedCleanupError(proc, 'yt-dlp');
          if (cleanupError) {
            operation.cleanupErrors.push(cleanupError);
            reject(cleanupError);
            return;
          }
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
      // options fail immediately.
      const initialArgs = buildYtDlpArgs(pythonInfo, url, outDir, options);
      try {
        await runDownload(initialArgs);
      } catch (err) {
        if (err?.code === 'PROCESS_CLEANUP_FAILED') throw err;
        if (operation.cancelled) throw cancelledError();
        const extractionFailure = isExtractionFailure(err);
        // Try only the available yt-dlp fallbacks. Dependency repair remains a
        // signed Media Pack/app update action, never a download side effect.
        const hasImpersonationSupport = !extractionFailure
          && await hasPythonModule(pythonInfo, 'curl_cffi', operation);

        const baseConfig = {
          ...options,
          format,
          cookiesFile: cookiesFile || undefined
        };

        const retryConfigs = hasImpersonationSupport ? orderedImpersonationAttempts(options).map((attempt) => {
          const label = attempt.cookiesFile
            ? 'Cookies mode'
            : (attempt.cookieBrowser ? `Browser mode (${attempt.cookieBrowser})` : 'Browser mode');
          const statusMsg = attempt.cookiesFile
            ? 'Standard request blocked. Browser impersonation with cookies file is active...'
            : (attempt.cookieBrowser
              ? `Retrying with ${attempt.cookieBrowser} browser cookies...`
              : 'Standard request blocked. Browser impersonation is active...');
          return { ...baseConfig, ...attempt, statusMsg, label };
        }) : [];

        // Seed with the original error for the no-impersonation case.
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
            if (e?.code === 'PROCESS_CLEANUP_FAILED') throw e;
            if (operation.cancelled) throw cancelledError();
            lastRetryErr = e;
          }
        }
        // Try yt-dlp's generic extractor on the original page. This can rescue
        // media that a site-specific extractor does not recognize.
        if (lastRetryErr) {
          if (win) {
            sendToolProgress(win, {
              tool: 'url-downloader', url, type: 'start', progress: 0.02,
              status: 'Site extractor failed — trying generic extractor...'
            });
          }
          stdout = ''; stderr = ''; outputPath = '';
          try {
            const genericArgs = buildYtDlpArgs(pythonInfo, url, outDir, {
              ...baseConfig, impersonate: hasImpersonationSupport
            });
            const gi = genericArgs.lastIndexOf(url);
            if (gi !== -1) genericArgs.splice(gi, 0, '--use-extractors', 'generic');
            await runDownload(genericArgs, {
              statusPrefix: 'Generic | ', modeLabel: 'Generic | ', minProgress: 0.02
            });
            lastRetryErr = null;
          } catch (e) {
            if (e?.code === 'PROCESS_CLEANUP_FAILED') throw e;
            if (operation.cancelled) throw cancelledError();
            lastRetryErr = e;
          }
        }

        if (lastRetryErr) {
          const originalMessage = redactSensitiveText(lastRetryErr.message || '', options);
          const guardedError = new Error(originalMessage.trim());
          guardedError.code = lastRetryErr.code;
          throw guardedError;
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
      if (err?.code === 'PROCESS_CLEANUP_FAILED') {
        return { success: false, error: err.message, code: err.code };
      }
      if (operation.cancelled || (err && err.code === 'CANCELLED')) {
        return { success: false, cancelled: true, error: 'Download cancelled by user.' };
      }
      if ((err.message || '').toLowerCase().includes('no module named')) {
        return { success: false, error: 'yt-dlp is not installed in Python. Run setup again or install Python dependencies from python/requirements.txt.' };
      }
      if ((err.message || '').toLowerCase().includes('impersonate') || (err.message || '').toLowerCase().includes('curl_cffi')) {
        return { success: false, error: 'This site blocks standard downloads. Install the bundled Python dependencies again so yt-dlp can use browser impersonation (curl_cffi).' };
      }
      const safeError = new Error(redactSensitiveText(err && err.message ? err.message : err, options));
      safeError.code = err && err.code;
      return { success: false, error: formatDownloadError(safeError, url) };
    } finally {
      if (operation.tempDir) {
        try { fs.rmSync(operation.tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
      }
      const windowOperations = activeDownloadsByWindow.get(winId);
      if (windowOperations) {
        windowOperations.delete(operation);
        if (windowOperations.size === 0) activeDownloadsByWindow.delete(winId);
      }
      operation.finish();
    }
  });

  ipcMain.handle('url-downloader-cancel', async (event) => {
    const winId = event.sender.id;
    const operations = activeDownloadsByWindow.get(winId);
    if (operations && operations.size > 0) {
      const targets = [...operations];
      for (const operation of targets) cancelOperation(operation);
      await Promise.all(targets.map((operation) => operation.done));
      const failure = targets.flatMap((operation) => operation.cleanupErrors)[0]
        || cleanupFailureLatch;
      if (failure) throw failure;
      return { success: true, cancelled: targets.length };
    }
    return { success: false, error: 'No active URL download to cancel' };
  });

  ipcMain.handle('url-downloader-info', async (event, options = {}) => {
    assertJobStart('Online media metadata request');
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
      return { success: false, requestId, error: 'Enter a valid http or https URL without embedded credentials.' };
    }

    try {
      await assertNetworkAllowed(networkPolicy, 'url-downloader.metadata');
    } catch (err) {
      return { success: false, requestId, error: err && err.message ? err.message : String(err) };
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
    const operation = createOperation();
    windowRequests.set(requestId, operation);

    try {
    const runInfo = (args) => new Promise((resolve, reject) => {
      if (operation.cancelled) { reject(cancelledError()); return; }
      const MAX_INFO_OUTPUT = 16 * 1024 * 1024;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let terminationError = null;
      const proc = spawnProcessTree(pythonInfo.cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1'
        },
        windowsHide: true
      });
      operation.processes.add(proc);
      const requestTermination = (error) => {
        if (settled || terminationError) return;
        terminationError = error;
        clearTimeout(timer);
        // Do not remove this process until the supervisor confirms that its
        // entire yt-dlp/ffmpeg tree has closed.
        terminateProcessTree(proc);
      };
      const timer = setTimeout(() => {
        requestTermination(new Error('Timed out while fetching video information.'));
      }, 60000);
      if (typeof timer.unref === 'function') timer.unref();

      const append = (current, chunk) => {
        const next = current + chunk.toString();
        if (next.length > MAX_INFO_OUTPUT) {
          requestTermination(new Error('Video information response was too large.'));
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
        reject(operation.cancelled ? cancelledError() : (terminationError || err));
      });
      proc.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation.processes.delete(proc);
        const cleanupError = supervisedCleanupError(proc, 'yt-dlp metadata');
        if (cleanupError) {
          operation.cleanupErrors.push(cleanupError);
          reject(cleanupError);
          return;
        }
        if (operation.cancelled) { reject(cancelledError()); return; }
        if (terminationError) { reject(terminationError); return; }
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
        '--ignore-config',
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
      if (err?.code === 'PROCESS_CLEANUP_FAILED') {
        return { success: false, requestId, error: err.message, code: err.code };
      }
      if (operation.cancelled || (err && err.code === 'CANCELLED')) {
        return cancelledInfoResponse();
      }
      if (!shouldRetryWithImpersonation(err)) {
        return { success: false, requestId, error: err.message || 'Failed to fetch video info.' };
      }

      if (!(await hasPythonModule(pythonInfo, 'curl_cffi', operation))) {
        if (operation.cancelled) return cancelledInfoResponse();
        return {
          success: false,
          requestId,
          error: 'Browser impersonation support is unavailable. Repair the Media Pack in Settings or update MuxMelt.'
        };
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
          if (e?.code === 'PROCESS_CLEANUP_FAILED') {
            return { success: false, requestId, error: e.message, code: e.code };
          }
          if (operation.cancelled || (e && e.code === 'CANCELLED')) {
            return cancelledInfoResponse();
          }
          lastErr = e;
        }
      }

      return { success: false, requestId, error: lastErr.message || 'Failed to fetch video info.' };
    }
    } catch (err) {
      if (err?.code === 'PROCESS_CLEANUP_FAILED') {
        return { success: false, requestId, error: err.message, code: err.code };
      }
      if (operation.cancelled || (err && err.code === 'CANCELLED')) {
        return cancelledInfoResponse();
      }
      return { success: false, requestId, error: err.message || 'Failed to fetch video info.' };
    } finally {
      const requests = activeInfoByWindow.get(winId);
      if (requests) {
        requests.delete(requestId);
        if (requests.size === 0) activeInfoByWindow.delete(winId);
      }
      operation.finish();
    }
  });

  ipcMain.handle('url-downloader-info-cancel', async (event, requestId) => {
    const id = typeof requestId === 'string' ? requestId.trim() : '';
    if (!id) return { success: false, error: 'A video information request ID is required.' };
    const requests = activeInfoByWindow.get(event.sender.id);
    const operation = requests && requests.get(id);
    if (!operation) return { success: false, error: 'Video information request is not active.' };
    cancelOperation(operation);
    await operation.done;
    const failure = operation.cleanupErrors[0] || cleanupFailureLatch;
    if (failure) throw failure;
    return { success: true, requestId: id };
  });

}

module.exports = {
  registerIPC,
  buildYtDlpArgs,
  orderedImpersonationAttempts,
  __privacy: {
    cleanupStalePrivateTempDirs,
    writePrivateAuthConfig,
    redactSensitiveText,
  }
};
