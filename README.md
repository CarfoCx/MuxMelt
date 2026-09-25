# MuxMelt

MuxMelt is a free, open-source desktop media toolkit for converting, cleaning
up, and creating media. There are no ads, analytics, accounts, or paid feature
gates.

Most media processing happens on your computer. Features that need a network
connection are identified below and in the app. Read [Privacy](PRIVACY.md) for
the exact data flow of every online feature.

## What it can do

| Tool | What it does | Network behavior |
|---|---|---|
| Home | Open a file and choose a compatible tool | Offline |
| Upscaler | Increases image and video resolution in 2x and 4x modes | Processing is local; model weights may download on first use |
| Format Converter | Converts images, audio, and video between common formats | Offline |
| Audio Extractor | Extracts audio from video to MP3, WAV, FLAC, AAC, or OGG | Offline |
| GIF Maker | Creates GIFs from video clips | Offline |
| Video Compressor | Reduces video size using friendly presets or detailed controls | Offline |
| Background Editor | Removes or replaces image backgrounds | Processing is local; model assets may download on first use |
| Image Editor | Crops or flips one image at a time | Offline |
| Stem Separator | Separates vocals, drums, bass, and other stems | Processing is local; model assets may download on first use |
| QR Studio | Creates QR codes and scans QR codes from images | Offline |
| Text to Speech | Converts text into speech using voices installed on the computer | Offline; uses Windows SAPI, macOS `say`, or eSpeak |
| Online Video Downloader | Downloads media from a URL | Online by design; connects to the requested site |
| Torrent Downloader | Downloads through the BitTorrent network | Online by design; peers and trackers can see your IP address |

## Privacy promise

- No advertising or behavioral analytics.
- No MuxMelt account and no automatic upload of media files.
- Network-capable features are documented instead of being described as
  universally offline.
- Recent-file history and automatic update checks are off by default and can be
  enabled in Settings.

Online downloads, torrents, update checks, support links, and optional
component/model installation necessarily contact third parties. Offline Mode
blocks app-managed network features, and local tools—including Text to
Speech—continue to work with already-installed components. See
[Privacy](PRIVACY.md) before using an online feature with sensitive material.

Offline Mode is an application safeguard, not an operating-system firewall.
MuxMelt guards its explicit network features and applies a socket/DNS guard to
its Python workers, but native libraries or other software running under your
account are outside that boundary. Disconnect the computer or enforce an OS
firewall rule when a system-level guarantee is required.

## Installing on Windows

Download `MuxMelt-<version>-windows-x64-setup.exe` from the
[latest GitHub release](https://github.com/CarfoCx/MuxMelt/releases/latest),
then run it. The installer is per-user and does not require administrator
rights.

The slim installer opens directly into the Core tools and does not download
optional AI components on first launch. Install the Media AI pack
from Settings only when you want it. The app shows the expected download and
disk requirements before installation; CUDA media packages can require several
gigabytes.

The official Windows x64 Media AI pack uses the bundled CPython 3.13 runtime
and a reviewed lock for every direct and transitive PyPI wheel. Setup accepts
only the recorded wheel SHA-256 hashes and re-runs Install/Repair whenever that
lock changes. Other source-build platforms retain exact direct version pins but
do not yet have a platform-complete transitive wheel lock.

### Windows SmartScreen

The official release workflow refuses to publish unless both the application
and installer have valid Authenticode signatures from the configured project
certificate. Locally built or unofficial community packages may still be
unsigned. Verify the publisher, download source, and checksum before running an
installer; do not assume a SmartScreen warning is harmless.

Each release includes a `MuxMelt-<version>-windows-x64.sha256.txt` file:

```powershell
Get-FileHash .\MuxMelt-1.3.0-windows-x64-setup.exe -Algorithm SHA256
```

Compare the printed hash with the value published beside the installer.

## Platform status

- **Windows x64:** current packaged release target.
- **Linux:** source builds and AppImage build scripts exist, but Linux is not
  currently produced by the release workflow.
- **macOS:** build scripts exist for development; distributed builds require
  signing and notarization work before they should be considered supported.

## Run from source

Source development requires Node.js 18+ and Python 3.11 through 3.13. FFmpeg is
bundled by packaged builds but may be required on `PATH` for source runs. Text
to Speech on Linux also requires the distribution's `espeak-ng` (preferred) or
`espeak` package; Windows and macOS use built-in speech facilities.

### Windows

```powershell
git clone https://github.com/CarfoCx/MuxMelt.git
cd MuxMelt
.\setup.bat
npm start
```

### Linux or macOS

```bash
git clone https://github.com/CarfoCx/MuxMelt.git
cd MuxMelt
./setup.sh
npm start
```

## Test and build

```bash
npm test
```

Check navigation, keyboard controls, themes, and desktop layouts in an isolated
Electron window (requires development dependencies):

```bash
npm run test:ui
```

The UI check uses fixture media services without processing real files or
connecting to the network. Screenshots and its report are saved in `artifacts/ui/`.

Build artifacts are written to `dist/`:

```bash
npm run build:slim:win
npm run build:full:win
npm run build:linux
```

## Project trust and support

- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

MuxMelt is intended to stay free, open source, ad-free, and free of behavioral
tracking. If it saves you time, you can support maintenance and code-signing
costs on [Ko-fi](https://ko-fi.com/carfo). Donations are optional and never
unlock features.

## Responsible use

Only download or transform media you are permitted to use. Website terms,
copyright law, and BitTorrent rules vary by content and location. MuxMelt does
not grant rights to third-party material.

## License

MuxMelt's original source code is available under the [MIT License](LICENSE).
Bundled tools, libraries, and model assets retain their own licenses; see
[Third-party notices](THIRD_PARTY_NOTICES.md).
