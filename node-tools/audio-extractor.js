'use strict';

const path = require('path');
const fs = require('fs');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError } = require('./path-utils');

const AUDIO_CODECS = {
  mp3:  ['-c:a', 'libmp3lame', '-b:a', '192k'],
  wav:  ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
  aac:  ['-c:a', 'aac', '-b:a', '192k'],
  ogg:  ['-c:a', 'libvorbis', '-b:a', '192k']
};

function registerIPC(ipcMain, getMainWindow) {
  let activeCancel = null;

  ipcMain.handle('audio-extractor-extract', async (event, options) => {
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

    try {
      if (!ffmpeg.findFfmpeg()) {
        return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
      }

      const audioFormat = (format || 'mp3').toLowerCase();
      const codecArgs = AUDIO_CODECS[audioFormat];
      if (!codecArgs) {
        return { success: false, error: `Unsupported audio format: ${audioFormat}` };
      }

      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      const outputPath = path.join(outDir, baseName + '.' + audioFormat);

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      // Probe duration for progress
      const duration = await ffmpeg.probeDuration(inputPath);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'audio-extractor',
          percent: 0,
          status: 'Extracting audio...',
          duration
        });
      }

      // Build args
      const args = ['-i', inputPath, '-vn']; // -vn = no video

      // Audio filters (fades + loudnorm)
      const filters = [];
      if (fadeIn && fadeIn > 0) {
        filters.push(`afade=t=in:d=${fadeIn}`);
      }
      if (fadeOut && fadeOut > 0 && duration) {
        const st = Math.max(0, duration - fadeOut);
        filters.push(`afade=t=out:st=${st}:d=${fadeOut}`);
      }
      if (normalize) {
        filters.push('loudnorm');
      }
      if (filters.length > 0) {
        args.push('-af', filters.join(','));
      }

      // Sample rate
      if (sampleRate) {
        args.push('-ar', String(sampleRate));
      }

      // Apply codec args, optionally override bitrate
      const finalCodecArgs = [...codecArgs];
      if (bitrate) {
        if (!/^\d+[kKmM]?$/.test(bitrate)) {
          return { success: false, error: `Invalid bitrate format: ${bitrate}. Use e.g. "320k" or "192k".` };
        }
        // Replace the bitrate value if present
        const brIdx = finalCodecArgs.indexOf('-b:a');
        if (brIdx !== -1) {
          finalCodecArgs[brIdx + 1] = bitrate;
        } else {
          finalCodecArgs.push('-b:a', bitrate);
        }
      }
      args.push(...finalCodecArgs, outputPath);

      const onProgress = (info) => {
        const w = getMainWindow();
        if (w) {
          w.webContents.send('tool-progress', {
            tool: 'audio-extractor',
            percent: info.percent || 0,
            speed: info.speed,
            timeSeconds: info.timeSeconds,
            duration,
            status: `Extracting audio... ${Math.round(info.percent || 0)}%`
          });
        }
      };

      const { promise, cancel } = ffmpeg.run({ args, durationSeconds: duration, onProgress });
      activeCancel = cancel;

      await promise;
      activeCancel = null;

      // Get output file size
      let outputSize = 0;
      try { outputSize = fs.statSync(outputPath).size; } catch (err) { console.warn('Could not read output size:', err.message); }

      const w = getMainWindow();
      if (w) {
        w.webContents.send('tool-progress', {
          tool: 'audio-extractor',
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
      activeCancel = null;
      return { success: false, error: formatToolError(err, 'Audio Extractor') };
    }
  });

  ipcMain.handle('audio-extractor-cancel', async () => {
    if (activeCancel) {
      activeCancel();
      activeCancel = null;
      return { success: true };
    }
    return { success: false, error: 'No active extraction to cancel' };
  });

  ipcMain.handle('audio-extractor-probe', async (event, filePath) => {
    try {
      const duration = await ffmpeg.probeDuration(filePath);
      return { success: true, duration };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Audio Extractor') };
    }
  });
}

module.exports = { registerIPC };
