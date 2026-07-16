"""Focused, dependency-free checks for tiled upscaler memory behavior.

The production module depends on PyTorch and OpenCV, which are deliberately
not required by the repository's lightweight smoke-test environment.  These
tests execute the real ``TiledInference`` class with controlled tensor mocks.
"""

import ast
import contextlib
import pathlib
import threading
import unittest

import numpy as np


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / 'python' / 'upscaler.py'
MAX_HOST_ASSEMBLY_BYTES = 512 * 1024 * 1024


class AllocationRecorder:
    def __init__(self):
        self.empty_calls = []
        self.device_tile_bytes = []
        self.cpu_transfer_bytes = []
        self.assignments = 0


def _slice_shape(shape, key):
    if not isinstance(key, tuple):
        key = (key,)
    key = key + (slice(None),) * (len(shape) - len(key))
    result = []
    for size, part in zip(shape, key):
        if isinstance(part, int):
            continue
        start, stop, step = part.indices(size)
        result.append(max(0, (stop - start + step - 1) // step))
    return tuple(result)


class ShapeTensor:
    """Shape-only tensor used to simulate outputs that would be multi-GB."""

    def __init__(self, shape, recorder, device='cuda', dtype=np.float16,
                 is_canvas=False):
        self.shape = tuple(shape)
        self.recorder = recorder
        self.device = device
        self.dtype = np.dtype(dtype)
        self.is_canvas = is_canvas

    def __getitem__(self, key):
        return ShapeTensor(
            _slice_shape(self.shape, key), self.recorder, self.device,
            self.dtype, self.is_canvas,
        )

    def __setitem__(self, key, value):
        expected = _slice_shape(self.shape, key)
        if expected != value.shape:
            raise AssertionError(f'assignment mismatch: {expected} != {value.shape}')
        if self.device != 'cpu' or value.device != 'cpu':
            raise AssertionError('full-frame assembly or assignment used an accelerator')
        self.recorder.assignments += 1

    def detach(self):
        return self

    def to(self, device=None, dtype=None, **_kwargs):
        target_device = device or self.device
        target_dtype = np.dtype(dtype or self.dtype)
        if self.device != 'cpu' and target_device == 'cpu':
            self.recorder.cpu_transfer_bytes.append(
                int(np.prod(self.shape)) * target_dtype.itemsize
            )
        return ShapeTensor(
            self.shape, self.recorder, target_device, target_dtype,
            self.is_canvas,
        )


class DenseTensor(ShapeTensor):
    def __init__(self, array, recorder, device='cuda'):
        self.array = np.asarray(array)
        super().__init__(self.array.shape, recorder, device, self.array.dtype)

    def __getitem__(self, key):
        return DenseTensor(self.array[key], self.recorder, self.device)

    def __setitem__(self, key, value):
        if self.device != 'cpu' or value.device != 'cpu':
            raise AssertionError('full-frame assembly or assignment used an accelerator')
        self.array[key] = value.array
        self.recorder.assignments += 1

    def to(self, device=None, dtype=None, **_kwargs):
        target_device = device or self.device
        target_dtype = np.dtype(dtype or self.dtype)
        if self.device != 'cpu' and target_device == 'cpu':
            self.recorder.cpu_transfer_bytes.append(
                self.array.size * target_dtype.itemsize
            )
        return DenseTensor(
            self.array.astype(target_dtype, copy=True),
            self.recorder,
            target_device,
        )


class FakeTorch:
    float32 = np.dtype(np.float32)

    def __init__(self, recorder, dense=False):
        self.recorder = recorder
        self.dense = dense

    @staticmethod
    def no_grad():
        return contextlib.nullcontext()

    def empty(self, shape, device=None, dtype=None):
        dtype = np.dtype(dtype)
        self.recorder.empty_calls.append((tuple(shape), device, dtype))
        if device != 'cpu':
            raise AssertionError('the full output canvas was allocated on an accelerator')
        if self.dense:
            return DenseTensor(np.empty(shape, dtype=dtype), self.recorder, device)
        return ShapeTensor(shape, self.recorder, device, dtype, is_canvas=True)


def _load_tiled_inference(fake_torch):
    tree = ast.parse(SOURCE_PATH.read_text(encoding='utf-8'), SOURCE_PATH)
    selected = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name in {
            'CancellationError', 'TiledInference'
        }:
            selected.append(node)
    module = ast.Module(body=selected, type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {
        'torch': fake_torch,
        'np': np,
        # Only ``_tile_process`` and cancellation checks are exercised here.
        'F': None,
    }
    exec(compile(module, SOURCE_PATH, 'exec'), namespace)
    return namespace['TiledInference'], namespace['CancellationError']


def _load_upscaler_class():
    tree = ast.parse(SOURCE_PATH.read_text(encoding='utf-8'), SOURCE_PATH)
    selected = [
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == 'Upscaler'
    ]
    module = ast.Module(body=selected, type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {'MAX_HOST_ASSEMBLY_BYTES': MAX_HOST_ASSEMBLY_BYTES}
    exec(compile(module, SOURCE_PATH, 'exec'), namespace)
    return namespace['Upscaler']


def _make_engine(fake_torch, tile=3, tile_pad=1):
    inference_class, cancellation_error = _load_tiled_inference(fake_torch)
    engine = object.__new__(inference_class)
    engine.scale = 4
    engine._net_scale = 4
    engine.device = 'cuda'
    engine.tile = tile
    engine.tile_pad = tile_pad
    engine.cancel_event = threading.Event()
    return engine, cancellation_error


class TiledMemoryTests(unittest.TestCase):
    def test_scale_aware_admission_rejects_multi_gigabyte_host_canvases(self):
        upscaler_class = _load_upscaler_class()
        upscaler = object.__new__(upscaler_class)
        upscaler.device = 'cuda'
        upscaler._vram_total = 24 * 1024 ** 3

        max_x4_input = upscaler._get_max_pixels(4)
        estimated_canvas = max_x4_input * 4 * 4 * 3 * 4
        self.assertLessEqual(estimated_canvas, MAX_HOST_ASSEMBLY_BYTES)
        self.assertGreaterEqual(max_x4_input, 1920 * 1080)
        self.assertLess(max_x4_input, 50_000_000)
        self.assertLessEqual(
            upscaler._get_max_pixels(2) * 2 * 2 * 3 * 4,
            MAX_HOST_ASSEMBLY_BYTES,
        )

    def test_x4_large_canvas_is_cpu_only_and_device_work_is_tile_bounded(self):
        recorder = AllocationRecorder()
        fake_torch = FakeTorch(recorder)
        engine, _ = _make_engine(fake_torch, tile=512, tile_pad=10)

        # 12,500 x 4,000 = 50 MP.  Its float32 x4 output is 9.6 GB.
        image = ShapeTensor((1, 3, 4_000, 12_500), recorder, 'cuda', np.float16)

        def run_model(tile):
            shape = (
                tile.shape[0], tile.shape[1],
                tile.shape[2] * 4, tile.shape[3] * 4,
            )
            recorder.device_tile_bytes.append(
                int(np.prod(shape)) * np.dtype(np.float16).itemsize
            )
            return ShapeTensor(shape, recorder, 'cuda', np.float16)

        engine._run_model = run_model
        progress = []
        output = engine._tile_process(image, progress.append)

        full_bytes = 1 * 3 * 16_000 * 50_000 * 4
        self.assertEqual(full_bytes, 9_600_000_000)
        self.assertEqual(output.shape, (1, 3, 16_000, 50_000))
        self.assertEqual(output.device, 'cpu')
        self.assertEqual(recorder.empty_calls[0][1], 'cpu')
        self.assertLess(max(recorder.device_tile_bytes), 64 * 1024 * 1024)
        self.assertLess(max(recorder.cpu_transfer_bytes), 128 * 1024 * 1024)
        self.assertEqual(recorder.assignments, len(progress))
        self.assertEqual(progress[-1], 1.0)

    def test_tiled_assembly_preserves_x4_pixels_and_progress(self):
        recorder = AllocationRecorder()
        fake_torch = FakeTorch(recorder, dense=True)
        engine, _ = _make_engine(fake_torch, tile=3, tile_pad=1)
        values = np.arange(1 * 3 * 5 * 7, dtype=np.float16).reshape(1, 3, 5, 7)
        image = DenseTensor(values, recorder, 'cuda')

        engine._run_model = lambda tile: DenseTensor(
            np.repeat(np.repeat(tile.array, 4, axis=2), 4, axis=3),
            recorder,
            'cuda',
        )
        progress = []
        output = engine._tile_process(image, progress.append)
        expected = np.repeat(np.repeat(values, 4, axis=2), 4, axis=3).astype(np.float32)

        np.testing.assert_array_equal(output.array, expected)
        self.assertEqual(output.device, 'cpu')
        self.assertEqual(progress, [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1.0])

    def test_cancellation_after_forward_skips_transfer_and_assignment(self):
        recorder = AllocationRecorder()
        fake_torch = FakeTorch(recorder, dense=True)
        engine, cancellation_error = _make_engine(fake_torch)
        image = DenseTensor(np.ones((1, 3, 4, 4), dtype=np.float16), recorder, 'cuda')

        def cancel_during_forward(tile):
            engine.cancel_event.set()
            return DenseTensor(
                np.repeat(np.repeat(tile.array, 4, axis=2), 4, axis=3),
                recorder,
                'cuda',
            )

        engine._run_model = cancel_during_forward
        progress = []
        with self.assertRaises(cancellation_error):
            engine._tile_process(image, progress.append)

        self.assertEqual(recorder.cpu_transfer_bytes, [])
        self.assertEqual(recorder.assignments, 0)
        self.assertEqual(progress, [])


if __name__ == '__main__':
    unittest.main()
