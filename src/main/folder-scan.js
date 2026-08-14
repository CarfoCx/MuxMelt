const path = require('path');
const fs = require('fs');

const SUPPORTED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.gif', '.svg', '.heic', '.heif', '.tim',
  '.mp4', '.m4v', '.avi', '.mkv', '.mov', '.webm', '.flv', '.wmv', '.mpg', '.mpeg',
  '.mp3', '.wav', '.flac', '.m4a', '.mka', '.ogg', '.aac', '.wma', '.opus'
]);

// Recursively collect supported media files. Async (fs.promises) so a deep tree
// does not block the main/UI thread, and capped so a huge folder can't hang it.
async function scanFolder(dir, maxFiles = 1000) {
  const limit = Number.isFinite(maxFiles)
    ? Math.max(0, Math.min(Math.trunc(maxFiles), 10000))
    : 1000;
  const results = [];

  async function walk(d) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (err) {
      console.warn(`Failed to scan directory ${d}: ${err.message}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) return;
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
