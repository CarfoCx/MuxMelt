'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError, autoIncrementPath } = require('./path-utils');

const VALID_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow'
];

function registerIPC(ipcMain, getMainWindow) {
  const activeCancels = new Map();

  ipcMain.handle('video-compressor-compress', async (event, options) => {
    const winId = event.sender.id;
    const {
      inputPath,
      outputDir,
      crf,          // 18-35, default 23
      preset,       // ultrafast..veryslow, default 'medium'
      resolution,   // e.g. '1080p', '720p', '480p', 'custom', or null for original
      codec = 'h264',        // 'h264' or 'h265'
      customWidth,           // used when resolution === 'custom'
      audioBitrate, // e.g. '128k', default '128k'
      twoPass       // boolean, two-pass encoding
    } = options;

    let tempOutputPath = null;

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
      let outputPath = path.join(outDir, baseName + '_compressed' + ext);
      outputPath = autoIncrementPath(outputPath);
      tempOutputPath = path.join(outDir, `${baseName}_compressed.${process.pid}.${Date.now()}.tmp${ext}`);

      fs.mkdirSync(outDir, { recursive: true });

      // Get input file size for compression ratio
      let inputSize = 0;
      try { inputSize = fs.statSync(inputPath).size; } catch (err) { console.warn('Could not read input size:', err.message); }

      const videoInfo = await ffmpeg.probeVideoInfo(inputPath);
      const duration = videoInfo.duration || await ffmpeg.probeDuration(inputPath);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'video-compressor',
          type: 'progress',
          file: inputPath,
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
          const targetHeight = parseInt(resolution, 10);
          if (!videoInfo.height || targetHeight < videoInfo.height) {
            commonArgs.push('-vf', resolutionMap[resolution]);
          }
        } else if (resolution === 'custom' && customWidth) {
          const w = Math.max(128, Math.min(7680, parseInt(customWidth) || 1280));
          if (!videoInfo.width || w < videoInfo.width) {
            commonArgs.push('-vf', `scale=${w}:-2`);
          }
        }
      }

      const runSinglePassEncode = async (encodeCrf, label) => {
        const args = ['-i', inputPath, ...commonArgs];
        const crfIndex = args.indexOf('-crf');
        if (crfIndex !== -1) args[crfIndex + 1] = String(encodeCrf);
        args.push('-c:a', 'aac', '-b:a', audioBr);
        args.push('-movflags', '+faststart');
        args.push(tempOutputPath);

        const onProgress = (info) => {
          const w = getMainWindow();
          if (w) {
            const estimatedSize = info.sizeKB ? info.sizeKB * 1024 : null;
            const estimatedFinalSize = (estimatedSize && info.percent > 0)
              ? Math.round(estimatedSize / (info.percent / 100))
              : null;
            const compressionRatio = (estimatedFinalSize && inputSize > 0)
              ? (estimatedFinalSize / inputSize).toFixed(2)
              : null;
            const pct = Math.min(95, info.percent || 0);

            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              type: 'progress',
              file: inputPath,
              percent: pct,
              frame: info.frame,
              speed: info.speed,
              currentSizeKB: info.sizeKB,
              estimatedFinalSize,
              compressionRatio,
              status: `${label}... ${Math.round(pct)}%`
            });
          }
        };

        const { promise, cancel } = ffmpeg.run({ args, durationSeconds: duration, onProgress });
        activeCancels.set(winId, cancel);
        await promise;
        activeCancels.delete(winId);
      };

      if (twoPass) {
        // Two-pass encoding
        const passlogfile = path.join(os.tmpdir(), `ffmpeg2pass_${Date.now()}`);
        const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';

        // --- Pass 1: analysis ---
        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            type: 'progress',
            file: inputPath,
            percent: 0,
            status: 'Two-pass: analyzing (pass 1/2)...'
          });
        }

        const pass1Args = ['-i', inputPath, ...commonArgs, '-pass', '1', '-passlogfile', passlogfile, '-an', '-f', 'null', nullOutput];

        const onPass1Progress = (info) => {
          const w = getMainWindow();
          if (w) {
            // Keep completion headroom for pass handoff and final file work.
            const pct = Math.min(40, (info.percent || 0) * 0.4);
            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              type: 'progress',
              file: inputPath,
              percent: pct,
              frame: info.frame,
              speed: info.speed,
              status: `Two-pass: analyzing... ${Math.round(pct)}%`
            });
          }
        };

        const pass1 = ffmpeg.run({ args: pass1Args, durationSeconds: duration, onProgress: onPass1Progress });
        activeCancels.set(winId, pass1.cancel);
        await pass1.promise;
        activeCancels.delete(winId);

        // --- Pass 2: encode ---
        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            type: 'progress',
            file: inputPath,
            percent: 45,
            status: 'Two-pass: analysis complete. Encoding (pass 2/2)...'
          });
        }

        const pass2Args = ['-i', inputPath, ...commonArgs, '-pass', '2', '-passlogfile', passlogfile, '-c:a', 'aac', '-b:a', audioBr, '-movflags', '+faststart', tempOutputPath];

        const onPass2Progress = (info) => {
          const w = getMainWindow();
          if (w) {
            // Pass 2 accounts for 45-95%; final mux/stat work completes after ffmpeg exits.
            const pct = 45 + Math.min(50, (info.percent || 0) * 0.5);
            const estimatedSize = info.sizeKB ? info.sizeKB * 1024 : null;
            const estimatedFinalSize = (estimatedSize && info.percent > 0)
              ? Math.round(estimatedSize / (info.percent / 100))
              : null;
            const compressionRatio = (estimatedFinalSize && inputSize > 0)
              ? (estimatedFinalSize / inputSize).toFixed(2)
              : null;

            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              type: 'progress',
              file: inputPath,
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
        activeCancels.set(winId, pass2.cancel);
        await pass2.promise;
        activeCancels.delete(winId);

        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            type: 'progress',
            file: inputPath,
            percent: 98,
            status: 'Finalizing output...'
          });
        }

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
        await runSinglePassEncode(crfValue, 'Compressing');

        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            type: 'progress',
            file: inputPath,
            percent: 98,
            status: 'Finalizing output...'
          });
        }
      }

      // Get output file size and compute ratio
      let outputSize = 0;
      try { outputSize = fs.statSync(tempOutputPath).size; } catch (err) { console.warn('Could not read output size:', err.message); }
      const w = getMainWindow();

      if (!twoPass && inputSize > 0 && outputSize >= inputSize) {
        const retryCrfs = getRetryCrfs(crfValue);
        for (const retryCrf of retryCrfs) {
          try { fs.unlinkSync(tempOutputPath); } catch {}
          if (w) {
            w.webContents.send('tool-progress', {
              tool: 'video-compressor',
              type: 'progress',
              file: inputPath,
              percent: 0,
              status: `Output was larger. Retrying at CRF ${retryCrf}...`
            });
          }
          await runSinglePassEncode(retryCrf, `Retrying CRF ${retryCrf}`);
          try { outputSize = fs.statSync(tempOutputPath).size; } catch { outputSize = 0; }
          if (outputSize > 0 && outputSize < inputSize) break;
        }
      }

      const compressionRatio = inputSize > 0 ? (outputSize / inputSize).toFixed(2) : null;
      const savedBytes = inputSize - outputSize;
      const savedPercent = inputSize > 0 ? ((savedBytes / inputSize) * 100).toFixed(1) : 0;

      if (inputSize > 0 && outputSize >= inputSize) {
        try { fs.unlinkSync(tempOutputPath); } catch {}
        if (w) {
          w.webContents.send('tool-progress', {
            tool: 'video-compressor',
            type: 'error',
            file: inputPath,
            error: `Compressed output would be larger (${formatBytes(outputSize)} vs ${formatBytes(inputSize)}). No output was saved.`
          });
        }
        return {
          success: false,
          error: `Compressed output would be larger (${formatBytes(outputSize)} vs ${formatBytes(inputSize)}). Try a higher CRF, lower max resolution, or H.265.`
        };
      }

      try { fs.rmSync(outputPath, { force: true }); } catch {}
      fs.renameSync(tempOutputPath, outputPath);

      if (w) {
        w.webContents.send('tool-progress', {
          tool: 'video-compressor',
          type: 'complete',
          file: inputPath,
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
      activeCancels.delete(winId);
      if (tempOutputPath) {
        try { fs.unlinkSync(tempOutputPath); } catch {}
      }
      return { success: false, error: formatToolError(err, 'Video Compressor') };
    } finally {
      activeCancels.delete(winId);
    }
  });

  ipcMain.handle('video-compressor-cancel', async (event) => {
    const winId = event.sender.id;
    const cancel = activeCancels.get(winId);
    if (cancel) {
      cancel();
      activeCancels.delete(winId);
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

  ipcMain.handle('video-compressor-probe', async (event, filePath) => {
    try {
      const info = await ffmpeg.probeVideoInfo(filePath);
      return { success: true, ...info };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Video Compressor') };
    }
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function getRetryCrfs(initialCrf) {
  const candidates = [initialCrf + 4, initialCrf + 8, initialCrf + 12, 35]
    .map((value) => Math.max(18, Math.min(35, Math.round(value))))
    .filter((value) => value > initialCrf);
  return [...new Set(candidates)];
}

module.exports = { registerIPC };
