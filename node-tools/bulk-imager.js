'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { validateOutputDir, formatToolError, autoIncrementPath } = require('./path-utils');

const OPERATIONS = new Set(['resize', 'crop', 'rotate', 'flip', 'watermark']);
const OUTPUT_FORMATS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.avif']);
const FIT_MODES = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
const MAX_BATCH_FILES = 1000;

function outputExtension(inputPath, requestedFormat) {
  if (requestedFormat != null && requestedFormat !== '') {
    const normalized = `.${String(requestedFormat).trim().toLowerCase().replace(/^\./, '')}`;
    if (!OUTPUT_FORMATS.has(normalized)) throw new Error(`Unsupported output image format: ${requestedFormat}`);
    return normalized;
  }
  const inputExt = path.extname(inputPath).toLowerCase();
  return OUTPUT_FORMATS.has(inputExt) ? inputExt : '.png';
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

function isRegularFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

/**
 * Apply a single operation to one image and save the result.
 */
async function processImage(inputPath, outputPath, operation, operationOptions) {
  if (!OPERATIONS.has(operation)) throw new Error(`Unknown operation: ${operation}`);
  operationOptions = operationOptions && typeof operationOptions === 'object' ? operationOptions : {};
  const inputMetadata = await sharp(inputPath, { animated: true }).metadata();
  if (Number(inputMetadata.pages || 1) > 1) {
    throw new Error(
      'Animated or multi-page images are not supported by Bulk Imager. ' +
      'Extract the frames/pages first to avoid silently flattening them.'
    );
  }
  let pipeline = sharp(inputPath);

  switch (operation) {
    case 'resize': {
      const { width, height, percentage, fit } = operationOptions;
      const fitMode = FIT_MODES.has(fit) ? fit : 'inside';
      if (percentage != null && percentage !== '') {
        const scalePercent = finiteNumber(percentage, 'resize percentage', { min: 0.1, max: 1000 });
        // Resize by percentage – need to read metadata first
        const meta = inputMetadata;
        if (!meta.width || !meta.height) throw new Error('Could not read image dimensions');
        const newWidth = Math.max(1, Math.round(meta.width * (scalePercent / 100)));
        const newHeight = Math.max(1, Math.round(meta.height * (scalePercent / 100)));
        if (newWidth > 32768 || newHeight > 32768) throw new Error('Requested resize is too large');
        pipeline = pipeline.resize(newWidth, newHeight, { fit: fitMode });
      } else {
        const newWidth = width == null || width === '' ? null : finiteNumber(width, 'resize width', { min: 1, max: 32768, integer: true });
        const newHeight = height == null || height === '' ? null : finiteNumber(height, 'resize height', { min: 1, max: 32768, integer: true });
        if (newWidth == null && newHeight == null) throw new Error('Resize requires a width, height, or percentage');
        const resizeOpts = { fit: fitMode, withoutEnlargement: true };
        pipeline = pipeline.resize(
          newWidth,
          newHeight,
          resizeOpts
        );
      }
      break;
    }

    case 'crop': {
      const { left, top, width, height } = operationOptions;
      pipeline = pipeline.extract({
        left: left == null || left === '' ? 0 : finiteNumber(left, 'crop left edge', { min: 0, max: 100000, integer: true }),
        top: top == null || top === '' ? 0 : finiteNumber(top, 'crop top edge', { min: 0, max: 100000, integer: true }),
        width: finiteNumber(width, 'crop width', { min: 1, max: 32768, integer: true }),
        height: finiteNumber(height, 'crop height', { min: 1, max: 32768, integer: true })
      });
      break;
    }

    case 'rotate': {
      const { angle, background } = operationOptions;
      const rotation = angle == null || angle === '' ? 0 : finiteNumber(angle, 'rotation angle', { min: -36000, max: 36000 });
      pipeline = pipeline.rotate(rotation, {
        background: background || { r: 0, g: 0, b: 0, alpha: 0 }
      });
      break;
    }

    case 'flip': {
      const { direction } = operationOptions;
      if (direction === 'horizontal') {
        pipeline = pipeline.flop();
      } else if (!direction || direction === 'vertical') {
        pipeline = pipeline.flip();
      } else {
        throw new Error('Flip direction must be horizontal or vertical');
      }
      break;
    }

    case 'watermark': {
      const {
        text,
        fontSize,
        color,
        opacity,
        position,  // 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'
        margin
      } = operationOptions;

      if (typeof text !== 'string') throw new Error('Watermark text must be a string');
      if (!text) break;
      if (text.length > 5000) throw new Error('Watermark text is too long');

      const meta = inputMetadata;
      const imgWidth = meta.width;
      const imgHeight = meta.height;

      // Validate inputs to prevent SVG injection
      const size = Number(fontSize || Math.max(20, Math.round(imgWidth / 20)));
      if (!Number.isFinite(size) || size <= 0 || size > 2000) {
        throw new Error('Invalid font size');
      }

      const textColor = String(color || 'white');
      const colorPattern = /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+)$/;
      if (!colorPattern.test(textColor)) {
        throw new Error('Invalid color format');
      }

      const textOpacity = Number(opacity != null ? opacity : 0.5);
      if (!Number.isFinite(textOpacity) || textOpacity < 0 || textOpacity > 1) {
        throw new Error('Invalid opacity');
      }

      const pad = Number(margin != null ? margin : 20);
      if (!Number.isFinite(pad) || pad < 0 || pad > Math.max(imgWidth, imgHeight)) {
        throw new Error('Invalid margin');
      }

      // Position calculation
      let x, y, anchor;
      switch (position || 'bottom-right') {
        case 'center':
          x = '50%'; y = '50%'; anchor = 'middle';
          break;
        case 'top-left':
          x = String(pad); y = String(pad + size); anchor = 'start';
          break;
        case 'top-right':
          x = String(imgWidth - pad); y = String(pad + size); anchor = 'end';
          break;
        case 'bottom-left':
          x = String(pad); y = String(imgHeight - pad); anchor = 'start';
          break;
        case 'bottom-right':
        default:
          x = String(imgWidth - pad); y = String(imgHeight - pad); anchor = 'end';
          break;
      }

      // Create SVG text overlay
      const svgText = `
        <svg width="${imgWidth}" height="${imgHeight}">
          <text
            x="${x}" y="${y}"
            font-size="${size}"
            fill="${textColor}"
            opacity="${textOpacity}"
            text-anchor="${anchor}"
            font-family="Arial, Helvetica, sans-serif"
          >${escapeXml(text)}</text>
        </svg>`;

      const overlayBuffer = Buffer.from(svgText);
      pipeline = pipeline.composite([{ input: overlayBuffer, gravity: 'northwest' }]);
      break;
    }

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }

  await pipeline.toFile(outputPath);
  return outputPath;
}

/**
 * Escape special XML characters for SVG text content.
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function registerIPC(ipcMain, getMainWindow, jobRegistry = null) {
  const assertJobStart = () => jobRegistry?.assertCanStart?.('Bulk image processing');
  const cancelledWindows = new Set();
  const activeWindows = new Set();
  if (jobRegistry && typeof jobRegistry.register === 'function') {
    jobRegistry.register('bulk-imager', () => {
      for (const winId of activeWindows) cancelledWindows.add(winId);
    });
  }

  ipcMain.handle('bulk-imager-process', async (event, options = {}) => {
    assertJobStart();
    options = options && typeof options === 'object' ? options : {};
    const {
      files,            // array of file paths
      operation,        // 'resize', 'crop', 'rotate', 'flip', 'watermark'
      operationOptions, // options specific to the chosen operation
      outputDir,        // output directory (files saved with _edited suffix)
      outputFormat      // optional: 'png', 'jpg', 'webp', etc.
    } = options;

    const winId = event.sender.id;

    if (!Array.isArray(files) || files.length === 0) {
      return { success: false, error: 'No files provided' };
    }
    if (files.length > MAX_BATCH_FILES || files.some(file => typeof file !== 'string' || !file)) {
      return { success: false, error: `Select between 1 and ${MAX_BATCH_FILES} valid image files.` };
    }
    if (!OPERATIONS.has(operation)) return { success: false, error: `Unknown operation: ${operation}` };
    if (activeWindows.has(winId)) return { success: false, error: 'A bulk image operation is already running in this window.' };

    let outDir;
    try {
      outDir = validateOutputDir(outputDir) || path.dirname(files[0]);
      outputExtension(files[0], outputFormat);
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Bulk Imager') };
    }
    activeWindows.add(winId);
    cancelledWindows.delete(winId);

    try {
      const results = [];
      const total = files.length;

      for (let i = 0; i < total; i++) {
        if (cancelledWindows.has(winId)) {
          return { success: false, error: 'Operation cancelled', results };
        }

        const inputPath = files[i];
        if (!isRegularFile(inputPath)) {
          results.push({ input: inputPath, success: false, error: 'File not found' });
          continue;
        }
        const ext = path.extname(inputPath);
        const baseName = path.basename(inputPath, ext);
        const outExt = outputExtension(inputPath, outputFormat);
        let outputPath = path.join(outDir, baseName + '_edited' + outExt);
        outputPath = autoIncrementPath(outputPath);

        try {
          const win = getMainWindow();
          if (win) {
            win.webContents.send('tool-progress', {
              tool: 'bulk-imager',
              percent: (i / total) * 100,
              current: i + 1,
              total,
              currentFile: path.basename(inputPath),
              status: `Processing ${i + 1}/${total}: ${path.basename(inputPath)}`
            });
          }

          await processImage(inputPath, outputPath, operation, operationOptions || {});
          if (cancelledWindows.has(winId)) {
            try { fs.rmSync(outputPath, { force: true }); } catch {}
            return { success: false, error: 'Operation cancelled', results };
          }
          results.push({ input: inputPath, output: outputPath, success: true });
        } catch (err) {
          try { fs.rmSync(outputPath, { force: true }); } catch {}
          results.push({ input: inputPath, success: false, error: err.message });
        }
      }

      if (cancelledWindows.has(winId)) {
        return { success: false, error: 'Operation cancelled', results };
      }

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'bulk-imager',
          percent: 100,
          current: total,
          total,
          status: 'Done'
        });
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return {
        success: true,
        results,
        summary: { total, succeeded, failed }
      };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Bulk Imager') };
    } finally {
      cancelledWindows.delete(winId);
      activeWindows.delete(winId);
    }
  });

  ipcMain.handle('bulk-imager-process-chain', async (event, options = {}) => {
    assertJobStart();
    options = options && typeof options === 'object' ? options : {};
    const {
      files,            // array of file paths
      chain,            // array of { operation, operationOptions }
      outputDir,        // output directory
      outputFormat      // optional: 'png', 'jpg', 'webp', etc.
    } = options;

    const winId = event.sender.id;

    if (!Array.isArray(files) || files.length === 0) {
      return { success: false, error: 'No files provided' };
    }
    if (files.length > MAX_BATCH_FILES || files.some(file => typeof file !== 'string' || !file)) {
      return { success: false, error: `Select between 1 and ${MAX_BATCH_FILES} valid image files.` };
    }
    if (!Array.isArray(chain) || chain.length === 0) {
      return { success: false, error: 'No operations in chain' };
    }
    if (chain.length > 20 || chain.some(step => !step || typeof step !== 'object' || !OPERATIONS.has(step.operation))) {
      return { success: false, error: 'The operation chain is invalid or too long.' };
    }
    if (activeWindows.has(winId)) return { success: false, error: 'A bulk image operation is already running in this window.' };

    let outDir;
    try {
      outDir = validateOutputDir(outputDir) || path.dirname(files[0]);
      outputExtension(files[0], outputFormat);
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Bulk Imager') };
    }
    activeWindows.add(winId);
    cancelledWindows.delete(winId);

    try {
      const results = [];
      const total = files.length;

      for (let i = 0; i < total; i++) {
        if (cancelledWindows.has(winId)) {
          return { success: false, error: 'Operation cancelled', results };
        }

        const inputPath = files[i];
        if (!isRegularFile(inputPath)) {
          results.push({ input: inputPath, success: false, error: 'File not found' });
          continue;
        }

        const ext = path.extname(inputPath);
        const baseName = path.basename(inputPath, ext);
        const outExt = outputExtension(inputPath, outputFormat);
        let outputPath = path.join(outDir, baseName + '_edited' + outExt);
        outputPath = autoIncrementPath(outputPath);

        const tempFiles = [];
        try {
          const win = getMainWindow();
          if (win) {
            win.webContents.send('tool-progress', {
              tool: 'bulk-imager',
              percent: (i / total) * 100,
              current: i + 1,
              total,
              currentFile: path.basename(inputPath),
              status: `Processing ${i + 1}/${total}: ${path.basename(inputPath)}`
            });
          }

          // Apply operations in sequence using temp files
          let currentInput = inputPath;

          for (let step = 0; step < chain.length; step++) {
            const { operation, operationOptions } = chain[step];
            const isLast = step === chain.length - 1;
            const stepOutput = isLast
              ? outputPath
              // Intermediates must be lossless. Reusing a requested JPEG/AVIF
              // extension re-encoded the image at every step and compounded
              // artifacts before the final export.
              : path.join(outDir, `_tmp_chain_${process.pid}_${crypto.randomUUID()}.png`);

            if (!isLast) tempFiles.push(stepOutput);

            await processImage(currentInput, stepOutput, operation, operationOptions || {});
            currentInput = stepOutput;
            if (cancelledWindows.has(winId)) {
              const cancelError = new Error('Operation cancelled');
              cancelError.code = 'CANCELLED';
              throw cancelError;
            }
          }

          results.push({ input: inputPath, output: outputPath, success: true });
        } catch (err) {
          try { fs.rmSync(outputPath, { force: true }); } catch {}
          if (err && err.code === 'CANCELLED') {
            return { success: false, error: 'Operation cancelled', results };
          }
          results.push({ input: inputPath, success: false, error: err.message });
        } finally {
          // Clean up temp files even when a mid-chain step failed
          for (const tmp of tempFiles) {
            try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
          }
        }
      }

      if (cancelledWindows.has(winId)) {
        return { success: false, error: 'Operation cancelled', results };
      }

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'bulk-imager',
          percent: 100,
          current: total,
          total,
          status: 'Done'
        });
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return {
        success: true,
        results,
        summary: { total, succeeded, failed }
      };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'Bulk Imager') };
    } finally {
      cancelledWindows.delete(winId);
      activeWindows.delete(winId);
    }
  });

  ipcMain.handle('bulk-imager-cancel', async (event) => {
    const winId = event.sender.id;
    if (!activeWindows.has(winId)) return { success: false, error: 'No active bulk image operation to cancel' };
    cancelledWindows.add(winId);
    return { success: true };
  });

  ipcMain.handle('bulk-imager-info', async (event, filePath) => {
    assertJobStart();
    try {
      if (typeof filePath !== 'string' || !isRegularFile(filePath)) {
        return { success: false, error: 'Image file was not found.' };
      }
      const meta = await sharp(filePath).metadata();
      return {
        success: true,
        width: meta.width,
        height: meta.height,
        format: meta.format,
        channels: meta.channels,
        size: meta.size,
        space: meta.space
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerIPC };
