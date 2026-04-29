# MuxMelt

MuxMelt is a desktop media utility for common file conversion, cleanup, and batch processing workflows. It runs locally, keeps your files on your machine, and brings video, audio, image, PDF, QR, and speech tools into one app.

## Features

| Tool | What it does |
|------|--------------|
| Upscaler | Increases image and video resolution with 2x and 4x modes |
| Format Converter | Converts images and videos between common formats |
| URL Downloader | Downloads videos from supported website URLs into a selected folder |
| Audio Extractor | Extracts audio from video files to MP3, WAV, FLAC, AAC, or OGG |
| GIF Maker | Creates GIFs from video clips with FPS, width, and duration controls |
| Video Compressor | Reduces video file size with codec, CRF, preset, and resolution options |
| Background Remover | Removes image backgrounds and exports transparent PNG files |
| Bulk Imager | Batch-crops, resizes, rotates, flips, and watermarks images |
| PDF Toolkit | Merges, splits, and extracts pages from PDF files |
| Stem Separator | Separates vocals, drums, bass, and other stems from audio tracks |
| QR Studio | Generates styled QR codes and scans QR codes from images |
| Text to Speech | Converts text into speech files with voice and speed controls |

## Why Use It

- Local-first processing for private media workflows
- Batch queues for repeated work
- Shared output folder settings across tools
- Progress tracking, retry handling, and recent output history
- Windows, macOS, and Linux build targets

## Requirements

- Node.js 18+
- Python 3.10 through 3.13
- ffmpeg for video and audio operations
- Optional GPU acceleration for supported processing tasks

Windows builds can be produced as:

- **Slim installer**: bundles ffmpeg; installs Python dependencies on first launch
- **Full installer**: bundles Python dependencies into the installer

## Setup

### Windows

```bash
git clone https://github.com/CarfoCx/MuxMelt.git
cd MuxMelt
setup.bat
```

### macOS / Linux

```bash
git clone https://github.com/CarfoCx/MuxMelt.git
cd MuxMelt
./setup.sh
```

## Run From Source

```bash
npm install
npm start
```

## Build

### Windows

```bash
npm run build:slim:win
npm run build:full:win
```

### macOS

```bash
npm run build:slim:mac
npm run build:full:mac
```

### Linux

```bash
npm run build:linux
npm run build:full:linux
```

Build artifacts are written to `dist/`.

## Project Layout

```text
MuxMelt/
  main.js                 Electron main process
  preload.js              Renderer IPC bridge
  renderer/               App shell and tool interfaces
  renderer/tools/         Individual tool screens
  node-tools/             Node-based processing backends
  python/                 Python backend and processing modules
  build/                  Icons, build config, and bundle prep scripts
```

## License

MIT
