#!/usr/bin/env bash
set -euo pipefail

echo "============================================"
echo "  MuxMelt - Setup Script (macOS / Linux)"
echo "============================================"
echo ""

# Check for a Python version supported by rembg, PyTorch, and llama.cpp wheels.
PYTHON_CMD=""
for cmd in python3.13 python3.12 python3.11 python3 python; do
  if command -v "$cmd" &>/dev/null; then
    if "$cmd" -c 'import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 14) else 1)' 2>/dev/null; then
      PYTHON_CMD="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON_CMD" ]; then
  echo "[ERROR] Python 3.11 through 3.13 is required but not found."
  echo "Install from https://www.python.org/downloads/"
  echo "Python 3.10 and 3.14+ are not supported by the current media dependencies."
  exit 1
fi

echo "[OK] Python found: $($PYTHON_CMD --version)"
echo ""

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed or not in PATH."
  echo "Install from https://nodejs.org/"
  exit 1
fi

echo "[OK] Node.js found: $(node --version)"
echo ""

# Check for ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo "[WARNING] ffmpeg is not installed or not in PATH."
  echo "Some tools (GIF Maker, Video Compressor, Audio Extractor) require ffmpeg."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Install with: brew install ffmpeg"
  else
    echo "Install with: sudo apt install ffmpeg (Debian/Ubuntu)"
    echo "          or: sudo dnf install ffmpeg (Fedora)"
  fi
  echo ""
else
  echo "[OK] ffmpeg found"
  echo ""
fi

# Install exact direct dependency versions from the controlled package index.
# Packaged builds use an app-managed component; this is for source development.
echo "Installing Python dependencies..."
echo "This may take several minutes (PyTorch dependencies are large)."
echo ""
PIP_CONFIG_FILE=/dev/null \
PIP_INDEX_URL=https://pypi.org/simple \
PIP_DISABLE_PIP_VERSION_CHECK=1 \
PIP_NO_INPUT=1 \
PYTHONNOUSERSITE=1 \
  "$PYTHON_CMD" -m pip --isolated --disable-pip-version-check --no-input \
  install --index-url https://pypi.org/simple -r python/requirements.txt \
  --prefer-binary

echo ""
echo "[OK] Python dependencies installed"
echo ""

# Install Node.js dependencies
echo "Installing locked Node.js dependencies..."
npm ci
echo ""
echo "[OK] Node.js dependencies installed"
echo ""

echo "============================================"
echo "  Setup complete! Run with: npm start"
echo "============================================"
echo ""
echo "MuxMelt includes:"
echo "  - Upscaler (image enhancement)"
echo "  - Stem Separator (vocals/drums/bass separation)"
echo "  - Format Converter, Video Compressor"
echo "  - Audio Extractor, GIF Maker"
echo "  - Background Remover, Bulk Imager"
echo "  - Image Editor, QR Studio, Text to Speech"
echo ""
echo "GPU acceleration:"
echo "  macOS: Apple Silicon (MPS) supported automatically"
echo "  Linux: NVIDIA GPU with CUDA required"
echo "  Without a GPU, processing will still work but slower."
echo ""
