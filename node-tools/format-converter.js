'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError, validateMagicBytes } = require('./path-utils');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov']);

/**
 * Map a 1-100 quality slider value to a CRF value for video encoding.
 * Quality 100 -> CRF 15 (best), Quality 1 -> CRF 45 (worst).
 */
function qualityToCRF(quality) {
  const q = Math.max(1, Math.min(100, quality || 80));
  return Math.round(45 - (q / 100) * 30);
}

/**
 * Build sharp output options from format + quality.
 */
function sharpOutputOptions(format, quality) {
  // quality: 1-100 (maps to library-specific ranges)
  const q = quality != null ? Math.max(1, Math.min(100, quality)) : 80;

  switch (format) {
    case 'png':  return { format: 'png',  options: { compressionLevel: Math.round(9 - (q / 100) * 9) } };
    case 'jpg':
    case 'jpeg': return { format: 'jpeg', options: { quality: q } };
    case 'webp': return { format: 'webp', options: { quality: q } };
    case 'tiff': return { format: 'tiff', options: { quality: q } };
    case 'avif': return { format: 'avif', options: { quality: q } };
    case 'bmp':  return { format: 'raw',  options: {} }; // sharp doesn't natively export BMP, use png as fallback
    default:     return { format: 'png',  options: {} };
  }
}

/**
 * Convert a single image file using sharp.
 */
async function convertImage(inputPath, outputPath, targetFormat, quality, keepMetadata) {
  const { format, options } = sharpOutputOptions(targetFormat, quality);

  if (targetFormat === 'bmp') {
    throw new Error('BMP output is not supported. Please use PNG, JPG, or WebP instead.');
  }

  let pipeline = sharp(inputPath);
  if (keepMetadata) pipeline = pipeline.withMetadata();
  await pipeline.toFormat(format, options).toFile(outputPath);
  return outputPath;
}

function registerIPC(ipcMain, getMainWindow) {
  // Active cancel handle
  let activeCancel = null;

  ipcMain.handle('format-converter-convert', async (event, options) => {
    const {
      inputPath,
      outputDir,
      targetFormat,
      quality,
      keepMetadata
    } = options;

    try {
      const ext = path.extname(inputPath).toLowerCase();

      // Validate file content matches extension
      if (!validateMagicBytes(inputPath)) {
        return { success: false, error: `File "${path.basename(inputPath)}" does not appear to be a valid ${ext} file. The file may be corrupted or have the wrong extension.` };
      }

      const baseName = path.basename(inputPath, ext);
      const outExt = '.' + targetFormat;
      const safeOutputDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      const outputPath = path.join(safeOutputDir, baseName + '_converted' + outExt);

      // Ensure output directory exists
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      const isImage = IMAGE_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);

      if (isImage) {
        const win = getMainWindow();
        if (win) win.webContents.send('tool-progress', { tool: 'format-converter', percent: 0, status: 'Converting image...' });

        await convertImage(inputPath, outputPath, targetFormat, quality, keepMetadata);

        if (win) win.webContents.send('tool-progress', { tool: 'format-converter', percent: 100, status: 'Done' });
        return { success: true, output: outputPath };
      }

      if (isVideo) {
        if (!ffmpeg.findFfmpeg()) {
          return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
        }

        const onProgress = (info) => {
          const win = getMainWindow();
          if (win) {
            win.webContents.send('tool-progress', {
              tool: 'format-converter',
              percent: info.percent || 0,
              frame: info.frame,
              speed: info.speed,
              status: `Converting video... ${Math.round(info.percent || 0)}%`
            });
          }
        };

        activeCancel = null;
        const duration = await ffmpeg.probeDuration(inputPath);

        const crf = qualityToCRF(quality);
        const args = ['-i', inputPath];
        switch (targetFormat) {
          case 'mp4':
            args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac', '-b:a', '192k');
            break;
          case 'mkv':
            args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'copy');
            break;
          case 'webm':
            args.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k');
            break;
          case 'avi':
            args.push('-c:v', 'mpeg4', '-q:v', String(Math.max(1, Math.round(crf / 3))), '-c:a', 'mp3', '-b:a', '192k');
            break;
          case 'mov':
            args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac', '-b:a', '192k');
            break;
          default:
            args.push('-c', 'copy');
        }
        args.push(outputPath);

        const { promise, cancel } = ffmpeg.run({ args, durationSeconds: duration, onProgress });
        activeCancel = cancel;

        await promise;
        activeCancel = null;

        return { success: true, output: outputPath };
      }

      return { success: false, error: `Unsupported file type: ${ext}` };
    } catch (err) {
      activeCancel = null;
      return { success: false, error: formatToolError(err, 'Format Converter') };
    }
  });

  ipcMain.handle('format-converter-cancel', async () => {
    if (activeCancel) {
      activeCancel();
      activeCancel = null;
      return { success: true };
    }
    return { success: false, error: 'No active conversion to cancel' };
  });

  ipcMain.handle('format-converter-formats', async () => {
    return {
      image: ['png', 'jpg', 'webp', 'tiff', 'avif'],
      video: ['mp4', 'mkv', 'webm', 'avi', 'mov'],
      ffmpegAvailable: !!ffmpeg.findFfmpeg()
    };
  });
}

module.exports = { registerIPC };
