/**
 * MuxMelt Build Script
 * Prepares the Python environment and ffmpeg for bundling.
 *
 * Usage:
 *   node build/prepare-python.js full   — bundles standalone Python + all deps + ffmpeg
 *   node build/prepare-python.js slim   — bundles only ffmpeg (Python auto-installed on first run)
 *
 * Options:
 *   --arch=arm64|x64    Override target architecture (default: current machine)
 *
 * Detects the current platform and downloads the appropriate binaries.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const BUNDLE_DIR = path.join(__dirname, 'bundle');
const PYTHON_ENV_DIR = path.join(BUNDLE_DIR, 'python-env');
const FFMPEG_DIR = path.join(BUNDLE_DIR, 'ffmpeg');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// Parse --arch flag or default to current
const archFlag = process.argv.find(a => a.startsWith('--arch='));
const TARGET_ARCH = archFlag ? archFlag.split('=')[1] : process.arch;

// python-build-standalone release tag and URLs
const PBS_RELEASE = '20260320';
const PBS_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}`;

// Map platform+arch to python-build-standalone filename
function getPythonStandaloneUrl() {
  const PYTHON_VER = '3.13.12';
  const tag = PBS_RELEASE;

  const platformMap = {
    'darwin-arm64':  `cpython-${PYTHON_VER}+${tag}-aarch64-apple-darwin-install_only.tar.gz`,
    'darwin-x64':    `cpython-${PYTHON_VER}+${tag}-x86_64-apple-darwin-install_only.tar.gz`,
    'win32-x64':     `cpython-${PYTHON_VER}+${tag}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    'linux-x64':     `cpython-${PYTHON_VER}+${tag}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    'linux-arm64':   `cpython-${PYTHON_VER}+${tag}-aarch64-unknown-linux-gnu-install_only.tar.gz`,
  };

  const key = `${process.platform}-${TARGET_ARCH}`;
  const filename = platformMap[key];
  if (!filename) {
    throw new Error(`No python-build-standalone binary for platform: ${key}`);
  }
  return `${PBS_BASE}/${filename}`;
}

// FFmpeg download URLs per platform
const FFMPEG_URLS = {
  win32: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  darwin: {
    ffmpeg: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    ffprobe: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'
  },
  linux: {
    x64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    arm64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz'
  }
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading: ${url}`);
    const file = fs.createWriteStream(dest);
    const http = require('http');
    const request = (url) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'MuxMelt-Builder' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(new URL(res.headers.location, url).toString());
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            process.stdout.write(`\r  Progress: ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); console.log(''); resolve(); });
      }).on('error', reject);
    };
    request(url);
  });
}

function extractZip(zipPath, destDir) {
  console.log(`  Extracting to ${destDir}...`);
  fs.mkdirSync(destDir, { recursive: true });

  if (IS_WIN) {
    const cmds = [
      `7z x "${zipPath}" -o"${destDir}" -y`,
      `cmd /c "tar -xf ""${zipPath}"" -C ""${destDir}"""`,
      `powershell -Command "Expand-Archive -Force '${zipPath}' '${destDir}'"`,
    ];
    for (const cmd of cmds) {
      try {
        execSync(cmd, { stdio: 'pipe', timeout: 120000 });
        return;
      } catch {}
    }
    throw new Error(`Failed to extract ${zipPath}`);
  } else {
    // macOS / Linux: use unzip
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe', timeout: 120000 });
  }
}

function extractTarGz(tarPath, destDir) {
  console.log(`  Extracting to ${destDir}...`);
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'pipe', timeout: 120000 });
}

// ─── FFmpeg Bundling ─────────────────────────────────────────────────────────

async function prepareFfmpegWindows() {
  console.log('\n=== Preparing ffmpeg (Windows) ===');
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  if (fs.existsSync(path.join(FFMPEG_DIR, 'ffmpeg.exe'))) {
    console.log('  ffmpeg already prepared');
    return;
  }

  const ffmpegZip = path.join(BUNDLE_DIR, 'ffmpeg.zip');
  await downloadFile(FFMPEG_URLS.win32, ffmpegZip);

  const tempDir = path.join(BUNDLE_DIR, 'ffmpeg-temp');
  extractZip(ffmpegZip, tempDir);

  // Find the ffmpeg.exe inside the extracted folder
  const dirs = fs.readdirSync(tempDir);
  const ffmpegRoot = dirs.find(d => d.startsWith('ffmpeg'));
  if (ffmpegRoot) {
    const binDir = path.join(tempDir, ffmpegRoot, 'bin');
    for (const file of ['ffmpeg.exe', 'ffprobe.exe']) {
      const src = path.join(binDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(FFMPEG_DIR, file));
      }
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(ffmpegZip, { force: true });
  console.log('  ffmpeg ready');
}

async function prepareFfmpegMac() {
  console.log('\n=== Preparing ffmpeg (macOS) ===');
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  if (fs.existsSync(path.join(FFMPEG_DIR, 'ffmpeg'))) {
    console.log('  ffmpeg already prepared');
    return;
  }

  // Download ffmpeg binary
  const ffmpegZip = path.join(BUNDLE_DIR, 'ffmpeg-mac.zip');
  await downloadFile(FFMPEG_URLS.darwin.ffmpeg, ffmpegZip);
  extractZip(ffmpegZip, FFMPEG_DIR);
  fs.rmSync(ffmpegZip, { force: true });

  // Download ffprobe binary
  const ffprobeZip = path.join(BUNDLE_DIR, 'ffprobe-mac.zip');
  await downloadFile(FFMPEG_URLS.darwin.ffprobe, ffprobeZip);
  extractZip(ffprobeZip, FFMPEG_DIR);
  fs.rmSync(ffprobeZip, { force: true });

  // Make executable
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const binPath = path.join(FFMPEG_DIR, bin);
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    }
  }
  console.log('  ffmpeg ready');
}

async function prepareFfmpegLinux() {
  console.log('\n=== Preparing ffmpeg (Linux) ===');
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  if (fs.existsSync(path.join(FFMPEG_DIR, 'ffmpeg'))) {
    console.log('  ffmpeg already prepared');
    return;
  }

  const archKey = TARGET_ARCH === 'arm64' ? 'arm64' : 'x64';
  const url = FFMPEG_URLS.linux[archKey];
  const tarPath = path.join(BUNDLE_DIR, 'ffmpeg-linux.tar.xz');
  await downloadFile(url, tarPath);

  // Extract the tar.xz
  const tempDir = path.join(BUNDLE_DIR, 'ffmpeg-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  console.log(`  Extracting to ${tempDir}...`);
  execSync(`tar -xJf "${tarPath}" -C "${tempDir}"`, { stdio: 'pipe', timeout: 120000 });

  // Find the extracted directory and copy ffmpeg + ffprobe
  const dirs = fs.readdirSync(tempDir);
  const ffmpegRoot = dirs.find(d => d.startsWith('ffmpeg'));
  if (ffmpegRoot) {
    for (const bin of ['ffmpeg', 'ffprobe']) {
      const src = path.join(tempDir, ffmpegRoot, bin);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(FFMPEG_DIR, bin));
        fs.chmodSync(path.join(FFMPEG_DIR, bin), 0o755);
      }
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(tarPath, { force: true });
  console.log('  ffmpeg ready');
}

async function prepareFfmpeg() {
  if (IS_WIN) {
    await prepareFfmpegWindows();
  } else if (IS_MAC) {
    await prepareFfmpegMac();
  } else {
    await prepareFfmpegLinux();
  }
}

// ─── Python Environment Bundling (Standalone) ────────────────────────────────

async function preparePythonFull() {
  console.log(`\n=== Preparing standalone Python (${process.platform}/${TARGET_ARCH}) ===`);
  fs.mkdirSync(PYTHON_ENV_DIR, { recursive: true });

  // The standalone Python extracts a "python/" directory
  const pythonBin = IS_WIN
    ? path.join(PYTHON_ENV_DIR, 'python', 'python.exe')
    : path.join(PYTHON_ENV_DIR, 'python', 'bin', 'python3');

  if (fs.existsSync(pythonBin)) {
    console.log('  Standalone Python already prepared');
    // Still install deps in case they changed
    await installPythonDeps(pythonBin);
    return;
  }

  // Step 1: Download standalone Python
  console.log('Step 1/3: Downloading standalone Python...');
  const url = getPythonStandaloneUrl();
  const tarPath = path.join(BUNDLE_DIR, 'python-standalone.tar.gz');
  await downloadFile(url, tarPath);

  // Step 2: Extract
  console.log('Step 2/3: Extracting Python...');
  extractTarGz(tarPath, PYTHON_ENV_DIR);
  fs.rmSync(tarPath, { force: true });

  // Make binaries executable (Unix)
  if (!IS_WIN && fs.existsSync(pythonBin)) {
    fs.chmodSync(pythonBin, 0o755);
  }

  // Verify it works
  try {
    const ver = execSync(`"${pythonBin}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
    console.log(`  Standalone Python ready: ${ver}`);
  } catch (err) {
    throw new Error(`Standalone Python failed to run: ${err.message}`);
  }

  // Step 3: Install dependencies
  await installPythonDeps(pythonBin);
}

async function installPythonDeps(pythonBin) {
  console.log('Step 3/3: Installing Python dependencies...');

  // Ensure pip is available
  try {
    execSync(`"${pythonBin}" -m pip --version`, { encoding: 'utf-8', timeout: 10000 });
  } catch {
    console.log('  Installing pip...');
    execSync(`"${pythonBin}" -m ensurepip --upgrade`, { stdio: 'inherit', timeout: 60000 });
  }

  // Install PyTorch — choose variant by platform
  if (IS_MAC) {
    console.log('  Installing PyTorch (MPS for Apple Silicon)...');
    execSync(`"${pythonBin}" -m pip install torch torchvision torchaudio --no-warn-script-location`, {
      stdio: 'inherit', timeout: 600000
    });
  } else if (IS_WIN) {
    console.log('  Installing PyTorch with CUDA...');
    execSync(`"${pythonBin}" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 --no-warn-script-location`, {
      stdio: 'inherit', timeout: 600000
    });
  } else {
    // Linux — detect GPU
    let hasNvidia = false;
    try { execSync('nvidia-smi', { stdio: 'ignore', timeout: 5000 }); hasNvidia = true; } catch {}

    if (hasNvidia) {
      console.log('  Installing PyTorch with CUDA...');
      execSync(`"${pythonBin}" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 --no-warn-script-location`, {
        stdio: 'inherit', timeout: 600000
      });
    } else {
      console.log('  Installing PyTorch (CPU)...');
      execSync(`"${pythonBin}" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu --no-warn-script-location`, {
        stdio: 'inherit', timeout: 600000
      });
    }
  }

  // Install remaining deps from requirements.txt
  console.log('  Installing remaining dependencies...');
  const requirementsPath = path.join(__dirname, '..', 'python', 'requirements.txt');
  execSync(`"${pythonBin}" -m pip install -r "${requirementsPath}" --no-warn-script-location`, {
    stdio: 'inherit', timeout: 600000
  });

  console.log('  All Python dependencies installed');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2] || 'slim';
  console.log(`\nMuxMelt Build — Mode: ${mode.toUpperCase()} — Platform: ${process.platform} — Arch: ${TARGET_ARCH}`);
  console.log('='.repeat(60));

  fs.mkdirSync(BUNDLE_DIR, { recursive: true });

  await prepareFfmpeg();

  if (mode === 'full') {
    await preparePythonFull();
  } else {
    // Slim mode — create empty python-env dir with marker
    fs.mkdirSync(PYTHON_ENV_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PYTHON_ENV_DIR, '.slim'),
      'This is the slim build. Python will be installed on first run.'
    );
    console.log('\n=== Slim mode: Python will be auto-installed on first run ===');
  }

  console.log('\n=== Build preparation complete ===');
  console.log(`Bundle directory: ${BUNDLE_DIR}`);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
