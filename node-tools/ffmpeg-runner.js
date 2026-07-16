'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LOOKUP_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 15000;
const MAX_PROBE_OUTPUT = 1024 * 1024;

function findBundledTool(tool) {
  const executable = process.platform === 'win32' ? `${tool}.exe` : tool;
  const candidates = [];
  // electron-builder places extraResources beside app.asar. Keep the source
  // checkout path as a fallback for development and unpacked builds.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', executable));
  }
  candidates.push(path.join(__dirname, '..', 'ffmpeg', executable));
  try {
    const packageExport = require(tool === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static');
    const packagePath = typeof packageExport === 'string' ? packageExport : packageExport && packageExport.path;
    if (packagePath) candidates.push(packagePath);
  } catch {}
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

/**
 * Check whether ffmpeg is reachable on the system PATH or bundled alongside
 * the app.  Returns the resolved command string or null.
 *
 * The PATH probe spawns `ffmpeg -version` synchronously (up to 5s), so the
 * result is cached after the first lookup — every probe/convert/compress call
 * goes through here and must not re-block the main process. A null (not
 * found) result is not cached, so installing ffmpeg mid-session is picked up.
 */
let _cachedFfmpeg;
let _ffmpegLookupPromise = null;
function findFfmpeg() {
  if (_cachedFfmpeg !== undefined && _cachedFfmpeg !== null) return _cachedFfmpeg;

  // 1) Check for a bundled binary next to the app
  const bundled = findBundledTool('ffmpeg');
  if (bundled) {
    _cachedFfmpeg = bundled;
    return _cachedFfmpeg;
  }

  // 2) Fall back to PATH
  try {
    const result = spawnSync('ffmpeg', ['-version'], {
      stdio: 'ignore',
      timeout: LOOKUP_TIMEOUT_MS,
      windowsHide: true
    });
    _cachedFfmpeg = !result.error && result.status === 0 ? 'ffmpeg' : null;
  } catch {
    _cachedFfmpeg = null;
  }
  return _cachedFfmpeg;
}

/**
 * Async variant used to warm the ffmpeg cache during startup, off the UI
 * thread. findFfmpeg()'s PATH probe is synchronous and can block
 * the main process for up to 5s — calling this once at launch means the first
 * convert/probe doesn't pay that cost (or freeze the window) on a user click.
 * A not-found result is left uncached so installing ffmpeg mid-session works.
 */
function findFfmpegAsync() {
  if (_cachedFfmpeg !== undefined && _cachedFfmpeg !== null) return Promise.resolve(_cachedFfmpeg);

  const bundled = findBundledTool('ffmpeg');
  if (bundled) {
    _cachedFfmpeg = bundled;
    return Promise.resolve(_cachedFfmpeg);
  }
  if (_ffmpegLookupPromise) return _ffmpegLookupPromise;

  _ffmpegLookupPromise = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      _cachedFfmpeg = val;
      resolve(val);
    };
    try {
      const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(null);
      }, LOOKUP_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      proc.once('error', () => finish(null));
      proc.once('close', (code) => finish(code === 0 ? 'ffmpeg' : null));
    } catch {
      finish(null);
    }
  });
  _ffmpegLookupPromise.finally(() => { _ffmpegLookupPromise = null; });
  return _ffmpegLookupPromise;
}

/**
 * Parse an ffmpeg stderr line and extract progress fields.
 * Returns an object with whatever fields were found, or null if nothing matched.
 */
function parseProgress(line) {
  const info = {};
  let matched = false;

  const timeMatch = line.match(/time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const s = parseFloat(timeMatch[3]);
    info.timeSeconds = h * 3600 + m * 60 + s;
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

  // Normalize decimal and binary output-size units to KiB for callers.
  const sizeMatch = line.match(/size=\s*([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)\b/i);
  if (sizeMatch) {
    const value = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toLowerCase();
    const multipliers = { b: 1 / 1024, kb: 1000 / 1024, kib: 1, mb: 1000000 / 1024, mib: 1024, gb: 1000000000 / 1024, gib: 1024 * 1024 };
    if (Number.isFinite(value)) {
      info.sizeKB = Math.round(value * multipliers[unit]);
      matched = true;
    }
  }

  return matched ? info : null;
}

/**
 * Probe a media file and return its duration in seconds.
 * Uses ffprobe if available, otherwise falls back to ffmpeg.
 */
function probeDuration(filePath) {
  return new Promise((resolve) => {
    if (typeof filePath !== 'string' || !filePath) { resolve(0); return; }
    const ffmpegCmd = findFfmpeg();
    if (!ffmpegCmd) { resolve(0); return; }

    // Try ffprobe first (same directory as ffmpeg)
    const probeCmd = findBundledTool('ffprobe') || ffmpegCmd.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ];

    let proc;
    try {
      proc = spawn(probeCmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolveViaFfmpeg(ffmpegCmd, filePath, resolve);
      return;
    }
    let stdout = '';
    let settled = false;
    let timer = null;
    const fallback = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch {}
      resolveViaFfmpeg(ffmpegCmd, filePath, resolve);
    };
    timer = setTimeout(fallback, PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    proc.stdout.on('data', (d) => {
      if (stdout.length <= MAX_PROBE_OUTPUT) stdout += d.toString();
      if (stdout.length > MAX_PROBE_OUTPUT) fallback();
    });
    proc.stderr.on('data', () => {});
    proc.once('error', () => {
      // ffprobe not found – parse from ffmpeg stderr
      fallback();
    });
    proc.once('close', (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        const dur = parseFloat(stdout.trim());
        resolve(Number.isFinite(dur) && dur >= 0 ? dur : 0);
      } else {
        fallback();
      }
    });
  });
}

function probeVideoInfo(filePath) {
  return new Promise((resolve) => {
    if (typeof filePath !== 'string' || !filePath) { resolve({ duration: 0, width: 0, height: 0 }); return; }
    const ffmpegCmd = findFfmpeg();
    if (!ffmpegCmd) { resolve({ duration: 0, width: 0, height: 0 }); return; }

    const probeCmd = findBundledTool('ffprobe') || ffmpegCmd.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:format=duration',
      '-of', 'json',
      filePath
    ];

    let proc;
    try {
      proc = spawn(probeCmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolveViaFfmpeg(ffmpegCmd, filePath, (duration) => resolve({ duration, width: 0, height: 0 }));
      return;
    }
    let stdout = '';
    let settled = false;
    let timer = null;
    const fallback = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch {}
      resolveViaFfmpeg(ffmpegCmd, filePath, (duration) => resolve({ duration, width: 0, height: 0 }));
    };
    timer = setTimeout(fallback, PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    proc.stdout.on('data', (d) => {
      if (stdout.length <= MAX_PROBE_OUTPUT) stdout += d.toString();
      if (stdout.length > MAX_PROBE_OUTPUT) fallback();
    });
    proc.stderr.on('data', () => {});
    proc.once('error', fallback);
    proc.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fallback();
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const stream = Array.isArray(info.streams) ? info.streams[0] : null;
        const formatDuration = parseFloat(info.format && info.format.duration);
        const streamDuration = parseFloat(stream && stream.duration);
        const duration = Number.isFinite(formatDuration) ? formatDuration : streamDuration;
        settled = true;
        clearTimeout(timer);
        resolve({
          duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
          width: stream && Number.isFinite(Number(stream.width)) ? Number(stream.width) : 0,
          height: stream && Number.isFinite(Number(stream.height)) ? Number(stream.height) : 0
        });
      } catch {
        fallback();
      }
    });
  });
}

function resolveViaFfmpeg(ffmpegCmd, filePath, resolve) {
  let proc;
  try {
    proc = spawn(ffmpegCmd, ['-i', filePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    resolve(0);
    return;
  }
  let stderr = '';
  let settled = false;
  let timer = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (m) {
      const dur = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      resolve(dur);
    } else {
      resolve(0);
    }
  };
  timer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
    finish();
  }, PROBE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  proc.stderr.on('data', (d) => {
    if (stderr.length <= MAX_PROBE_OUTPUT) stderr += d.toString();
  });
  proc.stdout.on('data', () => {});
  proc.once('close', finish);
  proc.once('error', finish);
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
function run(options = {}) {
  const { args, onProgress, durationSeconds } = options;
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    return {
      promise: Promise.reject(new Error('ffmpeg arguments must be an array of strings')),
      cancel: () => {}
    };
  }
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

  let proc;
  try {
    proc = spawn(ffmpegCmd, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    return {
      promise: Promise.reject(new Error(`Failed to launch ffmpeg: ${err.message}`)),
      cancel: () => {}
    };
  }

  let stderrBuf = '';
  let cancelled = false;
  let settled = false;
  let forceKillTimer = null;
  let progressRemainder = '';

  const emitProgress = (line) => {
    if (typeof onProgress !== 'function') return;
    const info = parseProgress(line);
    if (!info) return;
    if (durationSeconds && durationSeconds > 0 && info.timeSeconds != null) {
      info.percent = Math.min(100, (info.timeSeconds / durationSeconds) * 100);
    }
    try {
      onProgress(info);
    } catch (err) {
      console.warn('ffmpeg progress callback failed:', err.message || err);
    }
  };

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    if (stderrBuf.length > 8192) {
      stderrBuf = stderrBuf.slice(-4096);
    }

    // Stream chunks can end in the middle of a status field. Retain the
    // trailing fragment so progress is not silently lost at chunk boundaries.
    const lines = (progressRemainder + text).split(/\r\n|\n|\r/);
    progressRemainder = (lines.pop() || '').slice(-65536);
    for (const line of lines) {
      emitProgress(line.length > 65536 ? line.slice(-65536) : line);
    }
  });

  // Capture stdout too (unused by most commands but handy for debugging)
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    if (stdoutBuf.length > 8192) {
      stdoutBuf = stdoutBuf.slice(-4096);
    }
  });

  const promise = new Promise((resolve, reject) => {
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(cancelled
        ? new Error('ffmpeg process was cancelled')
        : new Error(`Failed to launch ffmpeg: ${err.message}`));
    });

    proc.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (progressRemainder) emitProgress(progressRemainder);
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
    if (!settled && !cancelled) {
      cancelled = true;
      try { proc.kill('SIGTERM'); } catch {}
      // Force-kill after 3 s if it hasn't stopped
      forceKillTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      if (typeof forceKillTimer.unref === 'function') forceKillTimer.unref();
    }
  }

  return { promise, cancel };
}

module.exports = {
  findFfmpeg,
  findFfmpegAsync,
  parseProgress,
  probeDuration,
  probeVideoInfo,
  run
};
