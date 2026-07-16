import os
import re
import threading
from importlib.util import find_spec

from PIL import Image, ImageFilter

# rembg pulls in onnxruntime, a heavy import that previously ran at server
# startup just by importing this module. Defer it until a background actually
# needs removing (first use), and probe availability cheaply via find_spec so
# startup stays fast. This mirrors how the stem separator defers demucs.
_available = find_spec('rembg') is not None and find_spec('onnxruntime') is not None
_HEX_COLOR_RE = re.compile(r'^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
_OUTPUT_FORMATS = {'png': 'PNG', 'webp': 'WEBP', 'tiff': 'TIFF'}
_BG_MODES = {'transparent', 'color', 'blur', 'image'}


def is_available():
    return _available


def _hex_to_rgb(hex_str):
    """Convert a hex color string like '#FF0000' to an (R, G, B) tuple."""
    if not isinstance(hex_str, str) or not _HEX_COLOR_RE.fullmatch(hex_str):
        raise ValueError('Background color must be a 3- or 6-digit hex color')
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join(c * 2 for c in hex_str)
    return tuple(int(hex_str[i:i + 2], 16) for i in (0, 2, 4))


def _cover_resize(bg, size):
    """Scale `bg` to completely cover `size` (width, height), then centre-crop —
    the same "cover" behaviour as CSS background-size: cover, so the replacement
    background fills the frame without distortion or letterboxing."""
    target_w, target_h = size
    src_w, src_h = bg.size
    if src_w <= 0 or src_h <= 0:
        return bg.resize(size)
    scale = max(target_w / src_w, target_h / src_h)
    new_w, new_h = max(1, round(src_w * scale)), max(1, round(src_h * scale))
    bg = bg.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return bg.crop((left, top, left + target_w, top + target_h))


class BGRemover:
    def __init__(self):
        self.cancel_event = threading.Event()
        self._session = None
        self._remove = None
        self._session_lock = threading.Lock()

    def cancel(self):
        self.cancel_event.set()

    def reset_cancel(self):
        self.cancel_event.clear()

    def _get_backend(self):
        """Load rembg once and reuse its expensive ONNX session per batch."""
        with self._session_lock:
            if self._session is not None and self._remove is not None:
                return self._remove, self._session
            if self.cancel_event.is_set():
                raise RuntimeError('Cancelled')
            try:
                from rembg import new_session, remove
                session = new_session()
            except (Exception, SystemExit) as exc:
                raise RuntimeError(
                    'Background removal could not load its ONNX runtime. Run '
                    'the Python setup again, then restart MediaMelt.'
                ) from exc
            self._remove = remove
            self._session = session
            return remove, session

    def remove_background(self, input_path, output_path, progress_callback=None,
                          alpha_matting=False,
                          alpha_matting_foreground_threshold=240,
                          alpha_matting_background_threshold=10,
                          alpha_matting_erode_size=10,
                          output_format='png',
                          bg_mode='transparent',
                          bg_color='#FFFFFF',
                          bg_blur=25,
                          bg_image=''):
        if not _available:
            raise RuntimeError(
                'Background removal is unavailable because rembg or its ONNX '
                'runtime is not installed. Run the Python setup again.'
            )

        if not isinstance(input_path, str) or not os.path.isfile(input_path):
            raise FileNotFoundError(f'Input image not found: {input_path}')
        if not isinstance(output_path, str) or not output_path:
            raise ValueError('Output path is required')
        fmt = str(output_format).lower()
        if fmt not in _OUTPUT_FORMATS:
            raise ValueError(f'Unsupported background-removal output format: {output_format}')
        if bg_mode not in _BG_MODES:
            raise ValueError(f'Unsupported background mode: {bg_mode}')
        if not isinstance(alpha_matting, bool):
            raise ValueError('Alpha matting must be true or false')
        for value, label in (
            (alpha_matting_foreground_threshold, 'Foreground threshold'),
            (alpha_matting_background_threshold, 'Background threshold'),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 255:
                raise ValueError(f'{label} must be an integer from 0 to 255')
        if (not isinstance(alpha_matting_erode_size, int)
                or isinstance(alpha_matting_erode_size, bool)
                or not 0 <= alpha_matting_erode_size <= 255):
            raise ValueError('Alpha-matting erode size must be an integer from 0 to 255')
        if (alpha_matting
                and alpha_matting_foreground_threshold <= alpha_matting_background_threshold):
            raise ValueError('Foreground threshold must be greater than background threshold')
        if not isinstance(bg_blur, int) or isinstance(bg_blur, bool) or not 1 <= bg_blur <= 100:
            raise ValueError('Background blur must be an integer from 1 to 100')

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        # Heavy import and ONNX initialization are deferred until first use,
        # then cached so a batch does not reload the U2Net model for every file.
        remove, session = self._get_backend()

        if progress_callback:
            progress_callback(0.1, 'Loading image...')

        # ``convert`` eagerly copies pixel data, allowing the source file handle
        # to close before model inference (important for subsequent moves on
        # Windows).
        with Image.open(input_path) as source:
            if source.width * source.height > 100_000_000:
                raise ValueError('Input image is too large (maximum 100 megapixels)')
            img = source.convert('RGBA')

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            msg = 'Removing background (with edge refinement)...' if alpha_matting else 'Removing background...'
            progress_callback(0.3, msg)

        result = remove(
            img,
            session=session,
            alpha_matting=alpha_matting,
            alpha_matting_foreground_threshold=alpha_matting_foreground_threshold,
            alpha_matting_background_threshold=alpha_matting_background_threshold,
            alpha_matting_erode_size=alpha_matting_erode_size,
        )

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        # Apply background replacement based on bg_mode
        if bg_mode == 'color':
            if progress_callback:
                progress_callback(0.85, 'Applying solid color background...')
            rgb = _hex_to_rgb(bg_color)
            bg_layer = Image.new('RGBA', result.size, (*rgb, 255))
            bg_layer.paste(result, (0, 0), result)
            result = bg_layer

        elif bg_mode == 'blur':
            if progress_callback:
                progress_callback(0.85, 'Applying blurred background...')
            blurred = img.filter(ImageFilter.GaussianBlur(radius=bg_blur))
            blurred = blurred.convert('RGBA')
            blurred.paste(result, (0, 0), result)
            result = blurred

        elif bg_mode == 'image':
            if progress_callback:
                progress_callback(0.85, 'Applying image background...')
            if not isinstance(bg_image, str) or not bg_image or not os.path.isfile(bg_image):
                raise ValueError('No background image selected, or the file could not be found.')
            with Image.open(bg_image) as source_bg:
                if source_bg.width * source_bg.height > 100_000_000:
                    raise ValueError('Background image is too large (maximum 100 megapixels)')
                bg_layer = source_bg.convert('RGBA')
            bg_layer = _cover_resize(bg_layer, result.size)
            bg_layer.paste(result, (0, 0), result)
            result = bg_layer

        if progress_callback:
            progress_callback(0.9, 'Saving...')

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

        # Save beside the destination and atomically publish it. Cancellation,
        # codec errors, or a full disk can no longer leave a corrupt file that
        # looks complete to the UI.
        temp_output = f'{output_path}.{os.getpid()}.{threading.get_ident()}.part'
        try:
            result.save(temp_output, format=_OUTPUT_FORMATS[fmt])
            if self.cancel_event.is_set():
                raise RuntimeError('Cancelled')
            os.replace(temp_output, output_path)
        finally:
            try:
                os.remove(temp_output)
            except FileNotFoundError:
                pass

        if progress_callback:
            progress_callback(1.0, 'Complete')

        return output_path
