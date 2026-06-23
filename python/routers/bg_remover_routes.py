import asyncio
import os
import queue as thread_queue
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.bg_remover import BGRemover
from routers.validation import validate_output_dir

remover = BGRemover()

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'}


router = APIRouter()


@router.websocket('/ws')
async def bg_remover_ws(ws: WebSocket):
    await ws.accept()
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
            action = data.get('action')

            if action == 'remove':
                remover.reset_cancel()
                files = data.get('files', [])
                output_format = data.get('output_format', 'png')
                output_dir = data.get('output_dir', '')
                alpha_matting = bool(data.get('alpha_matting', False))
                alpha_matting_foreground_threshold = int(data.get('alpha_matting_foreground_threshold', 240))
                alpha_matting_background_threshold = int(data.get('alpha_matting_background_threshold', 10))
                alpha_matting_erode_size = int(data.get('alpha_matting_erode_size', 10))
                bg_mode = data.get('bg_mode', 'transparent')
                bg_color = data.get('bg_color', '#FFFFFF')
                bg_blur = int(data.get('bg_blur', 25))
                bg_image = data.get('bg_image', '') or ''

                for file_path in files:
                    if remover.cancel_event.is_set():
                        await ws.send_json({'type': 'error', 'file': file_path, 'error': 'Cancelled'})
                        continue

                    try:
                        name = Path(file_path).stem
                        out_ext = f'.{output_format}'
                        out_dir = validate_output_dir(output_dir) or str(Path(file_path).parent)
                        os.makedirs(out_dir, exist_ok=True)
                        base_output = f'{name}_nobg{out_ext}'
                        output_path = os.path.join(out_dir, base_output)
                        counter = 1
                        while os.path.exists(output_path):
                            output_path = os.path.join(out_dir, f'{name}_nobg_{counter}{out_ext}')
                            counter += 1

                        progress_q = thread_queue.Queue()

                        def on_progress(pct, status, _fp=file_path):
                            progress_q.put_nowait((pct, status))

                        loop = asyncio.get_running_loop()

                        def _run_removal(_fp=file_path, _op=output_path, _cb=on_progress,
                                         _am=alpha_matting,
                                         _am_fg=alpha_matting_foreground_threshold,
                                         _am_bg=alpha_matting_background_threshold,
                                         _am_er=alpha_matting_erode_size,
                                         _fmt=output_format,
                                         _bgm=bg_mode,
                                         _bgc=bg_color,
                                         _bgb=bg_blur,
                                         _bgi=bg_image):
                            return remover.remove_background(
                                _fp, _op, progress_callback=_cb,
                                alpha_matting=_am,
                                alpha_matting_foreground_threshold=_am_fg,
                                alpha_matting_background_threshold=_am_bg,
                                alpha_matting_erode_size=_am_er,
                                output_format=_fmt,
                                bg_mode=_bgm,
                                bg_color=_bgc,
                                bg_blur=_bgb,
                                bg_image=_bgi,
                            )

                        task = loop.run_in_executor(None, _run_removal)

                        while not task.done():
                            while not progress_q.empty():
                                pct, status = progress_q.get_nowait()
                                await ws.send_json({
                                    'type': 'progress', 'file': file_path,
                                    'progress': pct, 'status': status
                                })
                            await asyncio.sleep(0.2)

                        while not progress_q.empty():
                            pct, status = progress_q.get_nowait()
                            await ws.send_json({
                                'type': 'progress', 'file': file_path,
                                'progress': pct, 'status': status
                            })

                        await task

                        await ws.send_json({
                            'type': 'complete', 'file': file_path,
                            'output': output_path, 'progress': 1.0
                        })

                    except Exception as e:
                        await ws.send_json({
                            'type': 'error', 'file': file_path,
                            'error': str(e)
                        })

                await ws.send_json({'type': 'all_complete'})

            elif action == 'cancel':
                remover.cancel()

    except WebSocketDisconnect:
        pass
