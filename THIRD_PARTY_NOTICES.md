# Third-Party Notices

MuxMelt's original source code is licensed under MIT. The application also
uses and, in packaged builds, may redistribute third-party software and model
assets under their own licenses.

This file is an inventory aid, not a replacement for the license text shipped
by each dependency. Release maintainers must generate and review a complete
dependency/license report for every published artifact.

## Major runtime components

| Component | Purpose | Upstream/license reference |
|---|---|---|
| Electron | Desktop runtime | MIT |
| Sharp/libvips | Image processing | Apache-2.0 and upstream transitive licenses |
| jsQR | QR decoding | Apache-2.0 |
| node-qrcode | QR generation | MIT |
| WebTorrent | BitTorrent client | MIT |
| FFmpeg/ffprobe 6.1.1 | Audio/video processing | Pinned binaries from the `ffmpeg-static` b6.1.1 release; GPL-3.0-or-later for the bundled configuration |
| Python | Local media backend | Python Software Foundation License |
| FastAPI/Uvicorn | Loopback backend | Upstream licenses |
| PyTorch/torchvision/torchaudio | Local ML inference | BSD-style upstream licenses and bundled notices |
| OpenCV, NumPy, Pillow | Media processing | Upstream licenses |
| Demucs | Stem separation | MIT upstream |
| rembg and ONNX Runtime | Background processing | Upstream licenses |
| yt-dlp | Online media downloader | The Unlicense, plus third-party component notices |
| Windows SAPI / macOS `say` / eSpeak | Offline system Text to Speech | Operating-system terms; eSpeak/eSpeak NG is GPL-licensed and supplied by the Linux distribution, not bundled by MuxMelt |
| llama.cpp | Local Chat inference engine | MIT |

Each packaged FFmpeg directory also contains `FFMPEG-LICENSE.txt` and
`FFMPEG-BUILD-INFO.txt`, downloaded and SHA-256 verified alongside the matching
binary. The build-info file records the exact configuration and upstream source
revision for that platform build.

## Models and downloadable assets

- Real-ESRGAN weights are downloaded from the Real-ESRGAN project's published
  releases and retain their upstream terms.
- Background-removal and stem-separation models retain their individual
  upstream terms.
- Curated Qwen GGUF files are identified in the app by model and quantizer. The
  underlying Qwen models and quantized files retain their upstream licenses.
- Imported GGUF files are supplied by the user; MuxMelt does not infer or grant
  a license for them.

## Release checklist

Before publishing an installer:

1. Produce an SBOM and license report from the exact locked dependency set.
2. Include every required license, copyright notice, and source offer.
3. Record each downloaded binary/model URL, version, checksum, and license.
4. Verify FFmpeg configuration and redistribution obligations.
5. Confirm that installer contents match this notice.

If you find a missing or inaccurate notice, please report it through the issue
tracker.
