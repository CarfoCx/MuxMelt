#!/usr/bin/env bash
set -e

echo "=== MuxMelt — Full Build (macOS) ==="
echo "This bundles Python dependencies + ffmpeg into the DMG."
echo "Build size will be ~3-4 GB."
echo ""

# Check prerequisites
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not found. Install from https://nodejs.org/"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "[ERROR] Python 3.10+ not found. Install from https://python.org/downloads"
  exit 1
fi

npm run build:full:mac
echo ""
echo "=== Build complete! Check dist/ for the DMG. ==="
