'use strict';

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const sharp = require('sharp');
const { validateOutputDir, validateOutputName } = require('./path-utils');

function registerIPC(ipcMain, getMainWindow) {

  // ---- GENERATE QR CODE ----
  ipcMain.handle('qr-studio-generate', async (event, options) => {
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

    try {
      if (!text || text.trim().length === 0) {
        return { success: false, error: 'No text or URL provided for QR code generation' };
      }

      const outDir = validateOutputDir(outputDir) || path.join(require('os').tmpdir(), 'qr-studio');
      fs.mkdirSync(outDir, { recursive: true });

      const fileName = validateOutputName(outputName) || `qr_${Date.now()}.png`;
      const outputPath = path.join(outDir, fileName);

      const qrOptions = {
        type: 'png',
        width: size || 512,
        margin: margin != null ? margin : 4,
        color: {
          dark: color || '#000000',
          light: backgroundColor || '#ffffff'
        },
        errorCorrectionLevel: errorCorrection || 'M'
      };

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
      return { success: false, error: err.message };
    }
  });

  // ---- GENERATE QR AS DATA URL (for preview) ----
  ipcMain.handle('qr-studio-preview', async (event, options) => {
    const {
      text,
      size,
      margin,
      color,
      backgroundColor,
      errorCorrection
    } = options;

    try {
      if (!text || text.trim().length === 0) {
        return { success: false, error: 'No text provided' };
      }

      const qrOptions = {
        type: 'image/png',
        width: size || 256,
        margin: margin != null ? margin : 4,
        color: {
          dark: color || '#000000',
          light: backgroundColor || '#ffffff'
        },
        errorCorrectionLevel: errorCorrection || 'M'
      };

      const dataUrl = await QRCode.toDataURL(text, qrOptions);
      return { success: true, dataUrl };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---- SCAN / DECODE QR FROM IMAGE ----
  ipcMain.handle('qr-studio-scan', async (event, options) => {
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

      // Read image and convert to raw RGBA pixel data
      const { data, info } = await sharp(inputPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const imageData = {
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
        width: info.width,
        height: info.height
      };

      const code = jsQR(imageData.data, imageData.width, imageData.height);

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
  let batchCancelled = false;

  ipcMain.handle('qr-studio-batch-scan', async (event, options) => {
    const { inputPaths } = options;

    if (!inputPaths || inputPaths.length === 0) {
      return { success: false, error: 'No files provided' };
    }

    batchCancelled = false;
    const results = [];
    const total = inputPaths.length;

    for (let i = 0; i < total; i++) {
      if (batchCancelled) {
        results.push({ file: inputPaths[i], success: false, error: 'Cancelled' });
        continue;
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
        const { data, info } = await sharp(filePath)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const imageData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
        const code = jsQR(imageData, info.width, info.height);

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
        status: batchCancelled ? 'Cancelled' : 'Done'
      });
    }

    return {
      success: true,
      cancelled: batchCancelled,
      results,
      found: results.filter(r => r.success).length,
      total
    };
  });

  ipcMain.handle('qr-studio-cancel-batch', async () => {
    batchCancelled = true;
    return { success: true };
  });
}

module.exports = { registerIPC };
