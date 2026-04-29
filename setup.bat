@echo off
echo ============================================
echo   MuxMelt - Setup Script
echo ============================================
echo.

REM Check for Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.10-3.13 from https://www.python.org/downloads/
    echo NOTE: Python 3.14 is NOT compatible with PyTorch yet.
    pause
    exit /b 1
)

echo [OK] Python found:
python --version
echo.

REM Check for Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js found:
node --version
echo.

REM Check for ffmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARNING] ffmpeg is not installed or not in PATH.
    echo Some tools (GIF Maker, Video Compressor, Audio Extractor) require ffmpeg.
    echo Install from https://ffmpeg.org/download.html
    echo.
) else (
    echo [OK] ffmpeg found
    echo.
)

REM Install Python dependencies (CUDA version of PyTorch for GPU acceleration)
echo Installing Python dependencies...
echo This may take several minutes (PyTorch dependencies are large).
echo.
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r python\requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install Python dependencies.
    echo If using Python 3.13+, try installing Python 3.11 or 3.12 instead.
    pause
    exit /b 1
)
echo.
echo [OK] Python dependencies installed
echo.

REM Install Node.js dependencies
echo Installing Node.js dependencies...
npm install
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install Node.js dependencies.
    pause
    exit /b 1
)
echo.
echo [OK] Node.js dependencies installed
echo.

echo ============================================
echo   Setup complete! Run with: npm start
echo ============================================
echo.
echo MuxMelt includes:
echo   - Upscaler (image enhancement)
echo   - Stem Separator (vocals/drums/bass separation)
echo   - Format Converter, Video Compressor
echo   - Audio Extractor, GIF Maker
echo   - Background Remover, Bulk Imager
echo   - PDF Toolkit, QR Studio
echo.
echo GPU acceleration requires an NVIDIA GPU with CUDA support.
echo Without a GPU, processing will still work but will be slower.
echo.
pause
