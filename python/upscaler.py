import os
import cv2
import numpy as np
import subprocess
import tempfile
import shutil
import urllib.request
import threading

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

WEIGHTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weights')


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
    def __init__(self, model, scale, device='cuda', half=True, tile=512, tile_pad=10, pre_pad=10, cancel_event=None):
        self.scale = scale
        self.device = device
        self.half = half and (device == 'cuda')
        self.tile = tile
        self.tile_pad = tile_pad
        self.pre_pad = pre_pad
        self.cancel_event = cancel_event

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

    def _check_cancelled(self):
        if self.cancel_event and self.cancel_event.is_set():
            raise CancellationError('Processing cancelled by user')

    def enhance(self, img, outscale=None, progress_callback=None):
        """Upscale a BGR uint8 numpy image. Returns upscaled BGR uint8 numpy image."""
        self._check_cancelled()

        if outscale is None:
            outscale = self.scale

        h, w = img.shape[:2]

        has_alpha = img.shape[2] == 4 if len(img.shape) == 3 else False
        if has_alpha:
            alpha = img[:, :, 3]
            img = img[:, :, :3]

        img_tensor = torch.from_numpy(img[:, :, ::-1].copy().transpose(2, 0, 1)).float() / 255.0
        img_tensor = img_tensor.unsqueeze(0).to(self.device)
        if self.half:
            img_tensor = img_tensor.half()

        # Pad to even dimensions for pixel_unshuffle compatibility (x2 model)
        _, _, th, tw = img_tensor.shape
        pad_h = (2 - th % 2) % 2
        pad_w = (2 - tw % 2) % 2
        if pad_h > 0 or pad_w > 0:
            img_tensor = F.pad(img_tensor, [0, pad_w, 0, pad_h], mode='reflect')

        if self.pre_pad > 0:
            img_tensor = F.pad(img_tensor, [self.pre_pad] * 4, mode='reflect')

        if self.tile == 0 or (img_tensor.shape[2] <= self.tile and img_tensor.shape[3] <= self.tile):
            with torch.no_grad():
                output = self.model(img_tensor)
        else:
            output = self._tile_process(img_tensor, progress_callback)

        if self.pre_pad > 0:
            pp = self.pre_pad * self._net_scale
            output = output[:, :, pp:-pp, pp:-pp]

        output = output.squeeze(0).float().clamp(0, 1).cpu().numpy()
        del img_tensor
        if self.device == 'cuda':
            torch.cuda.empty_cache()
        elif self.device == 'mps':
            torch.mps.empty_cache()
        output = (output.transpose(1, 2, 0)[:, :, ::-1] * 255.0).round().astype(np.uint8)

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

        return output

    def _tile_process(self, img, progress_callback=None):
        batch, channel, height, width = img.shape
        ns = self._net_scale
        output_h = height * ns
        output_w = width * ns
        output = img.new_zeros((batch, channel, output_h, output_w))

        tiles_x = max(1, (width + self.tile - 1) // self.tile)
        tiles_y = max(1, (height + self.tile - 1) // self.tile)
        total_tiles = tiles_x * tiles_y
        tile_idx = 0

        for y in range(tiles_y):
            for x in range(tiles_x):
                self._check_cancelled()
                tile_idx += 1

                if progress_callback:
                    progress_callback(tile_idx / total_tiles)

                ofs_x = x * self.tile
                ofs_y = y * self.tile

                in_x0 = max(ofs_x - self.tile_pad, 0)
                in_x1 = min(ofs_x + self.tile + self.tile_pad, width)
                in_y0 = max(ofs_y - self.tile_pad, 0)
                in_y1 = min(ofs_y + self.tile + self.tile_pad, height)

                input_tile = img[:, :, in_y0:in_y1, in_x0:in_x1]

                with torch.no_grad():
                    output_tile = self.model(input_tile)

                crop_left = (ofs_x - in_x0) * ns
                crop_top = (ofs_y - in_y0) * ns
                tile_w = min(self.tile, width - ofs_x) * ns
                tile_h = min(self.tile, height - ofs_y) * ns

                out_x = ofs_x * ns
                out_y = ofs_y * ns

                output[:, :, out_y:out_y + tile_h, out_x:out_x + tile_w] = \
                    output_tile[:, :, crop_top:crop_top + tile_h, crop_left:crop_left + tile_w]

        return output


# ---------------------------------------------------------------------------
# Main Upscaler class
# ---------------------------------------------------------------------------

class Upscaler:
    def __init__(self):
        self._models = {}  # key: (profile, scale)
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
            result['free'] = self._vram_total - result['used']
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

    def reset_cancel(self):
        """Clear the cancellation flag for a new batch."""
        self.cancel_event.clear()

    def is_model_loaded(self, scale, profile='general'):
        """Check if a model is already loaded (no download/load needed)."""
        return (profile, scale) in self._models

    def _ensure_model(self, scale, profile='general', download_callback=None):
        key = (profile, scale)
        if key in self._models:
            return self._models[key]

        profile_data = MODEL_PROFILES.get(profile, MODEL_PROFILES['general'])
        model_info = profile_data.get(scale)
        if not model_info:
            raise ValueError(f'No model available for profile={profile}, scale={scale}')

        os.makedirs(WEIGHTS_DIR, exist_ok=True)
        model_path = os.path.join(WEIGHTS_DIR, model_info['filename'])

        if not os.path.exists(model_path):
            url = model_info['url']
            print(f'Downloading {model_info["filename"]} from {url}...')

            def reporthook(count, block_size, total_size):
                if total_size > 0 and download_callback:
                    pct = min(count * block_size / total_size, 1.0)
                    download_callback(pct, f'Downloading {model_info["filename"]}... {pct * 100:.0f}%')

            # Set a 5-minute timeout for the download
            import socket
            old_timeout = socket.getdefaulttimeout()
            socket.setdefaulttimeout(300)
            try:
                urllib.request.urlretrieve(url, model_path, reporthook=reporthook)
            finally:
                socket.setdefaulttimeout(old_timeout)
            print(f'Downloaded ({os.path.getsize(model_path) / 1e6:.1f} MB)')

        if download_callback:
            download_callback(None, 'Loading model into GPU...')

        model = RRDBNet(
            num_in_ch=3, num_out_ch=3, num_feat=64,
            num_block=model_info['num_block'], num_grow_ch=32, scale=scale
        )

        loadnet = torch.load(model_path, map_location=torch.device('cpu'), weights_only=True)
        if 'params_ema' in loadnet:
            keyname = 'params_ema'
        elif 'params' in loadnet:
            keyname = 'params'
        else:
            keyname = None

        if keyname:
            model.load_state_dict(loadnet[keyname], strict=True)
        else:
            model.load_state_dict(loadnet, strict=True)

        tile_size = self._get_optimal_tile_size(scale)

        engine = TiledInference(
            model=model,
            scale=scale,
            device=self.device,
            half=(self.device == 'cuda'),
            tile=tile_size,
            tile_pad=10,
            pre_pad=10,
            cancel_event=self.cancel_event
        )

        # Unload any previously loaded model to free GPU memory
        if self._models:
            for old_key in list(self._models.keys()):
                if old_key != key:
                    del self._models[old_key]
            self._free_gpu_cache()

        self._models[key] = engine
        print(f'Loaded {model_info["filename"]} on {self.device} (tile={tile_size})')
        return engine

    def _get_max_pixels(self):
        """Scale max input pixels based on available VRAM."""
        if self.device == 'mps':
            return 30_000_000  # 30MP for MPS (unified memory)
        if self.device != 'cuda':
            return 20_000_000  # 20MP for CPU
        vram_gb = self._vram_total / (1024 ** 3)
        if vram_gb >= 10:
            return 50_000_000   # 50MP
        if vram_gb >= 8:
            return 40_000_000   # 40MP
        if vram_gb >= 6:
            return 25_000_000   # 25MP
        if vram_gb >= 4:
            return 16_000_000   # 16MP
        return 8_000_000        # 8MP for 2-3GB

    def upscale_image(self, input_path, output_path, scale=4, profile='general', progress_callback=None):
        engine = self._ensure_model(scale, profile)
        img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError(f'Failed to read image: {input_path}')

        h, w = img.shape[:2]
        if h == 0 or w == 0:
            raise ValueError(f'Image has invalid dimensions ({w}x{h}): {input_path}')
        max_pixels = self._get_max_pixels()
        if h * w > max_pixels:
            raise ValueError(
                f'Image too large ({w}x{h} = {w*h:,} pixels) for your hardware. '
                f'Max supported: {max_pixels:,} pixels. '
                f'Resize the image before upscaling.'
            )

        # Try inference; on OOM, keep halving the tile size until it fits or we
        # hit the floor (below which the model can't run usefully).
        MIN_TILE = 64
        original_tile = engine.tile
        try:
            while True:
                try:
                    output = engine.enhance(img, outscale=scale, progress_callback=progress_callback)
                    break
                except RuntimeError as e:
                    is_oom = 'out of memory' in str(e).lower()
                    if not (is_oom and self.device in ('cuda', 'mps')):
                        raise
                    self._free_gpu_cache()
                    if engine.tile <= MIN_TILE:
                        # Already as small as it gets — let the OOM propagate so
                        # the user gets the actionable VRAM guidance.
                        raise
                    new_tile = max(MIN_TILE, engine.tile // 2)
                    print(f'OOM: retrying with tile size {new_tile} (was {engine.tile})')
                    engine.tile = new_tile
        finally:
            engine.tile = original_tile  # restore tuned size for the next file

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

        ext = os.path.splitext(output_path)[1].lower()
        temp_output_path = output_path + '.tmp' + ext
        if os.path.exists(temp_output_path):
            os.remove(temp_output_path)
        if ext in ('.jpg', '.jpeg'):
            written = cv2.imwrite(temp_output_path, output, [cv2.IMWRITE_JPEG_QUALITY, 95])
        elif ext == '.webp':
            written = cv2.imwrite(temp_output_path, output, [cv2.IMWRITE_WEBP_QUALITY, 95])
        else:
            written = cv2.imwrite(temp_output_path, output)

        if not written:
            raise RuntimeError(f'Failed to write output image: {output_path}')

        os.replace(temp_output_path, output_path)

        return output_path

    def upscale_video(self, input_path, output_path, scale=4, output_ext='mp4',
                      progress_callback=None, profile='general'):
        engine = self._ensure_model(scale, profile)

        cap = cv2.VideoCapture(input_path)
        if not cap.isOpened():
            raise ValueError(f'Failed to open video: {input_path}')
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()

        if total_frames <= 0:
            raise ValueError(f'Could not determine frame count for: {input_path}')

        if not self.check_ffmpeg():
            raise FileNotFoundError(
                'ffmpeg is not installed or not in PATH. '
                'Video upscaling requires ffmpeg. '
                'Install from https://ffmpeg.org/download.html'
            )

        # Upscaling extracts every frame to lossless PNG (source + upscaled
        # copies) into temp before reassembly — tens of GB for long/HD videos.
        # Estimate the footprint up front and fail with actionable guidance
        # rather than dying with ENOSPC deep into extraction.
        if src_w > 0 and src_h > 0:
            bytes_per_px = 1.5  # rough compressed-PNG estimate
            est_bytes = total_frames * (src_w * src_h + (src_w * scale) * (src_h * scale)) * bytes_per_px
            try:
                free_bytes = shutil.disk_usage(tempfile.gettempdir()).free
            except OSError:
                free_bytes = None
            if free_bytes is not None and est_bytes > free_bytes * 0.9:
                raise ValueError(
                    f'This video needs roughly {est_bytes / 1e9:.0f} GB of temporary disk space to '
                    f'upscale ({total_frames} frames at {scale}x), but only {free_bytes / 1e9:.0f} GB '
                    f'is free. Free up space, trim the video, or upscale at 2x instead.'
                )

        temp_dir = tempfile.mkdtemp(prefix='upscaler_')
        frames_dir = os.path.join(temp_dir, 'frames')
        upscaled_dir = os.path.join(temp_dir, 'upscaled')
        os.makedirs(frames_dir)
        os.makedirs(upscaled_dir)

        try:
            if progress_callback:
                progress_callback(0.0, 'Extracting frames...')

            # Extract frames losslessly as PNG so the upscaler isn't fed
            # already-degraded (JPEG-compressed) input. Costs more disk/time
            # but preserves the quality the model was trained to enhance.
            result = subprocess.run([
                'ffmpeg', '-i', input_path,
                '-vsync', '0',
                os.path.join(frames_dir, 'frame_%08d.png')
            ], capture_output=True, timeout=3600)

            if result.returncode != 0:
                stderr = result.stderr.decode('utf-8', errors='replace')
                raise RuntimeError(f'ffmpeg frame extraction failed: {stderr[:300]}')

            frame_files = sorted(f for f in os.listdir(frames_dir) if f.endswith('.png'))
            total = len(frame_files)

            if total == 0:
                raise RuntimeError('ffmpeg extracted 0 frames from the video')

            # Overlap disk I/O with GPU work: prefetch the next frame's decode
            # and offload PNG encoding of finished frames to a writer pool, so
            # the GPU isn't stalled waiting on OpenCV's (GIL-releasing) codecs.
            from concurrent.futures import ThreadPoolExecutor

            def read_frame(path):
                im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
                if im is None:
                    raise RuntimeError(f'Failed to read extracted frame: {os.path.basename(path)}')
                return im

            def write_frame(path, arr):
                if not cv2.imwrite(path, arr):
                    raise RuntimeError(f'Failed to write upscaled frame: {os.path.basename(path)}')

            reader = ThreadPoolExecutor(max_workers=1)
            writer = ThreadPoolExecutor(max_workers=2)
            pending_writes = []
            try:
                paths = [os.path.join(frames_dir, f) for f in frame_files]
                next_read = reader.submit(read_frame, paths[0])

                for i, frame_file in enumerate(frame_files):
                    if self.cancel_event.is_set():
                        raise CancellationError('Processing cancelled by user')

                    img = next_read.result()
                    if i + 1 < total:
                        next_read = reader.submit(read_frame, paths[i + 1])

                    output = engine.enhance(img, outscale=scale)

                    out_frame_path = os.path.join(upscaled_dir, frame_file)
                    # Bound in-flight writes; block on the oldest if we're ahead,
                    # which also surfaces any writer exception promptly.
                    while len(pending_writes) >= 4:
                        pending_writes.pop(0).result()
                    pending_writes.append(writer.submit(write_frame, out_frame_path, output))

                    if progress_callback:
                        pct = (i + 1) / total * 0.95
                        progress_callback(pct, f'Upscaling frame {i + 1}/{total}')

                # Ensure every frame is on disk before reassembly.
                for f in pending_writes:
                    f.result()
            finally:
                reader.shutdown(wait=True)
                writer.shutdown(wait=True)

            if self.cancel_event.is_set():
                raise CancellationError('Processing cancelled by user')

            if progress_callback:
                progress_callback(0.96, 'Reassembling video...')

            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

            progress_file = os.path.join(temp_dir, 'encode_progress.txt')
            cmd = [
                'ffmpeg', '-y',
                '-progress', progress_file, '-nostats',
                '-framerate', str(fps),
                '-i', os.path.join(upscaled_dir, 'frame_%08d.png'),
                '-i', input_path,
                '-map', '0:v:0',
                '-map', '1:a?',
                '-c:a', 'copy',
                '-shortest',
            ]

            if output_ext in ('mp4', 'mov'):
                cmd.extend(['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p'])
            elif output_ext in ('mkv', 'avi'):
                cmd.extend(['-c:v', 'libx264', '-crf', '18', '-preset', 'medium'])
            elif output_ext == 'webm':
                cmd.extend(['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0'])
            else:
                cmd.extend(['-c:v', 'libx264', '-crf', '18', '-preset', 'medium'])

            cmd.append(output_path)
            self._run_ffmpeg_with_progress(
                cmd, progress_file, total, progress_callback,
                base=0.96, span=0.04, label='Reassembling video',
            )

            if progress_callback:
                progress_callback(1.0, 'Complete')

            return output_path

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
