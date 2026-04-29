import os
import threading
import tempfile
import shutil
from pathlib import Path

try:
    import demucs.api
    _available = True
except ImportError:
    _available = False


def is_available():
    return _available


class StemSeparator:
    def __init__(self):
        self.cancel_event = threading.Event()
        self._separator = None

    def cancel(self):
        self.cancel_event.set()

    def reset_cancel(self):
        self.cancel_event.clear()

    def separate(self, input_path, output_dir, model='htdemucs', stems=None,
                 progress_callback=None):
        """
        Separate an audio/video file into stems.

        Args:
            input_path: Path to audio/video file
            output_dir: Where to save stem files
            model: Demucs model name (htdemucs, htdemucs_ft, mdx_extra)
            stems: List of stems to export (None = all). Options: vocals, drums, bass, other
            progress_callback: fn(pct, status)
        Returns:
            dict with stem names mapped to output file paths
        """
        if not _available:
            raise RuntimeError(
                'demucs is not installed. Run: pip install demucs'
            )

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            progress_callback(0.05, 'Loading separation model...')

        # Initialize separator on first use (or if model changed)
        if self._separator is None or getattr(self._separator, 'model_name', None) != model:
            try:
                self._separator = demucs.api.Separator(model=model)
            except Exception as e:
                raise RuntimeError(f'Failed to load model "{model}": {e}')

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            progress_callback(0.1, 'Separating audio stems...')

        # Run separation
        try:
            origin, separated = self._separator.separate_audio_file(input_path)
        except Exception as e:
            raise RuntimeError(f'Separation failed: {e}')

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            progress_callback(0.85, 'Saving stems...')

        # Determine which stems to save
        available_stems = list(separated.keys())
        if stems:
            save_stems = [s for s in stems if s in available_stems]
        else:
            save_stems = available_stems

        if not save_stems:
            raise RuntimeError(f'No matching stems found. Available: {available_stems}')

        # Save each stem
        os.makedirs(output_dir, exist_ok=True)
        base_name = Path(input_path).stem
        outputs = {}

        for i, stem_name in enumerate(save_stems):
            if self.cancel_event.is_set():
                raise RuntimeError('Cancelled')

            stem_tensor = separated[stem_name]
            output_path = os.path.join(output_dir, f'{base_name}_{stem_name}.wav')

            # Use demucs save utility
            from demucs.api import save_audio
            save_audio(stem_tensor, output_path, samplerate=self._separator.samplerate)

            outputs[stem_name] = output_path

            if progress_callback:
                pct = 0.85 + (0.15 * (i + 1) / len(save_stems))
                progress_callback(pct, f'Saved {stem_name} stem')

        return outputs
