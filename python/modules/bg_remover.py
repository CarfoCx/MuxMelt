import os
import threading
from pathlib import Path

try:
    from rembg import remove
    from PIL import Image, ImageFilter
    _available = True
except ImportError:
    _available = False


def is_available():
    return _available


def _hex_to_rgb(hex_str):
    """Convert a hex color string like '#FF0000' to an (R, G, B) tuple."""
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join(c * 2 for c in hex_str)
    return tuple(int(hex_str[i:i + 2], 16) for i in (0, 2, 4))


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
                          bg_blur=25):
        if not _available:
            raise RuntimeError('rembg is not installed. Run: pip install rembg[gpu]')

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
