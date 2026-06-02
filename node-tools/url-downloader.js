'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { validateOutputDir, formatToolError } = require('./path-utils');

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
      ['--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'],
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

function hasPythonModule(pythonInfo, moduleName) {
  try {
    execFileSync(pythonInfo.cmd, [
      ...(pythonInfo.args || []),
      '-c',
      `import ${moduleName}`
    ], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function installYtDlpImpersonationDeps(pythonInfo) {
  execFileSync(pythonInfo.cmd, [
    ...(pythonInfo.args || []),
    '-m',
    'pip',
    'install',
    '--upgrade',
    'yt-dlp[default,curl-cffi]',
    '--no-warn-script-location'
  ], { stdio: 'pipe', timeout: 300000, windowsHide: true });
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
  if (format === 'audioonly') {
    const aFormat = options.audioFormat || 'mp3';
    args.push('-x', '--audio-format', aFormat, '--audio-quality', '0');
  } else if (format === '2160p') {
    args.push('-f', 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]', '--merge-output-format', 'mp4');
  } else if (format === '1080p') {
    args.push('-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--merge-output-format', 'mp4');
  } else if (format === '720p') {
    args.push('-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]', '--merge-output-format', 'mp4');
  } else if (format === '480p') {
    args.push('-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]', '--merge-output-format', 'mp4');
  } else if (format === '360p') {
    args.push('-f', 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]', '--merge-output-format', 'mp4');
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
            win.webContents.send('tool-progress', {
              tool: 'url-downloader',
              url,
              type: 'progress',
              progress: progress.percent / 100,
              status: [
                `${statusPrefix}Downloading... ${Math.round(progress.percent)}%`,
                progress.speed,
                progress.eta ? `ETA ${progress.eta}` : ''
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
            const last = usefulLines.reverse().find(Boolean) || `yt-dlp exited with code ${code}`;
            const err = new Error(last);
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
        if (!shouldRetryWithImpersonation(err)) throw err;
        if (!hasPythonModule(pythonInfo, 'curl_cffi')) {
          if (win) {
            win.webContents.send('tool-progress', {
              tool: 'url-downloader',
              url,
              type: 'start',
              status: 'Installing browser impersonation support...'
            });
          }
          try {
            installYtDlpImpersonationDeps(pythonInfo);
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

        const retryConfigs = orderedImpersonationAttempts(options).map((attempt) => {
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

        let lastRetryErr = null;
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
        if (lastRetryErr) throw lastRetryErr;
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

      if (!hasPythonModule(pythonInfo, 'curl_cffi')) {
        try {
          installYtDlpImpersonationDeps(pythonInfo);
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
      
      const stdout = execFileSync(pythonInfo.cmd, args, { stdio: 'pipe', timeout: 300000, windowsHide: true });
      return { success: true, message: stdout.toString().trim() };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
}

module.exports = { registerIPC, buildYtDlpArgs, orderedImpersonationAttempts };
