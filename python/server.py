import asyncio
import json
import os
import sys
import argparse
import queue as thread_queue
from pathlib import Path

from contextlib import asynccontextmanager

import torch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from upscaler import Upscaler, CancellationError

upscaler = None
available_modules = ['upscaler']


@asynccontextmanager
async def lifespan(app):
    global upscaler
    upscaler = Upscaler()
    yield

app = FastAPI(title='MuxMelt Backend', lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$',
    allow_methods=['*'],
    allow_headers=['*'],
)

# Register optional routers
try:
    from routers.bg_remover_routes import router as bg_router
    app.include_router(bg_router, prefix='/bg-remover')
    available_modules.append('bg-remover')
except ImportError:
    pass

try:
    from routers.stem_separator_routes import router as stem_router
    app.include_router(stem_router, prefix='/stem-separator')
    available_modules.append('stem-separator')
except ImportError:
    pass

try:
    from routers.tts_routes import router as tts_router
    app.include_router(tts_router, prefix='/tts')
    available_modules.append('tts')
except ImportError:
    pass

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mkv', '.mov', '.webm'}


def validate_output_dir(output_dir):
    """Validate and normalize output directory to prevent path traversal."""
    if not output_dir:
        return output_dir
    normalized = os.path.normpath(output_dir)
    if '..' in normalized.split(os.sep):
        raise ValueError('Invalid output directory: path traversal not allowed')
    if not os.path.isabs(normalized):
        raise ValueError('Output directory must be an absolute path')
    return normalized



@app.get('/health')
def health():
    has_ffmpeg = Upscaler.check_ffmpeg()
    vram_info = upscaler.get_vram_info() if upscaler else None

    result = {
        'status': 'ok',
        'device': upscaler.device if upscaler else 'loading',
        'ffmpeg': has_ffmpeg,
        'python_version': f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}',
        'modules': available_modules,
    }

    if vram_info:
        result['vram_total'] = vram_info['total']
        result['vram_used'] = vram_info['used']
        result['gpu_name'] = vram_info['gpu_name']
        result['gpu_util'] = vram_info.get('gpu_util')
        result['temperature'] = vram_info.get('temperature')

    return result


@app.get('/vram')
def vram():
    """Real-time GPU stats endpoint."""
    if not upscaler:
        return {'available': False}
    info = upscaler.get_vram_info()
    if not info:
        return {'available': False}
    return {
        'available': True,
        'total': info['total'],
        'used': info['used'],
        'free': info['free'],
        'gpu_name': info['gpu_name'],
        'gpu_util': info.get('gpu_util'),
        'mem_util': info.get('mem_util'),
        'temperature': info.get('temperature'),
    }


@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            try:
                data = await ws.receive_json()
            except Exception as json_err:
                await ws.send_json({'type': 'error', 'error': f'Invalid message: {str(json_err)}'})
                continue
            action = data.get('action')

            if action == 'upscale':
                upscaler.reset_cancel()

                files = data.get('files', [])
                if not files:
                    await ws.send_json({'type': 'error', 'error': 'No files provided'})
                    continue
                scale = data.get('scale', 4)
                if scale not in (2, 4):
                    await ws.send_json({'type': 'error', 'error': f'Invalid scale: {scale}. Must be 2 or 4.'})
                    continue
                output_format = data.get('output_format', 'same')
                output_dir = data.get('output_dir', '')
                profile = data.get('profile', 'general')

                # Pre-load model with progress feedback
                await ensure_model_with_progress(ws, scale, profile, files[0] if files else '')

                for file_path in files:
                    if upscaler.cancel_event.is_set():
                        await ws.send_json({
                            'type': 'error',
                            'file': file_path,
                            'error': 'Cancelled'
                        })
                        continue

                    await process_file(ws, file_path, scale, output_format, output_dir, profile)

                await ws.send_json({'type': 'all_complete'})

            elif action == 'cancel':
                upscaler.cancel()
                await send_log(ws, 'Cancellation requested...', 'warn')

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({'type': 'fatal_error', 'error': categorize_error(e)})
        except Exception:
            pass


async def send_log(ws, message, level='info'):
    """Send a log message to the frontend."""
    await ws.send_json({'type': 'log', 'message': message, 'level': level})


def categorize_error(e):
    """Return a user-friendly error message based on exception type."""
    msg = str(e)

    if isinstance(e, CancellationError):
        return 'Processing cancelled by user'

    if isinstance(e, FileNotFoundError):
        if 'ffmpeg' in msg.lower():
            return ('ffmpeg is not installed or not in PATH. '
                    'Video upscaling requires ffmpeg. '
                    'Install from https://ffmpeg.org/download.html')
        return f'File not found: {msg}'

    if isinstance(e, torch.cuda.OutOfMemoryError if hasattr(torch.cuda, 'OutOfMemoryError') else RuntimeError):
        if 'out of memory' in msg.lower() or 'CUDA out of memory' in msg:
            vram_info = ''
            if upscaler and upscaler.device == 'cuda':
                vram_gb = upscaler._vram_total / (1024 ** 3)
                vram_info = f' (Your GPU has {vram_gb:.0f}GB VRAM.)'
            return (f'GPU ran out of memory.{vram_info} Try: '
                    '1) Use 2x instead of 4x scale, '
                    '2) Close other GPU-intensive apps (games, browsers), '
                    '3) Use a smaller image/video, '
                    '4) Restart the app to clear GPU memory')

    if isinstance(e, RuntimeError):
        if 'ffmpeg' in msg.lower():
            return f'ffmpeg error: {msg}'
        if 'cuda' in msg.lower() or 'gpu' in msg.lower():
            return f'GPU error: {msg}'

    if isinstance(e, ValueError):
        return f'Invalid input: {msg}'

    return msg


async def ensure_model_with_progress(ws, scale, profile, first_file):
    """Load the model if needed, sending progress to the frontend."""
    if upscaler.is_model_loaded(scale, profile):
        return

    await ws.send_json({
        'type': 'model_loading',
        'file': first_file,
        'message': f'Loading {profile} {scale}x model...'
    })
    await send_log(ws, f'Loading {profile} {scale}x model (this may take a moment)...')

    progress_q = thread_queue.Queue()

    def on_progress(pct, status):
        progress_q.put_nowait((pct, status))

    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(
        None, lambda: upscaler._ensure_model(scale, profile, on_progress)
    )

    while not task.done():
        while not progress_q.empty():
            pct, status = progress_q.get_nowait()
            await send_log(ws, status)
        await asyncio.sleep(0.3)

    # Drain remaining
    while not progress_q.empty():
        pct, status = progress_q.get_nowait()
        await send_log(ws, status)

    await task  # Re-raise any exception

    await ws.send_json({'type': 'model_loaded', 'file': first_file})
    await send_log(ws, 'Model loaded successfully', 'success')


async def process_file(ws, file_path, scale, output_format, output_dir, profile):
    try:
        if not os.path.exists(file_path):
            await ws.send_json({'type': 'error', 'file': file_path, 'error': f'File not found: {file_path}'})
            return

        ext = Path(file_path).suffix.lower()
        name = Path(file_path).stem

        if output_format == 'same':
            out_ext = ext
        else:
            out_ext = f'.{output_format}'

        if output_dir:
            out_dir = validate_output_dir(output_dir)
        else:
            out_dir = str(Path(file_path).parent)

        os.makedirs(out_dir, exist_ok=True)
        output_path = os.path.join(out_dir, f'{name}_{scale}x{out_ext}')

        file_type = 'image' if ext in IMAGE_EXTENSIONS else 'video' if ext in VIDEO_EXTENSIONS else 'unknown'

        if file_type == 'video' and not Upscaler.check_ffmpeg():
            await ws.send_json({
                'type': 'error',
                'file': file_path,
                'error': 'ffmpeg is not installed. Video upscaling requires ffmpeg. '
                         'Install from https://ffmpeg.org/download.html'
            })
            return

        await send_log(ws, f'Queued {file_type}: {name}{ext} ({scale}x \u2192 {out_ext})')

        if ext in IMAGE_EXTENSIONS:
            await process_image(ws, file_path, output_path, scale, profile)
        elif ext in VIDEO_EXTENSIONS:
            actual_ext = out_ext.lstrip('.')
            await process_video(ws, file_path, output_path, scale, actual_ext, profile)
        else:
            await ws.send_json({
                'type': 'error',
                'file': file_path,
                'error': f'Unsupported file format: {ext}'
            })

    except CancellationError:
        await ws.send_json({
            'type': 'error',
            'file': file_path,
            'error': 'Cancelled'
        })
    except Exception as e:
        await ws.send_json({
            'type': 'error',
            'file': file_path,
            'error': categorize_error(e)
        })


async def process_image(ws, file_path, output_path, scale, profile):
    import cv2
    name = Path(file_path).name

    await ws.send_json({
        'type': 'progress',
        'file': file_path,
        'progress': 0.05,
        'status': 'Loading image...'
    })

    loop = asyncio.get_running_loop()
    img = await loop.run_in_executor(None, cv2.imread, file_path)
    if img is not None:
        h, w = img.shape[:2]
        await send_log(ws, f'Input: {name} ({w}x{h})')

    progress_q = thread_queue.Queue()

    def on_tile_progress(pct):
        progress_q.put_nowait(pct)

    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(
        None, lambda: upscaler.upscale_image(
            file_path, output_path, scale, profile, on_tile_progress
        )
    )

    while not task.done():
        last_pct = None
        while not progress_q.empty():
            last_pct = progress_q.get_nowait()
        if last_pct is not None:
            await ws.send_json({
                'type': 'progress',
                'file': file_path,
                'progress': 0.1 + last_pct * 0.85,
                'status': f'Upscaling... {int(last_pct * 100)}%'
            })
        await asyncio.sleep(0.2)

    # Drain
    while not progress_q.empty():
        progress_q.get_nowait()

    await task  # Re-raise exceptions

    out_img = await loop.run_in_executor(None, cv2.imread, output_path)
    if out_img is not None:
        oh, ow = out_img.shape[:2]
        await send_log(ws, f'Output: {Path(output_path).name} ({ow}x{oh})', 'success')

    await ws.send_json({
        'type': 'complete',
        'file': file_path,
        'output': output_path,
        'progress': 1.0
    })


async def process_video(ws, file_path, output_path, scale, output_ext, profile):
    import cv2
    name = Path(file_path).name

    cap = cv2.VideoCapture(file_path)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    await send_log(ws, f'Video: {name} ({w}x{h}, {fps:.1f}fps, {frames} frames)')

    progress_q = thread_queue.Queue()

    def on_progress(progress, status):
        progress_q.put_nowait((progress, status))

    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(
        None, upscaler.upscale_video, file_path, output_path, scale, output_ext,
        on_progress, profile
    )

    while not task.done():
        while not progress_q.empty():
            try:
                progress, status = progress_q.get_nowait()
                await ws.send_json({
                    'type': 'progress',
                    'file': file_path,
                    'progress': progress,
                    'status': status
                })
            except thread_queue.Empty:
                break
        await asyncio.sleep(0.2)

    # Drain remaining progress messages
    while not progress_q.empty():
        try:
            progress, status = progress_q.get_nowait()
            await ws.send_json({
                'type': 'progress',
                'file': file_path,
                'progress': progress,
                'status': status
            })
        except thread_queue.Empty:
            break

    await task

    await send_log(ws, f'Video complete: {Path(output_path).name} ({w*scale}x{h*scale})', 'success')

    await ws.send_json({
        'type': 'complete',
        'file': file_path,
        'output': output_path,
        'progress': 1.0
    })


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MuxMelt Backend')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Python version check
    v = sys.version_info
    print(f'Python {v.major}.{v.minor}.{v.micro}')
    if v.major != 3 or v.minor < 10:
        print('WARNING: Python 3.10+ is required for PyTorch compatibility')
    if v.minor >= 14:
        print('WARNING: Python 3.14+ may not be compatible with PyTorch')

    print(f'Starting MuxMelt backend on port {args.port}...')
    print(f'Available modules: {", ".join(available_modules)}')
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='info')
