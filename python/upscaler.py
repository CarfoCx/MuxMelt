import os
import json
import cv2
import numpy as np
import subprocess
import socket
import tempfile
import urllib.request
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import torch
import torch.nn as nn
import torch.nn.functional as F

try:
    import pynvml
    pynvml.nvmlInit()
    _nvml_available = True
except Exception:
    _nvml_available = False


# ---------------------------------------------------------------------------
# Model profiles and URLs
# ---------------------------------------------------------------------------

MODEL_PROFILES = {
    'general': {
        2: {
            'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth',
            'num_block': 23,
            'filename': 'RealESRGAN_x2plus.pth',
        },
        4: {
            'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
            'num_block': 23,
            'filename': 'RealESRGAN_x4plus.pth',
        },
    },
    'anime': {
        2: {
            'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth',
            'num_block': 23,
            'filename': 'RealESRGAN_x2plus.pth',
        },
        4: {
            'url': 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth',
            'num_block': 6,
            'filename': 'RealESRGAN_x4plus_anime_6B.pth',
        },
    },
}

BUNDLED_WEIGHTS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'weights'
)
# Kept as a public alias for compatibility with existing tooling/tests.
WEIGHTS_DIR = BUNDLED_WEIGHTS_DIR

# Tiled inference assembles one RGB float32 output frame in host memory before
# converting it to the requested image/video pixel format. Keep that canvas
# below 512 MiB; conversion scratch space can temporarily require multiples of
# it, and larger frames can otherwise exhaust the machine even when GPU tiling
# succeeds. The corresponding *input* limit is derived from the requested
# scale below.
MAX_HOST_ASSEMBLY_BYTES = 512 * 1024 * 1024


def _model_path(filename):
    """Prefer bundled weights; put new downloads in writable user data."""
    bundled_path = os.path.join(BUNDLED_WEIGHTS_DIR, filename)
    if os.path.isfile(bundled_path):
        return bundled_path
    data_dir = os.environ.get('MUXMELT_DATA_DIR')
    if data_dir:
        user_weights = os.path.join(data_dir, 'models', 'upscaler')
        os.makedirs(user_weights, exist_ok=True)
        return os.path.join(user_weights, filename)
    return bundled_path


class CancellationError(Exception):
    """Raised when processing is cancelled by the user."""
    pass


# ---------------------------------------------------------------------------
# RRDBNet architecture (from Real-ESRGAN / BasicSR, bundled here to avoid
# the basicsr build dependency which fails on Python 3.13+)
# ---------------------------------------------------------------------------

class ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat, num_grow_ch=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x):
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, scale=4, num_feat=64, num_block=23, num_grow_ch=32):
        super().__init__()
        self.scale = scale
        if scale == 2:
            num_in_ch = num_in_ch * 4
        elif scale == 1:
            num_in_ch = num_in_ch * 16
        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        if self.scale == 2:
            feat = F.pixel_unshuffle(x, downscale_factor=2)
        elif self.scale == 1:
            feat = F.pixel_unshuffle(x, downscale_factor=4)
        else:
            feat = x
        feat = self.conv_first(feat)
        body_feat = self.conv_body(self.body(feat))
        feat = feat + body_feat
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        out = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


# ---------------------------------------------------------------------------
# Tiled inference engine (handles large images by splitting into tiles)
# ---------------------------------------------------------------------------

class TiledInference:
    def __init__(self, model, scale, device='cuda', half=True, tile=512,
                 tile_pad=10, pre_pad=10, cancel_event=None,
                 eager_fallback_model=None):
        self.scale = scale
        self.device = device
        self.half = half and (device == 'cuda')
        self.tile = tile
        self.tile_pad = tile_pad
        self.pre_pad = pre_pad
        self.cancel_event = cancel_event
        self._eager_fallback_model = eager_fallback_model

        # The actual spatial scale the network produces.
        # x2 model: pixel_unshuffle(2) halves dims, two 2x upsamples → net 2x
        # x4 model: no unshuffle, two 2x upsamples → net 4x
        # x1 model: pixel_unshuffle(4) quarters dims, two 2x upsamples → net 1x
        if scale == 1:
            self._net_scale = 1
        else:
            self._net_scale = scale

        self.model = model.to(device)
        self.model.eval()
        if self.half:
            self.model = self.model.half()
            if self._eager_fallback_model is not None:
                self._eager_fallback_model = self._eager_fallback_model.half()

    def _check_cancelled(self):
        if self.cancel_event and self.cancel_event.is_set():
            raise CancellationError('Processing cancelled by user')

    def _run_model(self, tensor):
        """Run one forward pass, falling back if torch.compile fails lazily.

        ``torch.compile`` does most compilation on the first invocation, not in
        the call to ``torch.compile`` itself. Backends unavailable on a user's
        machine therefore fail here. Keep the eager module so that optional
        acceleration can never make an otherwise-supported GPU unusable.
        """
        try:
            return self.model(tensor)
        except Exception as exc:
            if (self._eager_fallback_model is None
                    or 'out of memory' in str(exc).lower()):
                raise
            print(f'torch.compile runtime failed; using eager inference: {exc}')
            self.model = self._eager_fallback_model.to(self.device)
            self.model.eval()
            if self.half:
                self.model = self.model.half()
            self._eager_fallback_model = None
            return self.model(tensor)

    @staticmethod
    def _pad(tensor, padding):
        """Reflect-pad when legal, otherwise replicate tiny edge images."""
        left, right, top, bottom = padding
        height, width = tensor.shape[-2:]
        can_reflect = (
            left < width and right < width and top < height and bottom < height
        )
        return F.pad(tensor, padding, mode='reflect' if can_reflect else 'replicate')

    def enhance(self, img, outscale=None, progress_callback=None):
        """Upscale a BGR uint8 numpy image. Returns upscaled BGR uint8 numpy image."""
        self._check_cancelled()

        if outscale is None:
            outscale = self.scale
        if (not isinstance(outscale, (int, float)) or isinstance(outscale, bool)
                or not np.isfinite(outscale) or outscale <= 0):
            raise ValueError('Output scale must be a positive number')

        if not isinstance(img, np.ndarray) or img.ndim not in (2, 3):
            raise ValueError('Image data must be a 2D or 3D numpy array')
        if img.dtype not in (np.uint8, np.uint16):
            raise ValueError(f'Unsupported image bit depth: {img.dtype}')

        h, w = img.shape[:2]
        if h <= 0 or w <= 0:
            raise ValueError('Image dimensions must be positive')

        was_grayscale = img.ndim == 2 or (img.ndim == 3 and img.shape[2] == 1)
        if img.ndim == 3 and img.shape[2] not in (1, 3, 4):
            raise ValueError(f'Unsupported image channel count: {img.shape[2]}')
        has_alpha = img.ndim == 3 and img.shape[2] == 4
        if has_alpha:
            alpha = img[:, :, 3]
            img = img[:, :, :3]
        elif was_grayscale:
            gray = img if img.ndim == 2 else img[:, :, 0]
            img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

        value_range = 65535.0 if img.dtype == np.uint16 else 255.0
        output_dtype = img.dtype
        img_tensor = torch.from_numpy(img[:, :, ::-1].copy().transpose(2, 0, 1)).float() / value_range
        img_tensor = img_tensor.unsqueeze(0).to(self.device)
        if self.half:
            img_tensor = img_tensor.half()

        # Pad to even dimensions for pixel_unshuffle compatibility (x2 model)
        _, _, th, tw = img_tensor.shape
        pad_h = (2 - th % 2) % 2
        pad_w = (2 - tw % 2) % 2
        if pad_h > 0 or pad_w > 0:
            img_tensor = self._pad(img_tensor, [0, pad_w, 0, pad_h])

        if self.pre_pad > 0:
            img_tensor = self._pad(img_tensor, [self.pre_pad] * 4)

        if self.tile == 0 or (img_tensor.shape[2] <= self.tile and img_tensor.shape[3] <= self.tile):
            with torch.no_grad():
                output = self._run_model(img_tensor)
        else:
            output = self._tile_process(img_tensor, progress_callback)

        if self.pre_pad > 0:
            pp = self.pre_pad * self._net_scale
            output = output[:, :, pp:-pp, pp:-pp]

        # Remove the one-pixel compatibility pad by cropping, not resizing it
        # into the result (which subtly distorted odd-sized inputs).
        output = output[:, :, :h * self._net_scale, :w * self._net_scale]

        # Move accelerator results off-device before converting to float32.
        # Calling ``.float()`` first would allocate a second, full-resolution
        # output tensor on CUDA/MPS (particularly expensive for x4 models).
        del img_tensor
        output = output.squeeze(0).to(device='cpu', dtype=torch.float32)
        output.clamp_(0, 1)
        output = output.numpy()
        output = (output.transpose(1, 2, 0)[:, :, ::-1] * value_range).round().astype(output_dtype)

        # Resize to target dimensions (needed when net_scale != outscale, e.g. x2 model)
        target_h = int(h * outscale)
        target_w = int(w * outscale)
        if output.shape[0] != target_h or output.shape[1] != target_w:
            output = cv2.resize(
                output,
                (target_w, target_h),
                interpolation=cv2.INTER_LANCZOS4
            )

        if has_alpha:
            alpha_up = cv2.resize(
                alpha,
                (output.shape[1], output.shape[0]),
                interpolation=cv2.INTER_LANCZOS4
            )
            output = np.concatenate([output, alpha_up[:, :, np.newaxis]], axis=2)
        elif was_grayscale:
            output = cv2.cvtColor(output, cv2.COLOR_BGR2GRAY)

        return output

    def _tile_process(self, img, progress_callback=None):
        batch, channel, height, width = img.shape
        ns = self._net_scale
        output_h = height * ns
        output_w = width * ns
        # Tiling must bound accelerator memory, not just model activations.  A
        # device-side assembly canvas grows with the *entire* scaled image
        # (for example, 50 MP at x4 needs 9.6 GB as float32).  Assemble on the
        # CPU and copy one cropped tile at a time so reducing ``self.tile`` on
        # OOM actually reduces every device allocation.
        output = torch.empty(
            (batch, channel, output_h, output_w),
            device='cpu',
            dtype=torch.float32,
        )

        tiles_x = max(1, (width + self.tile - 1) // self.tile)
        tiles_y = max(1, (height + self.tile - 1) // self.tile)
        total_tiles = tiles_x * tiles_y
        tile_idx = 0

        for y in range(tiles_y):
            for x in range(tiles_x):
                self._check_cancelled()
                tile_idx += 1

                ofs_x = x * self.tile
                ofs_y = y * self.tile

                in_x0 = max(ofs_x - self.tile_pad, 0)
                in_x1 = min(ofs_x + self.tile + self.tile_pad, width)
                in_y0 = max(ofs_y - self.tile_pad, 0)
                in_y1 = min(ofs_y + self.tile + self.tile_pad, height)

                input_tile = img[:, :, in_y0:in_y1, in_x0:in_x1]

                with torch.no_grad():
                    output_tile = self._run_model(input_tile)

                # Cancellation can be requested during a long forward pass.
                # Do not spend time transferring its result once it returns.
                self._check_cancelled()

                crop_left = (ofs_x - in_x0) * ns
                crop_top = (ofs_y - in_y0) * ns
                tile_w = min(self.tile, width - ofs_x) * ns
                tile_h = min(self.tile, height - ofs_y) * ns

                out_x = ofs_x * ns
                out_y = ofs_y * ns

                output_chunk = output_tile[
                    :, :, crop_top:crop_top + tile_h,
                    crop_left:crop_left + tile_w,
                ].detach().to(device='cpu', dtype=torch.float32)
                output[
                    :, :, out_y:out_y + tile_h,
                    out_x:out_x + tile_w,
                ] = output_chunk
                del output_tile, output_chunk

                if progress_callback:
                    progress_callback(tile_idx / total_tiles)

        self._check_cancelled()
        return output


# ---------------------------------------------------------------------------
# Main Upscaler class
# ---------------------------------------------------------------------------

class Upscaler:
    def __init__(self):
        self._models = {}  # key: (profile, scale)
        self._model_lock = threading.RLock()
        self._download_response_lock = threading.Lock()
        self._active_download_response = None
        self.cancel_event = threading.Event()
        self._vram_total = 0
        self._gpu_name = ''
        self._nvml_handle = None

        # Device detection: CUDA (NVIDIA) > MPS (Apple Silicon) > CPU
        if torch.cuda.is_available():
            self.device = 'cuda'
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            self.device = 'mps'
        else:
            self.device = 'cpu'

        print(f'Using device: {self.device}')
        if self.device == 'cuda':
            props = torch.cuda.get_device_properties(0)
            self._vram_total = props.total_memory
            self._gpu_name = props.name
            print(f'GPU: {self._gpu_name}')
            print(f'VRAM: {self._vram_total / (1024 ** 3):.1f} GB')

            # Tile/frame shapes are highly repetitive, so let cuDNN pick the
            # fastest convolution algorithm for them once and reuse it.
            torch.backends.cudnn.benchmark = True

            if _nvml_available:
                try:
                    self._nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(0)
                except Exception:
                    self._nvml_handle = None
        elif self.device == 'mps':
            self._gpu_name = 'Apple Silicon (MPS)'
            try:
                self._vram_total = int(torch.mps.recommended_max_memory())
            except (AttributeError, RuntimeError):
                self._vram_total = 0
            print(f'GPU: {self._gpu_name}')
            print('Using Metal Performance Shaders for GPU acceleration')
        else:
            import multiprocessing
            cpu_count = multiprocessing.cpu_count()
            print(f'No GPU detected — running on CPU ({cpu_count} cores)')
            print('GPU acceleration requires an NVIDIA GPU with CUDA or Apple Silicon')
            # Set PyTorch to use all CPU cores
            if hasattr(torch, 'set_num_threads'):
                torch.set_num_threads(max(1, cpu_count - 1))

    def _get_optimal_tile_size(self, scale):
        """Choose tile size based on available VRAM and scale factor."""
        if self.device == 'mps':
            # MPS has unified memory; use moderate tile sizes
            return 384 if scale == 4 else 512
        if self.device != 'cuda' or self._vram_total == 0:
            return 192 if scale == 4 else 256

        vram_gb = self._vram_total / (1024 ** 3)
        if scale == 4:
            if vram_gb >= 10:
                return 768
            if vram_gb >= 8:
                return 512
            if vram_gb >= 6:
                return 384
            if vram_gb >= 4:
                return 256
            return 192  # 2-3GB VRAM
        else:
            if vram_gb >= 10:
                return 1024
            if vram_gb >= 8:
                return 768
            if vram_gb >= 6:
                return 512
            if vram_gb >= 4:
                return 384
            return 256  # 2-3GB VRAM

    def get_vram_info(self):
        """Return current GPU stats via NVML, or None if on CPU."""
        if self.device not in ('cuda', 'mps'):
            return None

        result = {
            'gpu_name': self._gpu_name,
        }

        if self._nvml_handle:
            try:
                mem = pynvml.nvmlDeviceGetMemoryInfo(self._nvml_handle)
                result['total'] = mem.total
                result['used'] = mem.used
                result['free'] = mem.free
            except Exception:
                result['total'] = self._vram_total
                result['used'] = torch.cuda.memory_allocated(0)
                result['free'] = self._vram_total - result['used']

            try:
                util = pynvml.nvmlDeviceGetUtilizationRates(self._nvml_handle)
                result['gpu_util'] = util.gpu
                result['mem_util'] = util.memory
            except Exception:
                result['gpu_util'] = None
                result['mem_util'] = None

            try:
                temp = pynvml.nvmlDeviceGetTemperature(
                    self._nvml_handle, pynvml.NVML_TEMPERATURE_GPU
                )
                result['temperature'] = temp
            except Exception:
                result['temperature'] = None
        else:
            result['total'] = self._vram_total
            if self.device == 'mps':
                try:
                    result['used'] = torch.mps.current_allocated_memory()
                except Exception:
                    result['used'] = 0
            else:
                result['used'] = torch.cuda.memory_allocated(0)
            result['free'] = max(0, self._vram_total - result['used'])
            result['gpu_util'] = None
            result['mem_util'] = None
            result['temperature'] = None

        return result

    @staticmethod
    def check_ffmpeg():
        """Check if ffmpeg is available in PATH."""
        try:
            result = subprocess.run(
                ['ffmpeg', '-version'], capture_output=True, timeout=5
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    @staticmethod
    def _probe_video_timing(input_path):
        """Return source timing metadata when ffprobe is available.

        Raw-video pipes carry no presentation timestamps, so video upscaling
        explicitly converts decoded frames to a constant rate. The average
        source rate keeps that normalized stream aligned with the original
        audio for variable-frame-rate recordings.
        """
        try:
            result = subprocess.run(
                [
                    'ffprobe', '-v', 'error',
                    '-show_entries',
                    'stream=codec_type,avg_frame_rate,r_frame_rate,duration,nb_frames',
                    '-of', 'json', input_path,
                ],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode != 0:
                return None
            streams = json.loads(result.stdout or '{}').get('streams') or []
            if not streams:
                return None
            stream = next(
                (item for item in streams if item.get('codec_type') == 'video'),
                None,
            )
            if stream is None:
                return None

            def parse_rate(value):
                try:
                    numerator, denominator = str(value).split('/', 1)
                    denominator = float(denominator)
                    rate = float(numerator) / denominator
                    return rate if np.isfinite(rate) and rate > 0 else None
                except (TypeError, ValueError, ZeroDivisionError):
                    return None

            average = parse_rate(stream.get('avg_frame_rate'))
            nominal = parse_rate(stream.get('r_frame_rate'))
            try:
                duration = float(stream.get('duration'))
                if not np.isfinite(duration) or duration <= 0:
                    duration = None
            except (TypeError, ValueError):
                duration = None
            return {
                'average': average,
                'nominal': nominal,
                'duration': duration,
                'has_audio': any(
                    item.get('codec_type') == 'audio' for item in streams
                ),
            }
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

    def _free_gpu_cache(self):
        """Release cached GPU memory on whichever accelerator is in use."""
        if self.device == 'cuda':
            torch.cuda.empty_cache()
        elif self.device == 'mps':
            torch.mps.empty_cache()

    def _run_ffmpeg_with_progress(self, cmd, progress_file, total_frames,
                                  progress_callback, base, span, label):
        """Run an ffmpeg command that writes machine-readable progress to
        ``progress_file`` (via ``-progress``), forwarding frame progress to
        ``progress_callback`` mapped onto [base, base + span]. Honours
        cancellation and raises RuntimeError with the stderr tail on failure."""
        import time

        # stderr is drained in a thread so a full pipe can never deadlock us.
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        stderr_chunks = []

        def drain():
            for line in proc.stderr:
                stderr_chunks.append(line)

        drainer = threading.Thread(target=drain, daemon=True)
        drainer.start()

        deadline = time.monotonic() + 3600  # mirror the old subprocess timeout

        def latest_frame():
            try:
                with open(progress_file, 'r', errors='replace') as fh:
                    last = 0
                    for line in fh:
                        if line.startswith('frame='):
                            try:
                                last = int(line.split('=', 1)[1].strip())
                            except ValueError:
                                pass
                    return last
            except OSError:
                return 0

        try:
            while proc.poll() is None:
                if self.cancel_event.is_set():
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    raise CancellationError('Processing cancelled by user')
                if time.monotonic() > deadline:
                    proc.kill()
                    raise RuntimeError('ffmpeg timed out after 3600s')
                if progress_callback and total_frames > 0:
                    frac = min(latest_frame() / total_frames, 1.0)
                    progress_callback(base + span * frac, f'{label}... {int(frac * 100)}%')
                time.sleep(0.5)
        finally:
            drainer.join(timeout=2)

        if proc.returncode != 0:
            stderr = b''.join(stderr_chunks).decode('utf-8', errors='replace')
            raise RuntimeError(f'ffmpeg failed: {stderr[-300:]}')

    def cancel(self):
        """Signal cancellation of the current processing batch."""
        self.cancel_event.set()
        # Closing the active HTTP response interrupts a blocking model-weight
        # read immediately instead of making disconnect/Cancel wait for the
        # socket timeout.
        with self._download_response_lock:
            response = self._active_download_response
        if response is not None:
            try:
                response.close()
            except OSError:
                pass

    def reset_cancel(self):
        """Clear the cancellation flag for a new batch."""
        self.cancel_event.clear()

    def close(self):
        """Release cached models and optional GPU monitoring resources."""
        self.cancel()
        with self._model_lock:
            self._models.clear()
            self._free_gpu_cache()
        self._nvml_handle = None
        if _nvml_available:
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass

    def is_model_loaded(self, scale, profile='general'):
        """Check if a model is already loaded (no download/load needed)."""
        with self._model_lock:
            return (profile, scale) in self._models

    def _download_model(self, url, model_path, callback=None):
        """Download model weights to a temporary file and atomically publish."""
        temp_path = None
        response = None
        request = urllib.request.Request(url, headers={'User-Agent': 'MuxMelt/1.0'})
        try:
            # A short socket timeout bounds cancellation latency even during
            # connection setup. Once connected, cancel() also closes this
            # response from the websocket thread to interrupt stalled reads.
            response = urllib.request.urlopen(request, timeout=10)
            with self._download_response_lock:
                if self.cancel_event.is_set():
                    response.close()
                    raise CancellationError('Model download cancelled by user')
                self._active_download_response = response
            with response:
                total = int(response.headers.get('Content-Length') or 0)
                downloaded = 0
                last_data_at = time.monotonic()
                with tempfile.NamedTemporaryFile(
                    mode='wb', prefix=os.path.basename(model_path) + '.',
                    suffix='.part', dir=os.path.dirname(model_path), delete=False,
                ) as output:
                    temp_path = output.name
                    while True:
                        if self.cancel_event.is_set():
                            raise CancellationError('Model download cancelled by user')
                        try:
                            chunk = response.read(256 * 1024)
                        except (TimeoutError, socket.timeout) as exc:
                            if self.cancel_event.is_set():
                                raise CancellationError(
                                    'Model download cancelled by user'
                                ) from exc
                            if time.monotonic() - last_data_at >= 60:
                                raise RuntimeError(
                                    'Model download stalled for 60 seconds. '
                                    'Check your connection and try again.'
                                ) from exc
                            continue
                        if not chunk:
                            break
                        last_data_at = time.monotonic()
                        output.write(chunk)
                        downloaded += len(chunk)
                        if callback:
                            progress = downloaded / total if total else 0.0
                            callback(
                                min(progress, 1.0),
                                f'Downloading {os.path.basename(model_path)}... '
                                f'{progress * 100:.0f}%' if total else
                                f'Downloading {os.path.basename(model_path)}... '
                                f'{downloaded / 1_000_000:.0f} MB',
                            )
            if total and downloaded != total:
                raise RuntimeError(
                    f'Model download was incomplete ({downloaded} of {total} bytes)'
                )
            if downloaded < 1_000_000:
                raise RuntimeError('Downloaded model file is unexpectedly small')
            os.replace(temp_path, model_path)
        finally:
            with self._download_response_lock:
                if self._active_download_response is response:
                    self._active_download_response = None
            if response is not None:
                try:
                    response.close()
                except OSError:
                    pass
            try:
                if temp_path:
                    os.remove(temp_path)
            except OSError:
                pass

    def _ensure_model(self, scale, profile='general', download_callback=None):
        if not isinstance(scale, int) or isinstance(scale, bool) or scale not in (2, 4):
            raise ValueError('Scale must be 2 or 4')
        if profile not in MODEL_PROFILES:
            raise ValueError(f'Unknown model profile: {profile}')

        with self._model_lock:
            key = (profile, scale)
            if key in self._models:
                return self._models[key]

            model_info = MODEL_PROFILES[profile].get(scale)
            if not model_info:
                raise ValueError(f'No model available for profile={profile}, scale={scale}')

            model_path = _model_path(model_info['filename'])
            os.makedirs(os.path.dirname(model_path), exist_ok=True)

            if not os.path.isfile(model_path):
                url = model_info['url']
                print(f'Downloading {model_info["filename"]} from {url}...')
                self._download_model(url, model_path, download_callback)
                print(f'Downloaded ({os.path.getsize(model_path) / 1e6:.1f} MB)')

            if self.cancel_event.is_set():
                raise CancellationError('Processing cancelled by user')
            if download_callback:
                target = 'GPU' if self.device in ('cuda', 'mps') else 'memory'
                download_callback(None, f'Loading model into {target}...')

            model = RRDBNet(
                num_in_ch=3, num_out_ch=3, num_feat=64,
                num_block=model_info['num_block'], num_grow_ch=32, scale=scale
            )

            try:
                loadnet = torch.load(
                    model_path, map_location=torch.device('cpu'), weights_only=True
                )
                if not isinstance(loadnet, dict):
                    raise RuntimeError('Model weights have an unexpected structure')
                if 'params_ema' in loadnet:
                    state_dict = loadnet['params_ema']
                elif 'params' in loadnet:
                    state_dict = loadnet['params']
                else:
                    state_dict = loadnet
                model.load_state_dict(state_dict, strict=True)
            except Exception as exc:
                raise RuntimeError(
                    f'Could not load model weights {model_info["filename"]}: {exc}'
                ) from exc

            eager_model = None
            if hasattr(torch, 'compile') and self.device == 'cuda':
                try:
                    eager_model = model
                    model = torch.compile(model)
                    print('Model enabled for torch.compile acceleration')
                except Exception as exc:
                    eager_model = None
                    print(f'torch.compile unavailable; using eager inference: {exc}')

            tile_size = self._get_optimal_tile_size(scale)

            engine = TiledInference(
                model=model,
                scale=scale,
                device=self.device,
                half=(self.device == 'cuda'),
                tile=tile_size,
                tile_pad=10,
                pre_pad=10,
                cancel_event=self.cancel_event,
                eager_fallback_model=eager_model,
            )

            # Unload any previously loaded model to free GPU memory.
            self._models.clear()
            self._free_gpu_cache()
            self._models[key] = engine
            print(f'Loaded {model_info["filename"]} on {self.device} (tile={tile_size})')
            return engine

    def _get_max_pixels(self, scale=1):
        """Return a scale-aware input cap for accelerator and host memory."""
        if self.device == 'mps':
            hardware_limit = 30_000_000  # unified memory
        elif self.device != 'cuda':
            hardware_limit = 20_000_000
        else:
            vram_gb = self._vram_total / (1024 ** 3)
            if vram_gb >= 10:
                hardware_limit = 50_000_000
            elif vram_gb >= 8:
                hardware_limit = 40_000_000
            elif vram_gb >= 6:
                hardware_limit = 25_000_000
            elif vram_gb >= 4:
                hardware_limit = 16_000_000
            else:
                hardware_limit = 8_000_000

        safe_scale = max(1, int(scale))
        # RGB float32 canvas = input_pixels * scale^2 * 3 channels * 4 bytes.
        host_limit = MAX_HOST_ASSEMBLY_BYTES // (safe_scale * safe_scale * 3 * 4)
        return max(1, min(hardware_limit, host_limit))

    def _enhance_with_oom_retry(self, engine, img, scale, progress_callback=None,
                                restore_tile=True):
        """Enhance one frame and retry accelerator OOMs with smaller tiles."""
        min_tile = 64
        original_tile = engine.tile
        try:
            while True:
                try:
                    return engine.enhance(
                        img, outscale=scale, progress_callback=progress_callback
                    )
                except RuntimeError as exc:
                    is_oom = 'out of memory' in str(exc).lower()
                    if not (is_oom and self.device in ('cuda', 'mps')):
                        raise
                    self._free_gpu_cache()
                    if engine.tile <= min_tile:
                        raise
                    new_tile = max(min_tile, engine.tile // 2)
                    print(f'OOM: retrying with tile size {new_tile} (was {engine.tile})')
                    engine.tile = new_tile
        finally:
            if restore_tile:
                engine.tile = original_tile

    def upscale_image(self, input_path, output_path, scale=4, profile='general', progress_callback=None):
        if not isinstance(input_path, str) or not os.path.isfile(input_path):
            raise FileNotFoundError(f'Input image not found: {input_path}')
        if not isinstance(output_path, str) or not output_path:
            raise ValueError('Output path is required')
        output_ext = os.path.splitext(output_path)[1].lower()
        if output_ext not in ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'):
            raise ValueError(f'Unsupported image output format: {output_ext or "(none)"}')

        engine = self._ensure_model(scale, profile)
        img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError(f'Failed to read image: {input_path}')

        h, w = img.shape[:2]
        if h == 0 or w == 0:
            raise ValueError(f'Image has invalid dimensions ({w}x{h}): {input_path}')
        max_pixels = self._get_max_pixels(scale)
        if h * w > max_pixels:
            raise ValueError(
                f'Image too large ({w}x{h} = {w*h:,} pixels) for your hardware. '
                f'Max supported: {max_pixels:,} pixels. '
                f'Resize the image before upscaling.'
            )

        output = self._enhance_with_oom_retry(
            engine, img, scale, progress_callback, restore_tile=True
        )

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

        temp_output_path = (
            f'{output_path}.{os.getpid()}.{threading.get_ident()}.part{output_ext}'
        )
        try:
            save_output = output
            if output_ext in ('.jpg', '.jpeg') and save_output.ndim == 3 and save_output.shape[2] == 4:
                save_output = cv2.cvtColor(save_output, cv2.COLOR_BGRA2BGR)
            if save_output.dtype == np.uint16 and output_ext in ('.jpg', '.jpeg', '.webp', '.bmp'):
                save_output = (save_output / 257.0).round().astype(np.uint8)
            if output_ext in ('.jpg', '.jpeg'):
                written = cv2.imwrite(
                    temp_output_path, save_output, [cv2.IMWRITE_JPEG_QUALITY, 95]
                )
            elif output_ext == '.webp':
                written = cv2.imwrite(
                    temp_output_path, save_output, [cv2.IMWRITE_WEBP_QUALITY, 95]
                )
            else:
                written = cv2.imwrite(temp_output_path, save_output)

            if not written:
                raise RuntimeError(f'Failed to write output image: {output_path}')
            if self.cancel_event.is_set():
                raise CancellationError('Processing cancelled by user')
            os.replace(temp_output_path, output_path)
        finally:
            try:
                os.remove(temp_output_path)
            except OSError:
                pass

        return output_path

    def upscale_video(self, input_path, output_path, scale=4, output_ext='mp4',
                      progress_callback=None, profile='general'):
        if not isinstance(input_path, str) or not os.path.isfile(input_path):
            raise FileNotFoundError(f'Input video not found: {input_path}')
        if not isinstance(output_path, str) or not output_path:
            raise ValueError('Output path is required')
        output_ext = str(output_ext).lower().lstrip('.')
        if output_ext not in {'mp4', 'mov', 'mkv', 'avi', 'webm'}:
            raise ValueError(f'Unsupported video output format: {output_ext}')
        if os.path.splitext(output_path)[1].lower() != f'.{output_ext}':
            raise ValueError('Output path extension does not match output format')

        cap = cv2.VideoCapture(input_path)
        try:
            if not cap.isOpened():
                raise ValueError(f'Failed to open video: {input_path}')
            fps = float(cap.get(cv2.CAP_PROP_FPS))
            raw_frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            total_frames = (
                max(0, int(raw_frame_count)) if np.isfinite(raw_frame_count) else 0
            )
            src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        finally:
            cap.release()

        if src_w <= 0 or src_h <= 0:
            raise ValueError(f'Video has invalid dimensions ({src_w}x{src_h})')
        if not np.isfinite(fps) or fps <= 0:
            raise ValueError('Could not determine a valid video frame rate')
        max_pixels = self._get_max_pixels(scale)
        if src_w * src_h > max_pixels:
            raise ValueError(
                f'Video frames are too large ({src_w}x{src_h}) for {scale}x upscaling. '
                f'Max supported: {max_pixels:,} input pixels.'
            )
        if not self.check_ffmpeg():
            raise FileNotFoundError(
                'ffmpeg is not installed or not in PATH. '
                'Video upscaling requires ffmpeg. '
                'Install from https://ffmpeg.org/download.html'
            )

        timing = self._probe_video_timing(input_path)
        is_variable_rate = False
        if timing and timing['average']:
            fps = timing['average']
            nominal_fps = timing['nominal']
            if nominal_fps:
                is_variable_rate = abs(nominal_fps - fps) > max(0.01, fps * 0.001)
            if timing['duration']:
                total_frames = max(1, round(timing['duration'] * fps))

        # Reject invalid media and establish its timing before loading or
        # downloading a potentially large model.
        engine = self._ensure_model(scale, profile)

        if progress_callback:
            if is_variable_rate:
                progress_callback(
                    0.0,
                    f'Normalizing variable frame rate to {fps:.3f} fps...',
                )
            else:
                progress_callback(0.0, 'Starting encode pipeline...')

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        temp_output = (
            f'{output_path}.{os.getpid()}.{threading.get_ident()}.part.{output_ext}'
        )

        reader_cmd = [
            'ffmpeg', '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error',
            '-i', input_path,
            '-map', '0:v:0', '-an',
            # Raw video has no timestamps. Normalize through FFmpeg's fps
            # filter before the pipe so the writer's constant-rate timestamps
            # retain the source timeline instead of drifting against audio.
            '-vf', f'fps={fps:.12g}:round=near',
            '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1',
        ]
        writer_cmd = [
            'ffmpeg', '-y', '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error',
            '-f', 'rawvideo', '-pix_fmt', 'bgr24',
            '-video_size', f'{src_w * scale}x{src_h * scale}',
            '-framerate', f'{fps:.12g}', '-i', 'pipe:0',
            '-i', input_path,
            '-map', '0:v:0', '-map', '1:a?',
        ]

        if output_ext in ('mp4', 'mov'):
            writer_cmd.extend([
                '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart',
            ])
        elif output_ext == 'mkv':
            writer_cmd.extend([
                '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '192k',
            ])
        elif output_ext == 'avi':
            # AVI cannot reliably mux modern source audio codecs such as Opus,
            # Vorbis, or FLAC. Transcode both streams to broadly compatible
            # MPEG-4 Part 2 + MP3 instead of blindly copying the input audio.
            writer_cmd.extend([
                '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame', '-b:a', '192k'
            ])
        else:
            writer_cmd.extend([
                '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
                '-c:a', 'libopus', '-b:a', '160k',
            ])
        if timing and timing['has_audio']:
            # Pad short audio with silence and let -shortest stop at the raw
            # video stream. This makes video the controlling duration whether
            # source audio is shorter or longer and prevents FFmpeg closing
            # stdin before every expensive upscaled frame has been written.
            writer_cmd.extend(['-af', 'apad', '-shortest'])
        writer_cmd.append(temp_output)

        reader = None
        writer = None
        reader_pool = None
        writer_pool = None
        drain_threads = []
        reader_errors = deque(maxlen=100)
        writer_errors = deque(maxlen=100)
        pipeline_done = threading.Event()
        cancel_thread = None
        succeeded = False
        original_tile = engine.tile

        def drain(stream, destination):
            try:
                for line in iter(stream.readline, b''):
                    destination.append(line)
            finally:
                stream.close()

        def stop_process(process):
            if process is None or process.poll() is not None:
                return
            try:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass

        try:
            reader = subprocess.Popen(
                reader_cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, bufsize=0,
            )
            writer = subprocess.Popen(
                writer_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, bufsize=0,
            )
            for process, errors in ((reader, reader_errors), (writer, writer_errors)):
                thread = threading.Thread(
                    target=drain, args=(process.stderr, errors), daemon=True
                )
                thread.start()
                drain_threads.append(thread)

            def cancellation_watcher():
                while not pipeline_done.wait(0.1):
                    if self.cancel_event.is_set():
                        stop_process(reader)
                        stop_process(writer)
                        return

            cancel_thread = threading.Thread(target=cancellation_watcher, daemon=True)
            cancel_thread.start()

            frame_size = src_w * src_h * 3

            def read_frame():
                data = bytearray()
                while len(data) < frame_size:
                    chunk = reader.stdout.read(frame_size - len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                if not data:
                    return None
                if len(data) != frame_size:
                    raise RuntimeError(
                        f'ffmpeg returned a partial video frame ({len(data)} of {frame_size} bytes)'
                    )
                return np.frombuffer(data, dtype=np.uint8).reshape((src_h, src_w, 3))

            def write_frame(frame):
                view = memoryview(frame.tobytes())
                while view:
                    written = writer.stdin.write(view)
                    if not written:
                        raise BrokenPipeError('ffmpeg stopped accepting upscaled frames')
                    view = view[written:]

            reader_pool = ThreadPoolExecutor(max_workers=1)
            writer_pool = ThreadPoolExecutor(max_workers=1)
            pending_writes = []
            frame_idx = 0
            next_read = reader_pool.submit(read_frame)

            while True:
                if self.cancel_event.is_set():
                    raise CancellationError('Processing cancelled by user')
                frame = next_read.result()
                if frame is None:
                    break
                next_read = reader_pool.submit(read_frame)
                output = self._enhance_with_oom_retry(
                    engine, frame, scale, restore_tile=False
                )
                while len(pending_writes) >= 2:
                    pending_writes.pop(0).result()
                pending_writes.append(writer_pool.submit(write_frame, output))

                frame_idx += 1
                if progress_callback:
                    if total_frames > 0:
                        progress = min(frame_idx / total_frames * 0.95, 0.95)
                        status = f'Upscaling frame {frame_idx}/{total_frames}'
                    else:
                        progress = 0.0
                        status = f'Upscaling frame {frame_idx}'
                    progress_callback(progress, status)

            for pending in pending_writes:
                pending.result()
            reader_pool.shutdown(wait=True)
            reader_pool = None
            writer_pool.shutdown(wait=True)
            writer_pool = None
            writer.stdin.close()

            reader.wait(timeout=30)
            if reader.returncode != 0:
                details = b''.join(reader_errors).decode('utf-8', errors='replace')[-500:]
                raise RuntimeError(f'ffmpeg video decode failed: {details}')
            if frame_idx == 0:
                raise RuntimeError('ffmpeg decoded zero video frames')

            if progress_callback:
                progress_callback(0.96, 'Finishing encode...')

            deadline = time.monotonic() + 3600
            while writer.poll() is None:
                if self.cancel_event.is_set():
                    raise CancellationError('Processing cancelled by user')
                if time.monotonic() > deadline:
                    raise RuntimeError('ffmpeg encode timed out while finalizing the video')
                pipeline_done.wait(0.1)

            if writer.returncode != 0:
                details = b''.join(writer_errors).decode('utf-8', errors='replace')[-500:]
                raise RuntimeError(f'ffmpeg video encode failed: {details}')
            if not os.path.isfile(temp_output) or os.path.getsize(temp_output) == 0:
                raise RuntimeError('ffmpeg did not create a valid output video')

            os.replace(temp_output, output_path)
            succeeded = True
            if progress_callback:
                progress_callback(1.0, 'Complete')
            return output_path
        except Exception as exc:
            if self.cancel_event.is_set() and not isinstance(exc, CancellationError):
                raise CancellationError('Processing cancelled by user') from exc
            raise
        finally:
            pipeline_done.set()
            stop_process(reader)
            stop_process(writer)
            if reader_pool is not None:
                reader_pool.shutdown(wait=True, cancel_futures=True)
            if writer_pool is not None:
                writer_pool.shutdown(wait=True, cancel_futures=True)
            for stream in (
                getattr(reader, 'stdout', None), getattr(reader, 'stderr', None),
                getattr(writer, 'stdin', None), getattr(writer, 'stderr', None),
            ):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            for thread in drain_threads:
                thread.join(timeout=2)
            if cancel_thread is not None:
                cancel_thread.join(timeout=2)
            engine.tile = original_tile
            self._free_gpu_cache()
            if not succeeded:
                try:
                    os.remove(temp_output)
                except OSError:
                    pass
