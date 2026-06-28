// Recompute the sha512/size fields in latest.yml after the installer was
// re-signed by SignPath. electron-updater verifies the sha512 recorded in
// latest.yml against the file it downloads, so a signature applied *after*
// electron-builder generated latest.yml would otherwise fail that check and
// break auto-update. Re-hash the signed artifact and rewrite the feed.
//
// Usage: node patch-latest-yml.js <latest.yml> <distDir>
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const yaml = require('js-yaml');

const [, , ymlPath, distDir] = process.argv;
if (!ymlPath || !distDir) {
  console.error('Usage: node patch-latest-yml.js <latest.yml> <distDir>');
  process.exit(1);
}

const sha512 = (file) =>
  crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

const doc = yaml.load(fs.readFileSync(ymlPath, 'utf8'));

for (const entry of doc.files || []) {
  const filePath = path.join(distDir, entry.url);
  if (!fs.existsSync(filePath)) continue;
  entry.sha512 = sha512(filePath);
  entry.size = fs.statSync(filePath).size;
  // The blockmap is stale once the exe bytes change; drop it so the updater
  // falls back to a full download instead of a broken differential one.
  delete entry.blockMapSize;
}

// Top-level path/sha512 mirror the primary installer.
if (doc.path) {
  const primary = path.join(distDir, doc.path);
  if (fs.existsSync(primary)) doc.sha512 = sha512(primary);
}

fs.writeFileSync(ymlPath, yaml.dump(doc, { lineWidth: -1 }));
console.log(`Patched ${ymlPath} for re-signed artifacts.`);
