import asyncio
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.tts import get_voices, synthesize
from routers.validation import next_output_path, validate_choice, validate_output_dir

router = APIRouter()
_job_lock = asyncio.Lock()


def _cleanup_previews(preview_paths, requested_path=None):
    """Delete only preview files created by this WebSocket connection."""
    if preview_paths is None:
        return
    if requested_path is None:
        targets = list(preview_paths)
    else:
        targets = [requested_path] if requested_path in preview_paths else []
    for preview_path in targets:
        try:
            os.remove(preview_path)
        except FileNotFoundError:
            pass
        except OSError:
            # A media player may still hold the file open on Windows; retry on
            # the next preview or when the socket disconnects.
            continue
        preview_paths.discard(preview_path)


async def _run_synthesis_locked(ws, data, preview_paths=None):
    try:
        await _run_synthesis(ws, data, preview_paths)
    finally:
        _job_lock.release()


async def _run_synthesis(ws, data, preview_paths=None):
    output_path = None
    try:
        text = data.get('text', '')
        if not isinstance(text, str) or not text.strip():
            raise ValueError('No text provided')
        if len(text) > 50_000:
            raise ValueError(
                f'Text too long ({len(text)} chars). Maximum is 50,000 characters.'
            )
        voice = data.get('voice', 'en-US-AriaNeural')
        if not isinstance(voice, str) or not voice:
            raise ValueError('A voice must be selected')
        output_format = validate_choice(
            data.get('output_format', 'mp3'), {'mp3', 'wav'}, 'Output format'
        )
        rate = data.get('rate', '+0%')
        pitch = data.get('pitch', '+0Hz')
        is_preview = data.get('is_preview', False)
        if not isinstance(is_preview, bool):
            raise ValueError('is_preview must be true or false')

        output_dir = data.get('output_dir', '')
        if is_preview and output_dir == 'TEMP':
            import tempfile
            output_dir = tempfile.gettempdir()
        elif not output_dir:
            output_dir = os.path.join(os.path.expanduser('~'), 'Desktop')
        else:
            output_dir = validate_output_dir(output_dir)
        os.makedirs(output_dir, exist_ok=True)

        words = text.strip().split()[:5]
        safe_name = '_'.join(word[:10] for word in words) if words else 'speech'
        safe_name = ''.join(
            character for character in safe_name
            if character.isalnum() or character in ('_', '-')
        ) or 'speech'
        windows_reserved = {
            'CON', 'PRN', 'AUX', 'NUL',
            *(f'COM{i}' for i in range(1, 10)),
            *(f'LPT{i}' for i in range(1, 10)),
        }
        if safe_name.upper() in windows_reserved:
            safe_name = f'speech_{safe_name}'
        if is_preview:
            safe_name = f'preview_{safe_name}_{os.urandom(4).hex()}'
        output_path = next_output_path(output_dir, safe_name, f'.{output_format}')

        async def on_progress(pct, status):
            await ws.send_json({
                'type': 'progress', 'progress': pct, 'status': status,
            })

        await synthesize(
            text, voice, output_path, rate=rate, pitch=pitch,
            progress_callback=on_progress,
        )
        if is_preview and preview_paths is not None:
            preview_paths.add(output_path)
        await ws.send_json({
            'type': 'complete', 'output': output_path,
            'progress': 1.0, 'is_preview': is_preview,
        })
    except asyncio.CancelledError:
        if output_path:
            try:
                os.remove(output_path)
            except OSError:
                pass
            if preview_paths is not None:
                preview_paths.discard(output_path)
        try:
            await ws.send_json({'type': 'error', 'error': 'Cancelled'})
        except (WebSocketDisconnect, RuntimeError):
            pass
    except Exception as exc:
        await ws.send_json({'type': 'error', 'error': str(exc)})


@router.websocket('/ws')
async def tts_ws(ws: WebSocket):
    await ws.accept()
    job_task = None
    preview_paths = set()
    try:
        while True:
            try:
                data = await ws.receive_json()
            except WebSocketDisconnect:
                raise
            except Exception:
                try:
                    await ws.send_json({'type': 'error', 'error': 'Invalid message'})
                except (WebSocketDisconnect, RuntimeError):
                    return
                continue
            if not isinstance(data, dict):
                await ws.send_json({'type': 'error', 'error': 'Message must be an object'})
                continue
            action = data.get('action')

            if action == 'list_voices':
                try:
                    voices = await get_voices()
                    await ws.send_json({'type': 'voices', 'voices': voices})
                except Exception as exc:
                    await ws.send_json({'type': 'error', 'error': str(exc)})

            elif action == 'synthesize':
                if job_task is not None and not job_task.done():
                    await ws.send_json({'type': 'error', 'error': 'Speech generation is already running'})
                    continue
                if job_task is not None:
                    try:
                        await job_task
                    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                        pass
                    except Exception:
                        pass
                if _job_lock.locked():
                    await ws.send_json({'type': 'error', 'error': 'The speech generator is busy'})
                    continue
                _cleanup_previews(preview_paths)
                await _job_lock.acquire()
                job_task = asyncio.create_task(
                    _run_synthesis_locked(ws, data, preview_paths)
                )
            elif action == 'cancel':
                if job_task is not None and not job_task.done():
                    job_task.cancel()
            elif action == 'cleanup_preview':
                requested_path = data.get('path')
                if isinstance(requested_path, str):
                    _cleanup_previews(preview_paths, requested_path)
            else:
                await ws.send_json({'type': 'error', 'error': f'Unknown action: {action}'})

    except WebSocketDisconnect:
        pass
    finally:
        if job_task is not None and not job_task.done():
            job_task.cancel()
        if job_task is not None:
            try:
                await job_task
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                pass
            except Exception:
                pass
        _cleanup_previews(preview_paths)
