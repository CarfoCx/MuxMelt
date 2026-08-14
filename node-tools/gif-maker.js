'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError, autoIncrementPath } = require('./path-utils');

// FFmpeg's reverse filter buffers the whole filtered clip in memory. Budget
// conservatively for decoded RGBA frames plus frame/filter bookkeeping.
const MAX_REVERSE_MEMORY_BYTES = 512 * 1024 * 1024;
const REVERSE_BYTES_PER_PIXEL = 4;
const REVERSE_MEMORY_OVERHEAD = 1.25;

function parseTimeToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, parseFloat(raw));

  const parts = raw.split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return NaN;
  if (parts.length === 3 && parts[1] < 60 && parts[2] < 60) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2 && parts[1] < 60) return parts[0] * 60 + parts[1];
  return NaN;
}

function registerIPC(ipcMain, getMainWindow, jobRegistry = null) {
  const assertJobStart = () => {
    ffmpeg.throwIfCleanupFailed();
    jobRegistry?.assertCanStart?.('GIF creation');
  };
  const activeCancels = new Map();
  const activeWindows = new Set();
  const cancelledWindows = new Set();
  if (jobRegistry && typeof jobRegistry.register === 'function') {
    jobRegistry.register('gif-maker', async () => {
      for (const winId of activeWindows) cancelledWindows.add(winId);
      const cancellations = [...activeCancels.values()].map((cancel) => Promise.resolve().then(cancel));
      await Promise.all(cancellations);
      ffmpeg.throwIfCleanupFailed();
    });
  }

  const throwIfCancelled = (winId) => {
    if (cancelledWindows.has(winId)) throw new Error('GIF creation cancelled by user.');
  };

  ipcMain.handle('gif-maker-create', async (event, options = {}) => {
    assertJobStart();
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
    const {
      inputPath,
      outputDir,
      fps,          // 10-30, default 15
      width,        // output width, -1 for auto-scale, default 480
      startTime,    // start offset in seconds, default 0
      duration,     // clip duration in seconds, default full
      dither,       // 'bayer', 'floyd_steinberg', 'sierra2', 'none'
      maxColors,    // 32-256, default 256
      reverse       // boolean, reverse playback
    } = options;

    let palettePath = null;
    let outputPath = null;
    let registeredActive = false;

    try {
      if (activeWindows.has(winId)) {
        return { success: false, error: 'A GIF is already being created in this window.' };
      }
      if (!ffmpeg.findFfmpeg()) {
        return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
      }
      if (typeof inputPath !== 'string' || !inputPath || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        return { success: false, error: 'Input video was not found.' };
      }

      const requestedFps = Number(fps);
      const gifFps = Number.isFinite(requestedFps) ? Math.max(1, Math.min(30, Math.round(requestedFps))) : 15;
      const requestedWidth = Number(width);
      const gifWidth = requestedWidth === -1
        ? -1
        : (Number.isFinite(requestedWidth) ? Math.max(16, Math.min(7680, Math.round(requestedWidth))) : 480);
      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      outputPath = autoIncrementPath(path.join(outDir, baseName + '.gif'));

      fs.mkdirSync(outDir, { recursive: true });

      // Temp palette file (declared before try so it's accessible in finally)
      palettePath = path.join(os.tmpdir(), `muxmelt-palette-${process.pid}-${crypto.randomUUID()}.png`);
      activeWindows.add(winId);
      registeredActive = true;
      cancelledWindows.delete(winId);

      // Dimensions are required to preflight the reverse filter's whole-clip
      // frame buffer; the same probe also supplies duration for progress.
      const videoInfo = await ffmpeg.probeVideoInfo(inputPath);
      throwIfCancelled(winId);
      const totalDuration = Number(videoInfo && videoInfo.duration) || 0;
      const startSeconds = parseTimeToSeconds(startTime);
      if (!Number.isFinite(startSeconds)) {
        return { success: false, error: 'Invalid start time. Use seconds or HH:MM:SS.' };
      }
      if (totalDuration > 0 && startSeconds >= totalDuration) {
        return { success: false, error: 'Start time must be before the end of the video.' };
      }
      const requestedDuration = Number.parseFloat(duration);
      const constrainedDuration = Math.max(0.5, Math.min(60, Number.isFinite(requestedDuration) ? requestedDuration : 5));
      const availableDuration = totalDuration > 0 ? totalDuration - startSeconds : constrainedDuration;
      const clipDuration = Math.min(constrainedDuration, availableDuration);

      if (reverse) {
        const sourceWidth = Number(videoInfo && videoInfo.width);
        const sourceHeight = Number(videoInfo && videoInfo.height);
        if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
          return {
            success: false,
            error: 'Reverse needs readable video dimensions to estimate memory safely. Try another video or turn off Reverse.'
          };
        }

        const outputWidth = gifWidth === -1 ? sourceWidth : gifWidth;
        const proportionalHeight = gifWidth === -1
          ? sourceHeight
          : (sourceHeight * outputWidth) / sourceWidth;
        // Round upward to an even height so the estimate never understates the
        // aspect-preserving scale produced by FFmpeg.
        const outputHeight = Math.max(2, Math.ceil(proportionalHeight / 2) * 2);
        const frameCount = Math.max(1, Math.ceil(clipDuration * gifFps));
        const estimatedBytes = outputWidth * outputHeight * frameCount
          * REVERSE_BYTES_PER_PIXEL * REVERSE_MEMORY_OVERHEAD;

        if (!Number.isFinite(estimatedBytes) || estimatedBytes > MAX_REVERSE_MEMORY_BYTES) {
          const estimatedMiB = Number.isFinite(estimatedBytes)
            ? Math.ceil(estimatedBytes / (1024 * 1024))
            : 'an unknown amount of';
          return {
            success: false,
            error: `Reverse would require too much memory (about ${estimatedMiB} MiB for ${frameCount} frames at ${outputWidth}x${outputHeight}; safe limit 512 MiB). Shorten the clip or reduce width/FPS, or turn off Reverse.`
          };
        }
      }

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'progress',
          file: inputPath,
          percent: 0,
          status: 'Generating palette (pass 1/2)...'
        });
      }

      // Clip the video input before both passes. Keeping -t before the video
      // input avoids it being interpreted against the palette input in pass 2.
      const videoInputArgs = [];
      if (startSeconds > 0) {
        videoInputArgs.push('-ss', String(startSeconds));
      }
      videoInputArgs.push('-t', String(clipDuration), '-i', inputPath);

      const filters = [`fps=${gifFps}`];
      if (gifWidth !== -1) filters.push(`scale=${gifWidth}:-1:flags=lanczos`);
      if (reverse) filters.push('reverse');
      const filterScale = filters.join(',');
      const requestedColors = Number(maxColors);
      const colors = Number.isFinite(requestedColors) ? Math.max(32, Math.min(256, Math.round(requestedColors))) : 256;

      // Build dither string for paletteuse
      const ditherMap = {
        bayer: 'dither=bayer:bayer_scale=5',
        floyd_steinberg: 'dither=floyd_steinberg',
        sierra2: 'dither=sierra2',
        none: 'dither=none'
      };
      const ditherStr = ditherMap[dither] || ditherMap.bayer;

      // ------- PASS 1: Generate palette -------
      const pass1Args = [
        ...videoInputArgs,
        '-vf', `${filterScale},palettegen=max_colors=${colors}:stats_mode=diff`,
        palettePath
      ];

      const onPass1Progress = (info) => {
        const w = getMainWindow();
        if (w) {
          // Pass 1 accounts for 0-35%. The step only reaches 40 once ffmpeg exits.
          const pct = Math.min(35, (info.percent || 0) * 0.35);
          w.webContents.send('tool-progress', {
            tool: 'gif-maker',
            type: 'progress',
            file: inputPath,
            percent: pct,
            status: `Generating palette... ${Math.round(pct)}%`
          });
        }
      };

      const pass1 = ffmpeg.run({
        args: pass1Args,
        durationSeconds: clipDuration,
        onProgress: onPass1Progress
      });
      activeCancels.set(winId, pass1.cancel);
      await pass1.promise;
      activeCancels.delete(winId);
      throwIfCancelled(winId);

      // ------- PASS 2: Create GIF using palette -------
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'progress',
          file: inputPath,
          percent: 40,
          status: 'Creating GIF (pass 2/2)...'
        });
      }

      const pass2Args = [
        ...videoInputArgs,
        '-i', palettePath,
        '-lavfi', `${filterScale} [x]; [x][1:v] paletteuse=${ditherStr}`,
        outputPath
      ];

      const onPass2Progress = (info) => {
        const w = getMainWindow();
        if (w) {
          // Pass 2 accounts for 40-95%. 100 is reserved for actual completion.
          const pct = 40 + Math.min(55, (info.percent || 0) * 0.55);
          w.webContents.send('tool-progress', {
            tool: 'gif-maker',
            type: 'progress',
            file: inputPath,
            percent: pct,
            status: `Creating GIF... ${Math.round(pct)}%`
          });
        }
      };

      const pass2 = ffmpeg.run({
        args: pass2Args,
        durationSeconds: clipDuration,
        onProgress: onPass2Progress
      });
      activeCancels.set(winId, pass2.cancel);
      await pass2.promise;
      activeCancels.delete(winId);
      throwIfCancelled(winId);

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'progress',
          file: inputPath,
          percent: 98,
          status: 'Finalizing GIF...'
        });
      }

      // Clean up palette
      try { fs.unlinkSync(palettePath); } catch {}

      // Get output file size
      let outputSize = 0;
      try { outputSize = fs.statSync(outputPath).size; } catch {}

      const w = getMainWindow();
      if (w) {
        w.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'complete',
          file: inputPath,
          output: outputPath,
          status: 'Done'
        });
      }

      return {
        success: true,
        output: outputPath,
        outputSize
      };
    } catch (err) {
      // autoIncrementPath guarantees this path is ours, so a leftover file
      // after a failed/cancelled run is always a partial output.
      if (outputPath) { try { fs.rmSync(outputPath, { force: true }); } catch {} }
      return { success: false, error: formatToolError(err, 'GIF Maker') };
    } finally {
      if (registeredActive) {
        activeCancels.delete(winId);
        cancelledWindows.delete(winId);
        activeWindows.delete(winId);
      }
      // Always clean up palette file
      if (palettePath) { try { fs.unlinkSync(palettePath); } catch {} }
    }
  });

  ipcMain.handle('gif-maker-cancel', async (event) => {
    const winId = event.sender.id;
    if (!activeWindows.has(winId)) {
      return { success: false, error: 'No active GIF creation to cancel' };
    }
    cancelledWindows.add(winId);
    const cancel = activeCancels.get(winId);
    if (cancel) await cancel();
    ffmpeg.throwIfCleanupFailed();
    return { success: true };
  });
}

module.exports = { registerIPC };
