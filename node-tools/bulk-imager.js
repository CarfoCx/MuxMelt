'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { validateOutputDir, formatToolError } = require('./path-utils');

/**
 * Apply a single operation to one image and save the result.
 */
async function processImage(inputPath, outputPath, operation, operationOptions) {
  let pipeline = sharp(inputPath);

  switch (operation) {
    case 'resize': {
      const { width, height, percentage, fit } = operationOptions;
      if (percentage && percentage > 0) {
        // Resize by percentage – need to read metadata first
        const meta = await sharp(inputPath).metadata();
        const newWidth = Math.round(meta.width * (percentage / 100));
        const newHeight = Math.round(meta.height * (percentage / 100));
        pipeline = pipeline.resize(newWidth, newHeight, { fit: fit || 'fill' });
      } else {
        const resizeOpts = { fit: fit || 'inside', withoutEnlargement: true };
        pipeline = pipeline.resize(
          width || null,
          height || null,
          resizeOpts
        );
      }
      break;
    }

    case 'crop': {
      const { left, top, width, height } = operationOptions;
      if (width && height) {
        pipeline = pipeline.extract({
          left: left || 0,
          top: top || 0,
          width,
          height
        });
      }
      break;
    }

    case 'rotate': {
      const { angle, background } = operationOptions;
      pipeline = pipeline.rotate(angle || 0, {
        background: background || { r: 0, g: 0, b: 0, alpha: 0 }
      });
      break;
    }

    case 'flip': {
      const { direction } = operationOptions;
      if (direction === 'horizontal') {
        pipeline = pipeline.flop();
      } else {
        pipeline = pipeline.flip();
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

      if (!text) break;

      const meta = await sharp(inputPath).metadata();
      const imgWidth = meta.width;
      const imgHeight = meta.height;
      const size = fontSize || Math.max(20, Math.round(imgWidth / 20));
      const textColor = color || 'white';
      const textOpacity = opacity != null ? opacity : 0.5;
      const pad = margin || 20;

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

function registerIPC(ipcMain, getMainWindow) {
  let cancelled = false;

  ipcMain.handle('bulk-imager-process', async (event, options) => {
    const {
      files,            // array of file paths
      operation,        // 'resize', 'crop', 'rotate', 'flip', 'watermark'
      operationOptions, // options specific to the chosen operation
      outputDir,        // output directory (files saved with _edited suffix)
      outputFormat      // optional: 'png', 'jpg', 'webp', etc.
    } = options;

    cancelled = false;

    if (!files || files.length === 0) {
      return { success: false, error: 'No files provided' };
    }

    const outDir = validateOutputDir(outputDir) || path.dirname(files[0]);
    fs.mkdirSync(outDir, { recursive: true });

    const results = [];
    const total = files.length;

    for (let i = 0; i < total; i++) {
      if (cancelled) {
        return { success: false, error: 'Operation cancelled', results };
      }

      const inputPath = files[i];
      if (!fs.existsSync(inputPath)) {
        results.push({ input: inputPath, success: false, error: 'File not found' });
        continue;
      }
      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outExt = outputFormat ? ('.' + outputFormat) : ext;
      const outputPath = path.join(outDir, baseName + '_edited' + outExt);

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
        results.push({ input: inputPath, output: outputPath, success: true });
      } catch (err) {
        results.push({ input: inputPath, success: false, error: err.message });
      }
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
  });

  ipcMain.handle('bulk-imager-process-chain', async (event, options) => {
    const {
      files,            // array of file paths
      chain,            // array of { operation, operationOptions }
      outputDir,        // output directory
      outputFormat      // optional: 'png', 'jpg', 'webp', etc.
    } = options;

    cancelled = false;

    if (!files || files.length === 0) {
      return { success: false, error: 'No files provided' };
    }
    if (!chain || chain.length === 0) {
      return { success: false, error: 'No operations in chain' };
    }

    const outDir = validateOutputDir(outputDir) || path.dirname(files[0]);
    fs.mkdirSync(outDir, { recursive: true });

    const results = [];
    const total = files.length;

    for (let i = 0; i < total; i++) {
      if (cancelled) {
        return { success: false, error: 'Operation cancelled', results };
      }

      const inputPath = files[i];
      if (!fs.existsSync(inputPath)) {
        results.push({ input: inputPath, success: false, error: 'File not found' });
        continue;
      }

      const ext = path.extname(inputPath);
      const baseName = path.basename(inputPath, ext);
      const outExt = outputFormat ? ('.' + outputFormat) : ext;
      const outputPath = path.join(outDir, baseName + '_edited' + outExt);

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
        const tempFiles = [];
        let currentInput = inputPath;

        for (let step = 0; step < chain.length; step++) {
          const { operation, operationOptions } = chain[step];
          const isLast = step === chain.length - 1;
          const stepOutput = isLast
            ? outputPath
            : path.join(outDir, `_tmp_chain_${i}_${step}${outExt}`);

          if (!isLast) tempFiles.push(stepOutput);

          await processImage(currentInput, stepOutput, operation, operationOptions || {});
          currentInput = stepOutput;
        }

        // Clean up temp files
        for (const tmp of tempFiles) {
          try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        }

        results.push({ input: inputPath, output: outputPath, success: true });
      } catch (err) {
        results.push({ input: inputPath, success: false, error: err.message });
      }
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
  });

  ipcMain.handle('bulk-imager-cancel', async () => {
    cancelled = true;
    return { success: true };
  });

  ipcMain.handle('bulk-imager-info', async (event, filePath) => {
    try {
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
