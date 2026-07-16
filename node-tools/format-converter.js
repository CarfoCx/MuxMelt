'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ffmpeg = require('./ffmpeg-runner');
const { validateOutputDir, formatToolError, validateMagicBytes, autoIncrementPath } = require('./path-utils');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.bmp', '.avif', '.gif', '.svg', '.heic', '.heif']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.mka', '.opus']);
const IMAGE_OUTPUT_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif', 'ico']);
const ANIMATED_IMAGE_OUTPUT_FORMATS = new Set(['gif', 'webp', 'tiff']);
const VIDEO_OUTPUT_FORMATS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov']);
const AUDIO_OUTPUT_FORMATS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac']);

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
    case 'gif':  return { format: 'gif',  options: { colours: 256, effort: 7 } };
    default:     return { format: 'png',  options: {} };
  }
}

async function createIcoBuffer(inputPath) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(async (size) => {
    const buffer = await sharp(inputPath, { animated: false })
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
    return { size, buffer };
  }));

  const headerSize = 6;
  const directorySize = images.length * 16;
  let offset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize + directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const entry = headerSize + index * 16;
    header.writeUInt8(image.size === 256 ? 0 : image.size, entry);
    header.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.buffer.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.buffer.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.buffer)]);
}

/**
 * Convert a single image file using sharp.
 */
async function convertImage(inputPath, outputPath, targetFormat, quality, keepMetadata) {
  if (!IMAGE_OUTPUT_FORMATS.has(targetFormat)) {
    throw new Error(`Unsupported image output format: ${targetFormat}`);
  }

  const metadata = await sharp(inputPath, { animated: false }).metadata();
  const isAnimated = Number(metadata.pages) > 1;
  if (isAnimated && !ANIMATED_IMAGE_OUTPUT_FORMATS.has(targetFormat)) {
    throw new Error(
      `This image has ${metadata.pages} animation frames. Choose GIF, WebP, or TIFF to preserve the animation.`
    );
  }

  if (targetFormat === 'ico') {
    const icoBuffer = await createIcoBuffer(inputPath);
    fs.writeFileSync(outputPath, icoBuffer);
    return outputPath;
  }

  const { format, options } = sharpOutputOptions(targetFormat, quality);

  if (targetFormat === 'bmp') {
    throw new Error('BMP output is not supported. Please use PNG, JPG, or WebP instead.');
  }

  let pipeline = sharp(inputPath, { animated: isAnimated });
  if (keepMetadata) pipeline = pipeline.withMetadata();
  const outputOptions = isAnimated && (format === 'gif' || format === 'webp')
    ? {
        ...options,
        ...(Array.isArray(metadata.delay) && metadata.delay.length > 0 ? { delay: metadata.delay } : {}),
        ...(Number.isInteger(metadata.loop) ? { loop: metadata.loop } : {})
      }
    : options;
  await pipeline.toFormat(format, outputOptions).toFile(outputPath);
  return outputPath;
}

function registerIPC(ipcMain, getMainWindow) {
  const activeCancels = new Map();
  const activeWindows = new Set();
  const cancelledWindows = new Set();

  const throwIfCancelled = (winId) => {
    if (cancelledWindows.has(winId)) throw new Error('Format conversion cancelled by user.');
  };

  ipcMain.handle('format-converter-convert', async (event, options = {}) => {
    const winId = event.sender.id;
    options = options && typeof options === 'object' ? options : {};
    const {
      inputPath,
      outputDir,
      targetFormat,
      quality,
      keepMetadata
    } = options;

    let outputPath = null;
    let registeredActive = false;
    try {
      if (activeWindows.has(winId)) {
        return { success: false, error: 'A format conversion is already running in this window.' };
      }
      if (typeof inputPath !== 'string' || !inputPath || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        return { success: false, error: 'Input file was not found.' };
      }
      const ext = path.extname(inputPath).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      const isVideo = VIDEO_EXTS.has(ext);
      const isAudio = AUDIO_EXTS.has(ext);
      if (!isImage && !isVideo && !isAudio) {
        return { success: false, error: `Unsupported file type: ${ext || '(none)'}` };
      }
      const outputFormat = String(targetFormat || '').trim().toLowerCase();
      const validTarget = isImage
        ? IMAGE_OUTPUT_FORMATS.has(outputFormat)
        : (VIDEO_OUTPUT_FORMATS.has(outputFormat) || AUDIO_OUTPUT_FORMATS.has(outputFormat));
      if (!validTarget || (isAudio && VIDEO_OUTPUT_FORMATS.has(outputFormat))) {
        return { success: false, error: `Unsupported output format "${outputFormat || '(none)'}" for this input.` };
      }
      const numericQuality = quality == null || quality === '' ? NaN : Number(quality);
      const qualityValue = Number.isFinite(numericQuality) ? Math.max(1, Math.min(100, numericQuality)) : 80;

      // Validate file content matches extension
      if (!validateMagicBytes(inputPath)) {
        return { success: false, error: `File "${path.basename(inputPath)}" does not appear to be a valid ${ext} file. The file may be corrupted or have the wrong extension.` };
      }

      const baseName = path.basename(inputPath, ext);
      const outExt = '.' + outputFormat;
      const safeOutputDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      outputPath = autoIncrementPath(path.join(safeOutputDir, baseName + '_converted' + outExt));

      // Ensure output directory exists
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      activeWindows.add(winId);
      registeredActive = true;
      cancelledWindows.delete(winId);

      if (isImage) {
        const win = getMainWindow();
        if (win) win.webContents.send('tool-progress', {
          tool: 'format-converter', type: 'progress', file: inputPath, percent: 0, status: 'Converting image...'
        });

        await convertImage(inputPath, outputPath, outputFormat, qualityValue, !!keepMetadata);
        throwIfCancelled(winId);

        if (win) win.webContents.send('tool-progress', {
          tool: 'format-converter', type: 'complete', file: inputPath, output: outputPath, percent: 100, status: 'Done'
        });
        return { success: true, output: outputPath };
      }

      if (isVideo || isAudio) {
        if (!ffmpeg.findFfmpeg()) {
          return { success: false, error: 'ffmpeg not found. Please install ffmpeg and add it to your PATH.' };
        }

        const onProgress = (info) => {
          const win = getMainWindow();
          if (win) {
            win.webContents.send('tool-progress', {
              tool: 'format-converter',
              type: 'progress',
              file: inputPath,
              percent: info.percent || 0,
              frame: info.frame,
              speed: info.speed,
              status: `Converting video... ${Math.round(info.percent || 0)}%`
            });
          }
        };

        const startWindow = getMainWindow();
        if (startWindow) startWindow.webContents.send('tool-progress', {
          tool: 'format-converter', type: 'progress', file: inputPath, percent: 0, status: 'Reading media information...'
        });
        const duration = await ffmpeg.probeDuration(inputPath);
        throwIfCancelled(winId);

        const crf = qualityToCRF(qualityValue);
        const args = ['-i', inputPath];
        if (AUDIO_OUTPUT_FORMATS.has(outputFormat) && isVideo) args.push('-vn');
        switch (outputFormat) {
          case 'mp4': args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac', '-b:a', '192k'); break;
          case 'mkv': args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'copy'); break;
          case 'webm': args.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'); break;
          case 'avi': args.push('-c:v', 'mpeg4', '-q:v', String(Math.max(1, Math.round(crf / 3))), '-c:a', 'mp3', '-b:a', '192k'); break;
          case 'mov': args.push('-c:v', 'libx264', '-crf', String(crf), '-c:a', 'aac', '-b:a', '192k'); break;
          case 'mp3': args.push('-c:a', 'libmp3lame', '-q:a', String(Math.max(0, Math.min(9, Math.round((crf - 15) / 5))))); break;
          case 'wav': args.push('-c:a', 'pcm_s16le'); break;
          case 'flac': args.push('-c:a', 'flac', '-compression_level', '8'); break;
          case 'm4a': args.push('-c:a', 'aac', '-b:a', '256k'); break;
          case 'ogg': args.push('-c:a', 'libvorbis', '-q:a', String(Math.max(0, Math.round(10 - crf / 4.5)))); break;
          case 'aac': args.push('-c:a', 'aac', '-b:a', '256k'); break;
          default: args.push('-c', 'copy');
        }
        const metadataInput = keepMetadata === true ? '0' : '-1';
        args.push('-map_metadata', metadataInput, '-map_chapters', metadataInput);
        args.push(outputPath);

        const { promise, cancel } = ffmpeg.run({ args, durationSeconds: duration, onProgress });
        activeCancels.set(winId, cancel);
        await promise;
        activeCancels.delete(winId);
        throwIfCancelled(winId);

        const completedWindow = getMainWindow();
        if (completedWindow) completedWindow.webContents.send('tool-progress', {
          tool: 'format-converter', type: 'complete', file: inputPath, output: outputPath, percent: 100, status: 'Done'
        });

        return { success: true, output: outputPath };
      }
    } catch (err) {
      // autoIncrementPath guarantees this path didn't exist before we started,
      // so a leftover file here is always our own partial output.
      if (outputPath) { try { fs.rmSync(outputPath, { force: true }); } catch {} }
      return { success: false, error: formatToolError(err, 'Format Converter') };
    } finally {
      if (registeredActive) {
        activeCancels.delete(winId);
        cancelledWindows.delete(winId);
        activeWindows.delete(winId);
      }
    }
  });

  ipcMain.handle('format-converter-cancel', async (event) => {
    const winId = event.sender.id;
    if (!activeWindows.has(winId)) {
      return { success: false, error: 'No active conversion to cancel' };
    }
    cancelledWindows.add(winId);
    const cancel = activeCancels.get(winId);
    if (cancel) cancel();
    return { success: true };
  });

  ipcMain.handle('format-converter-formats', async () => {
    return {
      image: ['png', 'jpg', 'webp', 'gif', 'ico', 'tiff', 'avif'],
      video: ['mp4', 'mkv', 'webm', 'avi', 'mov'],
      audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'],
      ffmpegAvailable: !!ffmpeg.findFfmpeg()
    };
  });
}

module.exports = { registerIPC };
