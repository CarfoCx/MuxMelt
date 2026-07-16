'use strict';

const path = require('path');
const fs = require('fs');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError, autoIncrementPath } = require('./path-utils');

const AUDIO_CODECS = {
  mp3:  ['-c:a', 'libmp3lame', '-b:a', '192k'],
  wav:  ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
  aac:  ['-c:a', 'aac', '-b:a', '192k'],
  ogg:  ['-c:a', 'libvorbis', '-b:a', '192k']
};

function registerIPC(ipcMain, getMainWindow) {
  const activeCancels = new Map();
  const activeWindows = new Set();
  const cancelledWindows = new Set();

  const throwIfCancelled = (winId) => {
    if (cancelledWindows.has(winId)) throw new Error('Audio extraction cancelled by user.');
  };

  ipcMain.handle('audio-extractor-extract', async (event, options = {}) => {
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
    const {
      inputPath,
      outputDir,
      format,       // mp3, wav, flac, aac, ogg
      bitrate,      // optional override e.g. '320k'
      sampleRate,   // null for original, or 22050/44100/48000
      normalize,    // boolean – apply loudnorm filter
      fadeIn,       // seconds, 0 = disabled
      fadeOut        // seconds, 0 = disabled
    } = options;

    let outputPath = null;
    let registeredActive = false;
    try {
      if (activeWindows.has(winId)) {
        return { success: false, error: 'An audio extraction is already running in this window.' };
      }
      if (!ffmpeg.findFfmpeg()) {
        return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
      }

      if (typeof inputPath !== 'string' || !inputPath || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        return { success: false, error: 'Input media file was not found.' };
      }

      const audioFormat = String(format || 'mp3').toLowerCase();
      const codecArgs = AUDIO_CODECS[audioFormat];
      if (!codecArgs) {
        return { success: false, error: `Unsupported audio format: ${audioFormat}` };
      }

      const bitrateValue = bitrate == null || bitrate === '' ? '' : String(bitrate).trim();
      const bitrateKbps = Number.parseInt(bitrateValue, 10);
      if (bitrateValue && (!/^\d{1,4}[kK]$/.test(bitrateValue) || bitrateKbps < 8 || bitrateKbps > 1536)) {
        return { success: false, error: `Invalid bitrate format: ${bitrateValue}. Use e.g. "320k" or "192k".` };
      }
      const sampleRateValue = sampleRate == null || sampleRate === '' ? null : Number(sampleRate);
      if (sampleRateValue != null && ![22050, 32000, 44100, 48000, 88200, 96000].includes(sampleRateValue)) {
        return { success: false, error: 'Unsupported sample rate.' };
      }
      const fadeInValue = fadeIn == null || fadeIn === '' ? 0 : Number(fadeIn);
      const fadeOutValue = fadeOut == null || fadeOut === '' ? 0 : Number(fadeOut);
      if (![fadeInValue, fadeOutValue].every(value => Number.isFinite(value) && value >= 0 && value <= 3600)) {
        return { success: false, error: 'Fade durations must be between 0 and 3600 seconds.' };
      }

      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      outputPath = autoIncrementPath(path.join(outDir, baseName + '.' + audioFormat));

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      activeWindows.add(winId);
      registeredActive = true;
      cancelledWindows.delete(winId);

      // Probe duration for progress
      const duration = await ffmpeg.probeDuration(inputPath);
      throwIfCancelled(winId);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'audio-extractor',
          type: 'progress',
          file: inputPath,
          percent: 0,
          status: 'Extracting audio...',
          duration
        });
      }

      // Build args
      const args = ['-i', inputPath, '-vn']; // -vn = no video

      // Audio filters (fades + loudnorm)
      const filters = [];
      if (fadeInValue > 0) {
        filters.push(`afade=t=in:d=${fadeInValue}`);
      }
      if (fadeOutValue > 0 && duration) {
        const actualFadeOut = Math.min(fadeOutValue, duration);
        const st = Math.max(0, duration - actualFadeOut);
        filters.push(`afade=t=out:st=${st}:d=${actualFadeOut}`);
      }
      if (normalize) {
        filters.push('loudnorm');
      }
      if (filters.length > 0) {
        args.push('-af', filters.join(','));
      }

      // Sample rate
      if (sampleRateValue) {
        args.push('-ar', String(sampleRateValue));
      }

      // Apply codec args, optionally override bitrate
      const finalCodecArgs = [...codecArgs];
      if (bitrateValue && ['mp3', 'aac', 'ogg'].includes(audioFormat)) {
        // Replace the bitrate value if present
        const brIdx = finalCodecArgs.indexOf('-b:a');
        if (brIdx !== -1) {
          finalCodecArgs[brIdx + 1] = bitrateValue.toLowerCase();
        } else {
          finalCodecArgs.push('-b:a', bitrateValue.toLowerCase());
        }
      }
      args.push(...finalCodecArgs, outputPath);

      const onProgress = (info) => {
        const w = getMainWindow();
        if (w) {
          w.webContents.send('tool-progress', {
            tool: 'audio-extractor',
            type: 'progress',
            file: inputPath,
            percent: info.percent || 0,
            speed: info.speed,
            timeSeconds: info.timeSeconds,
            duration,
            status: `Extracting audio... ${Math.round(info.percent || 0)}%`
          });
        }
      };

      const { promise, cancel } = ffmpeg.run({ args, durationSeconds: duration, onProgress });
      activeCancels.set(winId, cancel);

      await promise;
      activeCancels.delete(winId);
      throwIfCancelled(winId);

      // Get output file size
      let outputSize = 0;
      try { outputSize = fs.statSync(outputPath).size; } catch (err) { console.warn('Could not read output size:', err.message); }

      const w = getMainWindow();
      if (w) {
        w.webContents.send('tool-progress', {
          tool: 'audio-extractor',
          type: 'complete',
          file: inputPath,
          output: outputPath,
          percent: 100,
          status: 'Done'
        });
      }

      return {
        success: true,
        output: outputPath,
        duration,
        outputSize
      };
    } catch (err) {
      // autoIncrementPath guarantees this path is ours, so a leftover file
      // after a failed/cancelled run is always a partial output.
      if (outputPath) { try { fs.rmSync(outputPath, { force: true }); } catch {} }
      return { success: false, error: formatToolError(err, 'Audio Extractor') };
    } finally {
      if (registeredActive) {
        activeCancels.delete(winId);
        cancelledWindows.delete(winId);
        activeWindows.delete(winId);
      }
    }
  });

  ipcMain.handle('audio-extractor-cancel', async (event) => {
    const winId = event.sender.id;
    if (!activeWindows.has(winId)) {
      return { success: false, error: 'No active extraction to cancel' };
    }
    cancelledWindows.add(winId);
    const cancel = activeCancels.get(winId);
    if (cancel) cancel();
    return { success: true };
  });

  ipcMain.handle('audio-extractor-probe', async (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { success: false, error: 'Input media file was not found.' };
      }
      const duration = await ffmpeg.probeDuration(filePath);
      return { success: true, duration };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Audio Extractor') };
    }
  });
}

module.exports = { registerIPC };
