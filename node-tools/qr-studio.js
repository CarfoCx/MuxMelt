'use strict';

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const sharp = require('sharp');
const { validateOutputDir, validateOutputName, autoIncrementPath } = require('./path-utils');

const MAX_QR_TEXT_LENGTH = 10000;
const MAX_SCAN_PIXELS = 40 * 1000 * 1000;
const MAX_BATCH_FILES = 500;

function makeQrOptions(options, preview = false) {
  const requestedSize = options.size == null || options.size === '' ? NaN : Number(options.size);
  const width = Number.isFinite(requestedSize)
    ? Math.round(requestedSize)
    : (preview ? 256 : 512);
  const maxSize = preview ? 1024 : 4096;
  if (width < 64 || width > maxSize) throw new Error(`QR size must be between 64 and ${maxSize} pixels.`);

  const requestedMargin = options.margin == null ? 4 : Number(options.margin);
  if (!Number.isInteger(requestedMargin) || requestedMargin < 0 || requestedMargin > 20) {
    throw new Error('QR margin must be a whole number between 0 and 20.');
  }
  const colorPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const dark = String(options.color || '#000000');
  const light = String(options.backgroundColor || '#ffffff');
  if (!colorPattern.test(dark) || !colorPattern.test(light)) throw new Error('QR colors must be hexadecimal values.');
  const level = String(options.errorCorrection || 'M').toUpperCase();
  if (!['L', 'M', 'Q', 'H'].includes(level)) throw new Error('Invalid QR error-correction level.');

  return {
    type: preview ? 'image/png' : 'png',
    width,
    margin: requestedMargin,
    color: { dark, light },
    errorCorrectionLevel: level
  };
}

async function decodeQrFile(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error('Input image was not found.');
  }
  const image = sharp(inputPath, { limitInputPixels: MAX_SCAN_PIXELS, failOn: 'error' }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_SCAN_PIXELS) {
    throw new Error('Image is too large to scan safely.');
  }
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  return jsQR(pixels, info.width, info.height);
}

function registerIPC(ipcMain, getMainWindow, jobRegistry = null) {
  const assertJobStart = () => jobRegistry?.assertCanStart?.('QR operation');

  // ---- GENERATE QR CODE ----
  ipcMain.handle('qr-studio-generate', async (event, options = {}) => {
    assertJobStart();
    options = options && typeof options === 'object' ? options : {};
    const {
      text,
      outputDir,
      outputName,
      size,               // width/height in px, default 512
      margin,             // quiet zone modules, default 4
      color,              // foreground color hex, default '#000000'
      backgroundColor,    // background color hex, default '#ffffff'
      errorCorrection     // 'L', 'M', 'Q', 'H', default 'M'
    } = options;

    let outputPath = null;
    try {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { success: false, error: 'No text or URL provided for QR code generation' };
      }
      if (text.length > MAX_QR_TEXT_LENGTH) return { success: false, error: 'QR content is too long.' };

      const outDir = validateOutputDir(outputDir) || path.join(require('os').tmpdir(), 'qr-studio');
      fs.mkdirSync(outDir, { recursive: true });

      const fileName = validateOutputName(outputName) || `qr_${Date.now()}.png`;
      if (path.extname(fileName).toLowerCase() !== '.png') {
        return { success: false, error: 'QR output filename must end in .png.' };
      }
      outputPath = path.join(outDir, fileName);
      outputPath = autoIncrementPath(outputPath);

      const qrOptions = makeQrOptions({ size, margin, color, backgroundColor, errorCorrection });

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'qr-studio',
          percent: 0,
          status: 'Generating QR code...'
        });
      }

      await QRCode.toFile(outputPath, text, qrOptions);

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'qr-studio',
          percent: 100,
          status: 'Done'
        });
      }

      return { success: true, output: outputPath };
    } catch (err) {
      if (outputPath) { try { fs.rmSync(outputPath, { force: true }); } catch {} }
      return { success: false, error: err.message };
    }
  });

  // ---- GENERATE QR AS DATA URL (for preview) ----
  ipcMain.handle('qr-studio-preview', async (event, options = {}) => {
    assertJobStart();
    options = options && typeof options === 'object' ? options : {};
    const {
      text,
      size,
      margin,
      color,
      backgroundColor,
      errorCorrection
    } = options;

    try {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { success: false, error: 'No text provided' };
      }
      if (text.length > MAX_QR_TEXT_LENGTH) return { success: false, error: 'QR content is too long.' };

      const qrOptions = makeQrOptions({ size, margin, color, backgroundColor, errorCorrection }, true);

      const dataUrl = await QRCode.toDataURL(text, qrOptions);
      return { success: true, dataUrl };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---- SCAN / DECODE QR FROM IMAGE ----
  ipcMain.handle('qr-studio-scan', async (event, options = {}) => {
    assertJobStart();
    options = options && typeof options === 'object' ? options : {};
    const { inputPath } = options;

    try {
      if (!inputPath) {
        return { success: false, error: 'No input file specified' };
      }

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'qr-studio',
          percent: 0,
          status: 'Scanning image for QR code...'
        });
      }

      const code = await decodeQrFile(inputPath);

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'qr-studio',
          percent: 100,
          status: 'Done'
        });
      }

      if (code) {
        return {
          success: true,
          data: code.data,
          location: {
            topLeft: code.location.topLeftCorner,
            topRight: code.location.topRightCorner,
            bottomLeft: code.location.bottomLeftCorner,
            bottomRight: code.location.bottomRightCorner
          }
        };
      } else {
        return { success: false, error: 'No QR code found in the image' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---- BATCH SCAN multiple images ----
  const cancelledWindows = new Set();
  const activeBatchWindows = new Set();
  if (jobRegistry && typeof jobRegistry.register === 'function') {
    jobRegistry.register('qr-studio', () => {
      for (const winId of activeBatchWindows) cancelledWindows.add(winId);
    });
  }

  ipcMain.handle('qr-studio-batch-scan', async (event, options = {}) => {
    assertJobStart();
    options = options && typeof options === 'object' ? options : {};
    const { inputPaths } = options;

    if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
      return { success: false, error: 'No files provided' };
    }
    if (inputPaths.length > MAX_BATCH_FILES) return { success: false, error: `Select no more than ${MAX_BATCH_FILES} images at once.` };

    const winId = event.sender.id;
    if (activeBatchWindows.has(winId)) return { success: false, error: 'A QR batch scan is already running in this window.' };
    activeBatchWindows.add(winId);
    cancelledWindows.delete(winId);

    try {
      const results = [];
      const total = inputPaths.length;
      let isCancelled = false;

      for (let i = 0; i < total; i++) {
        if (cancelledWindows.has(winId)) {
          isCancelled = true;
          break;
        }

        const filePath = inputPaths[i];
        const win = getMainWindow();
        if (win) {
          win.webContents.send('tool-progress', {
            tool: 'qr-studio',
            percent: (i / total) * 100,
            current: i + 1,
            total,
            status: `Scanning ${i + 1}/${total}...`
          });
        }

        try {
          const code = await decodeQrFile(filePath);
          if (cancelledWindows.has(winId)) {
            isCancelled = true;
            break;
          }

          results.push({
            file: filePath,
            success: !!code,
            data: code ? code.data : null
          });
        } catch (err) {
          results.push({
            file: filePath,
            success: false,
            error: err.message
          });
        }
      }

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'qr-studio',
          percent: 100,
          status: isCancelled ? 'Cancelled' : 'Done'
        });
      }

      return {
        success: true,
        cancelled: isCancelled,
        results,
        found: results.filter(r => r.success).length,
        total
      };
    } catch (err) {
      return { success: false, error: err.message || 'QR batch scan failed.' };
    } finally {
      cancelledWindows.delete(winId);
      activeBatchWindows.delete(winId);
    }
  });

  ipcMain.handle('qr-studio-cancel-batch', async (event) => {
    const winId = event.sender.id;
    if (!activeBatchWindows.has(winId)) return { success: false, error: 'No active QR batch scan to cancel' };
    cancelledWindows.add(winId);
    return { success: true };
  });
}

module.exports = { registerIPC };
