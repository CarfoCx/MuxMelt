import asyncio
import os
import queue as thread_queue
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.bg_remover import BGRemover
from routers.validation import (
    next_output_path,
    validate_choice,
    validate_files_payload,
    validate_input_file,
    validate_int,
    validate_output_dir,
)

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}


router = APIRouter()
_job_lock = asyncio.Lock()


async def _send_batch_error(ws, data, message):
    files = data.get('files') if isinstance(data, dict) else None
    if isinstance(files, list):
        for file_path in files:
            if isinstance(file_path, str):
                await ws.send_json({
                    'type': 'error', 'file': file_path, 'error': message,
                })
    await ws.send_json({'type': 'all_complete'})


async def _run_remove_locked(ws, remover, data):
    try:
        await _run_remove_batch(ws, remover, data)
    finally:
        _job_lock.release()


async def _run_remove_batch(ws, remover, data):
    try:
        files = validate_files_payload(data.get('files', []), max_files=500)
        if not files:
            raise ValueError('No files provided')
        output_format = validate_choice(
            data.get('output_format', 'png'), {'png', 'webp', 'tiff'}, 'Output format'
        )
        output_dir = validate_output_dir(data.get('output_dir', ''))
        alpha_matting = data.get('alpha_matting', False)
        if not isinstance(alpha_matting, bool):
            raise ValueError('Alpha matting must be true or false')
        foreground_threshold = validate_int(
            data.get('alpha_matting_foreground_threshold', 240),
            'Foreground threshold', 0, 255,
        )
        background_threshold = validate_int(
            data.get('alpha_matting_background_threshold', 10),
            'Background threshold', 0, 255,
        )
        erode_size = validate_int(
            data.get('alpha_matting_erode_size', 10), 'Erode size', 0, 255
        )
        bg_mode = validate_choice(
            data.get('bg_mode', 'transparent'),
            {'transparent', 'color', 'blur', 'image'},
            'Background mode',
        )
        bg_color = data.get('bg_color', '#FFFFFF')
        if not isinstance(bg_color, str):
            raise ValueError('Background color must be a string')
        bg_blur = validate_int(data.get('bg_blur', 25), 'Background blur', 1, 100)
        bg_image = data.get('bg_image', '') or ''
        if bg_mode == 'image':
            bg_image = validate_input_file(bg_image, IMAGE_EXTENSIONS)
    except Exception as exc:
        await _send_batch_error(ws, data, str(exc))
        return

    remover.reset_cancel()
    for file_path in files:
        if remover.cancel_event.is_set():
            await ws.send_json({
                'type': 'error', 'file': file_path, 'error': 'Cancelled'
            })
            continue

        try:
            file_path = validate_input_file(file_path, IMAGE_EXTENSIONS)
            out_dir = output_dir or str(Path(file_path).parent)
            os.makedirs(out_dir, exist_ok=True)
            name = Path(file_path).stem
            output_path = next_output_path(
                out_dir, f'{name}_nobg', f'.{output_format}'
            )
            progress_q = thread_queue.Queue()

            def on_progress(pct, status):
                progress_q.put_nowait((pct, status))

            loop = asyncio.get_running_loop()
            task = loop.run_in_executor(
                None,
                lambda: remover.remove_background(
                    file_path, output_path, progress_callback=on_progress,
                    alpha_matting=alpha_matting,
                    alpha_matting_foreground_threshold=foreground_threshold,
                    alpha_matting_background_threshold=background_threshold,
                    alpha_matting_erode_size=erode_size,
                    output_format=output_format,
                    bg_mode=bg_mode,
                    bg_color=bg_color,
                    bg_blur=bg_blur,
                    bg_image=bg_image,
                ),
            )

            try:
                while not task.done():
                    while not progress_q.empty():
                        pct, status = progress_q.get_nowait()
                        await ws.send_json({
                            'type': 'progress', 'file': file_path,
                            'progress': pct, 'status': status,
                        })
                    await asyncio.sleep(0.1)

                while not progress_q.empty():
                    pct, status = progress_q.get_nowait()
                    await ws.send_json({
                        'type': 'progress', 'file': file_path,
                        'progress': pct, 'status': status,
                    })
                await task
            except BaseException:
                remover.cancel()
                try:
                    await task
                except BaseException:
                    pass
                raise
            await ws.send_json({
                'type': 'complete', 'file': file_path,
                'output': output_path, 'progress': 1.0,
            })
        except Exception as exc:
            error = 'Cancelled' if remover.cancel_event.is_set() else str(exc)
            await ws.send_json({
                'type': 'error', 'file': file_path, 'error': error,
            })

    await ws.send_json({'type': 'all_complete'})


@router.websocket('/ws')
async def bg_remover_ws(ws: WebSocket):
    await ws.accept()
    remover = BGRemover()
    job_task = None
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
            if action == 'remove':
                if job_task is not None and not job_task.done():
                    await _send_batch_error(ws, data, 'Background removal is already running')
                    continue
                if job_task is not None:
                    try:
                        await job_task
                    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                        pass
                    except Exception:
                        pass
                if _job_lock.locked():
                    await _send_batch_error(ws, data, 'The background remover is busy')
                    continue
                await _job_lock.acquire()
                job_task = asyncio.create_task(
                    _run_remove_locked(ws, remover, data)
                )
            elif action == 'cancel':
                remover.cancel()
            else:
                await ws.send_json({'type': 'error', 'error': f'Unknown action: {action}'})

    except WebSocketDisconnect:
        pass
    finally:
        remover.cancel()
        if job_task is not None:
            try:
                await job_task
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                pass
            except Exception:
                pass
