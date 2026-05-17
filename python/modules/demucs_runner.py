import sys
import wave

import torch
import torchaudio


def _save_wav(path, src, sample_rate, bits_per_sample=16, encoding=None, **_kwargs):
    """Fallback WAV writer for packaged torchaudio builds without audio backends."""
    wav = src.detach().cpu()
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)

    if bits_per_sample == 32 and encoding == 'PCM_F':
        data = wav.transpose(0, 1).contiguous().numpy().astype('<f4')
        sample_width = 4
    elif bits_per_sample == 24:
        clipped = wav.clamp(-1, 1)
        ints = (clipped * 8388607.0).round().to(torch.int32).transpose(0, 1).contiguous().numpy()
        data = bytearray()
        for value in ints.reshape(-1):
            data.extend(int(value).to_bytes(4, 'little', signed=True)[:3])
        sample_width = 3
    else:
        clipped = wav.clamp(-1, 1)
        data = (clipped * 32767.0).round().to(torch.int16).transpose(0, 1).contiguous().numpy()
        sample_width = 2

    with wave.open(str(path), 'wb') as wav_file:
        wav_file.setnchannels(wav.shape[0])
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        if isinstance(data, bytearray):
            wav_file.writeframes(data)
        else:
            wav_file.writeframes(data.tobytes())


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
