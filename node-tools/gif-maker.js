'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError } = require('./path-utils');

function parseTimeToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, parseFloat(raw));

  const parts = raw.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  return 0;
}

function registerIPC(ipcMain, getMainWindow) {
  let activeCancel = null;

  ipcMain.handle('gif-maker-create', async (event, options) => {
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

    try {
      if (!ffmpeg.findFfmpeg()) {
        return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
      }

      const gifFps = Math.max(1, Math.min(30, fps || 15));
      const gifWidth = width || 480;
      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      const outputPath = path.join(outDir, baseName + '.gif');

      fs.mkdirSync(outDir, { recursive: true });

      // Temp palette file (declared before try so it's accessible in finally)
      palettePath = path.join(os.tmpdir(), `palette_${Date.now()}.png`);

      // Probe total duration for progress calculation
      const totalDuration = await ffmpeg.probeDuration(inputPath);
      const startSeconds = parseTimeToSeconds(startTime);
      const requestedDuration = Number.parseFloat(duration);
      const constrainedDuration = Math.max(0.5, Math.min(60, Number.isFinite(requestedDuration) ? requestedDuration : 5));
      const availableDuration = totalDuration > 0 ? Math.max(0.5, totalDuration - startSeconds) : constrainedDuration;
      const clipDuration = Math.min(constrainedDuration, availableDuration);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
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

      const filterScale = reverse
        ? `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos,reverse`
        : `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos`;
      const colors = Math.max(32, Math.min(256, maxColors || 256));

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
      activeCancel = pass1.cancel;
      await pass1.promise;
      activeCancel = null;

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'progress',
          percent: 40,
          status: 'Palette generated. Creating GIF (pass 2/2)...'
        });
      }

      // ------- PASS 2: Create GIF using palette -------
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'progress',
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
      activeCancel = pass2.cancel;
      await pass2.promise;
      activeCancel = null;

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'gif-maker',
          type: 'progress',
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
          percent: 100,
          status: 'Done'
        });
      }

      return {
        success: true,
        output: outputPath,
        outputSize
      };
    } catch (err) {
      activeCancel = null;
      return { success: false, error: formatToolError(err, 'GIF Maker') };
    } finally {
      // Always clean up palette file
      if (palettePath) { try { fs.unlinkSync(palettePath); } catch {} }
    }
  });

  ipcMain.handle('gif-maker-cancel', async () => {
    if (activeCancel) {
      activeCancel();
      activeCancel = null;
      return { success: true };
    }
    return { success: false, error: 'No active GIF creation to cancel' };
  });
}

module.exports = { registerIPC };
