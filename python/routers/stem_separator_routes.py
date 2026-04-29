import asyncio
import os
import queue as thread_queue
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.stem_separator import StemSeparator
from routers.validation import validate_output_dir


separator = None


@asynccontextmanager
async def stem_lifespan(app):
    global separator
    separator = StemSeparator()
    yield

router = APIRouter(lifespan=stem_lifespan)


AUDIO_EXTENSIONS = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mkv', '.mov', '.webm'}


@router.websocket('/ws')
async def stem_separator_ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            try:
                data = await ws.receive_json()
            except Exception:
                await ws.send_json({'type': 'error', 'error': 'Invalid message'})
                continue

            action = data.get('action')

            if action == 'separate':
                separator.reset_cancel()
                files = data.get('files', [])
                if not files:
                    await ws.send_json({'type': 'error', 'error': 'No files provided'})
                    continue

                model = data.get('model', 'htdemucs')
                stems = data.get('stems', None)  # None = all stems
                output_dir = data.get('output_dir', '')

                for file_path in files:
                    if separator.cancel_event.is_set():
                        await ws.send_json({
                            'type': 'error', 'file': file_path,
                            'error': 'Cancelled'
                        })
                        continue

                    if not os.path.exists(file_path):
                        await ws.send_json({
                            'type': 'error', 'file': file_path,
                            'error': f'File not found: {file_path}'
                        })
                        continue

                    try:
                        out_dir = validate_output_dir(output_dir) or str(Path(file_path).parent)
                        os.makedirs(out_dir, exist_ok=True)

                        progress_q = thread_queue.Queue()

                        def on_progress(pct, status, _fp=file_path):
                            progress_q.put_nowait((pct, status))

                        loop = asyncio.get_event_loop()
                        task = loop.run_in_executor(
                            None, separator.separate,
                            file_path, out_dir, model, stems, on_progress
                        )

                        while not task.done():
                            while not progress_q.empty():
                                pct, status = progress_q.get_nowait()
                                await ws.send_json({
                                    'type': 'progress', 'file': file_path,
                                    'progress': pct, 'status': status
                                })
                            await asyncio.sleep(0.3)

                        # Drain remaining
                        while not progress_q.empty():
                            pct, status = progress_q.get_nowait()
                            await ws.send_json({
                                'type': 'progress', 'file': file_path,
                                'progress': pct, 'status': status
                            })

                        outputs = await task

                        await ws.send_json({
                            'type': 'complete', 'file': file_path,
                            'outputs': outputs, 'progress': 1.0
                        })

                    except Exception as e:
                        await ws.send_json({
                            'type': 'error', 'file': file_path,
                            'error': str(e)
                        })

                await ws.send_json({'type': 'all_complete'})

            elif action == 'cancel':
                separator.cancel()

    except WebSocketDisconnect:
        pass
