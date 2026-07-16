import asyncio
import math
import os
import secrets
import sys
import time
import argparse
import queue as thread_queue
from pathlib import Path
from PIL import Image

from contextlib import asynccontextmanager

import torch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from server_auth import TokenAuthMiddleware
from upscaler import MODEL_PROFILES, Upscaler, CancellationError
from routers.validation import (
    next_output_path,
    validate_choice,
    validate_files_payload,
    validate_input_file,
    validate_int,
    validate_output_dir,
)

upscaler = None
available_modules = ['upscaler']


@asynccontextmanager
async def lifespan(app):
    global upscaler
    upscaler = Upscaler()
    try:
        yield
    finally:
        upscaler.cancel()
        upscaler.close()

AUTH_TOKEN = None  # set from --token in __main__; gates every request when present

app = FastAPI(title='MuxMelt Backend', lifespan=lifespan)
# Added before CORS so CORS ends up the OUTER layer (reverse of add order):
# preflight/headers are handled by CORS, then the token gate runs.
app.add_middleware(TokenAuthMiddleware, get_token=lambda: AUTH_TOKEN)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['null'],
    allow_origin_regex=r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$',
    allow_methods=['*'],
    allow_headers=['*'],
)

# Register optional routers
try:
    from routers.bg_remover_routes import router as bg_router
    app.include_router(bg_router, prefix='/bg-remover')
    available_modules.append('bg-remover')
except ImportError as exc:
    print(f'Background remover router is unavailable: {exc}', file=sys.stderr)

try:
    from routers.stem_separator_routes import router as stem_router
    app.include_router(stem_router, prefix='/stem-separator')
    available_modules.append('stem-separator')
except ImportError as exc:
    print(f'Stem separator router is unavailable: {exc}', file=sys.stderr)

try:
    from routers.tts_routes import router as tts_router
    app.include_router(tts_router, prefix='/tts')
    available_modules.append('tts')
except ImportError as exc:
    print(f'TTS router is unavailable: {exc}', file=sys.stderr)

try:
    from routers.chat_routes import router as chat_router
    app.include_router(chat_router, prefix='/chat')
    available_modules.append('chat')
except ImportError as exc:
    print(f'Chat router is unavailable: {exc}', file=sys.stderr)

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mkv', '.mov', '.webm'}

# Only one upscale job may run at a time: the Upscaler is a process-global
# singleton with one shared cancel_event and one model cache, so a second
# concurrent job would have its cancellation crossed and its model evicted.
_upscale_in_progress = False


async def _run_upscale_batch(ws, data):
    global _upscale_in_progress
    try:
        try:
            files = validate_files_payload(data.get('files', []), max_files=500)
            if not files:
                raise ValueError('No files provided')
            scale = validate_int(data.get('scale', 4), 'Scale', 2, 4)
            if scale not in (2, 4):
                raise ValueError('Scale must be 2 or 4')
            output_format = validate_choice(
                data.get('output_format', 'same'),
                {'same', 'png', 'jpg', 'webp', 'mp4', 'mov', 'mkv', 'webm', 'avi'},
                'Output format',
            )
            output_dir = validate_output_dir(data.get('output_dir', ''))
            profile = validate_choice(
                data.get('profile', 'general'), set(MODEL_PROFILES), 'Profile'
            )
        except Exception as exc:
            await ws.send_json({'type': 'fatal_error', 'error': str(exc)})
            return

        upscaler.reset_cancel()
        first_supported = next(
            (
                file_path for file_path in files
                if os.path.isfile(file_path)
                and (
                    (Path(file_path).suffix.lower() in IMAGE_EXTENSIONS
                     and output_format in {'same', 'png', 'jpg', 'webp'})
                    or
                    (Path(file_path).suffix.lower() in VIDEO_EXTENSIONS
                     and output_format in {'same', 'mp4', 'mov', 'mkv', 'webm', 'avi'})
                )
            ),
            None,
        )
        if first_supported is not None:
            await ensure_model_with_progress(
                ws, scale, profile, first_supported
            )

        for file_path in files:
            if upscaler.cancel_event.is_set():
                await ws.send_json({
                    'type': 'error', 'file': file_path, 'error': 'Cancelled',
                })
                continue
            await process_file(
                ws, file_path, scale, output_format, output_dir, profile
            )
        await ws.send_json({'type': 'all_complete'})
    except WebSocketDisconnect:
        raise
    except Exception as exc:
        await ws.send_json({'type': 'fatal_error', 'error': categorize_error(exc)})
    finally:
        _upscale_in_progress = False



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


@app.get('/shutdown')
async def shutdown(token: str = None):
    """Allow Electron to stop the local backend before quitting."""
    expected_token = getattr(app.state, 'token', None)
    if (expected_token is not None
            and (not isinstance(token, str)
                 or not secrets.compare_digest(token, expected_token))):
        raise HTTPException(status_code=403, detail="Forbidden: Invalid token")

    async def stop_server():
        await asyncio.sleep(0.1)
        server = getattr(app.state, 'uvicorn_server', None)
        if server is not None:
            # Let Uvicorn close WebSockets and run lifespan cleanup. This is
            # essential for cancelling/reaping ffmpeg and Demucs children.
            server.should_exit = True

    asyncio.create_task(stop_server())
    return {'status': 'shutting_down'}


@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket):
    global _upscale_in_progress
    await ws.accept()
    job_task = None
    try:
        while True:
            try:
                data = await ws.receive_json()
            except WebSocketDisconnect:
                break
            except Exception as json_err:
                try:
                    await ws.send_json({'type': 'error', 'error': f'Invalid message: {str(json_err)}'})
                except Exception:
                    break
                continue
            if not isinstance(data, dict):
                await ws.send_json({'type': 'error', 'error': 'Message must be an object'})
                continue
            action = data.get('action')

            if action == 'upscale':
                if _upscale_in_progress:
                    await ws.send_json({
                        'type': 'fatal_error',
                        'error': 'The upscaler is already processing another job. Wait for it to finish before starting a new one.'
                    })
                    continue

                _upscale_in_progress = True
                job_task = asyncio.create_task(_run_upscale_batch(ws, data))

            elif action == 'cancel':
                if job_task is not None and not job_task.done():
                    upscaler.cancel()
                    await send_log(ws, 'Cancellation requested...', 'warn')
            else:
                await ws.send_json({'type': 'error', 'error': f'Unknown action: {action}'})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({'type': 'fatal_error', 'error': categorize_error(e)})
        except Exception:
            pass
    finally:
        if job_task is not None and not job_task.done():
            upscaler.cancel()
        if job_task is not None:
            try:
                await job_task
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                pass
            except Exception:
                pass


async def send_log(ws, message, level='info'):
    """Send a log message to the frontend."""
    await ws.send_json({'type': 'log', 'message': message, 'level': level})


def _is_oom_error(e):
    """True for a CUDA/GPU out-of-memory condition. Prefers torch's dedicated
    OutOfMemoryError when the installed torch exposes it, but always falls back
    to message sniffing so older torch (where OOM surfaces as a plain
    RuntimeError) is still recognised — without misclassifying every
    RuntimeError as OOM."""
    if 'out of memory' not in str(e).lower():
        return False
    oom_type = getattr(torch.cuda, 'OutOfMemoryError', None)
    if oom_type is not None and isinstance(e, oom_type):
        return True
    return isinstance(e, RuntimeError)


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
        return msg if msg.lower().startswith('file not found:') else f'File not found: {msg}'

    if _is_oom_error(e):
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

    try:
        while not task.done():
            while not progress_q.empty():
                pct, status = progress_q.get_nowait()
                await ws.send_json({
                    'type': 'model_progress',
                    'file': first_file,
                    'progress': pct,
                    'status': status
                })
            await asyncio.sleep(0.1)

        while not progress_q.empty():
            pct, status = progress_q.get_nowait()
            await ws.send_json({
                'type': 'model_progress',
                'file': first_file,
                'progress': pct,
                'status': status
            })
        await task
    except BaseException:
        upscaler.cancel()
        try:
            await task
        except BaseException:
            pass
        raise

    await ws.send_json({'type': 'model_loaded', 'file': first_file})
    await send_log(ws, 'Model loaded successfully', 'success')


async def process_file(ws, file_path, scale, output_format, output_dir, profile):
    try:
        file_path = validate_input_file(
            file_path, IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
        )
        ext = Path(file_path).suffix.lower()
        name = Path(file_path).stem
        file_type = 'image' if ext in IMAGE_EXTENSIONS else 'video'

        allowed_outputs = (
            {'same', 'png', 'jpg', 'webp'}
            if file_type == 'image'
            else {'same', 'mp4', 'mov', 'mkv', 'webm', 'avi'}
        )
        if output_format not in allowed_outputs:
            raise ValueError(
                f'{output_format.upper()} is not a valid {file_type} output format'
            )

        if output_format == 'same':
            out_ext = ext
        else:
            out_ext = f'.{output_format}'

        if output_dir:
            out_dir = validate_output_dir(output_dir)
        else:
            out_dir = str(Path(file_path).parent)

        os.makedirs(out_dir, exist_ok=True)
        output_path = next_output_path(out_dir, f'{name}_{scale}x', out_ext)

        if file_type == 'video' and not Upscaler.check_ffmpeg():
            await ws.send_json({
                'type': 'error',
                'file': file_path,
                'error': 'ffmpeg is not installed. Video upscaling requires ffmpeg. '
                         'Install from https://ffmpeg.org/download.html'
            })
            return

        await send_log(ws, f'Queued {file_type}: {name}{ext} ({scale}x \u2192 {out_ext})')

        if file_type == 'image':
            await process_image(ws, file_path, output_path, scale, profile)
        else:
            actual_ext = out_ext.lstrip('.')
            await process_video(ws, file_path, output_path, scale, actual_ext, profile)

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
    name = Path(file_path).name
    started = time.monotonic()
    megapixels = None
    input_dimensions = None

    await ws.send_json({
        'type': 'progress',
        'file': file_path,
        'progress': 0.05,
        'status': 'Loading image...'
    })

    loop = asyncio.get_running_loop()
    def read_dimensions(path):
        # Pillow reads container headers lazily; it does not allocate/decode a
        # full pixel array just to obtain width and height.
        with Image.open(path) as image:
            return image.size

    try:
        w, h = await loop.run_in_executor(None, read_dimensions, file_path)
        input_dimensions = (w, h)
        megapixels = (w * h) / 1_000_000
        await send_log(ws, f'Input: {name} ({w}x{h})')
    except (OSError, ValueError):
        pass

    progress_q = thread_queue.Queue()

    def on_tile_progress(pct):
        progress_q.put_nowait(pct)

    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(
        None, lambda: upscaler.upscale_image(
            file_path, output_path, scale, profile, on_tile_progress
        )
    )

    try:
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
            await asyncio.sleep(0.1)

        while not progress_q.empty():
            progress_q.get_nowait()
        await task
    except BaseException:
        upscaler.cancel()
        try:
            await task
        except BaseException:
            pass
        raise

    if input_dimensions:
        ow, oh = input_dimensions[0] * scale, input_dimensions[1] * scale
        await send_log(ws, f'Output: {Path(output_path).name} ({ow}x{oh})', 'success')

    await ws.send_json({
        'type': 'complete',
        'file': file_path,
        'output': output_path,
        'progress': 1.0,
        'megapixels': megapixels,
        'elapsed': time.monotonic() - started,
    })


async def process_video(ws, file_path, output_path, scale, output_ext, profile):
    import cv2
    name = Path(file_path).name
    started = time.monotonic()

    def probe_video():
        cap = cv2.VideoCapture(file_path)
        try:
            if not cap.isOpened():
                return 0, 0, 0.0, 0
            width = max(0, int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)))
            height = max(0, int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
            frame_rate = float(cap.get(cv2.CAP_PROP_FPS))
            raw_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            frame_count = max(0, int(raw_count)) if math.isfinite(raw_count) else 0
            return width, height, frame_rate, frame_count
        finally:
            cap.release()

    loop = asyncio.get_running_loop()
    w, h, fps, frames = await loop.run_in_executor(None, probe_video)
    await send_log(ws, f'Video: {name} ({w}x{h}, {fps:.1f}fps, {frames} frames)')

    progress_q = thread_queue.Queue()

    def on_progress(progress, status):
        progress_q.put_nowait((progress, status))

    task = loop.run_in_executor(
        None, upscaler.upscale_video, file_path, output_path, scale, output_ext,
        on_progress, profile
    )

    try:
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
            await asyncio.sleep(0.1)

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
    except BaseException:
        upscaler.cancel()
        try:
            await task
        except BaseException:
            pass
        raise

    await send_log(ws, f'Video complete: {Path(output_path).name} ({w*scale}x{h*scale})', 'success')

    await ws.send_json({
        'type': 'complete',
        'file': file_path,
        'output': output_path,
        'progress': 1.0,
        'megapixels': (w * h * frames) / 1_000_000 if frames > 0 else None,
        'elapsed': time.monotonic() - started,
    })


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MuxMelt Backend')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--token', type=str, default=None)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')

    app.state.token = args.token
    AUTH_TOKEN = args.token

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Python version check
    v = sys.version_info
    print(f'Python {v.major}.{v.minor}.{v.micro}')
    if v.major != 3 or not 11 <= v.minor <= 13:
        print(
            'ERROR: Python 3.11 through 3.13 is required by the current media dependencies.',
            file=sys.stderr,
        )
        sys.exit(2)

    print(f'Starting MuxMelt backend on port {args.port}...')
    print(f'Available modules: {", ".join(available_modules)}')
    # Tokens travel in the query string because browser WebSockets cannot set a
    # custom auth header. Disable access logs so those credentials are never
    # copied into Electron's console/log stream.
    config = uvicorn.Config(
        app, host='127.0.0.1', port=args.port,
        # Uvicorn's INFO-level WebSocket handshake log also includes the query
        # string, so WARNING is required in addition to access_log=False.
        log_level='warning', access_log=False,
    )
    server = uvicorn.Server(config)
    app.state.uvicorn_server = server
    server.run()
