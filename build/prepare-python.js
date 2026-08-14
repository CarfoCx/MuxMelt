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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { createGunzip } = require('zlib');

const BUNDLE_DIR = path.join(__dirname, 'bundle');
const PYTHON_ENV_DIR = path.join(BUNDLE_DIR, 'python-env');
const FFMPEG_DIR = path.join(BUNDLE_DIR, 'ffmpeg');
const DOWNLOAD_MANIFEST_PATH = path.join(__dirname, 'download-manifest.json');
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const TORCH_PACKAGES = Object.freeze({
  torch: '2.6.0',
  torchvision: '0.21.0',
  torchaudio: '2.6.0'
});
const TORCH_REQUIREMENTS = Object.entries(TORCH_PACKAGES)
  .map(([name, version]) => `${name}==${version}`)
  .join(' ');
const PYTHON_INSTALL_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Parse --arch flag or default to current
const archFlag = process.argv.find(a => a.startsWith('--arch='));
const TARGET_ARCH = archFlag ? archFlag.split('=')[1] : process.arch;

function validateDownloadManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error('Download manifest must use schemaVersion 1');
  }
  if (!Array.isArray(manifest.allowedHosts) || manifest.allowedHosts.length === 0) {
    throw new Error('Download manifest must contain a non-empty allowedHosts list');
  }
  if (!manifest.assets || typeof manifest.assets !== 'object') {
    throw new Error('Download manifest must contain assets');
  }

  const allowedHosts = new Set(manifest.allowedHosts);
  for (const [name, asset] of Object.entries(manifest.assets)) {
    const parsed = new URL(asset.url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`${name}: download URL must use HTTPS`);
    }
    if (!allowedHosts.has(parsed.hostname)) {
      throw new Error(`${name}: host ${parsed.hostname} is not allowlisted`);
    }
    if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '')) {
      throw new Error(`${name}: sha256 must be a lowercase 64-character hex digest`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`${name}: size must be a positive integer`);
    }
    if (!Number.isSafeInteger(asset.maxBytes) || asset.maxBytes < asset.size) {
      throw new Error(`${name}: maxBytes must be an integer at least as large as size`);
    }
  }
  return manifest;
}

const DOWNLOAD_MANIFEST = validateDownloadManifest(
  JSON.parse(fs.readFileSync(DOWNLOAD_MANIFEST_PATH, 'utf8'))
);
const ALLOWED_DOWNLOAD_HOSTS = new Set(DOWNLOAD_MANIFEST.allowedHosts);

function getDownloadAsset(name) {
  const asset = DOWNLOAD_MANIFEST.assets[name];
  if (!asset) {
    throw new Error(`No pinned download for ${name}`);
  }
  return asset;
}

function assertAllowedDownloadUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS download: ${parsed.href}`);
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing download redirect to unapproved host: ${parsed.hostname}`);
  }
  return parsed;
}

function openDownloadResponse(url, redirectCount = 0, visited = new Set()) {
  const parsed = assertAllowedDownloadUrl(url);
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Download exceeded ${MAX_REDIRECTS} redirects`));
  }
  if (visited.has(parsed.href)) {
    return Promise.reject(new Error(`Download redirect loop detected at ${parsed.href}`));
  }
  visited.add(parsed.href);

  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      headers: { 'User-Agent': 'MuxMelt-Builder/1.0' }
    }, (response) => {
      const isRedirect = response.statusCode >= 300 && response.statusCode < 400;
      if (isRedirect && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed).href;
        openDownloadResponse(nextUrl, redirectCount + 1, visited).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: HTTP ${response.statusCode} for ${parsed.href}`));
        return;
      }
      response.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        response.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS} ms`));
      });
      resolve(response);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS} ms`));
    });
    request.on('error', reject);
  });
}

async function downloadFile(asset, dest) {
  console.log(`  Downloading: ${asset.url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tempPath = `${dest}.${process.pid}.${Date.now()}.part`;
  let downloaded = 0;
  let lastReportedPercent = -1;
  const digest = crypto.createHash('sha256');

  try {
    const response = await openDownloadResponse(asset.url);
    const headerSize = Number(response.headers['content-length']);
    if (Number.isFinite(headerSize) && headerSize > asset.maxBytes) {
      response.destroy();
      throw new Error(`Download Content-Length ${headerSize} exceeds limit ${asset.maxBytes}`);
    }

    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > asset.maxBytes) {
          callback(new Error(`Download exceeded limit of ${asset.maxBytes} bytes`));
          return;
        }
        digest.update(chunk);
        const pct = Math.min(100, Math.round((downloaded / asset.size) * 100));
        const reportStep = process.stdout.isTTY ? 1 : 5;
        if (pct !== lastReportedPercent && (pct === 100 || pct % reportStep === 0)) {
          lastReportedPercent = pct;
          process.stdout.write(`\r  Progress: ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(asset.size / 1e6).toFixed(1)} MB)`);
        }
        callback(null, chunk);
      }
    });

    await pipeline(response, verifier, fs.createWriteStream(tempPath, { flags: 'wx' }));
    console.log('');

    if (downloaded !== asset.size) {
      throw new Error(`Download size mismatch: expected ${asset.size}, received ${downloaded}`);
    }
    const actualDigest = digest.digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(actualDigest, 'hex'), Buffer.from(asset.sha256, 'hex'))) {
      throw new Error(`Download SHA-256 mismatch: expected ${asset.sha256}, received ${actualDigest}`);
    }

    fs.rmSync(dest, { force: true });
    fs.renameSync(tempPath, dest);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function extractTarGz(tarPath, destDir) {
  console.log(`  Extracting to ${destDir}...`);
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'pipe', timeout: 120000 });
}

// ─── FFmpeg Bundling ─────────────────────────────────────────────────────────

async function gunzipVerifiedAsset(source, destination) {
  const tempPath = `${destination}.${process.pid}.${Date.now()}.part`;
  try {
    await pipeline(
      fs.createReadStream(source),
      createGunzip(),
      fs.createWriteStream(tempPath, { flags: 'wx' })
    );
    fs.rmSync(destination, { force: true });
    fs.renameSync(tempPath, destination);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

async function prepareFfmpeg() {
  const platformLabel = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux';
  console.log(`\n=== Preparing ffmpeg (${platformLabel}/${TARGET_ARCH}) ===`);

  const asset = getDownloadAsset(`ffmpeg-${process.platform}-${TARGET_ARCH}`);
  const executable = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const probeExecutable = IS_WIN ? 'ffprobe.exe' : 'ffprobe';
  const gzipPath = path.join(BUNDLE_DIR, `ffmpeg-${process.platform}-${TARGET_ARCH}.gz`);
  const probeGzipPath = path.join(BUNDLE_DIR, `ffprobe-${process.platform}-${TARGET_ARCH}.gz`);
  const probeAsset = getDownloadAsset(`ffprobe-${process.platform}-${TARGET_ARCH}`);
  const licenseAsset = getDownloadAsset(`ffmpeg-license-${process.platform}-${TARGET_ARCH}`);
  const readmeAsset = getDownloadAsset(`ffmpeg-readme-${process.platform}-${TARGET_ARCH}`);

  fs.rmSync(FFMPEG_DIR, { recursive: true, force: true });
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  try {
    await Promise.all([
      downloadFile(asset, gzipPath),
      downloadFile(probeAsset, probeGzipPath),
      downloadFile(licenseAsset, path.join(FFMPEG_DIR, 'FFMPEG-LICENSE.txt')),
      downloadFile(readmeAsset, path.join(FFMPEG_DIR, 'FFMPEG-BUILD-INFO.txt'))
    ]);
    await Promise.all([
      gunzipVerifiedAsset(gzipPath, path.join(FFMPEG_DIR, executable)),
      gunzipVerifiedAsset(probeGzipPath, path.join(FFMPEG_DIR, probeExecutable))
    ]);
  } finally {
    fs.rmSync(gzipPath, { force: true });
    fs.rmSync(probeGzipPath, { force: true });
  }

  if (!IS_WIN) {
    fs.chmodSync(path.join(FFMPEG_DIR, executable), 0o755);
    fs.chmodSync(path.join(FFMPEG_DIR, probeExecutable), 0o755);
  }
  console.log('  ffmpeg, ffprobe, license, and build/source information ready from pinned, verified inputs');
}

// ─── Python Environment Bundling (Standalone) ────────────────────────────────

async function preparePythonFull() {
  console.log(`\n=== Preparing standalone Python (${process.platform}/${TARGET_ARCH}) ===`);
  fs.mkdirSync(PYTHON_ENV_DIR, { recursive: true });
  fs.rmSync(path.join(PYTHON_ENV_DIR, '.slim'), { force: true });

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
  const asset = getDownloadAsset(`python-${process.platform}-${TARGET_ARCH}`);
  const tarPath = path.join(BUNDLE_DIR, 'python-standalone.tar.gz');
  await downloadFile(asset, tarPath);

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
    execSync(`"${pythonBin}" -m pip install ${TORCH_REQUIREMENTS} --no-warn-script-location`, {
      stdio: 'inherit', timeout: PYTHON_INSTALL_TIMEOUT_MS
    });
  } else if (IS_WIN) {
    console.log('  Installing PyTorch with CUDA...');
    execSync(`"${pythonBin}" -m pip install ${TORCH_REQUIREMENTS} --index-url https://download.pytorch.org/whl/cu124 --no-warn-script-location`, {
      stdio: 'inherit', timeout: PYTHON_INSTALL_TIMEOUT_MS
    });
  } else {
    // Linux — detect GPU
    let hasNvidia = false;
    try { execSync('nvidia-smi', { stdio: 'ignore', timeout: 5000 }); hasNvidia = true; } catch {}

    if (hasNvidia) {
      console.log('  Installing PyTorch with CUDA...');
      execSync(`"${pythonBin}" -m pip install ${TORCH_REQUIREMENTS} --index-url https://download.pytorch.org/whl/cu124 --no-warn-script-location`, {
        stdio: 'inherit', timeout: PYTHON_INSTALL_TIMEOUT_MS
      });
    } else {
      console.log('  Installing PyTorch (CPU)...');
      execSync(`"${pythonBin}" -m pip install ${TORCH_REQUIREMENTS} --index-url https://download.pytorch.org/whl/cpu --no-warn-script-location`, {
        stdio: 'inherit', timeout: PYTHON_INSTALL_TIMEOUT_MS
      });
    }
  }

  // Local Chat uses the hardware-matched standalone llama-server provisioned
  // by Electron, so the normal package index is sufficient here.
  console.log('  Installing remaining dependencies...');
  const requirementsPath = path.join(__dirname, '..', 'python', 'requirements.txt');
  execSync(
    `"${pythonBin}" -m pip install -r "${requirementsPath}" ` +
    '--prefer-binary --no-warn-script-location',
    { stdio: 'inherit', timeout: PYTHON_INSTALL_TIMEOUT_MS }
  );

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
    fs.rmSync(PYTHON_ENV_DIR, { recursive: true, force: true });
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

if (require.main === module) {
  main().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}

module.exports = {
  assertAllowedDownloadUrl,
  getDownloadAsset,
  validateDownloadManifest
};
