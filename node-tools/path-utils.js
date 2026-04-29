'use strict';

const path = require('path');

/**
 * Validate and normalize an output directory path to prevent path traversal.
 * Returns the normalized absolute path, or null if input is falsy.
 * Throws on invalid/unsafe paths.
 */
function validateOutputDir(outputDir) {
  if (!outputDir) return null;
  // Check for path traversal in the raw input BEFORE resolving
  const segments = outputDir.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error('Invalid output directory: path traversal not allowed');
  }
  const normalized = path.resolve(outputDir);
  if (!path.isAbsolute(normalized)) {
    throw new Error('Output directory must be an absolute path');
  }
  return normalized;
}

/**
 * Validate an output filename to prevent path traversal via filenames.
 * Returns the sanitized basename (no directory components).
 */
function validateOutputName(outputName) {
  if (!outputName) return null;
  const basename = path.basename(outputName);
  if (basename !== outputName || basename.includes('..')) {
    throw new Error('Invalid output filename: must not contain directory separators');
  }
  return basename;
}

/**
 * Common file extension sets used across tools for input validation.
 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma']);
const PDF_EXTS = new Set(['.pdf']);

/**
 * Validate that a file's extension is in the allowed set.
 * Returns the lowercase extension if valid, throws on invalid.
 */
function validateFileType(filePath, allowedExts, toolName) {
  if (!filePath) throw new Error('No file path provided');
  const ext = path.extname(filePath).toLowerCase();
  if (!allowedExts.has(ext)) {
    const allowed = [...allowedExts].join(', ');
    throw new Error(`${toolName || 'Tool'}: unsupported file type "${ext}". Accepted: ${allowed}`);
  }
  return ext;
}

/**
 * Format an error into a user-friendly message with actionable guidance.
 */
function formatToolError(err, toolName) {
  const msg = err.message || String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('ffmpeg') && (lower.includes('not found') || lower.includes('enoent'))) {
    return `ffmpeg is not installed or not in PATH. ${toolName || 'This tool'} requires ffmpeg. Install from https://ffmpeg.org/download.html`;
  }
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return `Permission denied. Check that you have write access to the output directory.`;
  }
  if (lower.includes('no space left') || lower.includes('enospc')) {
    return `Disk is full. Free up space and try again.`;
  }
  if (lower.includes('file not found') || lower.includes('enoent')) {
    return `File not found. It may have been moved or deleted: ${msg}`;
  }
  if (lower.includes('unsupported') || lower.includes('invalid')) {
    return msg;
  }
  if (lower.includes('out of memory') || lower.includes('enomem')) {
    return `Out of memory. Try closing other applications or processing fewer files at once.`;
  }
  if (lower.includes('cancelled') || lower.includes('canceled')) {
    return 'Operation cancelled by user.';
  }
  return msg;
}

/**
 * Magic byte signatures for common file types.
 * Each entry maps extensions to their expected magic bytes (as hex prefix).
 */
const MAGIC_BYTES = {
  '.png':  [0x89, 0x50, 0x4E, 0x47],
  '.jpg':  [0xFF, 0xD8, 0xFF],
  '.jpeg': [0xFF, 0xD8, 0xFF],
  '.gif':  [0x47, 0x49, 0x46],
  '.bmp':  [0x42, 0x4D],
  '.tiff': [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  '.tif':  [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]],
  '.webp': null, // RIFF header checked specially
  '.pdf':  [0x25, 0x50, 0x44, 0x46],
  '.mp4':  null, // ftyp box checked specially
  '.mkv':  [0x1A, 0x45, 0xDF, 0xA3],
  '.webm': [0x1A, 0x45, 0xDF, 0xA3],
  '.avi':  [0x52, 0x49, 0x46, 0x46],
  '.mp3':  [[0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xF2], [0x49, 0x44, 0x33]],
  '.wav':  [0x52, 0x49, 0x46, 0x46],
  '.flac': [0x66, 0x4C, 0x61, 0x43],
  '.ogg':  [0x4F, 0x67, 0x67, 0x53],
};

/**
 * Validate a file's actual content matches its extension by checking magic bytes.
 * Returns true if valid, false if the file content doesn't match.
 * Returns true for unknown extensions (no signature to check).
 */
function validateMagicBytes(filePath) {
  const fs = require('fs');
  const ext = path.extname(filePath).toLowerCase();
  const sigs = MAGIC_BYTES[ext];

  if (sigs === undefined) return true; // Unknown extension, skip check

  let header;
  try {
    const fd = fs.openSync(filePath, 'r');
    header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
  } catch {
    return true; // Can't read file, let the tool handle the error
  }

  // Special checks
  if (ext === '.webp') {
    return header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
           header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
  }
  if (ext === '.mp4' || ext === '.mov') {
    // ftyp box at offset 4
    return header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
  }

  if (sigs === null) return true;

  // sigs can be a single array or array of arrays
  const sigList = Array.isArray(sigs[0]) ? sigs : [sigs];
  return sigList.some(sig => sig.every((byte, i) => header[i] === byte));
}

/**
 * Generate an output filename from a user-defined pattern.
 * Returns null if no pattern is provided (fall back to tool default).
 * Supported placeholders: {name}, {operation}, {date}, {time}
 */
function generateOutputName(inputPath, operation, pattern) {
  if (!pattern) return null; // fall back to tool default
  const name = path.basename(inputPath, path.extname(inputPath));
  const ext = path.extname(inputPath);
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const timeStr = date.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-MM-SS
  return pattern
    .replace('{name}', name)
    .replace('{operation}', operation || 'output')
    .replace('{date}', dateStr)
    .replace('{time}', timeStr);
}

module.exports = { validateOutputDir, validateOutputName, validateFileType, formatToolError, validateMagicBytes, generateOutputName, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, PDF_EXTS };
