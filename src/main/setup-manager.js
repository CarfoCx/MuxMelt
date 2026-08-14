const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');
const {
  spawnSupervised,
  terminateSupervisedProcess,
  supervisedCleanupError,
} = require('./process-supervisor');

const SETUP_SCHEMA_VERSION = 2;
const RUNTIME_PYTHON_VERSION = '3.13.15';
const WINDOWS_X64_REQUIREMENTS_LOCK = 'requirements-win-cp313-x64.lock';
const RUNTIME_PYTHON_ARTIFACTS = {
  amd64: {
    sha256: 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf',
    maxBytes: 16 * 1024 * 1024,
  },
  arm64: {
    sha256: 'cd992cbfb33be433ff20f150691595efb2862e56f4f1bec684c6077d4775af8e',
    maxBytes: 16 * 1024 * 1024,
  },
};
const PIP_ZIPAPP = {
  url: 'https://bootstrap.pypa.io/pip/pip.pyz',
  // pip 26.2.1, fetched 2026-08-14. The mutable bootstrap URL is safe only
  // because a different payload is rejected before it is executed.
  sha256: '91d5fd9f6f25549fd839c60536c6f1b945316ce3588d34a605635b6071c91526',
  maxBytes: 3 * 1024 * 1024,
};
const CONTROLLED_PYPI_INDEX = 'https://pypi.org/simple';
const CONTROLLED_PIP_GLOBAL_ARGS = Object.freeze([
  '--isolated',
  '--disable-pip-version-check',
  '--no-input',
]);
const TORCH_PACKAGES = Object.freeze({
  torch: '2.6.0',
  torchvision: '0.21.0',
  torchaudio: '2.6.0',
});
const REQUIRED_IMPORTS = Object.freeze([
  'torch', 'torchvision', 'torchaudio', 'cv2', 'fastapi', 'uvicorn',
  'numpy', 'PIL', 'pynvml', 'demucs', 'rembg', 'onnxruntime', 'yt_dlp', 'curl_cffi',
]);

function setupRequirementsPath(options = {}) {
  const pythonAppDir = options.pythonAppDir || options.appDir;
  return options.requirementsPath || path.join(pythonAppDir, 'python', 'requirements.txt');
}

function windowsRequirementsLockPath(options = {}) {
  return options.windowsRequirementsLockPath
    || path.join(
      path.dirname(setupRequirementsPath(options)),
      WINDOWS_X64_REQUIREMENTS_LOCK
    );
}

function setupFingerprint(requirementsPath) {
  const requirements = fs.readFileSync(requirementsPath, 'utf8');
  const lockPath = path.join(path.dirname(requirementsPath), WINDOWS_X64_REQUIREMENTS_LOCK);
  // Only the supported Windows x64 media pack consumes this platform lock.
  // Folding it into the marker fingerprint ensures that changing any
  // transitive pin or wheel hash forces Install/Repair to run again.
  const fingerprint = {
    schemaVersion: SETUP_SCHEMA_VERSION,
    python: RUNTIME_PYTHON_VERSION,
    torch: TORCH_PACKAGES,
    requirements,
  };
  if (process.platform === 'win32' && process.arch === 'x64') {
    // Include an explicit null when the lock is missing so an older marker can
    // never make a damaged package look current. Setup itself then fails
    // closed with a clear missing-lock error.
    fingerprint.windowsDependencyLock = fs.existsSync(lockPath)
      ? fs.readFileSync(lockPath, 'utf8')
      : null;
  }
  return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

function pinnedRequirementVersions(requirementsPath) {
  const versions = {};
  for (const rawLine of fs.readFileSync(requirementsPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    const marker = line.includes(';') ? line.slice(line.indexOf(';') + 1).trim() : '';
    const platformMatch = marker.match(/^sys_platform\s*(==|!=)\s*['"](darwin|linux|win32)['"]$/);
    if (platformMatch) {
      const matches = process.platform === platformMatch[2];
      if ((platformMatch[1] === '==' && !matches) || (platformMatch[1] === '!=' && matches)) {
        continue;
      }
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^;\s]+)(?:\s|;|$)/);
    if (!match) continue;
    versions[match[1].toLowerCase().replace(/[-_.]+/g, '-')] = match[2];
  }
  return versions;
}

function controlledPythonEnvironment() {
  const environment = {};
  const excludedNames = new Set([
    'VIRTUAL_ENV',
    'CONDA_PREFIX',
    'CONDA_DEFAULT_ENV',
    'CONDA_PYTHON_EXE',
    '__PYVENV_LAUNCHER__',
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('PIP_')
        || normalized.startsWith('PYTHON')
        || excludedNames.has(normalized)) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    // pip treats an exact os.devnull value as a request to skip global, user,
    // site, and explicitly configured files. Keep the Windows spelling aligned
    // exactly with Python's os.devnull value.
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
    PIP_INDEX_URL: CONTROLLED_PYPI_INDEX,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    PYTHONUTF8: '1',
  };
}

function controlledPipArgs(command, args = [], options = {}) {
  const launcher = options.zipappPath
    ? [options.zipappPath]
    : ['-m', 'pip'];
  const indexArgs = command === 'install'
    ? ['--index-url', CONTROLLED_PYPI_INDEX]
    : [];
  return [
    ...launcher,
    ...CONTROLLED_PIP_GLOBAL_ARGS,
    command,
    ...indexArgs,
    ...args,
  ];
}

function setupCancelledError() {
  const error = new Error('Setup cancelled');
  error.code = 'SETUP_CANCELLED';
  return error;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(setupCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Long-running installs (PyTorch alone can take 10 minutes) must not use
// synchronous process execution: that freezes the main process, so the setup window stops
// receiving progress events and the retry/close handlers can't fire.
function runCommand(cmd, args, {
  timeout,
  idleTimeout,
  cwd,
  env,
  signal,
  onOutput,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    const proc = spawnSupervised(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    let settled = false;
    let idleTimer = null;
    let timer = null;
    let terminationError = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const terminateTree = () => {
      terminateSupervisedProcess(proc, 1000);
    };

    const requestTermination = (err) => {
      if (settled || terminationError) return;
      terminationError = err;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      terminateTree();
    };

    const emitOutput = (stream, data) => {
      const text = data.toString();
      if (stream === 'stderr') stderr = (stderr + text).slice(-4000);
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeout) {
        idleTimer = setTimeout(() => {
          requestTermination(new Error(`${cmd} produced no output for ${Math.round(idleTimeout / 1000)}s`));
        }, idleTimeout);
      }
      if (typeof onOutput === 'function') {
        const detail = text.replace(/[\r\n]+/g, ' ').trim().slice(-500);
        if (detail) {
          try { onOutput(detail, stream); } catch {}
        }
      }
    };
    proc.stdout.on('data', (d) => emitOutput('stdout', d));
    proc.stderr.on('data', (d) => emitOutput('stderr', d));
    const onAbort = () => {
      requestTermination(setupCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeout) {
      timer = setTimeout(() => {
        requestTermination(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }
    if (idleTimeout) {
      idleTimer = setTimeout(() => {
        requestTermination(new Error(`${cmd} produced no output for ${Math.round(idleTimeout / 1000)}s`));
      }, idleTimeout);
    }
    proc.on('error', (err) => {
      finish(terminationError || err);
    });
    proc.on('close', (code) => {
      const cleanupError = supervisedCleanupError(proc, cmd);
      if (cleanupError) finish(cleanupError);
      else if (terminationError) finish(terminationError);
      else if (code === 0) finish();
      else finish(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
    });
  });
}

function downloadFile(url, destination, options = {}) {
  const {
    timeout = 60000,
    maxBytes = 100 * 1024 * 1024,
    maxRedirects = 5,
    onProgress,
    signal,
    expectedSha256 = null,
    allowedHosts = null,
  } = options;

  if (expectedSha256 !== null && !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    return Promise.reject(new Error('Download manifest contains an invalid SHA-256 value'));
  }
  const allowedHostSet = Array.isArray(allowedHosts)
    ? new Set(allowedHosts.map((host) => String(host).toLowerCase()))
    : null;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    let settled = false;
    let activeRequest = null;
    let output = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (activeRequest && !activeRequest.destroyed) activeRequest.destroy();
      if (output) output.destroy();
      try { fs.rmSync(destination, { force: true }); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const requestUrl = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        fail(new Error(`Invalid download URL: ${currentUrl}`));
        return;
      }
      if (parsed.protocol !== 'https:') {
        fail(new Error('Refusing to download setup files over a non-HTTPS connection'));
        return;
      }
      if (allowedHostSet && !allowedHostSet.has(parsed.hostname.toLowerCase())) {
        fail(new Error(`Refusing setup download from unexpected host: ${parsed.hostname}`));
        return;
      }

      const request = https.get(parsed, (res) => {
        const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);
        if (isRedirect) {
          const location = res.headers.location;
          res.resume();
          if (!location || redirectsLeft <= 0) {
            fail(new Error('Setup download exceeded the redirect limit'));
            return;
          }
          try {
            requestUrl(new URL(location, parsed).href, redirectsLeft - 1);
          } catch (err) {
            fail(new Error(`Setup download returned an invalid redirect: ${err.message}`));
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Setup download failed: HTTP ${res.statusCode}`));
          return;
        }

        const declaredSize = Number(res.headers['content-length'] || 0);
        if (declaredSize > maxBytes) {
          res.resume();
          fail(new Error(`Setup download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`));
          return;
        }

        let downloaded = 0;
        const hash = crypto.createHash('sha256');
        output = fs.createWriteStream(destination, { mode: 0o600 });
        output.once('error', fail);
        res.once('error', fail);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          hash.update(chunk);
          if (downloaded > maxBytes) {
            res.destroy(new Error('Setup download exceeded its size limit'));
            return;
          }
          if (typeof onProgress === 'function') {
            try {
              onProgress(downloaded, declaredSize);
            } catch (err) {
              res.destroy(err);
            }
          }
        });
        output.once('finish', () => {
          output.close((err) => {
            if (err) {
              fail(err);
              return;
            }
            if (settled) return;
            if (expectedSha256) {
              const actualBytes = Buffer.from(hash.digest('hex'), 'hex');
              const expectedBytes = Buffer.from(expectedSha256, 'hex');
              if (actualBytes.length !== expectedBytes.length
                  || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
                fail(new Error('Setup download failed its SHA-256 integrity check'));
                return;
              }
            }
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        res.pipe(output);
      });
      activeRequest = request;
      request.once('error', fail);
      request.setTimeout(timeout, () => {
        request.destroy(new Error('Setup download timed out'));
      });
    };

    const onAbort = () => fail(setupCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    requestUrl(url, maxRedirects);
  });
}

// ─── Local Chat: GPU-accelerated inference backend ──────────────────────────
//
// The chat engine talks to a standalone `llama-server` process instead of an
// in-process Python binding, so it can use whichever GPU backend actually
// matches the user's hardware (the upstream project ships prebuilt CUDA,
// Vulkan, ROCm/HIP and Metal binaries — llama-cpp-python's own CUDA wheels
// stop at cp312, which permanently blocks the bundled cp313 Python). Pinned
// to a specific release tag rather than "latest" so every user on a given
// app version gets the same, already-tested binaries.
const LLAMA_RELEASE_TAG = 'b10069';
const LLAMA_RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}`;
const LLAMA_BACKEND_MANIFEST = '.muxmelt-llama-backend.json';
const LLAMA_STAGING_MANIFEST = '.muxmelt-llama-staging.json';
const LLAMA_MANIFEST_VERSION = 1;

const LLAMA_ASSETS = {
  win32: {
    cpu: {
      name: 'llama-b10069-bin-win-cpu-x64.zip',
      sha256: '6c6b235900f2264c9033ede3f0b0f2faac6ba363bd4c885ef672d55309e19662',
    },
    cuda124: {
      name: 'llama-b10069-bin-win-cuda-12.4-x64.zip',
      sha256: '5933cf07087cc2515ea25654cef7913cdb5f9c29b738cb303a01a01c153014fe',
    },
    cuda124rt: {
      name: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
      sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    },
    cuda133: {
      name: 'llama-b10069-bin-win-cuda-13.3-x64.zip',
      sha256: 'edebdb27d3335a386976d9bf983271d01d608c2e7468d752bc983724149ebdb2',
    },
    cuda133rt: {
      name: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
      sha256: '1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e',
    },
    hip: {
      name: 'llama-b10069-bin-win-hip-radeon-x64.zip',
      sha256: 'd53b09ddef27377ae2ab4bd144df7db8db4150d247260531f7ec6d886de6c6ef',
    },
    vulkan: {
      name: 'llama-b10069-bin-win-vulkan-x64.zip',
      sha256: '7705680162610e9586616c8e23f0a757957557fde033a28d2c489140b93b545a',
    },
  },
  linux: {
    cpu: {
      name: 'llama-b10069-bin-ubuntu-x64.tar.gz',
      sha256: '4ead56852d85d53a242ff1749cda5711904cc22c3bc98be82c1826ef0645dc9c',
    },
    rocm: {
      name: 'llama-b10069-bin-ubuntu-rocm-7.2-x64.tar.gz',
      sha256: '27b0a28aeb212a352a9f28a899fb18528057a96988507f1335f71f3abf16471d',
    },
    vulkan: {
      name: 'llama-b10069-bin-ubuntu-vulkan-x64.tar.gz',
      sha256: 'df7894a0d6bbd140c4b4ab128062f723aed2b4785b19a191e03101c235fac627',
    },
  },
  darwin: {
    arm64: {
      name: 'llama-b10069-bin-macos-arm64.tar.gz',
      sha256: '022469e0b22f4b84dcd0a323867d7f5a31dae21894931ee6a24a35abd2a60359',
    },
    x64: {
      name: 'llama-b10069-bin-macos-x64.tar.gz',
      sha256: 'a94c14a15e8347903bf5331d0e6c9d1f853856e89004af299b8eaebcd7ccdcd8',
    },
  },
};

// Win32_VideoController's AdapterRAM is a 32-bit field that wraps for cards
// >=4GB — verified against this project's own dev machine, where it reported
// ~4GB for an actual 10GB NVIDIA card. nvidia-smi is accurate for NVIDIA; for
// AMD/Intel on Windows, read the same qwMemorySize registry value the driver
// itself publishes (what Task Manager's GPU tab uses).
function detectNvidia() {
  try {
    const raw = execFileSync('nvidia-smi', [], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Label has varied across driver generations ("CUDA Version:" historically,
    // "CUDA UMD Version:" on newer drivers) — match either.
    const cudaMatch = raw.match(/CUDA(?:\s+\w+)?\s+Version:\s*(\d+)\.(\d+)/);
    const cudaMajor = cudaMatch ? Number.parseInt(cudaMatch[1], 10) : 0;

    const csv = execFileSync('nvidia-smi', [
      '--query-gpu=name,memory.total', '--format=csv,noheader,nounits',
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const firstLine = csv.split('\n')[0] || '';
    const [name, memMiB] = firstLine.split(',').map((s) => s.trim());
    if (!name) return null;

    return {
      vendor: 'nvidia',
      name,
      vramMb: Math.round(Number.parseFloat(memMiB) || 0),
      cudaMajor,
    };
  } catch {
    return null;
  }
}

function detectWindowsGpuFallback() {
  try {
    const psCmd = `$ErrorActionPreference = 'SilentlyContinue'; ` +
      `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ` +
      `ForEach-Object { $p = Get-ItemProperty -Path $_.PSPath; if ($p.'HardwareInformation.qwMemorySize') { ` +
      `[PSCustomObject]@{ Desc = $p.DriverDesc; Mem = $p.'HardwareInformation.qwMemorySize' } } } | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    let parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) parsed = [parsed];
    parsed.sort((a, b) => (Number(b.Mem) || 0) - (Number(a.Mem) || 0));
    const best = parsed[0];
    if (!best || !best.Mem) return null;
    const desc = String(best.Desc || '');
    const lower = desc.toLowerCase();
    const vendor = lower.includes('amd') || lower.includes('radeon')
      ? 'amd'
      : lower.includes('intel') ? 'intel' : 'unknown';
    return { vendor, name: desc || 'GPU', vramMb: Math.round(Number(best.Mem) / (1024 * 1024)) };
  } catch {
    return null;
  }
}

function detectLinuxAmdFallback() {
  try {
    execFileSync('rocm-smi', [], { stdio: 'ignore', timeout: 5000 });
    return { vendor: 'amd', name: 'AMD GPU (ROCm)', vramMb: 0 };
  } catch {
    return null;
  }
}

function detectHardware() {
  const gpu = detectNvidia()
    || (process.platform === 'win32' ? detectWindowsGpuFallback() : null)
    || (process.platform === 'linux' ? detectLinuxAmdFallback() : null);
  let cpuCores = 4;
  try { cpuCores = os.cpus().length || 4; } catch {}
  let ramMb = 8192;
  try { ramMb = Math.round(os.totalmem() / (1024 * 1024)); } catch {}
  return { gpu, cpuCores, ramMb };
}

// Chooses which prebuilt llama.cpp binaries to fetch. Every branch returns
// `{ id, assets, exeName }` — `assets` are pinned release-asset descriptors to
// download and extract (a CUDA build ships with a separate `cudart-*`
// redistributable zip that must land in the same directory).
function pickLlamaBackend(hw) {
  const plat = process.platform;
  const exeName = plat === 'win32' ? 'llama-server.exe' : 'llama-server';

  if (plat === 'darwin') {
    // The plain macOS build already includes Metal — there is no separate
    // GPU/CPU split to choose between.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return { id: 'metal', assets: [LLAMA_ASSETS.darwin[arch]], exeName };
  }

  if (plat === 'win32') {
    if (hw.gpu && hw.gpu.vendor === 'nvidia') {
      if (hw.gpu.cudaMajor >= 13) {
        return { id: 'cuda13.3', assets: [LLAMA_ASSETS.win32.cuda133, LLAMA_ASSETS.win32.cuda133rt], exeName };
      }
      if (hw.gpu.cudaMajor >= 12) {
        return { id: 'cuda12.4', assets: [LLAMA_ASSETS.win32.cuda124, LLAMA_ASSETS.win32.cuda124rt], exeName };
      }
      // Driver predates both bundled CUDA builds — Vulkan still runs on NVIDIA.
      return { id: 'vulkan', assets: [LLAMA_ASSETS.win32.vulkan], exeName };
    }
    if (hw.gpu && hw.gpu.vendor === 'amd') {
      return { id: 'hip', assets: [LLAMA_ASSETS.win32.hip], exeName };
    }
    if (hw.gpu) {
      // Intel or an unrecognized vendor with a real GPU — Vulkan is the safe
      // universal accelerated path.
      return { id: 'vulkan', assets: [LLAMA_ASSETS.win32.vulkan], exeName };
    }
    return { id: 'cpu', assets: [LLAMA_ASSETS.win32.cpu], exeName };
  }

  // Linux: this release has no dedicated CUDA asset, so NVIDIA/Intel both
  // route through Vulkan; ROCm is reserved for AMD.
  if (hw.gpu && hw.gpu.vendor === 'amd') {
    return { id: 'rocm', assets: [LLAMA_ASSETS.linux.rocm], exeName };
  }
  if (hw.gpu) {
    return { id: 'vulkan', assets: [LLAMA_ASSETS.linux.vulkan], exeName };
  }
  return { id: 'cpu', assets: [LLAMA_ASSETS.linux.cpu], exeName };
}

// The guaranteed-present safety net `llm.py` falls back to when the
// preferred (GPU) backend fails to launch or never becomes healthy.
function cpuFallbackBackend() {
  const plat = process.platform;
  const exeName = plat === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (plat === 'darwin') return null; // the Metal build is the only/default build
  if (plat === 'win32') return { id: 'cpu', assets: [LLAMA_ASSETS.win32.cpu], exeName };
  return { id: 'cpu', assets: [LLAMA_ASSETS.linux.cpu], exeName };
}

function llamaBackendForId(backendId) {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  let assets = null;
  if (process.platform === 'win32') {
    const variants = {
      cpu: [LLAMA_ASSETS.win32.cpu],
      'cuda12.4': [LLAMA_ASSETS.win32.cuda124, LLAMA_ASSETS.win32.cuda124rt],
      'cuda13.3': [LLAMA_ASSETS.win32.cuda133, LLAMA_ASSETS.win32.cuda133rt],
      hip: [LLAMA_ASSETS.win32.hip],
      vulkan: [LLAMA_ASSETS.win32.vulkan],
    };
    assets = variants[backendId] || null;
  } else if (process.platform === 'darwin') {
    if (backendId === 'metal') {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      assets = [LLAMA_ASSETS.darwin[arch]];
    }
  } else {
    const variants = {
      cpu: [LLAMA_ASSETS.linux.cpu],
      rocm: [LLAMA_ASSETS.linux.rocm],
      vulkan: [LLAMA_ASSETS.linux.vulkan],
    };
    assets = variants[backendId] || null;
  }
  return assets ? { id: backendId, assets, exeName } : null;
}

function validLlamaAsset(asset) {
  return !!asset
    && typeof asset.name === 'string'
    && asset.name.length > 0
    && path.basename(asset.name) === asset.name
    && typeof asset.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(asset.sha256);
}

function sameLlamaAsset(actual, expected) {
  return validLlamaAsset(actual)
    && actual.name === expected.name
    && actual.sha256 === expected.sha256;
}

function sameLlamaAssets(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((asset, index) => sameLlamaAsset(asset, expected[index]));
}

function readSmallJson(filePath) {
  try {
    if (fs.statSync(filePath).size > 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), {
      encoding: 'utf8', mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

function managedLlamaChild(llamaDir, childName) {
  if (typeof llamaDir !== 'string' || !llamaDir) {
    throw new Error('A managed llama directory is required');
  }
  if (typeof childName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(childName)) {
    throw new Error(`Invalid managed llama path component: ${childName}`);
  }
  const root = path.resolve(llamaDir);
  const child = path.resolve(root, childName);
  if (path.dirname(child) !== root || child === root) {
    throw new Error(`Refusing to use an unmanaged llama path: ${child}`);
  }
  return child;
}

function removeManagedLlamaDir(llamaDir, targetDir) {
  const root = path.resolve(llamaDir);
  const target = path.resolve(targetDir);
  if (path.dirname(target) !== root || target === root) {
    throw new Error(`Refusing to remove an unmanaged llama path: ${target}`);
  }
  let targetStat;
  try { targetStat = fs.lstatSync(target); } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  // A file/junction/symlink at a managed slot is removed as that one directory
  // entry; recursive deletion is reserved for a real directory whose resolved
  // parent is the managed llama root.
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    fs.rmSync(target, { recursive: targetStat.isDirectory(), force: true });
    return;
  }
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  const sameParent = process.platform === 'win32'
    ? path.dirname(realTarget).toLowerCase() === realRoot.toLowerCase()
    : path.dirname(realTarget) === realRoot;
  if (!sameParent) {
    throw new Error(`Refusing to remove a llama directory outside its managed root: ${realTarget}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function isManagedLlamaDirectory(llamaDir, targetDir) {
  try {
    const root = path.resolve(llamaDir);
    const target = path.resolve(targetDir);
    if (path.dirname(target) !== root || target === root) return false;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    return process.platform === 'win32'
      ? path.dirname(realTarget).toLowerCase() === realRoot.toLowerCase()
      : path.dirname(realTarget) === realRoot;
  } catch {
    return false;
  }
}

function pathIsInside(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pathsEqual(left, right) {
  try {
    const a = fs.realpathSync(left);
    const b = fs.realpathSync(right);
    return process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  } catch {
    return false;
  }
}

function findExecutable(rootDir, exeName) {
  const stack = [rootDir];
  const target = exeName.toLowerCase();
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === target) return full;
    }
  }
  return null;
}

function validateLlamaBackendInstall(destDir, backend) {
  if (!backend || !Array.isArray(backend.assets)
      || !backend.assets.every(validLlamaAsset)) return null;
  const manifest = readSmallJson(path.join(destDir, LLAMA_BACKEND_MANIFEST));
  if (!manifest
      || manifest.manifestVersion !== LLAMA_MANIFEST_VERSION
      || manifest.releaseTag !== LLAMA_RELEASE_TAG
      || manifest.backendId !== backend.id
      || !sameLlamaAssets(manifest.assets, backend.assets)
      || typeof manifest.executable !== 'string'
      || path.isAbsolute(manifest.executable)) return null;

  const executable = path.resolve(destDir, manifest.executable);
  if (!pathIsInside(destDir, executable)
      || path.basename(executable).toLowerCase() !== backend.exeName.toLowerCase()) return null;
  try {
    if (!fs.statSync(executable).isFile()) return null;
    const realDest = fs.realpathSync(destDir);
    const realExecutable = fs.realpathSync(executable);
    if (!pathIsInside(realDest, realExecutable)) return null;
  } catch {
    return null;
  }
  return executable;
}

function validLlamaStagingState(state, backend) {
  if (!state
      || state.manifestVersion !== LLAMA_MANIFEST_VERSION
      || state.releaseTag !== LLAMA_RELEASE_TAG
      || state.backendId !== backend.id
      || !sameLlamaAssets(state.assets, backend.assets)
      || !Array.isArray(state.completedAssets)
      || state.completedAssets.length > backend.assets.length) return false;
  // Assets are installed sequentially. Requiring a prefix prevents a corrupt
  // staging marker from skipping a missing CUDA runtime or other dependency.
  return state.completedAssets.every(
    (asset, index) => sameLlamaAsset(asset, backend.assets[index])
  );
}

function sha256File(filePath, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(setupCancelledError()); return; }
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    let settled = false;

    const finish = (err, digest) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(digest);
    };
    const onAbort = () => input.destroy(setupCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', (err) => finish(err));
    input.once('end', () => finish(null, hash.digest('hex')));
  });
}

async function verifyLlamaAsset(archivePath, asset, signal) {
  const actual = await sha256File(archivePath, signal);
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(asset.sha256, 'hex');
  if (actualBytes.length !== expectedBytes.length
      || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error(`Chat engine download failed integrity check: ${asset.name}`);
  }
}

async function extractZipTo(zipPath, destDir, signal) {
  fs.mkdirSync(destDir, { recursive: true });
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  try {
    const command = `Expand-Archive -Force -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)}`;
    await runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 120000, signal });
  } catch {
    await runCommand('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120000, signal });
  }
}

async function extractTarGzTo(tarPath, destDir, signal) {
  fs.mkdirSync(destDir, { recursive: true });
  await runCommand('tar', ['-xzf', tarPath, '-C', destDir], { timeout: 120000, signal });
}

function promoteStagedLlamaBackend(llamaDir, destDir, stageDir, backupDir) {
  let movedExisting = false;
  if (fs.existsSync(destDir)) {
    if (fs.existsSync(backupDir)) removeManagedLlamaDir(llamaDir, backupDir);
    fs.renameSync(destDir, backupDir);
    movedExisting = true;
  }
  try {
    fs.renameSync(stageDir, destDir);
  } catch (err) {
    if (!fs.existsSync(destDir) && fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, destDir); } catch {}
    }
    throw err;
  }
  if (movedExisting || fs.existsSync(backupDir)) {
    try { removeManagedLlamaDir(llamaDir, backupDir); } catch {}
  }
}

// Download and extract into a managed staging directory. Each verified asset
// is recorded after extraction, so a cancelled multi-archive CUDA setup resumes
// at the next asset. Only a fully manifested staging tree is promoted.
async function ensureLlamaBackend(send, options, backend, destDirName) {
  const { LLAMA_DIR, setupSignal } = options;
  if (!backend || backend.id !== destDirName || !Array.isArray(backend.assets)
      || !backend.assets.length || !backend.assets.every(validLlamaAsset)) {
    throw new Error('Invalid llama backend descriptor');
  }
  const llamaDir = path.resolve(LLAMA_DIR);
  const destDir = managedLlamaChild(llamaDir, destDirName);
  const stageDir = managedLlamaChild(llamaDir, `${destDirName}.staging`);
  const backupDir = managedLlamaChild(llamaDir, `${destDirName}.backup`);
  fs.mkdirSync(llamaDir, { recursive: true });

  let exePath = isManagedLlamaDirectory(llamaDir, destDir)
    ? validateLlamaBackendInstall(destDir, backend)
    : null;
  if (exePath) {
    if (fs.existsSync(stageDir)) removeManagedLlamaDir(llamaDir, stageDir);
    if (fs.existsSync(backupDir)) removeManagedLlamaDir(llamaDir, backupDir);
    return exePath;
  }

  let stagingState = isManagedLlamaDirectory(llamaDir, stageDir)
    ? readSmallJson(path.join(stageDir, LLAMA_STAGING_MANIFEST))
    : null;
  if (!validLlamaStagingState(stagingState, backend)) {
    if (fs.existsSync(stageDir)) removeManagedLlamaDir(llamaDir, stageDir);
    fs.mkdirSync(stageDir, { recursive: true });
    stagingState = {
      manifestVersion: LLAMA_MANIFEST_VERSION,
      releaseTag: LLAMA_RELEASE_TAG,
      backendId: backend.id,
      assets: backend.assets,
      completedAssets: [],
    };
    writeJsonAtomic(path.join(stageDir, LLAMA_STAGING_MANIFEST), stagingState);
  }

  const downloadsDir = path.join(stageDir, '.downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  for (let assetIndex = stagingState.completedAssets.length;
       assetIndex < backend.assets.length; assetIndex++) {
    const asset = backend.assets[assetIndex];
    const url = `${LLAMA_RELEASE_BASE}/${asset.name}`;
    const archivePath = path.join(downloadsDir, asset.name);
    send('setup-progress', {
      status: `Preparing chat acceleration (${backend.id})...`,
      detail: asset.name,
    });
    try {
      await downloadFile(url, archivePath, {
        maxBytes: 2 * 1024 * 1024 * 1024,
        signal: setupSignal,
        expectedSha256: asset.sha256,
        allowedHosts: [
          'github.com',
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
          'github-releases.githubusercontent.com',
        ],
        onProgress: (downloaded, total) => {
          if (total > 0) {
            send('setup-progress', {
              status: `Downloading chat acceleration (${backend.id})...`,
              detail: `${(downloaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`,
            });
          }
        },
      });
      await verifyLlamaAsset(archivePath, asset, setupSignal);
      if (asset.name.endsWith('.zip')) {
        await extractZipTo(archivePath, stageDir, setupSignal);
      } else {
        await extractTarGzTo(archivePath, stageDir, setupSignal);
      }
      stagingState.completedAssets.push(asset);
      writeJsonAtomic(path.join(stageDir, LLAMA_STAGING_MANIFEST), stagingState);
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  }

  try { fs.rmSync(downloadsDir, { recursive: true, force: true }); } catch {}
  exePath = findExecutable(stageDir, backend.exeName);
  if (exePath && process.platform !== 'win32') {
    try { fs.chmodSync(exePath, 0o755); } catch {}
  }
  if (!exePath) {
    throw new Error(`llama-server did not extract to the expected location under ${stageDir}`);
  }
  const executable = path.relative(stageDir, exePath);
  if (!executable || executable.startsWith('..') || path.isAbsolute(executable)) {
    throw new Error('The staged llama-server executable resolved outside its managed directory');
  }
  fs.rmSync(path.join(stageDir, LLAMA_STAGING_MANIFEST), { force: true });
  writeJsonAtomic(path.join(stageDir, LLAMA_BACKEND_MANIFEST), {
    manifestVersion: LLAMA_MANIFEST_VERSION,
    releaseTag: LLAMA_RELEASE_TAG,
    backendId: backend.id,
    assets: backend.assets,
    executable,
    installedAt: new Date().toISOString(),
  });

  promoteStagedLlamaBackend(llamaDir, destDir, stageDir, backupDir);
  exePath = validateLlamaBackendInstall(destDir, backend);
  if (!exePath) throw new Error(`Completed llama backend failed validation: ${backend.id}`);
  return exePath;
}

function hasCompleteLlamaSetup(LLAMA_DIR) {
  try {
    if (typeof LLAMA_DIR !== 'string' || !LLAMA_DIR) return false;
    const llamaDir = path.resolve(LLAMA_DIR);
    const hardware = readSmallJson(path.join(llamaDir, 'hardware.json'));
    if (!hardware
        || hardware.releaseTag !== LLAMA_RELEASE_TAG
        || typeof hardware.backend !== 'string'
        || typeof hardware.serverPath !== 'string'
        || typeof hardware.cpuServerPath !== 'string') return false;

    const primaryBackend = llamaBackendForId(hardware.backend);
    if (!primaryBackend) return false;
    const primaryDir = managedLlamaChild(llamaDir, primaryBackend.id);
    if (!isManagedLlamaDirectory(llamaDir, primaryDir)
        || !pathIsInside(llamaDir, hardware.serverPath)
        || !pathIsInside(llamaDir, hardware.cpuServerPath)) return false;
    const primaryPath = validateLlamaBackendInstall(primaryDir, primaryBackend);
    if (!primaryPath || !pathsEqual(primaryPath, hardware.serverPath)) return false;

    const fallbackBackend = cpuFallbackBackend();
    let cpuPath = primaryPath;
    if (fallbackBackend && fallbackBackend.id !== primaryBackend.id) {
      const cpuDir = managedLlamaChild(llamaDir, fallbackBackend.id);
      if (!isManagedLlamaDirectory(llamaDir, cpuDir)) return false;
      cpuPath = validateLlamaBackendInstall(cpuDir, fallbackBackend);
      if (!cpuPath) return false;
    }
    return pathsEqual(cpuPath, hardware.cpuServerPath);
  } catch {
    return false;
  }
}

// Detects hardware, downloads the matching (and, as a safety net, the CPU)
// llama-server backend, and records the result for the Python side to read.
// Detection falls back conservatively, while download, integrity, extraction,
// and manifest failures propagate so unverified or partial code is never used.
async function ensureLlamaServer(send, options) {
  const { LLAMA_DIR } = options;
  const hw = detectHardware();
  const backend = pickLlamaBackend(hw);

  const primaryPath = await ensureLlamaBackend(send, options, backend, backend.id);

  let cpuPath = primaryPath;
  const cpuBackend = cpuFallbackBackend();
  if (cpuBackend && cpuBackend.id !== backend.id) {
    cpuPath = await ensureLlamaBackend(send, options, cpuBackend, cpuBackend.id);
  }

  fs.mkdirSync(LLAMA_DIR, { recursive: true });
  const hardwareInfo = {
    releaseTag: LLAMA_RELEASE_TAG,
    backend: backend.id,
    gpuName: hw.gpu ? hw.gpu.name : null,
    vramMb: hw.gpu ? hw.gpu.vramMb : 0,
    ramMb: hw.ramMb,
    cpuCores: hw.cpuCores,
    serverPath: primaryPath,
    cpuServerPath: cpuPath,
    detectedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(LLAMA_DIR, 'hardware.json'), hardwareInfo);
}

async function runSlimSetup(options) {
  const { appDir, IS_WIN, SLIM_SETUP_MARKER } = options;
  const setupAbort = new AbortController();
  const externalSignal = options.setupSignal || null;
  const cancelFromExternalSignal = () => setupAbort.abort();
  if (externalSignal?.aborted) setupAbort.abort();
  else externalSignal?.addEventListener('abort', cancelFromExternalSignal, { once: true });
  if (SLIM_SETUP_MARKER) {
    fs.rmSync(SLIM_SETUP_MARKER, { force: true });
  }
  const setupWindow = new BrowserWindow({
    width: 540,
    height: 340,
    resizable: false,
    // A failed/offline first-time setup must never trap the user in an
    // always-on-top window. Alt+F4 / Cmd+W remains available even though the
    // window is frameless, and the error UI also exposes an explicit Quit.
    closable: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(appDir, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false
    },
    backgroundColor: '#0f0f1a'
  });
  const setupContents = setupWindow.webContents;
  const cancelSetup = () => {
    if (!setupAbort.signal.aborted) setupAbort.abort();
  };
  const cancelFromRenderer = (event) => {
    if (event.sender !== setupContents) return;
    cancelSetup();
    if (!setupWindow.isDestroyed()) setupWindow.close();
  };
  const cancelFromWindow = () => cancelSetup();

  // These handlers remain active for the entire setup lifecycle, including
  // downloads, extraction, pip installs, failure/retry, and the success delay.
  ipcMain.on('setup-cancel', cancelFromRenderer);
  setupWindow.on('closed', cancelFromWindow);

  setupContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupContents.on('will-navigate', (event) => event.preventDefault());
  setupContents.on('will-redirect', (event) => event.preventDefault());

  try {
    await setupWindow.loadFile(path.join(appDir, 'renderer', 'setup.html'));
    if (setupWindow.isDestroyed()) throw new Error('Setup window closed before loading');
    setupWindow.show();
    setupWindow.moveTop();

    const send = (channel, data) => {
      if (!setupWindow.isDestroyed() && !setupContents.isDestroyed()) {
        setupContents.send(channel, data);
      }
    };

    while (true) {
      try {
        if (IS_WIN) {
          await runSlimSetupWindows(send, { ...options, setupSignal: setupAbort.signal });
        } else {
          await runSlimSetupUnix(send, { ...options, setupSignal: setupAbort.signal });
        }

        const markerPath = SLIM_SETUP_MARKER || path.join(options.SLIM_PYTHON_DIR, '.setup-complete');
        fs.writeFileSync(markerPath, JSON.stringify({
          schemaVersion: SETUP_SCHEMA_VERSION,
          requirementsSha256: setupFingerprint(setupRequirementsPath(options)),
          pythonVersion: RUNTIME_PYTHON_VERSION,
          completedAt: new Date().toISOString(),
        }), {
          encoding: 'utf8', mode: 0o600
        });
        send('setup-progress', { percent: 100, status: 'Setup complete!' });
        send('setup-complete');
        await abortableDelay(1500, setupAbort.signal);
        if (!setupWindow.isDestroyed()) setupWindow.destroy();
        return;
      } catch (err) {
        send('setup-error', `Setup failed: ${err.message}`);
        if (setupWindow.isDestroyed()) throw err;

        try {
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              ipcMain.removeListener('setup-retry', retryHandler);
              setupAbort.signal.removeEventListener('abort', cancelHandler);
            };
            const retryHandler = (event) => {
              if (event.sender !== setupContents) return;
              cleanup();
              resolve();
            };
            const cancelHandler = () => {
              cleanup();
              reject(setupCancelledError());
            };
            ipcMain.on('setup-retry', retryHandler);
            setupAbort.signal.addEventListener('abort', cancelHandler, { once: true });
            if (setupAbort.signal.aborted) cancelHandler();
          });
          send('setup-progress', { percent: 0, status: 'Retrying...' });
          await abortableDelay(300, setupAbort.signal);
        } catch (waitError) {
          if (waitError && waitError.code === 'SETUP_CANCELLED') throw waitError;
          throw err;
        }
      }
    }
  } catch (err) {
    if (!setupWindow.isDestroyed()) setupWindow.destroy();
    if (setupAbort.signal.aborted && (!err || err.code !== 'SETUP_CANCELLED')) {
      throw setupCancelledError();
    }
    throw err;
  } finally {
    externalSignal?.removeEventListener('abort', cancelFromExternalSignal);
    ipcMain.removeListener('setup-cancel', cancelFromRenderer);
    setupWindow.removeListener('closed', cancelFromWindow);
  }
}

function promoteSlimEnvironment(finalDir, stageDir) {
  const resolvedFinal = path.resolve(finalDir);
  const resolvedStage = path.resolve(stageDir);
  if (path.dirname(resolvedFinal) !== path.dirname(resolvedStage)
      || resolvedStage !== `${resolvedFinal}.staging`) {
    throw new Error('Refusing to promote an unmanaged Python environment');
  }
  const backupDir = `${resolvedFinal}.backup`;
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  let movedExisting = false;
  if (fs.existsSync(resolvedFinal)) {
    fs.renameSync(resolvedFinal, backupDir);
    movedExisting = true;
  }
  try {
    fs.renameSync(resolvedStage, resolvedFinal);
  } catch (err) {
    if (movedExisting && !fs.existsSync(resolvedFinal) && fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, resolvedFinal); } catch {}
    }
    throw err;
  }
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
}

function resetSlimStagingEnvironment(finalDir, stageDir) {
  const resolvedFinal = path.resolve(finalDir);
  const resolvedStage = path.resolve(stageDir);
  if (path.dirname(resolvedFinal) !== path.dirname(resolvedStage)
      || resolvedStage !== `${resolvedFinal}.staging`) {
    throw new Error('Refusing to reset an unmanaged Python staging directory');
  }
  fs.rmSync(resolvedStage, { recursive: true, force: true });
}

function requireFreeDiskSpace(targetDir, requiredBytes, label) {
  if (typeof fs.statfsSync !== 'function') return;
  const disk = fs.statfsSync(targetDir);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
    const requiredGb = Math.ceil(requiredBytes / 1024 ** 3);
    throw new Error(`At least ${requiredGb} GB of free disk space is required for ${label}`);
  }
}

async function runSlimSetupWindows(send, options) {
  const {
    appDir, pythonAppDir = appDir, SLIM_PYTHON_DIR,
    setupSignal,
  } = options;
  if (process.arch !== 'x64') {
    throw new Error(
      'The hash-verified Windows media pack currently supports x64 releases only'
    );
  }
  const dependencyLockPath = windowsRequirementsLockPath(options);
  if (!fs.existsSync(dependencyLockPath)) {
    throw new Error(`The Windows media-pack dependency lock is missing: ${dependencyLockPath}`);
  }
  const setupEnvironment = controlledPythonEnvironment();
  const run = (cmd, args, runOptions = {}) => (
    runCommand(cmd, args, {
      ...runOptions,
      env: setupEnvironment,
      signal: setupSignal,
    })
  );
  const download = (url, destination, downloadOptions = {}) => (
    downloadFile(url, destination, { ...downloadOptions, signal: setupSignal })
  );
  const pythonArch = 'amd64';
  const pythonArtifact = RUNTIME_PYTHON_ARTIFACTS[pythonArch];
  if (!pythonArtifact) throw new Error(`Unsupported Windows Python architecture: ${process.arch}`);
  const PYTHON_URL = `https://www.python.org/ftp/python/${RUNTIME_PYTHON_VERSION}/python-${RUNTIME_PYTHON_VERSION}-embed-${pythonArch}.zip`;
  const zipPath = path.join(app.getPath('temp'), `muxmelt-python-embed-${process.pid}.zip`);
  const stageDir = `${path.resolve(SLIM_PYTHON_DIR)}.staging`;
  const stagePythonExe = path.join(stageDir, 'python.exe');
  const pipCacheDir = path.join(stageDir, '.pip-cache');

  let hasNvidia = false;
  try {
    execFileSync('nvidia-smi', [], { stdio: 'ignore', timeout: 5000 });
    hasNvidia = true;
  } catch {}

  const parentDir = path.dirname(path.resolve(SLIM_PYTHON_DIR));
  fs.mkdirSync(parentDir, { recursive: true });
  requireFreeDiskSpace(
    parentDir,
    (hasNvidia ? 7 : 3) * 1024 ** 3,
    hasNvidia ? 'the CUDA media pack' : 'the media pack'
  );
  resetSlimStagingEnvironment(SLIM_PYTHON_DIR, stageDir);

  send('setup-progress', { percent: 5, status: 'Downloading Python...', detail: PYTHON_URL });
  await download(PYTHON_URL, zipPath, {
    maxBytes: pythonArtifact.maxBytes,
    expectedSha256: pythonArtifact.sha256,
    allowedHosts: ['www.python.org'],
    onProgress: (downloaded, total) => {
      if (total > 0) {
        send('setup-progress', {
          percent: 5 + Math.round((downloaded / total) * 20),
          status: 'Downloading Python...',
          detail: `${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
        });
      }
    }
  });

  send('setup-progress', { percent: 28, status: 'Extracting Python...' });
  fs.mkdirSync(stageDir, { recursive: true });
  const unzipScript = `import zipfile; zipfile.ZipFile(${JSON.stringify(zipPath)}).extractall(${JSON.stringify(stageDir)})`;
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  try {
    try {
      const command = `Expand-Archive -Force -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(stageDir)}`;
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 60000 });
    } catch {
      try {
        await run('python', ['-c', unzipScript], { timeout: 60000 });
      } catch {
        await run('python3', ['-c', unzipScript], { timeout: 60000 });
      }
    }
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  const pthFiles = fs.readdirSync(stageDir).filter(f => f.endsWith('._pth'));
  for (const pth of pthFiles) {
    const p = path.join(stageDir, pth);
    let c = fs.readFileSync(p, 'utf-8');
    c = c.replace('#import site', 'import site');
    if (!c.includes('Lib/site-packages')) c += '\nLib/site-packages\n';
    const pythonModuleDir = path.join(pythonAppDir, 'python');
    if (!c.includes(pythonModuleDir)) c += `\n${pythonModuleDir}\n`;
    fs.writeFileSync(p, c);
  }

  send('setup-progress', { percent: 35, status: 'Installing hash-verified media pack...' });
  const pipZipappPath = path.join(stageDir, 'pip.pyz');
  await download(PIP_ZIPAPP.url, pipZipappPath, {
    maxBytes: PIP_ZIPAPP.maxBytes,
    expectedSha256: PIP_ZIPAPP.sha256,
    allowedHosts: ['bootstrap.pypa.io'],
  });
  try {
    await run(stagePythonExe, controlledPipArgs('install', [
      '--require-hashes',
      '--only-binary=:all:',
      '-r', dependencyLockPath,
      '--cache-dir', pipCacheDir,
      '--no-warn-script-location',
    ], { zipappPath: pipZipappPath }), {
      cwd: stageDir,
      timeout: 4 * 60 * 60 * 1000,
      idleTimeout: 15 * 60 * 1000,
      onOutput: (detail) => send('setup-progress', {
        percent: 40, status: 'Installing hash-verified media pack...', detail
      }),
    });
  } finally {
    fs.rmSync(pipZipappPath, { force: true });
  }
  const reqPath = path.join(pythonAppDir, 'python', 'requirements.txt');

  send('setup-progress', { percent: 94, status: 'Verifying the media pack...' });
  if (!(await hasCompleteEnvironmentAsync(stagePythonExe, reqPath, { signal: setupSignal }))) {
    throw new Error('The media pack failed its import/version verification');
  }
  fs.rmSync(pipCacheDir, { recursive: true, force: true });
  promoteSlimEnvironment(SLIM_PYTHON_DIR, stageDir);
}

async function runSlimSetupUnix(send, options) {
  const {
    appDir, pythonAppDir = appDir, SLIM_PYTHON_DIR,
    setupSignal,
  } = options;
  const setupEnvironment = controlledPythonEnvironment();
  const run = (cmd, args, runOptions = {}) => (
    runCommand(cmd, args, {
      ...runOptions,
      env: setupEnvironment,
      signal: setupSignal,
    })
  );
  const stageDir = `${path.resolve(SLIM_PYTHON_DIR)}.staging`;
  const stagePythonExe = path.join(stageDir, 'bin', 'python3');
  const pipCacheDir = path.join(stageDir, '.pip-cache');

  send('setup-progress', { percent: 5, status: 'Checking Python...' });

  let systemPython = null;
  for (const cmd of ['python3.13', 'python3.12', 'python3.11', 'python3', 'python']) {
    try {
      const result = execFileSync(cmd, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: setupEnvironment,
      }).trim();
      const match = result.match(/Python (\d+)\.(\d+)/);
      const minor = match ? Number.parseInt(match[2], 10) : 0;
      if (match && Number.parseInt(match[1], 10) === 3 && minor >= 11 && minor <= 13) {
        systemPython = cmd;
        break;
      }
    } catch {}
  }

  if (!systemPython) {
    const isMac = process.platform === 'darwin';
    throw new Error(
      'Python 3.11 through 3.13 is required.\n\n' +
      (isMac
        ? 'Install from https://python.org/downloads or: brew install python@3.12'
        : 'Install a supported version from https://python.org/downloads (Python 3.12 is recommended).')
    );
  }

  send('setup-progress', { percent: 10, status: 'Creating Python environment...', detail: systemPython });
  const parentDir = path.dirname(path.resolve(SLIM_PYTHON_DIR));
  fs.mkdirSync(parentDir, { recursive: true });
  let hasNvidia = false;
  if (process.platform !== 'darwin') {
    try {
      execFileSync('nvidia-smi', [], { stdio: 'ignore', timeout: 5000 });
      hasNvidia = true;
    } catch {}
  }
  requireFreeDiskSpace(
    parentDir,
    (hasNvidia ? 7 : process.platform === 'darwin' ? 4 : 3) * 1024 ** 3,
    hasNvidia ? 'the CUDA media pack' : 'the media pack'
  );
  resetSlimStagingEnvironment(SLIM_PYTHON_DIR, stageDir);
  fs.mkdirSync(stageDir, { recursive: true });
  await run(systemPython, ['-m', 'venv', stageDir], { timeout: 60000 });

  const isMac = process.platform === 'darwin';
  if (isMac) {
    send('setup-progress', { percent: 25, status: 'Installing PyTorch (MPS for Apple Silicon)...', detail: 'Downloading ~500 MB' });
    await run(stagePythonExe, controlledPipArgs('install', [
      `torch==${TORCH_PACKAGES.torch}`,
      `torchvision==${TORCH_PACKAGES.torchvision}`,
      `torchaudio==${TORCH_PACKAGES.torchaudio}`,
      '--cache-dir', pipCacheDir,
      '--no-warn-script-location'
    ]), {
      timeout: 4 * 60 * 60 * 1000,
      idleTimeout: 15 * 60 * 1000,
      onOutput: (detail) => send('setup-progress', {
        percent: 28, status: 'Installing PyTorch for Apple Silicon...', detail
      }),
    });
  } else {
    if (hasNvidia) {
      send('setup-progress', { percent: 25, status: 'Installing the pinned PyTorch runtime...', detail: 'Download size varies by platform' });
      await run(stagePythonExe, controlledPipArgs('install', [
        `torch==${TORCH_PACKAGES.torch}`,
        `torchvision==${TORCH_PACKAGES.torchvision}`,
        `torchaudio==${TORCH_PACKAGES.torchaudio}`,
        '--cache-dir', pipCacheDir,
        '--no-warn-script-location'
      ]), {
        timeout: 4 * 60 * 60 * 1000,
        idleTimeout: 15 * 60 * 1000,
        onOutput: (detail) => send('setup-progress', {
          percent: 28, status: 'Installing the pinned PyTorch runtime...', detail
        }),
      });
    } else {
      send('setup-progress', { percent: 25, status: 'Installing the pinned PyTorch runtime...', detail: 'Download size varies by platform' });
      await run(stagePythonExe, controlledPipArgs('install', [
        `torch==${TORCH_PACKAGES.torch}`,
        `torchvision==${TORCH_PACKAGES.torchvision}`,
        `torchaudio==${TORCH_PACKAGES.torchaudio}`,
        '--cache-dir', pipCacheDir,
        '--no-warn-script-location'
      ]), {
        timeout: 4 * 60 * 60 * 1000,
        idleTimeout: 15 * 60 * 1000,
        onOutput: (detail) => send('setup-progress', {
          percent: 28, status: 'Installing the pinned PyTorch runtime...', detail
        }),
      });
    }
  }

  send('setup-progress', { percent: 65, status: 'Installing processing tools...' });
  const reqPath = path.join(pythonAppDir, 'python', 'requirements.txt');
  await run(stagePythonExe, controlledPipArgs('install', [
    '-r', reqPath,
    '--prefer-binary', '--cache-dir', pipCacheDir, '--no-warn-script-location'
  ]), {
    timeout: 4 * 60 * 60 * 1000,
    idleTimeout: 15 * 60 * 1000,
    onOutput: (detail) => send('setup-progress', {
      percent: 68, status: 'Installing processing tools...', detail
    }),
  });

  send('setup-progress', { percent: 94, status: 'Verifying the media pack...' });
  if (!(await hasCompleteEnvironmentAsync(stagePythonExe, reqPath, { signal: setupSignal }))) {
    throw new Error('The media pack failed its import/version verification');
  }
  fs.rmSync(pipCacheDir, { recursive: true, force: true });
  promoteSlimEnvironment(SLIM_PYTHON_DIR, stageDir);
}

function buildEnvironmentValidationProbe(requirementsPath = null) {
  const lockPath = requirementsPath
    ? path.join(path.dirname(requirementsPath), WINDOWS_X64_REQUIREMENTS_LOCK)
    : null;
  const expectedVersions = {
    ...TORCH_PACKAGES,
    ...(requirementsPath && fs.existsSync(requirementsPath)
      ? pinnedRequirementVersions(requirementsPath)
      : {}),
    ...(process.platform === 'win32'
        && process.arch === 'x64'
        && lockPath
        && fs.existsSync(lockPath)
      ? pinnedRequirementVersions(lockPath)
      : {}),
  };
  return [
    'import importlib, importlib.metadata, json, sys',
    "if sys.version_info.major != 3 or sys.version_info.minor < 11 or sys.version_info.minor > 13: raise RuntimeError(f'unsupported Python {sys.version_info.major}.{sys.version_info.minor}')",
    `required = ${JSON.stringify(REQUIRED_IMPORTS)}`,
    `expected = ${JSON.stringify(expectedVersions)}`,
    'for name in required: importlib.import_module(name)',
    'actual = {}',
    'for name, version in expected.items():',
    '    installed = importlib.metadata.version(name)',
    "    if installed.split('+', 1)[0] != version: raise RuntimeError(f'{name} {installed} != {version}')",
    '    actual[name] = installed',
    "print(json.dumps({'ok': True, 'versions': actual}))",
  ].join('\n');
}

// Synchronous compatibility helper for scripts/tests that are not running an
// Electron UI loop. Interactive setup paths use hasCompleteEnvironmentAsync.
function hasCompleteEnvironment(pythonExe, requirementsPath = null) {
  const environment = controlledPythonEnvironment();
  try {
    const version = execFileSync(pythonExe, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: environment,
    }).trim();
    const match = version.match(/Python (\d+)\.(\d+)/);
    const major = match ? Number.parseInt(match[1], 10) : 0;
    const minor = match ? Number.parseInt(match[2], 10) : 0;
    if (major !== 3 || minor < 11 || minor > 13) return false;
  } catch {
    return false;
  }

  try {
    const probe = buildEnvironmentValidationProbe(requirementsPath);
    execFileSync(pythonExe, ['-c', probe], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    execFileSync(pythonExe, controlledPipArgs('check'), {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    return true;
  } catch {
    return false;
  }
}

// Importing Torch, ONNX Runtime, OpenCV, and the rest of the media stack can
// take well over a minute on some machines. Keep that work outside Electron's
// main thread, and route cancellation through runCommand so Install/Repair can
// always be stopped cleanly.
async function hasCompleteEnvironmentAsync(pythonExe, requirementsPath = null, options = {}) {
  const signal = options?.signal || options?.setupSignal || null;
  const environment = controlledPythonEnvironment();
  if (signal?.aborted) throw setupCancelledError();
  if (!pythonExe || !fs.existsSync(pythonExe)) return false;

  try {
    const probe = buildEnvironmentValidationProbe(requirementsPath);
    await runCommand(pythonExe, ['-c', probe], {
      timeout: 120000,
      env: environment,
      signal,
    });
    await runCommand(pythonExe, controlledPipArgs('check'), {
      timeout: 120000,
      env: environment,
      signal,
    });
    return true;
  } catch (err) {
    if (err?.code === 'PROCESS_CLEANUP_FAILED') throw err;
    if (signal?.aborted || err?.code === 'SETUP_CANCELLED') {
      if (err?.code === 'SETUP_CANCELLED') throw err;
      throw setupCancelledError();
    }
    return false;
  }
}

// `LLAMA_DIR` is optional so callers that don't care about the chat
// acceleration backend (e.g. older call sites, tests) keep working.
async function needsSlimSetup(
  IS_SLIM,
  SLIM_PYTHON_EXE,
  setupMarker,
  LLAMA_DIR,
  requirementsPath = null,
  validationOptions = {}
) {
  if (!IS_SLIM) return false;
  const signal = validationOptions?.signal || validationOptions?.setupSignal || null;
  if (signal?.aborted) throw setupCancelledError();
  if (!fs.existsSync(SLIM_PYTHON_EXE)) return true;
  // Run validation for existing installs too so a release upgrade can detect
  // stale or incomplete managed components instead of trusting an old marker.
  if (LLAMA_DIR && !hasCompleteLlamaSetup(LLAMA_DIR)) return true;
  if (!setupMarker) {
    return !(await hasCompleteEnvironmentAsync(
      SLIM_PYTHON_EXE,
      requirementsPath,
      validationOptions
    ));
  }
  const expectedFingerprint = requirementsPath && fs.existsSync(requirementsPath)
    ? setupFingerprint(requirementsPath)
    : null;
  if (fs.existsSync(setupMarker)) {
    const marker = readSmallJson(setupMarker);
    if (!marker
        || marker.schemaVersion !== SETUP_SCHEMA_VERSION
        || (expectedFingerprint && marker.requirementsSha256 !== expectedFingerprint)) {
      return true;
    }
    return !(await hasCompleteEnvironmentAsync(
      SLIM_PYTHON_EXE,
      requirementsPath,
      validationOptions
    ));
  }

  // Older releases did not create a completion marker. Avoid forcing those
  // users through a multi-gigabyte reinstall when the full dependency set is
  // already present, while still retrying genuinely partial installations.
  if (await hasCompleteEnvironmentAsync(
    SLIM_PYTHON_EXE,
    requirementsPath,
    validationOptions
  )) {
    try {
      fs.writeFileSync(setupMarker, JSON.stringify({
        schemaVersion: SETUP_SCHEMA_VERSION,
        requirementsSha256: expectedFingerprint,
        pythonVersion: RUNTIME_PYTHON_VERSION,
        migratedAt: new Date().toISOString(),
      }), {
        encoding: 'utf8', mode: 0o600
      });
    } catch {}
    return false;
  }
  return true;
}

function hasCurrentSetupMarker(pythonExe, setupMarker, requirementsPath) {
  if (!pythonExe || !setupMarker || !requirementsPath) return false;
  if (!fs.existsSync(pythonExe) || !fs.existsSync(requirementsPath)) return false;
  const marker = readSmallJson(setupMarker);
  if (!marker || marker.schemaVersion !== SETUP_SCHEMA_VERSION) return false;
  try {
    return marker.requirementsSha256 === setupFingerprint(requirementsPath);
  } catch {
    return false;
  }
}

module.exports = {
  runSlimSetup,
  needsSlimSetup,
  detectHardware,
  pickLlamaBackend,
  cpuFallbackBackend,
  ensureLlamaServer,
  hasCompleteLlamaSetup,
  hasCurrentSetupMarker,
  hasCompleteEnvironment,
  hasCompleteEnvironmentAsync,
};
