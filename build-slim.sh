#!/usr/bin/env bash
set -e

echo "=== MuxMelt — Slim Build (macOS) ==="
echo "This bundles ffmpeg only. Python dependencies are auto-installed on first launch."
echo "Build size will be ~100 MB."
echo ""

# Check prerequisites
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not found. Install from https://nodejs.org/"
  exit 1
fi

npm run build:slim:mac
echo ""
echo "=== Build complete! Check dist/ for the DMG. ==="
