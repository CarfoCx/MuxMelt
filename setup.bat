@echo off
echo ============================================
echo   MuxMelt - Setup Script
echo ============================================
echo.

REM Check for Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.11-3.13 from https://www.python.org/downloads/
    pause
    exit /b 1
)

python -c "import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 14) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] MuxMelt requires Python 3.11 through 3.13.
    echo Python 3.10 and 3.14+ are not supported by the current media dependencies.
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

REM Install the exact direct Python dependency versions from the controlled
REM package index. The packaged app uses its own managed optional component;
REM this path is only for source development.
echo Installing Python dependencies...
echo This may take several minutes (PyTorch dependencies are large).
echo.
set "PIP_CONFIG_FILE=NUL"
set "PIP_INDEX_URL=https://pypi.org/simple"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "PIP_NO_INPUT=1"
set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONNOUSERSITE=1"
python -m pip --isolated --disable-pip-version-check --no-input install --index-url https://pypi.org/simple -r python\requirements.txt --prefer-binary
if errorlevel 1 goto :python_install_failed
echo.
echo [OK] Python dependencies installed
echo.
goto :python_install_complete

:python_install_failed
echo.
echo [ERROR] Failed to install Python dependencies.
pause
exit /b 1

:python_install_complete

REM Install Node.js dependencies
echo Installing locked Node.js dependencies...
npm ci
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
echo   - Image Editor, QR Studio, Text to Speech
echo.
echo GPU acceleration requires an NVIDIA GPU with CUDA support.
echo Without a GPU, processing will still work but will be slower.
echo.
pause
