'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
    message.includes('cloudflare') ||
    message.includes('impersonat');
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

  return formatToolError(err, 'Online Video Downloader');
}

function buildYtDlpArgs(pythonInfo, url, outDir, options = {}) {
  const args = [
    ...(pythonInfo.args || []),
    '-m', 'yt_dlp',
    '--newline',
    '--no-color',
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--paths', outDir,
    '-o', '%(title).200B [%(id)s].%(ext)s',
    '--print', 'after_move:filepath',
  ];

  if (options.impersonate) {
    args.push('--impersonate', 'chrome');
  }

  args.push(...buildRequestHeaders(url, options));
  args.push(url);
  return args;
}

function registerIPC(ipcMain, getMainWindow, getPythonInfo) {
  let activeProcess = null;

  ipcMain.handle('url-downloader-download', async (event, options = {}) => {
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

      const runDownload = (args, statusPrefix = '') => new Promise((resolve, reject) => {
        const proc = spawn(pythonInfo.cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        activeProcess = proc;

        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          const progress = parseProgressLine(trimmed);
          const destination = extractDestination(trimmed);
          if (destination) outputPath = destination;

          // --print after_move:filepath prints a plain final path.
          if (!trimmed.startsWith('[') && /[\\/]/.test(trimmed)) {
            outputPath = trimmed;
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

        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
          activeProcess = null;
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

      try {
        await runDownload(buildYtDlpArgs(pythonInfo, url, outDir));
      } catch (err) {
        if (!shouldRetryWithImpersonation(err)) throw err;
        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'url-downloader',
            url,
            type: 'start',
            status: 'Site blocked the standard request. Retrying with browser impersonation...'
          });
        }
        stdout = '';
        stderr = '';
        outputPath = '';
        await runDownload(buildYtDlpArgs(pythonInfo, url, outDir, { impersonate: true }), 'Browser mode | ');
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
      activeProcess = null;
      if ((err.message || '').toLowerCase().includes('no module named')) {
        return { success: false, error: 'yt-dlp is not installed in Python. Run setup again or install Python dependencies from python/requirements.txt.' };
      }
      if ((err.message || '').toLowerCase().includes('impersonate') || (err.message || '').toLowerCase().includes('curl_cffi')) {
        return { success: false, error: 'This site blocks standard downloads. Install the bundled Python dependencies again so yt-dlp can use browser impersonation (curl_cffi).' };
      }
      return { success: false, error: formatDownloadError(err, url) };
    }
  });

  ipcMain.handle('url-downloader-cancel', async () => {
    if (activeProcess) {
      try { activeProcess.kill('SIGTERM'); } catch {}
      activeProcess = null;
      return { success: true };
    }
    return { success: false, error: 'No active URL download to cancel' };
  });
}

module.exports = { registerIPC, buildYtDlpArgs };
