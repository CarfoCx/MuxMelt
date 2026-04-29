@echo off
echo === MuxMelt — Full Build (Windows) ===
echo This bundles Python dependencies + ffmpeg into the installer.
echo Build size will be ~3-4 GB.
echo.

npm run build:full:win
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo === Build complete! Check dist\ for the installer. ===
pause
