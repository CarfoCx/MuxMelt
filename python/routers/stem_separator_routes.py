import asyncio
import os
import queue as thread_queue
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.stem_separator import (
    SUPPORTED_MODELS,
    SUPPORTED_STEMS,
    StemSeparator,
)
from routers.validation import (
    validate_choice,
    validate_files_payload,
    validate_input_file,
    validate_output_dir,
)

router = APIRouter()

AUDIO_EXTENSIONS = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mkv', '.mov', '.webm'}
MEDIA_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS
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


async def _run_separation_locked(ws, separator, data):
    try:
        await _run_separation_batch(ws, separator, data)
    finally:
        _job_lock.release()


async def _run_separation_batch(ws, separator, data):
    try:
        files = validate_files_payload(data.get('files', []), max_files=200)
        if not files:
            raise ValueError('No files provided')
        model = validate_choice(
            data.get('model', 'htdemucs'), SUPPORTED_MODELS, 'Model'
        )
        stems = data.get('stems')
        if stems is not None:
            if not isinstance(stems, list) or not stems:
                raise ValueError('Stems must be a non-empty list or null')
            if any(not isinstance(stem, str) or stem not in SUPPORTED_STEMS for stem in stems):
                raise ValueError('Stems may only contain vocals, drums, bass, and other')
            stems = list(dict.fromkeys(stems))
        output_dir = validate_output_dir(data.get('output_dir', ''))
    except Exception as exc:
        await _send_batch_error(ws, data, str(exc))
        return

    jobs = []
    valid_files = []
    for original_path in files:
        try:
            file_path = validate_input_file(original_path, MEDIA_EXTENSIONS)
            out_dir = output_dir or str(Path(file_path).parent)
            os.makedirs(out_dir, exist_ok=True)
            jobs.append((file_path, out_dir))
            valid_files.append(file_path)
        except Exception as exc:
            await ws.send_json({
                'type': 'error', 'file': original_path, 'error': str(exc),
            })

    if not jobs:
        await ws.send_json({'type': 'all_complete'})
        return

    separator.reset_cancel()
    progress_q = thread_queue.Queue()

    def on_progress(file_path, pct, status):
        progress_q.put_nowait((file_path, pct, status))

    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(
        None,
        lambda: separator.separate_batch(jobs, model, stems, on_progress),
    )
    try:
        while not task.done():
            while not progress_q.empty():
                file_path, pct, status = progress_q.get_nowait()
                await ws.send_json({
                    'type': 'progress', 'file': file_path,
                    'progress': pct, 'status': status,
                })
            await asyncio.sleep(0.1)

        while not progress_q.empty():
            file_path, pct, status = progress_q.get_nowait()
            await ws.send_json({
                'type': 'progress', 'file': file_path,
                'progress': pct, 'status': status,
            })
        try:
            results = await task
        except Exception as exc:
            error = 'Cancelled' if separator.cancel_event.is_set() else str(exc)
            for file_path in valid_files:
                await ws.send_json({
                    'type': 'error', 'file': file_path, 'error': error,
                })
        else:
            for file_path in valid_files:
                await ws.send_json({
                    'type': 'complete', 'file': file_path,
                    'outputs': results.get(file_path, {}), 'progress': 1.0,
                })
    except BaseException:
        separator.cancel()
        try:
            await task
        except BaseException:
            pass
        raise

    await ws.send_json({'type': 'all_complete'})


@router.websocket('/ws')
async def stem_separator_ws(ws: WebSocket):
    await ws.accept()
    separator = StemSeparator()
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
            if action == 'separate':
                if job_task is not None and not job_task.done():
                    await _send_batch_error(ws, data, 'Stem separation is already running')
                    continue
                if job_task is not None:
                    try:
                        await job_task
                    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                        pass
                    except Exception:
                        pass
                if _job_lock.locked():
                    await _send_batch_error(ws, data, 'The stem separator is busy')
                    continue
                await _job_lock.acquire()
                job_task = asyncio.create_task(
                    _run_separation_locked(ws, separator, data)
                )
            elif action == 'cancel':
                separator.cancel()
            else:
                await ws.send_json({'type': 'error', 'error': f'Unknown action: {action}'})

    except WebSocketDisconnect:
        pass
    finally:
        separator.cancel()
        if job_task is not None:
            try:
                await job_task
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                pass
            except Exception:
                pass
