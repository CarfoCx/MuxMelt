"""Local LLM chat backed by llama-cpp-python (GGUF models).

No external API: inference runs entirely on the user's machine. The inference
engine (llama-cpp-python) is bundled with the app, but the model weights are
downloaded once on first use into the per-user data dir and reused offline
afterwards. llama_cpp is a heavy import, so — like rembg/demucs — it is probed
with find_spec and only imported when a model is actually loaded.
"""

import os
import threading
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


# Downloadable GGUF chat models. All Apache-2.0 licensed (safe to use offline
# and to redistribute the weights you download). To add one, drop another entry
# here and it shows up in the picker automatically.
MODELS = {
    'qwen2.5-1.5b-instruct-q4': {
        'name': 'Qwen2.5 1.5B Instruct — fast (~1 GB)',
        'file': 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
        'approx_mb': 1100,
    },
    'qwen2.5-3b-instruct-q4': {
        'name': 'Qwen2.5 3B Instruct — balanced (~2 GB)',
        'file': 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
        'url': 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
        'approx_mb': 2000,
    },
}
DEFAULT_MODEL = 'qwen2.5-3b-instruct-q4'


class ChatLLM:
    def __init__(self):
        self.cancel_event = threading.Event()
        self._llm = None
        self._loaded_model_id = None
        self._lock = threading.Lock()

    def cancel(self):
        self.cancel_event.set()

    def reset_cancel(self):
        self.cancel_event.clear()

    def model_path(self, model_id):
        m = MODELS.get(model_id)
        if not m:
            return None
        return os.path.join(_models_dir(), m['file'])

    def is_downloaded(self, model_id):
        p = self.model_path(model_id)
        return bool(p and os.path.isfile(p) and os.path.getsize(p) > 0)

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
        dest = self.model_path(model_id)
        if self.is_downloaded(model_id):
            return dest

        tmp = dest + '.part'
        req = urllib.request.Request(m['url'], headers={'User-Agent': 'MuxMelt'})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                total = int(resp.headers.get('Content-Length') or 0)
                done = 0
                chunk_size = 1024 * 256
                with open(tmp, 'wb') as f:
                    while True:
                        if self.cancel_event.is_set():
                            raise RuntimeError('Cancelled')
                        buf = resp.read(chunk_size)
                        if not buf:
                            break
                        f.write(buf)
                        done += len(buf)
                        if progress_cb:
                            progress_cb(done / total if total else 0.0, done, total)
            os.replace(tmp, dest)
            return dest
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            raise

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
            if not path or not os.path.isfile(path):
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

    def chat_stream(self, messages, on_token, max_tokens=512, temperature=0.7):
        """Stream the assistant reply token-by-token via on_token(text).
        Uses the chat template embedded in the GGUF metadata. Stops early when
        cancel_event is set."""
        if self._llm is None:
            raise RuntimeError('Model not loaded.')

        stream = self._llm.create_chat_completion(
            messages=messages,
            stream=True,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        for chunk in stream:
            if self.cancel_event.is_set():
                break
            choices = chunk.get('choices') or [{}]
            delta = choices[0].get('delta', {}) or {}
            text = delta.get('content')
            if text:
                on_token(text)
