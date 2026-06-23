import os
import threading
from importlib.util import find_spec
from pathlib import Path

from PIL import Image, ImageFilter

# rembg pulls in onnxruntime, a heavy import that previously ran at server
# startup just by importing this module. Defer it until a background actually
# needs removing (first use), and probe availability cheaply via find_spec so
# startup stays fast. This mirrors how the stem separator defers demucs.
_available = find_spec('rembg') is not None


def is_available():
    return _available


def _hex_to_rgb(hex_str):
    """Convert a hex color string like '#FF0000' to an (R, G, B) tuple."""
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

    def cancel(self):
        self.cancel_event.set()

    def reset_cancel(self):
        self.cancel_event.clear()

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
            raise RuntimeError('rembg is not installed. Run: pip install rembg[gpu]')

        # Heavy import, deferred to first use (cached by Python afterwards).
        from rembg import remove

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            progress_callback(0.1, 'Loading image...')

        img = Image.open(input_path).convert('RGBA')

        if self.cancel_event.is_set():
            raise RuntimeError('Cancelled')

        if progress_callback:
            msg = 'Removing background (with edge refinement)...' if alpha_matting else 'Removing background...'
            progress_callback(0.3, msg)

        result = remove(
            img,
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
            blur_radius = max(1, int(bg_blur))
            blurred = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))
            blurred = blurred.convert('RGBA')
            blurred.paste(result, (0, 0), result)
            result = blurred

        elif bg_mode == 'image':
            if progress_callback:
                progress_callback(0.85, 'Applying image background...')
            if not bg_image or not os.path.isfile(bg_image):
                raise ValueError('No background image selected, or the file could not be found.')
            bg_layer = Image.open(bg_image).convert('RGBA')
            bg_layer = _cover_resize(bg_layer, result.size)
            bg_layer.paste(result, (0, 0), result)
            result = bg_layer

        if progress_callback:
            progress_callback(0.9, 'Saving...')

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

        fmt = output_format.lower()
        if fmt == 'webp':
            result.save(output_path, format='WEBP')
        elif fmt == 'tiff':
            result.save(output_path, format='TIFF')
        else:
            result.save(output_path, format='PNG')

        if progress_callback:
            progress_callback(1.0, 'Complete')

        return output_path
