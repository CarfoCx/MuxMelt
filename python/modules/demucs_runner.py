import sys
import wave

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


if __name__ == '__main__':
    main(sys.argv[1:])
