import os
import queue
import re
import subprocess
import sys
import threading
import tempfile
import shutil
from collections import deque
from pathlib import Path
from importlib.util import find_spec

try:
    _available = (
        find_spec('demucs') is not None
        and find_spec('demucs.separate') is not None
    )
except (ImportError, AttributeError, ValueError):
    _available = False
SUPPORTED_MODELS = {'htdemucs', 'htdemucs_ft', 'mdx_extra'}
SUPPORTED_STEMS = {'vocals', 'drums', 'bass', 'other'}


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

        if not isinstance(input_path, str) or not os.path.isfile(input_path):
            raise FileNotFoundError(f'Input media not found: {input_path}')
        if not isinstance(output_dir, str) or not output_dir:
            raise ValueError('Output directory is required')
        if not os.path.isabs(output_dir):
            raise ValueError('Output directory must be absolute')
        if model not in SUPPORTED_MODELS:
            raise ValueError(f'Unsupported Demucs model: {model}')
        if stems is not None:
            if not isinstance(stems, (list, tuple)):
                raise ValueError('Stems must be a list')
            if not stems:
                raise ValueError('At least one stem must be selected')
            invalid_stems = [stem for stem in stems if stem not in SUPPORTED_STEMS]
            if invalid_stems:
                raise ValueError(f'Unsupported stems: {", ".join(map(str, invalid_stems))}')
            # Preserve UI order but avoid trying to move the same result twice.
            stems = list(dict.fromkeys(stems))

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            progress_callback(0.05, 'Loading separation model...')

        os.makedirs(output_dir, exist_ok=True)
        base_name = Path(input_path).stem
        outputs = {}
        temp_dir = tempfile.mkdtemp(prefix='muxmelt-demucs-')
        process = None
        reader_thread = None

        try:
            runner_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'demucs_runner.py')
            cmd = [
                sys.executable,
                runner_path,
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

            q = queue.Queue()

            def read_stdout(stream, q):
                for line in iter(stream.readline, ''):
                    q.put(line)
                stream.close()

            reader_thread = threading.Thread(
                target=read_stdout, args=(process.stdout, q), daemon=True
            )
            reader_thread.start()

            output_lines = deque(maxlen=50)
            while True:
                if self.cancel_event.is_set():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    raise RuntimeError('Cancelled')

                try:
                    line = q.get(timeout=0.1)
                    line_str = line.strip()
                    if line_str:
                        output_lines.append(line_str)
                        match = re.search(r'(\d+)%', line_str)
                        if match and progress_callback:
                            pct = min(100, max(0, int(match.group(1))))
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

            if reader_thread:
                reader_thread.join(timeout=2)

            if process.returncode != 0:
                details = '\n'.join(list(output_lines)[-12:]).strip()
                raise RuntimeError(f'Separation failed with Demucs exit code {process.returncode}: {details}')

            if self.cancel_event.is_set():
                raise RuntimeError('Cancelled')

            if progress_callback:
                progress_callback(0.85, 'Saving stems...')

            demucs_output_dir = Path(temp_dir, model)
            prefix = f'{base_name}_'
            available = {}
            if demucs_output_dir.is_dir():
                for path in demucs_output_dir.iterdir():
                    if (path.is_file() and path.stat().st_size > 0
                            and path.suffix.lower() == '.wav'
                            and path.stem.startswith(prefix)):
                        available[path.stem[len(prefix):]] = str(path)
            save_stems = [s for s in (stems or available.keys()) if s in available]

            if not save_stems:
                raise RuntimeError(f'No matching stems found. Available: {list(available.keys())}')

            for i, stem_name in enumerate(save_stems):
                if self.cancel_event.is_set():
                    raise RuntimeError('Cancelled')

                base_output = f'{base_name}_{stem_name}.wav'
                output_path = os.path.join(output_dir, base_output)
                counter = 1
                while os.path.exists(output_path):
                    output_path = os.path.join(output_dir, f'{base_name}_{stem_name}_{counter}.wav')
                    counter += 1
                shutil.move(available[stem_name], output_path)
                outputs[stem_name] = output_path

                if progress_callback:
                    pct = 0.85 + (0.15 * (i + 1) / len(save_stems))
                    progress_callback(pct, f'Saved {stem_name} stem')

        except Exception:
            # A cancelled/failed job must not leave a subset of stems looking
            # like a successful export.
            for output_path in outputs.values():
                try:
                    os.remove(output_path)
                except OSError:
                    pass
            raise
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if reader_thread is not None and reader_thread.is_alive():
                reader_thread.join(timeout=2)
            shutil.rmtree(temp_dir, ignore_errors=True)

        return outputs

    def separate_batch(self, jobs, model='htdemucs', stems=None,
                       progress_callback=None):
        """Separate multiple inputs in as few Demucs model loads as possible.

        ``jobs`` contains ``(input_path, output_dir)`` pairs. Demucs accepts
        multiple tracks in one invocation, so normal batches load the model
        once instead of once per file. Inputs with the same basename are split
        into separate groups because the flat, deterministic output template
        would otherwise make their stems overwrite each other.
        """
        if not _available:
            raise RuntimeError(
                'Demucs is not installed in the app Python environment. Run '
                'the Python setup again.'
            )
        if not isinstance(jobs, (list, tuple)) or not jobs:
            raise ValueError('At least one input file is required')
        if model not in SUPPORTED_MODELS:
            raise ValueError(f'Unsupported Demucs model: {model}')
        if stems is not None:
            if not isinstance(stems, (list, tuple)) or not stems:
                raise ValueError('At least one stem must be selected')
            invalid = [stem for stem in stems if stem not in SUPPORTED_STEMS]
            if invalid:
                raise ValueError(f'Unsupported stems: {", ".join(map(str, invalid))}')
            stems = list(dict.fromkeys(stems))

        normalized = []
        for job in jobs:
            if not isinstance(job, (list, tuple)) or len(job) != 2:
                raise ValueError('Each separation job must contain an input and output directory')
            input_path, output_dir = job
            if not isinstance(input_path, str) or not os.path.isfile(input_path):
                raise FileNotFoundError(f'Input media not found: {input_path}')
            if not isinstance(output_dir, str) or not output_dir:
                raise ValueError('Output directory is required')
            if not os.path.isabs(output_dir):
                raise ValueError('Output directory must be absolute')
            normalized.append((input_path, output_dir, Path(input_path).stem))

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        groups = []
        for job in normalized:
            key = job[2].casefold()
            for group, names in groups:
                if key not in names:
                    group.append(job)
                    names.add(key)
                    break
            else:
                groups.append(([job], {key}))

        results = {}
        published_paths = []
        runner_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), 'demucs_runner.py'
        )

        try:
            for group_number, (group, _names) in enumerate(groups, 1):
                temp_dir = tempfile.mkdtemp(prefix='muxmelt-demucs-')
                process = None
                reader_thread = None
                try:
                    for input_path, _output_dir, _base_name in group:
                        if progress_callback:
                            progress_callback(input_path, 0.05, 'Loading separation model...')

                    cmd = [
                        sys.executable, runner_path,
                        '-n', model,
                        '-o', temp_dir,
                        '--filename', '{track}_{stem}.{ext}',
                        *[job[0] for job in group],
                    ]
                    process = subprocess.Popen(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        encoding='utf-8',
                        errors='replace',
                    )
                    output_queue = queue.Queue()

                    def read_stdout(stream):
                        for line in iter(stream.readline, ''):
                            output_queue.put(line)
                        stream.close()

                    reader_thread = threading.Thread(
                        target=read_stdout, args=(process.stdout,), daemon=True
                    )
                    reader_thread.start()
                    output_lines = deque(maxlen=50)

                    while True:
                        if self.cancel_event.is_set():
                            process.terminate()
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait(timeout=5)
                            raise RuntimeError('Cancelled')
                        try:
                            line = output_queue.get(timeout=0.1).strip()
                            if line:
                                output_lines.append(line)
                                match = re.search(r'(\d+)%', line)
                                if match and progress_callback:
                                    pct = min(100, max(0, int(match.group(1))))
                                    progress = 0.1 + 0.75 * pct / 100.0
                                    for input_path, _out, _base in group:
                                        progress_callback(
                                            input_path, progress,
                                            f'Separating audio stems... {pct}%',
                                        )
                        except queue.Empty:
                            if process.poll() is not None:
                                break

                    reader_thread.join(timeout=2)
                    while not output_queue.empty():
                        line = output_queue.get_nowait().strip()
                        if line:
                            output_lines.append(line)
                    if process.returncode != 0:
                        details = '\n'.join(list(output_lines)[-12:]).strip()
                        raise RuntimeError(
                            f'Separation failed with Demucs exit code '
                            f'{process.returncode}: {details}'
                        )

                    demucs_output_dir = Path(temp_dir, model)
                    for input_path, output_dir, base_name in group:
                        if self.cancel_event.is_set():
                            raise RuntimeError('Cancelled')
                        prefix = f'{base_name}_'
                        available = {}
                        if demucs_output_dir.is_dir():
                            for candidate in demucs_output_dir.iterdir():
                                if (candidate.is_file() and candidate.stat().st_size > 0
                                        and candidate.suffix.lower() == '.wav'
                                        and candidate.stem.startswith(prefix)):
                                    available[candidate.stem[len(prefix):]] = str(candidate)
                        save_stems = [
                            stem for stem in (stems or sorted(available))
                            if stem in available
                        ]
                        if not save_stems:
                            raise RuntimeError(
                                f'No matching stems found for {base_name}. '
                                f'Available: {list(available)}'
                            )

                        os.makedirs(output_dir, exist_ok=True)
                        outputs = {}
                        for index, stem_name in enumerate(save_stems):
                            output_path = os.path.join(
                                output_dir, f'{base_name}_{stem_name}.wav'
                            )
                            counter = 1
                            while os.path.exists(output_path):
                                output_path = os.path.join(
                                    output_dir,
                                    f'{base_name}_{stem_name}_{counter}.wav',
                                )
                                counter += 1
                            shutil.move(available[stem_name], output_path)
                            outputs[stem_name] = output_path
                            published_paths.append(output_path)
                            if progress_callback:
                                progress_callback(
                                    input_path,
                                    0.85 + 0.15 * (index + 1) / len(save_stems),
                                    f'Saved {stem_name} stem',
                                )
                        results[input_path] = outputs
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    if reader_thread is not None and reader_thread.is_alive():
                        reader_thread.join(timeout=2)
                    shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            # Publish the batch atomically from the caller's perspective: if
            # any track fails or is cancelled, do not leave an unreported
            # subset of stems behind.
            for output_path in published_paths:
                try:
                    os.remove(output_path)
                except OSError:
                    pass
            raise

        return results
