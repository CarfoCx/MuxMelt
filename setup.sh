#!/usr/bin/env bash
set -e

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

# Install Python dependencies
echo "Installing Python dependencies..."
echo "This may take several minutes (PyTorch dependencies are large)."
echo ""

# Detect platform for PyTorch install
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: use default PyTorch (MPS acceleration on Apple Silicon)
  $PYTHON_CMD -m pip install torch torchvision torchaudio
else
  # Linux: try CUDA first, fallback to CPU
  if command -v nvidia-smi &>/dev/null; then
    echo "NVIDIA GPU detected, installing PyTorch with CUDA..."
    $PYTHON_CMD -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
  else
    echo "No NVIDIA GPU detected, installing CPU-only PyTorch..."
    $PYTHON_CMD -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
fi

$PYTHON_CMD -m pip install -r python/requirements.txt \
  --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu \
  --prefer-binary

echo ""
echo "[OK] Python dependencies installed"
echo ""

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
npm install
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
echo "  - PDF Toolkit, QR Studio, Text to Speech"
echo ""
echo "GPU acceleration:"
echo "  macOS: Apple Silicon (MPS) supported automatically"
echo "  Linux: NVIDIA GPU with CUDA required"
echo "  Without a GPU, processing will still work but slower."
echo ""
