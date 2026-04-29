'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Check whether ffmpeg is reachable on the system PATH or bundled alongside
 * the app.  Returns the resolved command string or null.
 */
function findFfmpeg() {
  // 1) Check for a bundled binary next to the app
  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = path.join(__dirname, '..', 'ffmpeg', ffmpegName);
  if (fs.existsSync(bundled)) return bundled;

  // 2) Fall back to PATH
  try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'ignore', timeout: 5000 });
    return 'ffmpeg';
  } catch {
    return null;
  }
}

/**
 * Parse an ffmpeg stderr line and extract progress fields.
 * Returns an object with whatever fields were found, or null if nothing matched.
 */
function parseProgress(line) {
  const info = {};
  let matched = false;

  const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2,3})/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const s = parseInt(timeMatch[3], 10);
    const ms = parseInt(timeMatch[4].padEnd(3, '0'), 10);
    info.timeSeconds = h * 3600 + m * 60 + s + ms / 1000;
    matched = true;
  }

  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) {
    info.frame = parseInt(frameMatch[1], 10);
    matched = true;
  }

  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  if (speedMatch) {
    info.speed = parseFloat(speedMatch[1]);
    matched = true;
  }

  const sizeMatch = line.match(/size=\s*([\d]+)kB/);
  if (sizeMatch) {
    info.sizeKB = parseInt(sizeMatch[1], 10);
    matched = true;
  }

  return matched ? info : null;
}

/**
 * Probe a media file and return its duration in seconds.
 * Uses ffprobe if available, otherwise falls back to ffmpeg.
 */
function probeDuration(filePath) {
  return new Promise((resolve) => {
    const ffmpegCmd = findFfmpeg();
    if (!ffmpegCmd) { resolve(0); return; }

    // Try ffprobe first (same directory as ffmpeg)
    let probeCmd = ffmpegCmd.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ];

    const proc = spawn(probeCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', () => {
      // ffprobe not found – parse from ffmpeg stderr
      resolveViaFfmpeg(ffmpegCmd, filePath, resolve);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        const dur = parseFloat(stdout.trim());
        resolve(isNaN(dur) ? 0 : dur);
      } else {
        resolveViaFfmpeg(ffmpegCmd, filePath, resolve);
      }
    });
  });
}

function resolveViaFfmpeg(ffmpegCmd, filePath, resolve) {
  const proc = spawn(ffmpegCmd, ['-i', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('close', () => {
    const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2,3})/);
    if (m) {
      const dur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4].padEnd(3, '0')) / 1000;
      resolve(dur);
    } else {
      resolve(0);
    }
  });
  proc.on('error', () => resolve(0));
}

/**
 * Run an ffmpeg command.
 *
 * @param {Object} options
 * @param {string[]} options.args             - ffmpeg argument array (no leading "ffmpeg")
 * @param {Function} [options.onProgress]     - callback(progressInfo) called on each stderr progress line
 * @param {number}   [options.durationSeconds]- total duration so we can compute percent
 *
 * @returns {{ promise: Promise<{code: number, stderr: string}>, cancel: Function }}
 */
function run({ args, onProgress, durationSeconds }) {
  const ffmpegCmd = findFfmpeg();
  if (!ffmpegCmd) {
    return {
      promise: Promise.reject(new Error(
        'ffmpeg not found. Install ffmpeg and make sure it is on the system PATH.'
      )),
      cancel: () => {}
    };
  }

  // Always overwrite without asking
  const fullArgs = ['-y', ...args];

  const proc = spawn(ffmpegCmd, fullArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderrBuf = '';
  let cancelled = false;

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;

    if (typeof onProgress === 'function') {
      // ffmpeg can write multiple status lines in one chunk
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const info = parseProgress(line);
        if (info) {
          if (durationSeconds && durationSeconds > 0 && info.timeSeconds != null) {
            info.percent = Math.min(100, (info.timeSeconds / durationSeconds) * 100);
          }
          onProgress(info);
        }
      }
    }
  });

  // Capture stdout too (unused by most commands but handy for debugging)
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });

  const promise = new Promise((resolve, reject) => {
    proc.on('error', (err) => {
      reject(new Error(`Failed to launch ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (cancelled) {
        reject(new Error('ffmpeg process was cancelled'));
      } else if (code === 0) {
        resolve({ code, stderr: stderrBuf, stdout: stdoutBuf });
      } else {
        // Extract last meaningful error line from stderr
        const errLines = stderrBuf.trim().split('\n').filter(l => l.trim());
        const lastLine = errLines[errLines.length - 1] || 'Unknown ffmpeg error';
        reject(new Error(`ffmpeg exited with code ${code}: ${lastLine}`));
      }
    });
  });

  function cancel() {
    if (!proc.killed) {
      cancelled = true;
      proc.kill('SIGTERM');
      // Force-kill after 3 s if it hasn't stopped
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }
  }

  return { promise, cancel };
}

module.exports = {
  findFfmpeg,
  parseProgress,
  probeDuration,
  run
};
