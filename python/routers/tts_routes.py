import asyncio
import os
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.tts import get_voices, synthesize
from routers.validation import validate_output_dir

router = APIRouter()


@router.websocket('/ws')
async def tts_ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            try:
                data = await ws.receive_json()
            except Exception:
                await ws.send_json({'type': 'error', 'error': 'Invalid message'})
                continue
            action = data.get('action')

            if action == 'list_voices':
                voices = await get_voices()
                await ws.send_json({'type': 'voices', 'voices': voices})

            elif action == 'synthesize':
                text = data.get('text', '')
                if not text or not text.strip():
                    await ws.send_json({'type': 'error', 'error': 'No text provided'})
                    continue
                if len(text) > 50000:
                    await ws.send_json({'type': 'error', 'error': f'Text too long ({len(text)} chars). Maximum is 50,000 characters.'})
                    continue
                voice = data.get('voice', 'en-US-AriaNeural')
                output_dir = data.get('output_dir', '')
                output_format = data.get('output_format', 'mp3')
                rate = data.get('rate', '+0%')
                is_preview = data.get('is_preview', False)

                if is_preview and output_dir == 'TEMP':
                    import tempfile
                    output_dir = tempfile.gettempdir()
                elif not output_dir:
                    output_dir = os.path.join(os.path.expanduser('~'), 'Desktop')
                else:
                    output_dir = validate_output_dir(output_dir)

                os.makedirs(output_dir, exist_ok=True)

                # Generate a filename from first few words
                words = text.strip().split()[:5]
                safe_name = '_'.join(w[:10] for w in words) if words else 'speech'
                safe_name = ''.join(c for c in safe_name if c.isalnum() or c in ('_', '-'))
                if is_preview:
                    safe_name = f'preview_{safe_name}_{os.urandom(4).hex()}'
                output_path = os.path.join(output_dir, f'{safe_name}.{output_format}')

                try:
                    async def on_progress(pct, status):
                        await ws.send_json({
                            'type': 'progress', 'progress': pct, 'status': status
                        })

                    await synthesize(text, voice, output_path, rate=rate,
                                     progress_callback=on_progress)

                    await ws.send_json({
                        'type': 'complete', 'output': output_path, 'progress': 1.0, 'is_preview': is_preview
                    })

                except Exception as e:
                    await ws.send_json({
                        'type': 'error', 'error': str(e)
                    })

    except WebSocketDisconnect:
        pass
