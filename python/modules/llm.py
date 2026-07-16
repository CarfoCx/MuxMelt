"""Local LLM chat backed by llama-cpp-python (GGUF models).

No external API: inference runs entirely on the user's machine. The inference
engine (llama-cpp-python) is bundled with the app, but the model weights are
downloaded once on first use into the per-user data dir and reused offline
afterwards. llama_cpp is a heavy import, so — like rembg/demucs — it is probed
with find_spec and only imported when a model is actually loaded.
"""

import hashlib
import math
import os
import shutil
import socket
import tempfile
import threading
import time
import urllib.request
from importlib.util import find_spec

_available = find_spec('llama_cpp') is not None


def is_available():
    """True when the bundled inference engine is importable."""
    return _available


def _models_dir():
    # MUXMELT_DATA_DIR is exported by the Electron main process and points at
    # app.getPath('userData'); fall back to a home-dir path for bare runs.
    base = os.environ.get('MUXMELT_DATA_DIR') or os.path.join(os.path.expanduser('~'), '.muxmelt')
    d = os.path.join(base, 'models')
    os.makedirs(d, exist_ok=True)
    return d


# Downloadable GGUF chat models, ordered as an accuracy ladder (small/fast →
# large/accurate). The bigger Qwen2.5 sizes (1.5B/7B/14B) are Apache-2.0; the 3B
# is under the Qwen Research licence. Bigger models answer far more accurately
# but need more RAM and run slower on CPU — the picker lets the user choose.
# A higher-quality quant (Q5_K_M) keeps more of the model's precision than Q4 at
# a small size/speed cost. To add a model, drop another entry here and it shows
# up in the picker automatically. An optional 'sha256' (lowercase hex of the
# GGUF) pins the download for integrity — when present it is verified before the
# file is accepted; when absent, the GGUF magic, expected size range, and the
# server's Content-Length reject error pages and truncated downloads.
MODELS = {
    'qwen2.5-1.5b-instruct-q4': {
        'name': 'Qwen2.5 1.5B — fastest (~1 GB)',
        'file': 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
        'approx_mb': 1100,
    },
    'qwen2.5-3b-instruct-q4': {
        'name': 'Qwen2.5 3B — balanced (~2 GB)',
        'file': 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
        'approx_mb': 2000,
    },
    'qwen2.5-7b-instruct-q4': {
        'name': 'Qwen2.5 7B — high accuracy (~4.7 GB)',
        'file': 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
        'approx_mb': 4700,
    },
    'qwen2.5-7b-instruct-q5': {
        'name': 'Qwen2.5 7B — higher precision Q5 (~5.4 GB)',
        'file': 'Qwen2.5-7B-Instruct-Q5_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q5_K_M.gguf',
        'approx_mb': 5400,
    },
    'qwen2.5-14b-instruct-q4': {
        'name': 'Qwen2.5 14B — most accurate (~9 GB)',
        'file': 'Qwen2.5-14B-Instruct-Q4_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
        'approx_mb': 9000,
    },
}
DEFAULT_MODEL = 'qwen2.5-3b-instruct-q4'


class ChatLLM:
    def __init__(self):
        self.cancel_event = threading.Event()
        self._llm = None
        self._loaded_model_id = None
        # llama.cpp contexts are not safe to load/use concurrently. This also
        # prevents a model switch from freeing a context mid-generation.
        self._lock = threading.RLock()
        self._download_lock = threading.Lock()
        self._download_response_lock = threading.Lock()
        self._active_download_response = None

    def cancel(self):
        self.cancel_event.set()
        with self._download_response_lock:
            response = self._active_download_response
        if response is not None:
            try:
                response.close()
            except OSError:
                pass

    def reset_cancel(self):
        self.cancel_event.clear()

    def model_path(self, model_id):
        m = MODELS.get(model_id)
        if not m:
            return None
        return os.path.join(_models_dir(), m['file'])

    def is_downloaded(self, model_id):
        model_info = MODELS.get(model_id)
        p = self.model_path(model_id)
        if not model_info or not p or not os.path.isfile(p):
            return False
        try:
            # Every valid GGUF starts with this four-byte magic. Checking it is
            # cheap and avoids treating an HTML error page or stale partial as
            # an installed model.
            minimum_size = int(model_info.get('approx_mb', 0) * 1_000_000 * 0.65)
            if minimum_size and os.path.getsize(p) < minimum_size:
                return False
            with open(p, 'rb') as model_file:
                return model_file.read(4) == b'GGUF'
        except OSError:
            return False

    def list_models(self):
        return [
            {
                'id': mid,
                'name': m['name'],
                'approx_mb': m['approx_mb'],
                'downloaded': self.is_downloaded(mid),
            }
            for mid, m in MODELS.items()
        ]

    def download(self, model_id, progress_cb=None):
        """Stream the GGUF to <models>/<file>.part, then atomically rename.
        Honours cancel_event between chunks so a cancel leaves no full file."""
        m = MODELS.get(model_id)
        if not m:
            raise ValueError(f'Unknown model: {model_id}')
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

    def ensure_loaded(self, model_id, status_cb=None):
        """Load the model into memory (cached). Loading a fresh model frees the
        previous one first — only one model lives in RAM at a time."""
        if not _available:
            raise RuntimeError(
                'The chat engine (llama-cpp-python) is not installed in this '
                'build. Reinstall the app or run the Python setup again.'
            )
        with self._lock:
            if self._llm is not None and self._loaded_model_id == model_id:
                return
            path = self.model_path(model_id)
            if not path:
                raise ValueError(f'Unknown model: {model_id}')
            if not self.is_downloaded(model_id):
                raise RuntimeError('Model has not been downloaded yet.')

            if status_cb:
                status_cb('Loading model into memory...')

            from llama_cpp import Llama

            # Drop the old model first so we don't briefly hold two in RAM.
            self._llm = None
            self._loaded_model_id = None

            n_threads = max(1, (os.cpu_count() or 4) - 1)
            self._llm = Llama(
                model_path=path,
                n_ctx=4096,
                n_threads=n_threads,
                n_gpu_layers=0,   # CPU-only: one bundle works on every machine
                verbose=False,
            )
            self._loaded_model_id = model_id

    def chat_stream(self, messages, on_token, max_tokens=512, temperature=0.7,
                    top_p=0.95, top_k=40, repeat_penalty=1.1, min_p=0.05):
        """Stream the assistant reply token-by-token via on_token(text).
        Uses the chat template embedded in the GGUF metadata. Stops early when
        cancel_event is set.

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
            # while this worker is waiting for the context lock. Do not enter
            # llama.cpp at all when the request is already stale.
            if self.cancel_event.is_set():
                return
            if self._llm is None:
                raise RuntimeError('Model not loaded.')

            stream = self._llm.create_chat_completion(
                messages=messages,
                stream=True,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                repeat_penalty=repeat_penalty,
                min_p=min_p,
            )
            try:
                for chunk in stream:
                    if self.cancel_event.is_set():
                        break
                    if not isinstance(chunk, dict):
                        continue
                    choices = chunk.get('choices') or []
                    if not choices or not isinstance(choices[0], dict):
                        continue
                    delta = choices[0].get('delta') or {}
                    text = delta.get('content') if isinstance(delta, dict) else None
                    if text:
                        on_token(text)
            finally:
                close = getattr(stream, 'close', None)
                if close:
                    try:
                        close()
                    except Exception:
                        pass
