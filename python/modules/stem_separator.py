import os
import subprocess
import sys
import threading
import tempfile
import shutil
from pathlib import Path
from importlib.util import find_spec

_available = find_spec('demucs') is not None and find_spec('demucs.separate') is not None


def is_available():
    return _available


class StemSeparator:
    def __init__(self):
        self.cancel_event = threading.Event()

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
                'Demucs is not installed in the app Python environment. Run: python -m pip install demucs'
            )

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            progress_callback(0.05, 'Loading separation model...')

        os.makedirs(output_dir, exist_ok=True)
        base_name = Path(input_path).stem
        outputs = {}
        temp_dir = tempfile.mkdtemp(prefix='muxmelt-demucs-')

        try:
            cmd = [
                sys.executable,
                '-m', 'modules.demucs_runner',
                '-n', model,
                '-o', temp_dir,
                '--filename', '{track}_{stem}.{ext}',
                input_path,
            ]

            if progress_callback:
                progress_callback(0.1, 'Separating audio stems...')

            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
            )

            import queue
            q = queue.Queue()

            def read_stdout(stream, q):
                for line in iter(stream.readline, ''):
                    q.put(line)
                stream.close()

            t = threading.Thread(target=read_stdout, args=(process.stdout, q))
            t.daemon = True
            t.start()

            output_lines = []
            while True:
                if self.cancel_event.is_set():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    raise RuntimeError('Cancelled')

                try:
                    line = q.get(timeout=0.1)
                    line_str = line.strip()
                    if line_str:
                        output_lines.append(line_str)
                        import re
                        match = re.search(r'(\d+)%', line_str)
                        if match and progress_callback:
                            pct = int(match.group(1))
                            overall_pct = 0.1 + (0.75 * pct / 100.0)
                            progress_callback(overall_pct, f'Separating audio stems... {pct}%')
                except queue.Empty:
                    if process.poll() is not None:
                        while not q.empty():
                            try:
                                line = q.get_nowait()
                                line_str = line.strip()
                                if line_str:
                                    output_lines.append(line_str)
                            except queue.Empty:
                                break
                        break

            if process.returncode != 0:
                details = '\n'.join(output_lines[-12:]).strip()
                raise RuntimeError(f'Separation failed with Demucs exit code {process.returncode}: {details}')

            if self.cancel_event.is_set():
                raise RuntimeError('Cancelled')

            if progress_callback:
                progress_callback(0.85, 'Saving stems...')

            demucs_output_dir = os.path.join(temp_dir, model)
            available = {
                p.stem.removeprefix(f'{base_name}_'): str(p)
                for p in Path(demucs_output_dir).glob(f'{base_name}_*.wav')
            }
            save_stems = [s for s in (stems or available.keys()) if s in available]

            if not save_stems:
                raise RuntimeError(f'No matching stems found. Available: {list(available.keys())}')

            for i, stem_name in enumerate(save_stems):
                if self.cancel_event.is_set():
                    raise RuntimeError('Cancelled')

                output_path = os.path.join(output_dir, f'{base_name}_{stem_name}.wav')
                shutil.move(available[stem_name], output_path)
                outputs[stem_name] = output_path

                if progress_callback:
                    pct = 0.85 + (0.15 * (i + 1) / len(save_stems))
                    progress_callback(pct, f'Saved {stem_name} stem')

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        return outputs
