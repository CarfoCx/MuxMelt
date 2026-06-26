'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { validateOutputDir, formatToolError } = require('./path-utils');
const { BrowserWindow, net } = require('electron');

// Promise wrapper around spawn so long-running Python/pip calls never block the
// Electron main process (execFileSync freezes the entire UI for its timeout).
function execFileAsync(cmd, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timer = null;
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (timeout > 0) {
      timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeout);
    }
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
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

  if (!options.impersonate) {
    headers.push(
      ['--user-agent', options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'],
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

  if (options.referer) {
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
function orderedImpersonationAttempts(options, cap = MAX_BROWSER_COOKIE_ATTEMPTS) {
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

async function hasPythonModule(pythonInfo, moduleName) {
  try {
    await execFileAsync(pythonInfo.cmd, [
      ...(pythonInfo.args || []),
      '-c',
      `import ${moduleName}`
    ], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function installYtDlpImpersonationDeps(pythonInfo) {
  await execFileAsync(pythonInfo.cmd, [
    ...(pythonInfo.args || []),
    '-m',
    'pip',
    'install',
    '--upgrade',
    'yt-dlp[default,curl-cffi]',
    '--no-warn-script-location'
  ], { timeout: 300000 });
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
    '--paths', outDir,
    '--exec', 'echo {}',
  ];

  // Playlist options
  if (options.playlist) {
    args.push('--yes-playlist');
    if (options.maxDownloads && Number(options.maxDownloads) > 0) {
      args.push('--max-downloads', String(options.maxDownloads));
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
    const aFormat = options.audioFormat || 'mp3';
    args.push('-x', '--audio-format', aFormat, '--audio-quality', '0');
  } else if (maxHeight) {
    args.push(
      '-f',
      `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`,
      '--merge-output-format', 'mp4'
    );
  } else if (format === 'custom') {
    if (options.customFormat) {
      args.push('-f', options.customFormat);
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
    if (options.subLangs) {
      args.push('--sub-langs', options.subLangs);
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
  if (options.limitRate && options.limitRate.trim()) {
    args.push('--limit-rate', options.limitRate.trim());
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
  if (options.proxy && options.proxy.trim()) {
    args.push('--proxy', options.proxy.trim());
  }
  if (options.username && options.username.trim()) {
    args.push('--username', options.username.trim());
  }
  if (options.password && options.password.trim()) {
    args.push('--password', options.password.trim());
  }
  if (options.videoPassword && options.videoPassword.trim()) {
    args.push('--video-password', options.videoPassword.trim());
  }
  if (options.geoBypass) {
    args.push('--geo-bypass');
  }

  // Performance & Processing
  if (options.concurrentFragments && Number(options.concurrentFragments) > 0) {
    args.push('--concurrent-fragments', String(options.concurrentFragments));
  }
  if (options.timeRange && options.timeRange.trim()) {
    args.push('--download-sections', `*${options.timeRange.trim()}`);
  }
  if (options.writeAutoSubs) {
    args.push('--write-auto-subs');
  }

  // Impersonation
  if (options.impersonate) {
    args.push('--impersonate', 'chrome');
    args.push('--extractor-args', 'generic:impersonate');
  }

  if (options.cookieBrowser) {
    args.push('--cookies-from-browser', options.cookieBrowser);
  }

  if (options.cookiesFile) {
    args.push('--cookies', options.cookiesFile);
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

async function sniffVideoUrl(url, win, timeoutMs = 15000) {
  if (win) {
    win.webContents.send('tool-progress', {
      tool: 'url-downloader',
      url,
      type: 'start',
      progress: 0.05,
      status: 'Universal fallback: Sniffing webpage for video streams...'
    });
  }

  return new Promise((resolve, reject) => {
    const candidates = [];
    let isDone = false;

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
      try { snifferSession.webRequest.onHeadersReceived(null); } catch {}
      if (!snifferWin.isDestroyed()) snifferWin.destroy();
    };

    const done = async () => {
      if (isDone) return;
      isDone = true;

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
            if (u && /^https?:/i.test(u) && !candidates.some(c => c.url === u)) {
              candidates.push({ url: u, size: 0 });
            }
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

    snifferSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: false });

      const type = (details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'] || [])[0] || '';
      const sizeStr = (details.responseHeaders['content-length'] || details.responseHeaders['Content-Length'] || [])[0] || '0';
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
          candidates.push({ url: details.url, size });
          // A manifest is the ideal target — give late variants a brief window, then finish.
          if (isManifest || candidates.length >= 5) {
            setTimeout(done, 1500);
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

    setTimeout(done, timeoutMs);
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

    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8');
    if (referer) request.setHeader('Referer', referer);

    request.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.on('data', () => {});
        response.on('end', () => finish(reject, new Error(`Thumbnail request failed (HTTP ${status})`)));
        response.on('error', () => finish(reject, new Error(`Thumbnail request failed (HTTP ${status})`)));
        return;
      }

      let contentType = response.headers['content-type'] || 'image/jpeg';
      if (Array.isArray(contentType)) contentType = contentType[0];
      const mime = String(contentType).split(';')[0].trim() || 'image/jpeg';

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          try { request.abort(); } catch {}
          finish(reject, new Error('Thumbnail too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) { finish(reject, new Error('Empty thumbnail')); return; }
        finish(resolve, `data:${mime};base64,${buf.toString('base64')}`);
      });
      response.on('error', (err) => finish(reject, err));
    });

    request.on('error', (err) => finish(reject, err));
    request.end();
  });
}

function registerIPC(ipcMain, getMainWindow, getPythonInfo) {
  const activeProcessesByWindow = new Map();

  ipcMain.handle('url-downloader-download', async (event, options = {}) => {
    const winId = event.sender.id;
    const url = String(options.url || '').trim();

    try {
      if (!isHttpUrl(url)) {
        return { success: false, error: 'Enter a valid http or https URL.' };
      }

      const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
      if (!pythonInfo || !pythonInfo.cmd) {
        return { success: false, error: 'Python was not found. Online Video Downloader requires Python with yt-dlp installed.' };
      }

      const outDir = validateOutputDir(options.outputDir) || defaultOutputDir();
      fs.mkdirSync(outDir, { recursive: true });

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
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
        const statusPrefix = runOptions.statusPrefix || '';
        const modeLabel = runOptions.modeLabel ? `${runOptions.modeLabel} | ` : '';
        let lastStageStatus = '';
        
        // Smoothing state
        let overallProgress = 0;
        let currentStreamStart = 0;
        let lastRawPercent = 0;
        let smoothedEtaSeconds = -1;
        let lastSpeed = '';

        const proc = spawn(pythonInfo.cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1'
          },
          windowsHide: true
        });

        if (!activeProcessesByWindow.has(winId)) {
          activeProcessesByWindow.set(winId, new Set());
        }
        activeProcessesByWindow.get(winId).add(proc);

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
            win.webContents.send('tool-progress', {
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

            win.webContents.send('tool-progress', {
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

        proc.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          stdout += text;
          text.split(/\r?\n|\r/).forEach(handleLine);
        });

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderr += text;
          text.split(/\r?\n|\r/).forEach(handleLine);
        });

        proc.on('error', (err) => {
          const procs = activeProcessesByWindow.get(winId);
          if (procs) {
            procs.delete(proc);
            if (procs.size === 0) activeProcessesByWindow.delete(winId);
          }
          reject(err);
        });
        proc.on('close', (code) => {
          const procs = activeProcessesByWindow.get(winId);
          if (procs) {
            procs.delete(proc);
            if (procs.size === 0) activeProcessesByWindow.delete(winId);
          }
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
      
      try {
        await runDownload(buildYtDlpArgs(pythonInfo, url, outDir, options));
      } catch (err) {
        const extractionFailure = isExtractionFailure(err);
        // Universal fallback: don't give up on the first error. Whatever the
        // failure (403/blocked, 404 "not found", geo, or an unrecognised error),
        // fall through to browser-impersonation retries and then the in-app
        // stream sniffer below — if the page plays in a browser, we try to grab
        // it. (A genuinely dead link just fails a bit later, after we've tried.)
        if (!extractionFailure && !(await hasPythonModule(pythonInfo, 'curl_cffi'))) {
          if (win) {
            win.webContents.send('tool-progress', {
              tool: 'url-downloader',
              url,
              type: 'start',
              status: 'Installing browser impersonation support...'
            });
          }
          try {
            await installYtDlpImpersonationDeps(pythonInfo);
          } catch (installErr) {
            // No network or a read-only install — don't abort. Impersonation may
            // already be available, or the retries will surface a clear error.
            if (win) {
              win.webContents.send('tool-progress', {
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
            win.webContents.send('tool-progress', {
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
            lastRetryErr = e;
          }
        }
        // Before the (heavier) sniffer, try yt-dlp's GENERIC extractor on the
        // original page with impersonation. This frequently rescues a video
        // whose site-specific extractor returned 404/403 but whose page still
        // exposes an m3u8/og:video — and it's much faster than the sniffer.
        if (lastRetryErr) {
          if (win) {
            win.webContents.send('tool-progress', {
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
            lastRetryErr = e;
          }
        }

        if (lastRetryErr) {
          let sniffedData = null;
          try {
            sniffedData = await sniffVideoUrl(url, win, 30000);
          } catch (sniffErr) {
            throw lastRetryErr;
          }
          
          if (sniffedData && sniffedData.url) {
            if (win) {
              win.webContents.send('tool-progress', {
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
                  win.webContents.send('tool-progress', {
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

      if (!outputPath) {
        const candidates = fs.readdirSync(outDir)
          .map(name => path.join(outDir, name))
          .filter(file => {
            try { return fs.statSync(file).isFile(); } catch { return false; }
          })
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        outputPath = candidates[0] || '';
      }

      if (win) {
        win.webContents.send('tool-progress', {
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
      if ((err.message || '').toLowerCase().includes('no module named')) {
        return { success: false, error: 'yt-dlp is not installed in Python. Run setup again or install Python dependencies from python/requirements.txt.' };
      }
      if ((err.message || '').toLowerCase().includes('impersonate') || (err.message || '').toLowerCase().includes('curl_cffi')) {
        return { success: false, error: 'This site blocks standard downloads. Install the bundled Python dependencies again so yt-dlp can use browser impersonation (curl_cffi).' };
      }
      return { success: false, error: formatDownloadError(err, url) };
    }
  });

  ipcMain.handle('url-downloader-cancel', async (event) => {
    const winId = event.sender.id;
    const procs = activeProcessesByWindow.get(winId);
    if (procs && procs.size > 0) {
      for (const proc of procs) {
        try { proc.kill('SIGTERM'); } catch {}
      }
      activeProcessesByWindow.delete(winId);
      return { success: true };
    }
    return { success: false, error: 'No active URL download to cancel' };
  });

  ipcMain.handle('url-downloader-info', async (event, options = {}) => {
    const url = String(options.url || '').trim();
    if (!isHttpUrl(url)) {
      return { success: false, error: 'Enter a valid http or https URL.' };
    }

    const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
    if (!pythonInfo || !pythonInfo.cmd) {
      return { success: false, error: 'Python environment not found.' };
    }

    const runInfo = (args) => new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn(pythonInfo.cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1'
        },
        windowsHide: true
      });

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
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
        args.push('--cookies-from-browser', config.cookieBrowser);
      }
      if (config.cookiesFile) {
        args.push('--cookies', config.cookiesFile);
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
      return { success: true, info };
    } catch (err) {
      if (!shouldRetryWithImpersonation(err)) {
        return { success: false, error: err.message || 'Failed to fetch video info.' };
      }

      if (!(await hasPythonModule(pythonInfo, 'curl_cffi'))) {
        try {
          await installYtDlpImpersonationDeps(pythonInfo);
        } catch (e) {
          console.error('Failed to install impersonation dependencies during info fetch:', e);
        }
      }

      const retryConfigs = orderedImpersonationAttempts(options);

      let lastErr = err;
      for (const config of retryConfigs) {
        try {
          const stdout = await runInfo(buildInfoArgs(config));
          const info = parseJsonFromStdout(stdout);
          return { success: true, info };
        } catch (e) {
          lastErr = e;
        }
      }

      return { success: false, error: lastErr.message || 'Failed to fetch video info.' };
    }
  });

  ipcMain.handle('url-downloader-thumbnail', async (event, options = {}) => {
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
      const args = [
        ...(pythonInfo.args || []),
        '-m',
        'pip',
        'install',
        '--upgrade',
        'yt-dlp[default,curl-cffi]',
        '--no-warn-script-location'
      ];

      const { stdout } = await execFileAsync(pythonInfo.cmd, args, { timeout: 300000 });
      return { success: true, message: stdout.trim() };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
}

module.exports = { registerIPC, buildYtDlpArgs, orderedImpersonationAttempts };
