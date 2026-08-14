import hashlib
import hmac
import os
import re
import socket
import sys
import tempfile
import time
import wave
from pathlib import Path
from urllib.parse import urlparse
import urllib.request

# This file runs in a fresh interpreter. Install the same fail-closed guard as
# the FastAPI parent before importing Torch/Demucs, which may otherwise fetch
# model weights implicitly.
_PYTHON_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)
from offline_guard import install_if_requested

install_if_requested()

import numpy as np
import torch
import torchaudio


def _save_wav(path, src, sample_rate, bits_per_sample=16, encoding=None, **_kwargs):
    """Fallback WAV writer for packaged torchaudio builds without audio backends."""
    wav = src.detach().cpu()
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    if wav.ndim != 2 or wav.shape[0] <= 0 or wav.shape[1] <= 0:
        raise ValueError(f'Expected non-empty [channels, samples] audio, got {tuple(wav.shape)}')
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError(f'Invalid sample rate: {sample_rate}')
    wav = torch.nan_to_num(wav, nan=0.0, posinf=1.0, neginf=-1.0)

    if bits_per_sample == 32 and encoding == 'PCM_F':
        data = wav.transpose(0, 1).contiguous().numpy().astype('<f4')
        sample_width = 4
    elif bits_per_sample == 32:
        clipped = wav.clamp(-1, 1)
        data = (clipped * 2147483647.0).round().to(torch.int32).transpose(0, 1).contiguous().numpy()
        sample_width = 4
    elif bits_per_sample == 24:
        clipped = wav.clamp(-1, 1)
        ints = (clipped * 8388607.0).round().to(torch.int32).transpose(0, 1).contiguous().numpy()
        # Vectorized little-endian 24-bit packing. The prior Python loop scaled
        # poorly to millions of samples and could dominate export time.
        bytes_4 = ints.astype('<i4', copy=False).reshape(-1).view(np.uint8).reshape(-1, 4)
        data = bytes_4[:, :3].copy().tobytes()
        sample_width = 3
    elif bits_per_sample in (None, 16):
        clipped = wav.clamp(-1, 1)
        data = (clipped * 32767.0).round().to(torch.int16).transpose(0, 1).contiguous().numpy()
        sample_width = 2
    else:
        raise ValueError(f'Unsupported WAV bit depth: {bits_per_sample}')

    with wave.open(str(path), 'wb') as wav_file:
        wav_file.setnchannels(wav.shape[0])
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(data if isinstance(data, bytes) else data.tobytes())


def _patched_save(uri, src, sample_rate, format=None, encoding=None, bits_per_sample=None, **kwargs):
    suffix = str(uri).lower().rsplit('.', 1)[-1]
    if suffix == 'wav':
        _save_wav(uri, src, sample_rate, bits_per_sample or 16, encoding, **kwargs)
        return
    raise RuntimeError(f'Only WAV output is supported by the bundled Demucs writer: {uri}')


torchaudio.save = _patched_save

from demucs.separate import main


_PINNED_MODELS = {
    '955717e8': ('hybrid_transformer/955717e8-8726e21a.th', 84_141_911,
                 '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4'),
    'f7e0c4bc': ('hybrid_transformer/f7e0c4bc-ba3fe64a.th', 84_141_271,
                 'ba3fe64ae8ef66ac9a4857222ce48efbdc5eb3ad375cb79dd13debee5aaa4066'),
    'd12395a8': ('hybrid_transformer/d12395a8-e57c48e6.th', 84_141_271,
                 'e57c48e6b0e38af4f7118d7bd08c49f0a0c0edf7d09143bdd902ea0d237303e6'),
    '92cfc3b6': ('hybrid_transformer/92cfc3b6-ef3bcb9c.th', 84_141_271,
                 'ef3bcb9c8b40d14ae5d51b6db2587339cc12c6b77c0be151ce6d69002e087bf2'),
    '04573f0d': ('hybrid_transformer/04573f0d-f3cf25b2.th', 84_141_271,
                 'f3cf25b222c4eed7cd49dd8b2c9597d50c18bd154090f7b919cfa5f93cf22c49'),
    'e51eebcc': ('mdx_final/e51eebcc-c1b80bdd.th', 167_399_275,
                 'c1b80bdd6de58274abf359e66822a76f49ce2b9f086fc5dc917ac14598e6bebf'),
    'a1d90b5c': ('mdx_final/a1d90b5c-ae9d2452.th', 167_391_595,
                 'ae9d245283bf24b552913ee233a1101dcd0aeaed59b1c0a2da0e1f6eda15101b'),
    '5d2d6c55': ('mdx_final/5d2d6c55-db83574e.th', 167_391_595,
                 'db83574e05b2308f76e2764819da673f2d16d437b9e619f5fcb72f275fc0e24f'),
    'cfa93e08': ('mdx_final/cfa93e08-61801ae1.th', 167_399_275,
                 '61801ae1567d606c97a9c3469e943ae306d0a873eeb60d623ae7cfc7042b3f68'),
}
_PINNED_BAGS = {
    'htdemucs': ('955717e8',),
    'htdemucs_ft': ('f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d'),
    'mdx_extra': ('e51eebcc', 'a1d90b5c', '5d2d6c55', 'cfa93e08'),
}
_MODEL_ROOT = 'https://dl.fbaipublicfiles.com/demucs/'


def _offline_mode_enabled():
    return os.environ.get('MUXMELT_OFFLINE', '').strip().lower() in {
        '1', 'true', 'yes', 'on',
    }


def _sha256_matches(path, expected):
    digest = hashlib.sha256()
    try:
        with open(path, 'rb') as checkpoint:
            for chunk in iter(lambda: checkpoint.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError:
        return False
    return hmac.compare_digest(digest.hexdigest(), expected)


class _RejectModelRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Demucs model download used an unexpected redirect')


def _download_pinned_checkpoint(url, target, expected_size, expected_sha256):
    request = urllib.request.Request(url, headers={'User-Agent': 'MuxMelt/1.3'})
    response = None
    temp_path = None
    try:
        response = urllib.request.build_opener(
            _RejectModelRedirects(),
        ).open(request, timeout=10)
        if response.geturl() != url:
            raise RuntimeError('Demucs model download used an unexpected URL')
        declared = int(response.headers.get('Content-Length') or 0)
        if declared and declared != expected_size:
            raise RuntimeError('Demucs model download has an unexpected size')
        digest = hashlib.sha256()
        downloaded = 0
        last_data_at = time.monotonic()
        with tempfile.NamedTemporaryFile(
            mode='wb', prefix=target.name + '.', suffix='.part',
            dir=target.parent, delete=False,
        ) as output:
            temp_path = output.name
            while True:
                try:
                    chunk = response.read(256 * 1024)
                except (TimeoutError, socket.timeout) as exc:
                    if time.monotonic() - last_data_at >= 60:
                        raise RuntimeError('Demucs model download stalled') from exc
                    continue
                if not chunk:
                    break
                last_data_at = time.monotonic()
                downloaded += len(chunk)
                if downloaded > expected_size:
                    raise RuntimeError('Demucs model download exceeded its size limit')
                output.write(chunk)
                digest.update(chunk)
                print(f'Downloading {target.name}... {downloaded / expected_size * 100:.0f}%', flush=True)
        if downloaded != expected_size:
            raise RuntimeError('Demucs model download was incomplete')
        if not hmac.compare_digest(digest.hexdigest(), expected_sha256):
            raise RuntimeError('Demucs model failed its SHA-256 integrity check')
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if response is not None:
            try:
                response.close()
            except OSError:
                pass
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _prepare_pinned_model(argv):
    model_name = _requested_model(argv)
    signatures = _PINNED_BAGS.get(model_name)
    if signatures is None:
        raise RuntimeError(f'Unsupported Demucs model: {model_name}')
    cache_dir = Path(torch.hub.get_dir()) / 'checkpoints'
    cache_dir.mkdir(parents=True, exist_ok=True)
    for signature in signatures:
        relative_url, expected_size, expected_sha256 = _PINNED_MODELS[signature]
        target = cache_dir / Path(relative_url).name
        if (target.is_file() and target.stat().st_size == expected_size
                and _sha256_matches(target, expected_sha256)):
            continue
        if _offline_mode_enabled():
            raise RuntimeError(
                f'Demucs model {model_name!r} is not installed or its cached '
                'weights failed SHA-256 verification. Disable Offline Mode and '
                'run Stem Separator once to download it, then re-enable Offline Mode.'
            )
        _download_pinned_checkpoint(
            _MODEL_ROOT + relative_url, target, expected_size, expected_sha256,
        )


def _install_pinned_legacy_loader():
    """Avoid Demucs 4.1's moving Hugging Face lookup for curated UI models."""
    import demucs.api
    from demucs.pretrained import REMOTE_ROOT, _parse_remote_files
    from demucs.repo import AnyModelRepo, BagOnlyRepo, RemoteRepo

    def load_model(name, repo=None):
        if repo is not None or name not in _PINNED_BAGS:
            raise RuntimeError(f'Unsupported Demucs model source: {name}')
        urls = _parse_remote_files(REMOTE_ROOT / 'files.txt')
        for signature in _PINNED_BAGS[name]:
            expected_url = _MODEL_ROOT + _PINNED_MODELS[signature][0]
            if urls.get(signature) != expected_url:
                raise RuntimeError('Installed Demucs catalog does not match MuxMelt pins')
        model_repo = RemoteRepo(urls)
        model = AnyModelRepo(
            model_repo, BagOnlyRepo(REMOTE_ROOT, model_repo),
        ).get_model(name)
        model.eval()
        return model

    demucs.api.get_model = load_model


_CHECKPOINT_HASH_RE = re.compile(
    r'-([0-9a-f]{8,64})(?=\.[^.]+$)', re.IGNORECASE
)


def _checkpoint_hash_prefix(filename):
    """Extract the SHA-256 prefix embedded in an official checkpoint name."""
    match = _CHECKPOINT_HASH_RE.search(filename or '')
    return match.group(1).lower() if match else None


def _sha256_matches_prefix(path, expected_prefix):
    if not expected_prefix:
        return False
    digest = hashlib.sha256()
    try:
        with open(path, 'rb') as checkpoint:
            for chunk in iter(lambda: checkpoint.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError:
        return False
    return digest.hexdigest().startswith(expected_prefix.lower())


def _requested_model(argv):
    for flag in ('-n', '--name'):
        if flag in argv:
            index = argv.index(flag)
            if index + 1 < len(argv):
                return argv[index + 1]
    return 'htdemucs'


def _require_cached_model_when_offline(argv):
    if not _offline_mode_enabled():
        return
    import yaml
    from demucs.pretrained import REMOTE_ROOT, _parse_remote_files

    model_name = _requested_model(argv)
    model_urls = _parse_remote_files(REMOTE_ROOT / 'files.txt')
    bag_path = REMOTE_ROOT / f'{model_name}.yaml'
    signatures = [model_name]
    if bag_path.is_file():
        bag = yaml.safe_load(bag_path.read_text(encoding='utf-8')) or {}
        bag_models = bag.get('models') if isinstance(bag, dict) else None
        signatures = list(bag_models) if isinstance(bag_models, list) else []
    cache_dir = Path(torch.hub.get_dir()) / 'checkpoints'
    unusable = [] if signatures else [model_name]
    for signature in signatures:
        if not isinstance(signature, str) or not signature:
            unusable.append(repr(signature))
            continue
        url = model_urls.get(signature)
        filename = Path(urlparse(url).path).name if url else ''
        expected_prefix = _checkpoint_hash_prefix(filename)
        checkpoint = cache_dir / filename if filename else None
        if (checkpoint is None or not checkpoint.is_file()
                or expected_prefix is None
                or not _sha256_matches_prefix(checkpoint, expected_prefix)):
            unusable.append(signature)
    if unusable:
        raise RuntimeError(
            f'Demucs model {model_name!r} is not installed or its cached weights '
            'failed SHA-256 verification. Disable Offline Mode and run Stem '
            'Separator once to download it, then re-enable Offline Mode.'
        )


if __name__ == '__main__':
    _prepare_pinned_model(sys.argv[1:])
    _install_pinned_legacy_loader()
    main(sys.argv[1:])
