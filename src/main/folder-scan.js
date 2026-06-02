const path = require('path');
const fs = require('fs');

const SUPPORTED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.gif', '.svg', '.heic', '.heif',
  '.mp4', '.avi', '.mkv', '.mov', '.webm'
]);

// Recursively collect supported media files. Async (fs.promises) so a deep tree
// does not block the main/UI thread, and capped so a huge folder can't hang it.
async function scanFolder(dir, maxFiles = 1000) {
  const results = [];

  async function walk(d) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (err) {
      console.warn(`Failed to scan directory ${d}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return results;
}

module.exports = { scanFolder, SUPPORTED_EXTS };
