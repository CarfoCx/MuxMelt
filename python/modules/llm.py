"""Local LLM chat backed by llama.cpp's `llama-server` (GGUF models).

No external API: inference runs entirely on the user's machine. Rather than an
in-process Python binding, this drives a standalone `llama-server` process
over HTTP — the binary is chosen per-machine at setup time (CUDA/Vulkan/HIP/
Metal/CPU, whichever matches the user's actual hardware; see
`src/main/setup-manager.js`) and its path is recorded in
`<data dir>/llama/hardware.json` alongside the detected GPU/RAM/CPU so this
module can pick a sensible model, context size, and offload strategy. Users can
explicitly download a checksum-pinned catalog model or register an existing
local GGUF in place. Prompt traffic is restricted to an authenticated,
proxy-free 127.0.0.1 connection and llama-server itself runs in offline mode.
"""

import atexit
import hashlib
import json
import math
import os
import secrets
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


def _models_dir():
    # MUXMELT_DATA_DIR is exported by the Electron main process and points at
    # app.getPath('userData'); fall back to a home-dir path for bare runs.
    base = os.environ.get('MUXMELT_DATA_DIR') or os.path.join(os.path.expanduser('~'), '.muxmelt')
    d = os.path.join(base, 'models')
    os.makedirs(d, exist_ok=True)
    return d


def _llama_dir():
    base = os.environ.get('MUXMELT_DATA_DIR') or os.path.join(os.path.expanduser('~'), '.muxmelt')
    return os.path.join(base, 'llama')


def _hardware_path():
    return os.path.join(_llama_dir(), 'hardware.json')


def _custom_models_path():
    return os.path.join(_models_dir(), 'local-models.json')


def _safe_number(value, default=0):
    """Read untrusted hardware/profile JSON without leaking type errors into UI."""
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) and number >= 0 else default


def _load_hardware():
    """The hardware profile `setup-manager.js` wrote at install time: detected
    GPU/RAM/CPU plus the resolved paths to the preferred and CPU-fallback
    `llama-server` binaries. Re-read on every call (the file is tiny and only
    ever changes across a setup run, so there's nothing worth caching)."""
    try:
        with open(_hardware_path(), 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return None


def _managed_server_path(path):
    """Resolve only executables installed beneath the managed llama folder.
    `hardware.json` lives in user-writable storage, so never let a modified
    profile turn into arbitrary process execution."""
    if not isinstance(path, str) or not path:
        return None
    try:
        root = os.path.normcase(os.path.realpath(_llama_dir()))
        candidate = os.path.normcase(os.path.realpath(path))
        if os.path.commonpath((root, candidate)) != root or not os.path.isfile(candidate):
            return None
        return candidate
    except (OSError, ValueError):
        return None


def is_available():
    """True when at least one prepared `llama-server` binary exists on disk."""
    hw = _load_hardware()
    if not hw:
        return False
    for key in ('serverPath', 'cpuServerPath'):
        if _managed_server_path(hw.get(key)):
            return True
    return False


# Curated GGUF chat models with an explicit professional-quality floor. Qwen's
# own model cards describe the 0.8B and 2B checkpoints as prototyping,
# fine-tuning, and research/development models, so they are intentionally not
# offered as general-purpose assistants here. The 4B checkpoint is the minimum
# built-in option; users whose hardware cannot run it get an honest fit warning
# instead of being silently downgraded to a low-reliability model.
#
# `quality_tier` describes expected capability independently of whether the
# model fits this particular computer. `quality_rank` is used only to choose an
# automatic default; it is deliberately model-specific because total parameter
# count alone does not make the 35B-A3B MoE more accurate than the 27B dense
# model. Qwen3.5 is Apache-2.0 and these GGUFs are quantized by unsloth.
# `min_vram_mb`/`min_ram_mb` leave headroom for KV cache and app/OS overhead.
# Every catalog URL names an immutable repository revision; its file is also
# checksum-pinned and validated as GGUF before it can replace an installed model.
MODELS = {
    'qwen3.5-4b-instruct': {
        'name': 'Qwen3.5 4B Q4 — Professional minimum (~2.7 GB)',
        'file': 'Qwen3.5-4B-Q4_K_M.gguf',
        'url': 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/720bb031aae5488eae5d6a78768e6d826662b2ae/Qwen3.5-4B-Q4_K_M.gguf',
        'sha256': '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
        'approx_mb': 2740,
        'min_vram_mb': 4000,
        'min_ram_mb': 8000,
        'recommended_cpu_ram_mb': 12000,
        'min_cpu_cores': 8,
        'quality_tier': 'standard',
        'quality_rank': 10,
        'description': 'Minimum supported catalog quality for everyday questions, summaries, and writing.',
    },
    'qwen3.5-9b-instruct-q4': {
        'name': 'Qwen3.5 9B Q4 — Recommended (~5.7 GB)',
        'file': 'Qwen3.5-9B-Q4_K_M.gguf',
        'url': 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/99a1b2185534379e6e8b5ec869da25d3e7b3f73c/Qwen3.5-9B-Q4_K_M.gguf',
        'sha256': '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
        'approx_mb': 5680,
        'min_vram_mb': 7000,
        'min_ram_mb': 11000,
        'recommended_cpu_ram_mb': 16000,
        'min_cpu_cores': 8,
        'quality_tier': 'recommended',
        'quality_rank': 20,
        'description': 'Recommended general assistant with stronger reasoning, factual recall, writing, and coding.',
    },
    'qwen3.5-9b-instruct-q5': {
        'name': 'Qwen3.5 9B Q5 — Recommended+ (~6.6 GB)',
        'file': 'Qwen3.5-9B-Q5_K_M.gguf',
        'url': 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/dcb5858fb5302827076259ceafff1690cb56d736/Qwen3.5-9B-Q5_K_M.gguf',
        'sha256': 'dc2a39aef291f91a9116ad214058da0d86eb648743a124bd8c333787c4b9c91c',
        'approx_mb': 6580,
        'min_vram_mb': 8000,
        'min_ram_mb': 12000,
        'recommended_cpu_ram_mb': 20000,
        'min_cpu_cores': 10,
        'quality_tier': 'recommended',
        'quality_rank': 25,
        'description': 'Recommended 9B assistant with a higher-precision quantization when memory allows.',
    },
    'qwen3.5-27b-instruct': {
        'name': 'Qwen3.5 27B Q4 — Expert (~16.7 GB)',
        'file': 'Qwen3.5-27B-Q4_K_M.gguf',
        'url': 'https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/207d467c0085ba5f42a8552fff6d821ff2856996/Qwen3.5-27B-Q4_K_M.gguf',
        'sha256': '84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806',
        'approx_mb': 16700,
        'min_vram_mb': 19000,
        'min_ram_mb': 26000,
        'recommended_cpu_ram_mb': 48000,
        'min_cpu_cores': 16,
        'quality_tier': 'expert',
        'quality_rank': 40,
        'description': 'Highest-quality catalog choice for consistent analysis, reasoning, writing, and coding.',
    },
    'qwen3.5-35b-a3b-instruct': {
        'name': 'Qwen3.5 35B-A3B Q4 — Advanced MoE (~22 GB)',
        'file': 'Qwen3.5-35B-A3B-Q4_K_M.gguf',
        'url': 'https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/ac1c149b8500aa4cd8cbe9b4721804b2fccb82ee/Qwen3.5-35B-A3B-Q4_K_M.gguf',
        'sha256': '3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375',
        'approx_mb': 22000,
        'min_vram_mb': 28000,
        'min_ram_mb': 36000,
        'recommended_cpu_ram_mb': 48000,
        'min_cpu_cores': 16,
        'quality_tier': 'advanced',
        'quality_rank': 30,
        'description': 'Advanced mixture-of-experts option with strong answers and efficient token generation.',
    },
}

PROFESSIONAL_MINIMUM_MODEL = 'qwen3.5-4b-instruct'

EXECUTION_MODES = {'auto', 'gpu', 'cpu'}
RESOURCE_PROFILES = {'auto', 'eco', 'balanced', 'performance'}


def _is_valid_gguf(path, minimum_bytes=1024 * 1024):
    try:
        if (not isinstance(path, str) or not os.path.isabs(path)
                or not os.path.isfile(path) or os.path.getsize(path) < minimum_bytes):
            return False
        with open(path, 'rb') as model_file:
            return model_file.read(4) == b'GGUF'
    except OSError:
        return False


def _load_custom_models():
    """Return validated user-selected GGUF entries. The registry stores paths,
    never model data, so importing a 20 GB model is immediate and does not
    duplicate it. Missing/moved files simply disappear from the picker."""
    try:
        with open(_custom_models_path(), 'r', encoding='utf-8') as registry_file:
            raw = json.load(registry_file)
    except (OSError, ValueError):
        return {}

    entries = raw.get('models') if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return {}

    result = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get('id')
        path = entry.get('path')
        name = entry.get('name')
        if (not isinstance(model_id, str) or not model_id.startswith('local-')
                or not isinstance(name, str) or not name.strip()
                or not _is_valid_gguf(path)):
            continue
        approx_mb = max(1, round(os.path.getsize(path) / 1_000_000))
        result[model_id] = {
            'name': name.strip()[:120],
            'file': path,
            'approx_mb': approx_mb,
            'min_vram_mb': max(1000, math.ceil(approx_mb * 1.25)),
            'min_ram_mb': max(2000, math.ceil(approx_mb * 1.6)),
            'recommended_cpu_ram_mb': max(4000, math.ceil(approx_mb * 2.0)),
            'min_cpu_cores': 8 if approx_mb < 8000 else 12,
            'quality_tier': 'unverified',
            'quality_rank': 0,
            'description': (
                'Imported local GGUF. Its answer quality has not been evaluated '
                'or endorsed by MuxMelt.'
            ),
            'source': 'local',
        }
    return result


def _write_custom_models(models):
    registry_path = _custom_models_path()
    payload = {
        'version': 1,
        'models': [
            {'id': model_id, 'name': info['name'], 'path': info['file']}
            for model_id, info in sorted(models.items())
        ],
    }
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', prefix='local-models.', suffix='.tmp',
            dir=os.path.dirname(registry_path), delete=False,
        ) as registry_file:
            temp_path = registry_file.name
            json.dump(payload, registry_file, indent=2)
            registry_file.flush()
            os.fsync(registry_file.fileno())
        os.replace(temp_path, registry_path)
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _model_info(model_id):
    if model_id in MODELS:
        return MODELS[model_id]
    return _load_custom_models().get(model_id)


def recommend_tier(model_id, hw):
    """Classify a model against a detected hardware profile (possibly None):
    'recommended' (fits comfortably), 'possible' (runs, likely slower), or
    'not-recommended' (would probably thrash/OOM). Non-blocking — the picker
    shows every model regardless, this only badges them."""
    m = _model_info(model_id)
    if not m:
        return 'not-recommended'
    hw = hw if isinstance(hw, dict) else {}
    vram = _safe_number(hw.get('vramMb'))
    ram = _safe_number(hw.get('ramMb'), 8192)
    cores = max(1, int(_safe_number(hw.get('cpuCores'), 4)))
    backend = str(hw.get('backend') or 'cpu').lower()
    # Apple GPUs use unified memory; treating them as zero-VRAM would recommend
    # only the tiny model even on a 32/64 GB Apple Silicon machine.
    effective_vram = max(vram, ram * 0.72 if backend == 'metal' else 0)
    if effective_vram >= m['min_vram_mb']:
        return 'recommended'
    if ram >= m['min_ram_mb']:
        # CPU-only inference scales with memory capacity, memory bandwidth, and
        # core count. Give every curated model an explicit CPU comfort boundary
        # rather than permanently treating all models above 4B as second-class.
        cpu_ram = _safe_number(
            m.get('recommended_cpu_ram_mb'), m['min_ram_mb']
        )
        cpu_cores = max(1, int(_safe_number(m.get('min_cpu_cores'), 8)))
        if ram >= cpu_ram and cores >= cpu_cores:
            return 'recommended'
        return 'possible'
    return 'not-recommended'


def default_model(hw):
    """Choose the strongest curated model that comfortably fits.

    Quality priority is explicit rather than inferred from catalog order or
    parameter count. When the computer is below the catalog quality floor,
    return the 4B professional minimum with a hardware warning; never silently
    substitute a sub-professional checkpoint.
    """
    candidates = [
        (int(model.get('quality_rank', 0)), model_id)
        for model_id, model in MODELS.items()
        if recommend_tier(model_id, hw) == 'recommended'
    ]
    if candidates:
        return max(candidates)[1]
    return PROFESSIONAL_MINIMUM_MODEL


def hardware_summary(hw):
    if isinstance(hw, dict):
        name = hw.get('gpuName')
        backend = str(hw.get('backend') or 'cpu')
        vram = _safe_number(hw.get('vramMb'))
        if name and backend and backend != 'cpu':
            memory = f', {vram / 1024:.1f} GB VRAM' if vram else ''
            return f'{name} · {backend.upper()}{memory}'
        cores = max(1, int(_safe_number(hw.get('cpuCores'), 4)))
        return f'CPU inference · {cores} logical cores'
    return 'CPU inference'


def hardware_info(hw):
    hw = hw if isinstance(hw, dict) else {}
    backend = str(hw.get('backend') or 'cpu')
    return {
        'summary': hardware_summary(hw),
        'backend': backend,
        'gpu_name': str(hw.get('gpuName') or ''),
        'vram_mb': int(_safe_number(hw.get('vramMb'))),
        'ram_mb': int(_safe_number(hw.get('ramMb'), 8192)),
        'cpu_cores': max(1, int(_safe_number(hw.get('cpuCores'), 4))),
        'gpu_available': backend != 'cpu' and bool(_managed_server_path(hw.get('serverPath'))),
    }


def resolve_resource_profile(hw, requested='auto'):
    if requested not in RESOURCE_PROFILES:
        raise ValueError(f'Unknown resource profile: {requested}')
    info = hardware_info(hw)
    resolved = requested
    if requested == 'auto':
        if info['ram_mb'] < 10_000 and info['vram_mb'] < 4_000:
            resolved = 'eco'
        elif (info['vram_mb'] >= 10_000 or info['ram_mb'] >= 24_000) and info['cpu_cores'] >= 8:
            resolved = 'performance'
        else:
            resolved = 'balanced'

    capable_8k = info['vram_mb'] >= 5_000 or info['ram_mb'] >= 12_000
    cores = info['cpu_cores']
    if resolved == 'eco':
        return {
            'requested': requested, 'resolved': resolved, 'context_size': 4096,
            'threads': max(1, min(4, cores // 2 or 1)),
            'batch_size': 512, 'ubatch_size': 128, 'idle_seconds': 60,
        }
    if resolved == 'performance':
        return {
            'requested': requested, 'resolved': resolved,
            'context_size': 8192 if capable_8k else 4096,
            'threads': cores, 'batch_size': 2048, 'ubatch_size': 512,
            'idle_seconds': 300,
        }
    return {
        'requested': requested, 'resolved': 'balanced',
        'context_size': 8192 if capable_8k else 4096,
        'threads': max(1, cores - 1), 'batch_size': 1024,
        'ubatch_size': 256, 'idle_seconds': 180,
    }


def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _is_llama_listener_proof(line, port):
    """Recognize llama.cpp's own post-bind listener message.

    The message arrives on the exact child process's inherited output pipe. It
    is therefore a stronger identity signal than probing a recently released
    TCP port, which another local process could claim before llama-server.
    """
    if not isinstance(line, str) or not isinstance(port, int):
        return False
    lowered = ' '.join(line.lower().split())
    if 'listen' not in lowered:
        return False
    endpoint = (
        f'127.0.0.1:{port}' in lowered
        or f'localhost:{port}' in lowered
    )
    if endpoint:
        return True
    try:
        payload = json.loads(line)
    except (TypeError, ValueError):
        payload = None
    if isinstance(payload, dict):
        message = str(payload.get('msg') or payload.get('message') or '').lower()
        hostname = str(payload.get('hostname') or '').strip('[]').lower()
        try:
            logged_port = int(payload.get('port'))
        except (TypeError, ValueError):
            logged_port = -1
        if 'listen' in message and hostname in {'127.0.0.1', 'localhost'}:
            return logged_port == port
    host_marker = (
        'hostname: 127.0.0.1' in lowered
        or 'hostname = 127.0.0.1' in lowered
        or 'hostname: localhost' in lowered
        or 'hostname = localhost' in lowered
    )
    port_marker = f'port: {port}' in lowered or f'port = {port}' in lowered
    return host_marker and port_marker


def _watch_llama_listener(stream, port, ready_event):
    """Drain child output for its lifetime and signal only a valid bind line."""
    try:
        while True:
            raw = stream.readline(64 * 1024)
            if raw in ('', b''):
                return
            line = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else raw
            if _is_llama_listener_proof(line, port):
                ready_event.set()
    except (OSError, ValueError):
        return
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass


def _create_private_api_key_file(api_key):
    """Write one llama-server API key outside argv in a private temp folder.

    ``tempfile.mkdtemp`` creates the directory with owner-only permissions on
    POSIX and beneath the current user's private temp location on Windows. The
    explicit modes below keep that contract visible and fail closed if the
    platform cannot apply them.
    """
    if not isinstance(api_key, str) or not api_key or '\n' in api_key or '\r' in api_key:
        raise ValueError('Invalid local chat API key')

    key_dir = tempfile.mkdtemp(prefix='muxmelt-llama-auth-')
    key_path = os.path.join(key_dir, 'api-key')
    fd = None
    try:
        os.chmod(key_dir, stat.S_IRWXU)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, 'O_BINARY'):
            flags |= os.O_BINARY
        fd = os.open(key_path, flags, stat.S_IRUSR | stat.S_IWUSR)
        os.chmod(key_path, stat.S_IRUSR | stat.S_IWUSR)
        key_file = os.fdopen(fd, 'w', encoding='ascii', newline='\n')
        fd = None
        with key_file:
            # llama-server expects one API key per line.
            key_file.write(api_key + '\n')
            key_file.flush()
            os.fsync(key_file.fileno())
        return key_path
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        _cleanup_private_api_key_file(key_path)
        raise


def _cleanup_private_api_key_file(key_path):
    """Remove only the exact key file and private directory we created."""
    if not key_path:
        return
    try:
        os.remove(key_path)
    except FileNotFoundError:
        pass
    except OSError:
        return
    try:
        os.rmdir(os.path.dirname(key_path))
    except OSError:
        pass


def _watch_process_api_key(proc, key_path):
    """Delete a launch key after its exact llama-server child exits."""
    while True:
        try:
            if proc.poll() is not None:
                break
        except Exception:
            # The owning ChatLLM still performs synchronous cleanup on its
            # explicit shutdown path. Do not remove a live server's key merely
            # because an unusual process wrapper failed to report status.
            return
        time.sleep(0.2)
    _cleanup_private_api_key_file(key_path)


class ChatLLM:
    def __init__(self):
        self.cancel_event = threading.Event()
        self._server_proc = None
        self._server_port = None
        self._server_key_path = None
        self._loaded_model_id = None
        self._loaded_config = None
        self._context_size = 4096
        self._active_backend = None
        self._api_key = secrets.token_urlsafe(32)
        # The server subprocess is not safe to spawn/swap concurrently. This
        # also prevents a model switch from killing the process mid-generation.
        self._lock = threading.RLock()
        self._download_lock = threading.Lock()
        self._download_response_lock = threading.Lock()
        self._active_download_response = None
        self._chat_response_lock = threading.Lock()
        self._active_chat_response = None
        # Ignore ambient HTTP(S)_PROXY settings for the private inference hop.
        # This opener physically cannot route prompt traffic through a proxy.
        self._loopback_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        atexit.register(self._kill_server)

    def cancel(self):
        self.cancel_event.set()
        with self._download_response_lock:
            response = self._active_download_response
        if response is not None:
            try:
                response.close()
            except OSError:
                pass
        with self._chat_response_lock:
            response = self._active_chat_response
        if response is not None:
            try:
                response.close()
            except OSError:
                pass

    def reset_cancel(self):
        self.cancel_event.clear()

    def model_path(self, model_id):
        m = _model_info(model_id)
        if not m:
            return None
        if m.get('source') == 'local':
            return m['file']
        return os.path.join(_models_dir(), m['file'])

    def is_downloaded(self, model_id):
        model_info = _model_info(model_id)
        p = self.model_path(model_id)
        if not model_info or not p or not os.path.isfile(p):
            return False
        try:
            # Every valid GGUF starts with this four-byte magic. Checking it is
            # cheap and avoids treating an HTML error page or stale partial as
            # an installed model.
            minimum_size = (1024 * 1024 if model_info.get('source') == 'local'
                            else int(model_info.get('approx_mb', 0) * 1_000_000 * 0.65))
            if minimum_size and os.path.getsize(p) < minimum_size:
                return False
            with open(p, 'rb') as model_file:
                return model_file.read(4) == b'GGUF'
        except OSError:
            return False

    def list_models(self):
        hw = _load_hardware()
        catalog = dict(MODELS)
        catalog.update(_load_custom_models())
        result = []
        for mid, m in catalog.items():
            fit = recommend_tier(mid, hw)
            result.append({
                'id': mid,
                'name': m['name'],
                'approx_mb': m['approx_mb'],
                'downloaded': self.is_downloaded(mid),
                # `tier` remains as a compatibility alias for older renderers.
                # `fit` is the unambiguous hardware suitability field.
                'fit': fit,
                'tier': fit,
                'quality_tier': m.get('quality_tier', 'unverified'),
                'quality_rank': int(m.get('quality_rank', 0)),
                'source': m.get('source', 'catalog'),
                'can_download': m.get('source') != 'local' and bool(m.get('url')),
                'description': m.get('description', ''),
            })
        return result

    def hardware_info(self):
        info = hardware_info(_load_hardware())
        info['active_backend'] = self._active_backend
        return info

    def default_model(self):
        return default_model(_load_hardware())

    def has_model(self, model_id):
        return _model_info(model_id) is not None

    def register_local_model(self, source_path):
        if not isinstance(source_path, str) or not source_path.strip():
            raise ValueError('Choose a GGUF model file first.')
        if len(source_path) > 4096:
            raise ValueError('The selected model path is too long.')
        path = os.path.abspath(os.path.expanduser(source_path.strip()))
        if os.path.splitext(path)[1].lower() != '.gguf':
            raise ValueError('Local chat models must be .gguf files.')
        if not _is_valid_gguf(path):
            raise ValueError('The selected file is not a valid GGUF model.')

        normalized = os.path.normcase(os.path.realpath(path)).encode('utf-8', errors='surrogatepass')
        model_id = 'local-' + hashlib.sha256(normalized).hexdigest()[:16]
        name = os.path.splitext(os.path.basename(path))[0].strip() or 'Local GGUF model'
        custom = _load_custom_models()
        custom[model_id] = {'name': name[:120], 'file': path}
        _write_custom_models(custom)
        return model_id

    def download(self, model_id, progress_cb=None):
        """Stream the GGUF to <models>/<file>.part, then atomically rename.
        Honours cancel_event between chunks so a cancel leaves no full file."""
        if os.environ.get('MUXMELT_OFFLINE') == '1':
            raise RuntimeError(
                'Local Chat model downloads are disabled while Offline Mode is enabled.'
            )
        m = MODELS.get(model_id)
        if not m or not m.get('url'):
            raise ValueError(f'Unknown downloadable model: {model_id}')
        with self._download_lock:
            dest = self.model_path(model_id)
            if self.is_downloaded(model_id):
                return dest

            tmp = None
            expected_sha = (m.get('sha256') or '').lower() or None
            expected_bytes = int(m.get('approx_mb', 0) * 1_000_000)
            if expected_bytes:
                free_bytes = shutil.disk_usage(os.path.dirname(dest)).free
                if free_bytes < expected_bytes * 1.1:
                    raise RuntimeError(
                        f'Not enough free disk space for this model. '
                        f'About {m["approx_mb"] / 1000:.1f} GB is required.'
                    )

            req = urllib.request.Request(m['url'], headers={'User-Agent': 'MuxMelt/1.0'})
            resp = None
            try:
                hasher = hashlib.sha256() if expected_sha else None
                resp = urllib.request.urlopen(req, timeout=10)
                with self._download_response_lock:
                    if self.cancel_event.is_set():
                        resp.close()
                        raise RuntimeError('Cancelled')
                    self._active_download_response = resp
                with resp:
                    total = int(resp.headers.get('Content-Length') or 0)
                    maximum_bytes = max(
                        expected_bytes + 64 * 1024 * 1024,
                        int(expected_bytes * 1.08),
                    )
                    if total and total > maximum_bytes:
                        raise RuntimeError(
                            'The model download is larger than the verified catalog entry.'
                        )
                    done = 0
                    chunk_size = 1024 * 256
                    last_data_at = time.monotonic()
                    with tempfile.NamedTemporaryFile(
                        mode='wb', prefix=os.path.basename(dest) + '.',
                        suffix='.part', dir=os.path.dirname(dest), delete=False,
                    ) as f:
                        tmp = f.name
                        while True:
                            if self.cancel_event.is_set():
                                raise RuntimeError('Cancelled')
                            try:
                                buf = resp.read(chunk_size)
                            except (TimeoutError, socket.timeout) as exc:
                                if self.cancel_event.is_set():
                                    raise RuntimeError('Cancelled') from exc
                                if time.monotonic() - last_data_at >= 60:
                                    raise RuntimeError(
                                        'Model download stalled for 60 seconds. '
                                        'Check your connection and try again.'
                                    ) from exc
                                continue
                            if not buf:
                                break
                            last_data_at = time.monotonic()
                            f.write(buf)
                            if hasher:
                                hasher.update(buf)
                            done += len(buf)
                            if done > maximum_bytes:
                                raise RuntimeError(
                                    'The model download exceeded its verified size limit.'
                                )
                            if progress_cb:
                                progress_cb(done / total if total else 0.0, done, total)

                if total and done != total:
                    raise RuntimeError(
                        f'Download incomplete: got {done} of {total} bytes. '
                        'Check your connection and try again.'
                    )
                if expected_bytes and done < expected_bytes * 0.65:
                    raise RuntimeError(
                        'Downloaded model is much smaller than expected and is likely incomplete.'
                    )
                with open(tmp, 'rb') as model_file:
                    if model_file.read(4) != b'GGUF':
                        raise RuntimeError('The downloaded file is not a valid GGUF model.')
                if expected_sha:
                    actual_sha = hasher.hexdigest()
                    if actual_sha != expected_sha:
                        raise RuntimeError(
                            'Downloaded model failed integrity check (SHA-256 mismatch).'
                        )
                os.replace(tmp, dest)
                return dest
            except Exception as exc:
                try:
                    if tmp:
                        os.remove(tmp)
                except OSError:
                    pass
                if self.cancel_event.is_set() and str(exc) != 'Cancelled':
                    raise RuntimeError('Cancelled') from exc
                raise
            finally:
                with self._download_response_lock:
                    if self._active_download_response is resp:
                        self._active_download_response = None
                if resp is not None:
                    try:
                        resp.close()
                    except OSError:
                        pass

    def _kill_server(self):
        proc, self._server_proc = self._server_proc, None
        key_path, self._server_key_path = self._server_key_path, None
        self._server_port = None
        self._loaded_model_id = None
        self._loaded_config = None
        self._active_backend = None
        try:
            if proc is not None and proc.poll() is None:
                self._terminate_process(proc)
        finally:
            _cleanup_private_api_key_file(key_path)

    @staticmethod
    def _terminate_process(proc):
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        except Exception:
            pass

    def unload(self):
        """Release model RAM/VRAM. Safe to call repeatedly."""
        with self._lock:
            self.cancel()
            self._kill_server()

    def _launch_and_wait(self, server_path, model_path, profile, extra_args):
        """Spawn `llama-server` for `model_path` and block until it answers
        /health (or fails). Raises on any failure; never returns a process
        that isn't confirmed ready."""
        port = _find_free_port()
        launch_api_key = secrets.token_urlsafe(32)
        key_path = _create_private_api_key_file(launch_api_key)
        cmd = [
            server_path,
            '--model', model_path,
            '--host', '127.0.0.1',
            '--port', str(port),
            '--ctx-size', str(profile['context_size']),
            '--threads', str(profile['threads']),
            '--threads-batch', str(profile['threads']),
            '--batch-size', str(profile['batch_size']),
            '--ubatch-size', str(profile['ubatch_size']),
            '--parallel', '1',
            '--flash-attn', 'auto',
            '--sleep-idle-seconds', str(profile['idle_seconds']),
            '--api-key-file', key_path,
            '--offline',
            '--no-ui',
            '--no-slots',
            '--no-cont-batching',
        ] + list(extra_args)

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        child_env = os.environ.copy()
        child_env.update({
            'HF_HUB_OFFLINE': '1',
            'TRANSFORMERS_OFFLINE': '1',
            'NO_PROXY': '127.0.0.1,localhost',
            'no_proxy': '127.0.0.1,localhost',
        })
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=os.path.dirname(server_path) or None,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
                env=child_env,
            )
        except Exception:
            _cleanup_private_api_key_file(key_path)
            raise

        secret_watcher = threading.Thread(
            target=_watch_process_api_key,
            args=(proc, key_path),
            name='muxmelt-llama-auth-cleanup',
            daemon=True,
        )
        secret_watcher.start()

        # llama-server's post-bind message is observed through this exact
        # child's pipe. Until it appears, never send even a health request to
        # the selected port; a local process may have won the bind race.
        listener_ready = threading.Event()
        output_watcher = threading.Thread(
            target=_watch_llama_listener,
            args=(proc.stdout, port, listener_ready),
            name='muxmelt-llama-readiness',
            daemon=True,
        )
        output_watcher.start()

        url = f'http://127.0.0.1:{port}/health'
        health_request = urllib.request.Request(
            url,
            headers={'Authorization': f'Bearer {launch_api_key}'},
        )
        deadline = time.monotonic() + 90
        try:
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f'Chat engine exited during startup (code {proc.returncode})')
                if self.cancel_event.is_set():
                    raise RuntimeError('Cancelled')
                if not listener_ready.is_set():
                    listener_ready.wait(0.1)
                    continue
                try:
                    with self._loopback_opener.open(health_request, timeout=2) as resp:
                        if 200 <= resp.status < 300:
                            self._api_key = launch_api_key
                            self._server_key_path = key_path
                            return proc, port
                except Exception:
                    pass
                time.sleep(0.1)
            raise RuntimeError('Chat engine did not become ready in time')
        except Exception:
            self._terminate_process(proc)
            _cleanup_private_api_key_file(key_path)
            raise

    def ensure_loaded(self, model_id, execution='auto', profile='auto', status_cb=None):
        """Start (or reuse) the llama-server process serving `model_id`.
        Switching models always starts a fresh server since the model is
        fixed at server startup — only one server runs at a time."""
        if execution not in EXECUTION_MODES:
            raise ValueError(f'Unknown execution mode: {execution}')
        if profile not in RESOURCE_PROFILES:
            raise ValueError(f'Unknown resource profile: {profile}')

        with self._lock:
            hw = _load_hardware()
            runtime_profile = resolve_resource_profile(hw, profile)
            cache_key = (
                model_id, execution, runtime_profile['resolved'],
                runtime_profile['context_size'], runtime_profile['threads'],
                runtime_profile['batch_size'], runtime_profile['ubatch_size'],
            )
            if (self._server_proc is not None and self._server_proc.poll() is None
                    and self._loaded_config == cache_key):
                return
            path = self.model_path(model_id)
            if not path:
                raise ValueError(f'Unknown model: {model_id}')
            if not self.is_downloaded(model_id):
                raise RuntimeError('Model has not been downloaded yet.')

            primary_path = _managed_server_path(hw.get('serverPath')) if hw else None
            if not primary_path:
                raise RuntimeError(
                    'The chat engine is not installed in this build. Reinstall the app or run setup again.'
                )

            if status_cb:
                status_cb('Starting the chat engine...')

            # Drop the old server first so we don't briefly run two at once.
            self._kill_server()
            model_info = _model_info(model_id) or {}
            extra_args = []
            if 'a3b' in model_id and _safe_number(hw.get('vramMb')) < _safe_number(model_info.get('min_vram_mb')):
                # Mixture-of-experts model that won't fully fit in VRAM: keep
                # expert weights on CPU (only the active expert executes per
                # token, so this stays fast) while attention layers stay on GPU.
                extra_args = ['--n-cpu-moe', '999']

            configured_backend = str(hw.get('backend') or 'cpu')
            gpu_available = configured_backend != 'cpu'
            cpu_path = _managed_server_path(hw.get('cpuServerPath'))

            if execution == 'gpu' and not gpu_available:
                raise RuntimeError('No compatible GPU acceleration backend was detected.')

            if execution == 'cpu':
                server_path = cpu_path or primary_path
                proc, port = self._launch_and_wait(
                    server_path, path, runtime_profile,
                    ['--device', 'none', '--n-gpu-layers', '0'],
                )
                active_backend = 'cpu'
            else:
                try:
                    proc, port = self._launch_and_wait(
                        primary_path, path, runtime_profile, extra_args,
                    )
                    active_backend = configured_backend
                except Exception:
                    if (execution == 'gpu' or self.cancel_event.is_set() or not cpu_path
                            or cpu_path == primary_path):
                        raise
                    if status_cb:
                        status_cb('GPU acceleration unavailable — falling back to CPU...')
                    proc, port = self._launch_and_wait(
                        cpu_path, path, runtime_profile,
                        ['--device', 'none', '--n-gpu-layers', '0'],
                    )
                    active_backend = 'cpu'

            self._server_proc = proc
            self._server_port = port
            self._loaded_model_id = model_id
            self._loaded_config = cache_key
            self._context_size = runtime_profile['context_size']
            self._active_backend = active_backend

    def _request(self, endpoint, payload=None):
        """Build an authenticated request to the one allowed inference origin.
        Keeping URL construction here makes the no-remote-prompt boundary easy
        to audit and prevents environment proxy settings from changing it."""
        if not isinstance(self._server_port, int) or not 1 <= self._server_port <= 65535:
            raise RuntimeError('Chat engine is not running.')
        if not isinstance(endpoint, str) or not endpoint.startswith('/') or '://' in endpoint:
            raise ValueError('Invalid local inference endpoint.')
        body = json.dumps(payload).encode('utf-8') if payload is not None else None
        return urllib.request.Request(
            f'http://127.0.0.1:{self._server_port}{endpoint}',
            data=body,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {self._api_key}',
            },
            method='POST' if body is not None else 'GET',
        )

    @staticmethod
    def _http_error_message(exc):
        try:
            raw = exc.read(64 * 1024).decode('utf-8', errors='replace')
            parsed = json.loads(raw)
            detail = parsed.get('error') if isinstance(parsed, dict) else None
            if isinstance(detail, dict):
                message = detail.get('message')
                if isinstance(message, str) and message.strip():
                    return message.strip()[:500]
        except Exception:
            pass
        return f'Local chat engine returned HTTP {getattr(exc, "code", "error")}'

    @staticmethod
    def _estimate_message_tokens(messages):
        # Conservative fallback for older llama-server builds without the input
        # token-count endpoint. UTF-8 bytes handle CJK text much better than a
        # fixed characters-per-token estimate.
        total = 2
        for message in messages:
            content = str(message.get('content') or '')
            total += math.ceil(len(content.encode('utf-8')) / 3) + 5
        return total

    def count_message_tokens(self, messages):
        with self._lock:
            if self._server_proc is None or self._server_proc.poll() is not None:
                raise RuntimeError('Chat engine is not running.')
            request = self._request('/v1/chat/completions/input_tokens', {
                'messages': messages,
                'chat_template_kwargs': {'enable_thinking': False},
            })
            try:
                with self._loopback_opener.open(request, timeout=30) as response:
                    result = json.loads(response.read(1024 * 1024).decode('utf-8'))
                count = result.get('input_tokens') if isinstance(result, dict) else None
                if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
                    return count
            except Exception:
                pass
            return self._estimate_message_tokens(messages)

    def fit_messages(self, messages, max_tokens):
        """Fit complete recent turns into the live model context. Returns
        `(messages, trimmed, prompt_tokens)` and never drops the system prompt
        or newest user message."""
        fitted = [dict(message) for message in messages]
        # Normalize any legacy/orphan history before counting.
        while len(fitted) > 2 and fitted[1].get('role') == 'assistant':
            del fitted[1]
        budget = max(256, self._context_size - max_tokens - 192)
        trimmed = False
        while True:
            prompt_tokens = self.count_message_tokens(fitted)
            if prompt_tokens <= budget:
                return fitted, trimmed, prompt_tokens
            if len(fitted) <= 2:
                raise ValueError(
                    'This message is too long for the selected resource profile. '
                    'Shorten it or choose a profile with a larger context window.'
                )
            # Remove the oldest full user/assistant turn.
            del fitted[1]
            if len(fitted) > 2 and fitted[1].get('role') == 'assistant':
                del fitted[1]
            trimmed = True

    def chat_stream(self, messages, on_token, max_tokens=512, temperature=0.7,
                    top_p=0.95, top_k=40, repeat_penalty=1.1, min_p=0.05):
        """Stream the assistant reply token-by-token via on_token(text) from
        llama-server's OpenAI-compatible /v1/chat/completions endpoint. Stops
        early when cancel_event is set.

        The sampling knobs shape answer quality: lower `temperature` + `top_p`
        make replies more deterministic/factual; `repeat_penalty` curbs the
        looping small models are prone to; `min_p` trims low-probability tokens
        (a steadier alternative to top_k alone). The caller maps a user-facing
        style preset (Precise/Balanced/Creative) onto these values."""
        if not isinstance(messages, list) or not messages:
            raise ValueError('Messages must be a non-empty list')
        if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or not 1 <= max_tokens <= 4096:
            raise ValueError('max_tokens must be between 1 and 4096')
        numeric_ranges = (
            ('temperature', temperature, 0.0, 2.0),
            ('top_p', top_p, 0.0, 1.0),
            ('repeat_penalty', repeat_penalty, 0.0, 2.0),
            ('min_p', min_p, 0.0, 1.0),
        )
        for name, value, low, high in numeric_ranges:
            if (not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not math.isfinite(value) or not low <= value <= high):
                raise ValueError(f'{name} must be between {low} and {high}')
        if not isinstance(top_k, int) or isinstance(top_k, bool) or not 0 <= top_k <= 200:
            raise ValueError('top_k must be between 0 and 200')

        with self._lock:
            # Cancellation can arrive while the router is loading the model or
            # while this worker is waiting for the lock. Do not start a
            # request at all when it's already stale.
            if self.cancel_event.is_set():
                return
            if self._server_proc is None or self._server_port is None:
                raise RuntimeError('Model not loaded.')
            if self._server_proc.poll() is not None:
                raise RuntimeError('Chat engine is not running.')

            payload = {
                'messages': messages,
                'stream': True,
                'max_tokens': max_tokens,
                'temperature': temperature,
                'top_p': top_p,
                'top_k': top_k,
                'repeat_penalty': repeat_penalty,
                'min_p': min_p,
                # Qwen3.5's hybrid checkpoints default to emitting a reasoning
                # trace; this is a clean single-turn chat bubble, not a
                # reasoning console, so ask the template to skip it.
                'chat_template_kwargs': {'enable_thinking': False},
                'stream_options': {'include_usage': True},
            }
            req = self._request('/v1/chat/completions', payload)

            response = None
            started_at = time.monotonic()
            characters = 0
            completion_tokens = None
            finish_reason = None
            try:
                response = self._loopback_opener.open(req, timeout=120)
                with self._chat_response_lock:
                    if self.cancel_event.is_set():
                        response.close()
                        return {'cancelled': True, 'elapsed_seconds': 0, 'characters': 0}
                    self._active_chat_response = response
                for raw_line in response:
                    if self.cancel_event.is_set():
                        break
                    line = raw_line.decode('utf-8', errors='replace').strip()
                    if not line or not line.startswith('data:'):
                        continue
                    chunk = line[len('data:'):].strip()
                    if chunk == '[DONE]':
                        break
                    try:
                        obj = json.loads(chunk)
                    except ValueError as exc:
                        raise RuntimeError('The local chat engine returned a malformed stream.') from exc
                    if not isinstance(obj, dict):
                        raise RuntimeError('The local chat engine returned an invalid stream event.')
                    error = obj.get('error')
                    if error:
                        if isinstance(error, dict):
                            error = error.get('message') or error.get('type')
                        raise RuntimeError(str(error)[:500])
                    usage = obj.get('usage')
                    if isinstance(usage, dict) and isinstance(usage.get('completion_tokens'), int):
                        completion_tokens = usage['completion_tokens']
                    choices = obj.get('choices') or []
                    if not choices:
                        continue
                    if not isinstance(choices[0], dict):
                        raise RuntimeError('The local chat engine returned an invalid completion event.')
                    if choices[0].get('finish_reason'):
                        finish_reason = str(choices[0]['finish_reason'])
                    delta = choices[0].get('delta') or {}
                    text = delta.get('content') if isinstance(delta, dict) else None
                    if text:
                        characters += len(text)
                        on_token(text)
            except urllib.error.HTTPError as exc:
                if self.cancel_event.is_set():
                    return {
                        'cancelled': True,
                        'elapsed_seconds': round(time.monotonic() - started_at, 2),
                        'characters': characters,
                    }
                raise RuntimeError(self._http_error_message(exc)) from exc
            except Exception:
                if self.cancel_event.is_set():
                    return {
                        'cancelled': True,
                        'elapsed_seconds': round(time.monotonic() - started_at, 2),
                        'characters': characters,
                    }
                raise
            finally:
                with self._chat_response_lock:
                    if self._active_chat_response is response:
                        self._active_chat_response = None
                if response is not None:
                    try:
                        response.close()
                    except Exception:
                        pass
            elapsed = max(0.001, time.monotonic() - started_at)
            stats = {
                'cancelled': self.cancel_event.is_set(),
                'elapsed_seconds': round(elapsed, 2),
                'characters': characters,
                'finish_reason': finish_reason,
                'backend': self._active_backend,
            }
            if completion_tokens is not None:
                stats['completion_tokens'] = completion_tokens
                stats['tokens_per_second'] = round(completion_tokens / elapsed, 1)
            return stats
