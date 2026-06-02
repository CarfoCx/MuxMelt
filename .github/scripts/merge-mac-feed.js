'use strict';

// Merge the per-arch latest-mac.yml feeds (produced by the separate Intel and
// Apple Silicon build jobs) into a single electron-updater feed listing both
// architectures, so Mac auto-update works regardless of the user's chip.
//
// Usage: node merge-mac-feed.js <inputDir> <outputPath>
//   <inputDir> contains one sub-folder per downloaded artifact, each holding a
//   latest-mac.yml.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const [, , inputDir, outPath] = process.argv;
if (!inputDir || !outPath) {
  console.error('Usage: merge-mac-feed.js <inputDir> <outputPath>');
  process.exit(1);
}

const feeds = [];
for (const entry of fs.readdirSync(inputDir)) {
  const p = path.join(inputDir, entry, 'latest-mac.yml');
  if (fs.existsSync(p)) {
    feeds.push(yaml.load(fs.readFileSync(p, 'utf8')));
  }
}

if (feeds.length === 0) {
  console.error(`No latest-mac.yml found under ${inputDir}`);
  process.exit(1);
}

// Combine the files[] arrays (dedup by url); keep the newest releaseDate.
const byUrl = new Map();
let version;
let releaseDate;
for (const feed of feeds) {
  if (!version) version = feed.version;
  if (feed.releaseDate && (!releaseDate || feed.releaseDate > releaseDate)) {
    releaseDate = feed.releaseDate;
  }
  for (const file of feed.files || []) {
    byUrl.set(file.url, file);
  }
}

const files = [...byUrl.values()];
// Legacy top-level path/sha512: point at the arm64 build if present.
const primary = files.find((f) => /arm64/i.test(f.url)) || files[0];

const merged = {
  version,
  files,
  path: primary.url,
  sha512: primary.sha512,
  releaseDate: releaseDate || new Date().toISOString(),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, yaml.dump(merged, { lineWidth: -1 }));
console.log(`Wrote ${outPath} listing ${files.length} file(s): ${files.map((f) => f.url).join(', ')}`);
