'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError } = require('./path-utils');

const VALID_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow'
];

function registerIPC(ipcMain, getMainWindow) {
  let activeCancel = null;

  ipcMain.handle('video-compressor-compress', async (event, options) => {
    const {
      inputPath,
      outputDir,
      crf,          // 18-28, default 23
      preset,       // ultrafast..veryslow, default 'medium'
      resolution,   // e.g. '1080p', '720p', '480p', 'custom', or null for original
      codec = 'h264',        // 'h264' or 'h265'
      customWidth,           // used when resolution === 'custom'
      audioBitrate, // e.g. '128k', default '128k'
      twoPass       // boolean, two-pass encoding
    } = options;

    try {
      if (!ffmpeg.findFfmpeg()) {
        return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
      }

      const crfValue = Math.max(0, Math.min(51, crf != null ? crf : 23));
      const presetValue = VALID_PRESETS.includes(preset) ? preset : 'medium';
      const audioBr = audioBitrate || '128k';

      const ext = path.extname(inputPath).toLowerCase();
      const baseName = path.basename(inputPath, ext);
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      const outputPath = path.join(outDir, baseName + '_compressed' + ext);

      fs.mkdirSync(outDir, { recursive: true });

      // Get input file size for compression ratio
      let inputSize = 0;
      try { inputSize = fs.statSync(inputPath).size; } catch (err) { console.warn('Could not read input size:', err.message); }

      // Probe duration
      const duration = await ffmpeg.probeDuration(inputPath);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'video-compressor',
          percent: 0,
          status: 'Compressing video...',
          inputSize,
          duration
        });
      }

      // Build common args (codec, crf, preset, resolution)
      const commonArgs = [];

      // Codec selection
      const videoCodec = codec === 'h265' ? 'libx265' : 'libx264';
      commonArgs.push('-c:v', videoCodec);
      if (codec === 'h265') {
        commonArgs.push('-tag:v', 'hvc1');
      }

      commonArgs.push('-crf', String(crfValue));
      commonArgs.push('-preset', presetValue);

      // Optional resolution scaling
      const resolutionMap = {
        '1080p': 'scale=-2:1080',
        '720p': 'scale=-2:720',
        '480p': 'scale=-2:480',
      };
      if (resolution && resolution !== 'original') {
        if (resolutionMap[resolution]) {
          commonArgs.push('-vf', resolutionMap[resolution]);
        } else if (resolution === 'custom' && customWidth) {
          const w = Math.max(128, Math.min(7680, parseInt(customWidth) || 1280));
          commonArgs.push('-vf', `scale=${w}:-2`);
        }
      }

      if (twoPass) {
        // Two-pass encoding
        const passlogfile = path.join(os.tmpdir(), `ffmpeg2pass_${Date.now()}`);
        const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';

        // --- Pass 1: analysis ---
        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            percent: 0,
            status: 'Two-pass: analyzing (pass 1/2)...'
          });
        }

        const pass1Args = ['-i', inputPath, ...commonArgs, '-pass', '1', '-passlogfile', passlogfile, '-an', '-f', 'null', nullOutput];

        const onPass1Progress = (info) => {
          const w = getMainWindow();
          if (w) {
            // Pass 1 accounts for 0-45%
            const pct = Math.min(45, (info.percent || 0) * 0.45);
            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              percent: pct,
              frame: info.frame,
              speed: info.speed,
              status: `Two-pass: analyzing... ${Math.round(pct)}%`
            });
          }
        };

        const pass1 = ffmpeg.run({ args: pass1Args, durationSeconds: duration, onProgress: onPass1Progress });
        activeCancel = pass1.cancel;
        await pass1.promise;
        activeCancel = null;

        // --- Pass 2: encode ---
        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            percent: 45,
            status: 'Two-pass: encoding (pass 2/2)...'
          });
        }

        const pass2Args = ['-i', inputPath, ...commonArgs, '-pass', '2', '-passlogfile', passlogfile, '-c:a', 'aac', '-b:a', audioBr, '-movflags', '+faststart', outputPath];

        const onPass2Progress = (info) => {
          const w = getMainWindow();
          if (w) {
            // Pass 2 accounts for 45-100%
            const pct = 45 + Math.min(55, (info.percent || 0) * 0.55);
            const estimatedSize = info.sizeKB ? info.sizeKB * 1024 : null;
            const estimatedFinalSize = (estimatedSize && info.percent > 0)
              ? Math.round(estimatedSize / (info.percent / 100))
              : null;
            const compressionRatio = (estimatedFinalSize && inputSize > 0)
              ? (estimatedFinalSize / inputSize).toFixed(2)
              : null;

            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              percent: pct,
              frame: info.frame,
              speed: info.speed,
              currentSizeKB: info.sizeKB,
              estimatedFinalSize,
              compressionRatio,
              status: `Two-pass: encoding... ${Math.round(pct)}%`
            });
          }
        };

        const pass2 = ffmpeg.run({ args: pass2Args, durationSeconds: duration, onProgress: onPass2Progress });
        activeCancel = pass2.cancel;
        await pass2.promise;
        activeCancel = null;

        // Clean up passlog files
        try {
          const tmpDir = os.tmpdir();
          const logPrefix = path.basename(passlogfile);
          const tmpFiles = fs.readdirSync(tmpDir);
          for (const f of tmpFiles) {
            if (f.startsWith(logPrefix)) {
              try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
            }
          }
        } catch {}
      } else {
        // Single-pass encoding
        const args = ['-i', inputPath, ...commonArgs];
        args.push('-c:a', 'aac', '-b:a', audioBr);
        args.push('-movflags', '+faststart');
        args.push(outputPath);

        const onProgress = (info) => {
          const w = getMainWindow();
          if (w) {
            // Estimate output size based on current progress
            const estimatedSize = info.sizeKB ? info.sizeKB * 1024 : null;
            const estimatedFinalSize = (estimatedSize && info.percent > 0)
              ? Math.round(estimatedSize / (info.percent / 100))
              : null;
            const compressionRatio = (estimatedFinalSize && inputSize > 0)
              ? (estimatedFinalSize / inputSize).toFixed(2)
              : null;

            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              percent: info.percent || 0,
              frame: info.frame,
              speed: info.speed,
              currentSizeKB: info.sizeKB,
              estimatedFinalSize,
              compressionRatio,
              status: `Compressing... ${Math.round(info.percent || 0)}%`
            });
          }
        };

        const { promise, cancel } = ffmpeg.run({ args, durationSeconds: duration, onProgress });
        activeCancel = cancel;

        await promise;
        activeCancel = null;
      }

      // Get output file size and compute ratio
      let outputSize = 0;
      try { outputSize = fs.statSync(outputPath).size; } catch (err) { console.warn('Could not read output size:', err.message); }
      const compressionRatio = inputSize > 0 ? (outputSize / inputSize).toFixed(2) : null;
      const savedBytes = inputSize - outputSize;
      const savedPercent = inputSize > 0 ? ((savedBytes / inputSize) * 100).toFixed(1) : 0;

      const w = getMainWindow();
      if (w) {
        w.webContents.send('tool-progress', {
          tool: 'video-compressor',
          percent: 100,
          status: 'Done'
        });
      }

      return {
        success: true,
        output: outputPath,
        inputSize,
        outputSize,
        compressionRatio,
        savedBytes,
        savedPercent: parseFloat(savedPercent)
      };
    } catch (err) {
      activeCancel = null;
      return { success: false, error: formatToolError(err, 'Video Compressor') };
    }
  });

  ipcMain.handle('video-compressor-cancel', async () => {
    if (activeCancel) {
      activeCancel();
      activeCancel = null;
      return { success: true };
    }
    return { success: false, error: 'No active compression to cancel' };
  });

  ipcMain.handle('video-compressor-estimate', async (event, options) => {
    // Rough size estimate based on CRF and duration
    try {
      const duration = await ffmpeg.probeDuration(options.inputPath);
      let inputSize = 0;
      try { inputSize = fs.statSync(options.inputPath).size; } catch {}

      // Very rough estimate: CRF 23 roughly halves the file for most content
      // Each CRF +6 roughly halves the size
      const crfDiff = (options.crf || 23) - 18;
      const factor = Math.pow(0.5, crfDiff / 6);
      const estimatedSize = Math.round(inputSize * factor);

      return {
        success: true,
        duration,
        inputSize,
        estimatedOutputSize: estimatedSize,
        estimatedRatio: inputSize > 0 ? (estimatedSize / inputSize).toFixed(2) : null
      };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Video Compressor') };
    }
  });
}

module.exports = { registerIPC };
