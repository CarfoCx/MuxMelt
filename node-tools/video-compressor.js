'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError, autoIncrementPath } = require('./path-utils');

const VALID_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow'
];
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov']);

function isRegularFile(filePath) {
  try { return typeof filePath === 'string' && fs.statSync(filePath).isFile(); } catch { return false; }
}

function publishTempFile(tempPath, desiredPath) {
  let outputPath = desiredPath;
  for (let attempt = 0; attempt < 1000; attempt++) {
    let published = false;
    try {
      // A hard link publishes the completed file atomically and, unlike rename
      // on POSIX, never overwrites a file that appeared after autoIncrementPath.
      fs.linkSync(tempPath, outputPath);
      published = true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        outputPath = autoIncrementPath(desiredPath);
        continue;
      }
      // Some filesystems disallow hard links. COPYFILE_EXCL keeps the same
      // no-overwrite guarantee, at the cost of one additional copy.
      try {
        fs.copyFileSync(tempPath, outputPath, fs.constants.COPYFILE_EXCL);
        published = true;
      } catch (copyErr) {
        if (copyErr && copyErr.code === 'EEXIST') {
          outputPath = autoIncrementPath(desiredPath);
          continue;
        }
        throw copyErr;
      }
    }
    if (published) {
      try { fs.unlinkSync(tempPath); } catch {}
      return outputPath;
    }
  }
  throw new Error('Could not reserve a unique output filename.');
}

function registerIPC(ipcMain, getMainWindow, jobRegistry = null) {
  const assertJobStart = () => {
    ffmpeg.throwIfCleanupFailed();
    jobRegistry?.assertCanStart?.('Video compression');
  };
  const activeCancels = new Map();
  const activeWindows = new Set();
  const cancelledWindows = new Set();
  if (jobRegistry && typeof jobRegistry.register === 'function') {
    jobRegistry.register('video-compressor', async () => {
      for (const winId of activeWindows) cancelledWindows.add(winId);
      const cancellations = [...activeCancels.values()].map((cancel) => Promise.resolve().then(cancel));
      await Promise.all(cancellations);
      ffmpeg.throwIfCleanupFailed();
    });
  }

  const throwIfCancelled = (winId) => {
    if (cancelledWindows.has(winId)) throw new Error('Video compression cancelled by user.');
  };

  ipcMain.handle('video-compressor-compress', async (event, options = {}) => {
    assertJobStart();
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
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
    let passlogfile = null;
    let registeredActive = false;

    try {
      if (activeWindows.has(winId)) {
        return { success: false, error: 'A video compression is already running in this window.' };
      }
      if (!ffmpeg.findFfmpeg()) {
        return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
      }
      if (!isRegularFile(inputPath)) return { success: false, error: 'Input video was not found.' };

      const requestedCrf = crf == null || crf === '' ? NaN : Number(crf);
      const crfValue = Number.isFinite(requestedCrf) ? Math.max(18, Math.min(35, Math.round(requestedCrf))) : 23;
      const presetValue = VALID_PRESETS.includes(preset) ? preset : 'medium';
      const codecValue = codec === 'h265' ? 'h265' : (codec === 'h264' ? 'h264' : null);
      if (!codecValue) return { success: false, error: 'Unsupported video codec.' };
      const audioBr = String(audioBitrate || '128k').trim().toLowerCase();
      if (!/^\d{2,3}k$/.test(audioBr) || Number.parseInt(audioBr, 10) < 32 || Number.parseInt(audioBr, 10) > 512) {
        return { success: false, error: 'Audio bitrate must be between 32k and 512k.' };
      }
      const resolutionValue = resolution == null || resolution === '' ? 'original' : String(resolution);
      if (!['original', '1080p', '720p', '480p', 'custom'].includes(resolutionValue)) {
        return { success: false, error: 'Unsupported output resolution.' };
      }
      const requestedCustomWidth = Number(customWidth);
      if (resolutionValue === 'custom' && (!Number.isFinite(requestedCustomWidth) || requestedCustomWidth < 128 || requestedCustomWidth > 7680)) {
        return { success: false, error: 'Custom width must be between 128 and 7680 pixels.' };
      }

      const ext = path.extname(inputPath).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) return { success: false, error: `Unsupported video format: ${ext || '(none)'}` };
      // H.264/H.265 + AAC cannot be muxed into WebM and has very poor
      // interoperability in AVI. Preserve the selected modern codec by using
      // the widely supported MP4 container for both source formats.
      const outExt = (ext === '.webm' || ext === '.avi') ? '.mp4' : ext;
      const baseName = path.basename(inputPath, ext);
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      let outputPath = path.join(outDir, baseName + '_compressed' + outExt);
      outputPath = autoIncrementPath(outputPath);
      tempOutputPath = path.join(outDir, `${baseName}_compressed.${process.pid}.${crypto.randomUUID()}.tmp${outExt}`);
      // faststart is a MOV/MP4 muxer option; it has no meaning for MKV.
      const faststartArgs = (outExt === '.mp4' || outExt === '.mov') ? ['-movflags', '+faststart'] : [];

      fs.mkdirSync(outDir, { recursive: true });
      activeWindows.add(winId);
      registeredActive = true;
      cancelledWindows.delete(winId);

      // Get input file size for compression ratio
      let inputSize = 0;
      try { inputSize = fs.statSync(inputPath).size; } catch (err) { console.warn('Could not read input size:', err.message); }

      const videoInfo = await ffmpeg.probeVideoInfo(inputPath);
      const duration = videoInfo.duration || await ffmpeg.probeDuration(inputPath);
      throwIfCancelled(winId);

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
      const videoCodec = codecValue === 'h265' ? 'libx265' : 'libx264';
      commonArgs.push('-c:v', videoCodec);
      if (codecValue === 'h265' && (outExt === '.mp4' || outExt === '.mov')) {
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
      if (resolutionValue !== 'original') {
        if (resolutionMap[resolutionValue]) {
          const targetHeight = parseInt(resolutionValue, 10);
          if (!videoInfo.height || targetHeight < videoInfo.height) {
            commonArgs.push('-vf', resolutionMap[resolutionValue]);
          }
        } else if (resolutionValue === 'custom') {
          const w = Math.round(requestedCustomWidth / 2) * 2;
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
        args.push(...faststartArgs);
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
        throwIfCancelled(winId);
      };

      const useTwoPass = !!twoPass && duration > 0 && inputSize > 0;
      const twoPassCommonArgs = [...commonArgs];
      const twoPassCrfIndex = twoPassCommonArgs.indexOf('-crf');
      if (twoPassCrfIndex !== -1) twoPassCommonArgs.splice(twoPassCrfIndex, 2);
      const sourceTotalKbps = useTwoPass ? (inputSize * 8 / duration / 1000) : 0;
      const targetFactor = Math.max(0.2, Math.min(0.9, Math.pow(0.5, (crfValue - 18) / 6)));
      const targetVideoKbps = Math.min(100000, Math.max(100, Math.floor(sourceTotalKbps * targetFactor - Number.parseInt(audioBr, 10))));
      twoPassCommonArgs.push('-b:v', `${targetVideoKbps}k`);

      if (useTwoPass) {
        // Two-pass encoding
        passlogfile = path.join(os.tmpdir(), `muxmelt-ffmpeg2pass-${process.pid}-${crypto.randomUUID()}`);
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

        const pass1Args = ['-i', inputPath, ...twoPassCommonArgs, '-pass', '1', '-passlogfile', passlogfile, '-an', '-f', 'null', nullOutput];

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
        throwIfCancelled(winId);

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

        const pass2Args = ['-i', inputPath, ...twoPassCommonArgs, '-pass', '2', '-passlogfile', passlogfile, '-c:a', 'aac', '-b:a', audioBr, ...faststartArgs, tempOutputPath];

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
        throwIfCancelled(winId);

        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'video-compressor',
            type: 'progress',
            file: inputPath,
            percent: 98,
            status: 'Finalizing output...'
          });
        }

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

      if (!useTwoPass && inputSize > 0 && outputSize >= inputSize) {
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

      throwIfCancelled(winId);
      outputPath = publishTempFile(tempOutputPath, outputPath);

      if (w) {
        w.webContents.send('tool-progress', {
          tool: 'video-compressor',
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
        inputSize,
        outputSize,
        compressionRatio,
        savedBytes,
        savedPercent: parseFloat(savedPercent)
      };
    } catch (err) {
      if (tempOutputPath) {
        try { fs.unlinkSync(tempOutputPath); } catch {}
      }
      return { success: false, error: formatToolError(err, 'Video Compressor') };
    } finally {
      if (registeredActive) {
        activeCancels.delete(winId);
        cancelledWindows.delete(winId);
        activeWindows.delete(winId);
      }
      if (tempOutputPath) {
        try { fs.rmSync(tempOutputPath, { force: true }); } catch {}
      }
      if (passlogfile) {
        try {
          const prefix = path.basename(passlogfile);
          for (const file of fs.readdirSync(os.tmpdir())) {
            if (file.startsWith(prefix)) {
              try { fs.unlinkSync(path.join(os.tmpdir(), file)); } catch {}
            }
          }
        } catch {}
      }
    }
  });

  ipcMain.handle('video-compressor-cancel', async (event) => {
    const winId = event.sender.id;
    if (!activeWindows.has(winId)) {
      return { success: false, error: 'No active compression to cancel' };
    }
    cancelledWindows.add(winId);
    const cancel = activeCancels.get(winId);
    if (cancel) await cancel();
    ffmpeg.throwIfCleanupFailed();
    return { success: true };
  });

  ipcMain.handle('video-compressor-estimate', async (event, options) => {
    assertJobStart();
    // Rough size estimate based on CRF and duration
    try {
      options = options && typeof options === 'object' ? options : {};
      if (!isRegularFile(options.inputPath)) return { success: false, error: 'Input video was not found.' };
      const duration = await ffmpeg.probeDuration(options.inputPath);
      let inputSize = 0;
      try { inputSize = fs.statSync(options.inputPath).size; } catch {}

      // Very rough estimate: CRF 23 roughly halves the file for most content
      // Each CRF +6 roughly halves the size
      const requestedCrf = options.crf == null || options.crf === '' ? NaN : Number(options.crf);
      const estimateCrf = Number.isFinite(requestedCrf) ? Math.max(18, Math.min(35, requestedCrf)) : 23;
      const crfDiff = estimateCrf - 18;
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
    assertJobStart();
    try {
      if (!isRegularFile(filePath)) return { success: false, error: 'Input video was not found.' };
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
