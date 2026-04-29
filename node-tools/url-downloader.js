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
        url
      ];

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

      await new Promise((resolve, reject) => {
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
                `Downloading... ${Math.round(progress.percent)}%`,
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
            const last = lines.reverse().find(l => l && !l.startsWith('[download]')) || `yt-dlp exited with code ${code}`;
            reject(new Error(last));
          }
        });
      });

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
      return { success: false, error: formatToolError(err, 'Online Video Downloader') };
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

module.exports = { registerIPC };
