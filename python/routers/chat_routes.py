"""WebSocket router for the local chatbot. Mirrors the streaming pattern used
by the TTS/bg-remover routers: heavy work runs in a thread executor and pushes
to a thread queue that the async loop drains and forwards to the client."""

import asyncio
import queue as thread_queue

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.llm import ChatLLM, DEFAULT_MODEL, is_available

llm = ChatLLM()
router = APIRouter()

DEFAULT_SYSTEM_PROMPT = (
    'You are a helpful, knowledgeable assistant built into MuxMelt, a local '
    "media toolkit. Everything runs offline on the user's own computer.\n"
    '- Give a direct, accurate answer first, then add detail only if useful.\n'
    '- If you are not sure or do not know, say so plainly. Never invent facts, '
    'names, numbers, dates, quotes, or citations to fill a gap.\n'
    '- For math, logic, or code, work through the steps carefully before '
    'committing to a final answer.\n'
    '- Keep it focused; skip filler and repetition.'
)

# User-facing answer styles mapped to llama.cpp sampling settings. "Precise"
# favours determinism/accuracy (low temperature, tight nucleus); "Creative"
# loosens it for brainstorming. The default mirrors the old behaviour.
STYLE_PRESETS = {
    'precise':  {'temperature': 0.2, 'top_p': 0.90, 'top_k': 40, 'repeat_penalty': 1.1, 'min_p': 0.05},
    'balanced': {'temperature': 0.6, 'top_p': 0.95, 'top_k': 40, 'repeat_penalty': 1.1, 'min_p': 0.05},
    'creative': {'temperature': 0.9, 'top_p': 0.98, 'top_k': 80, 'repeat_penalty': 1.1, 'min_p': 0.02},
}
DEFAULT_STYLE = 'balanced'

# Keep only the most recent turns so we never overflow the model context.
MAX_HISTORY_MESSAGES = 12


@router.websocket('/ws')
async def chat_ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            try:
                data = await ws.receive_json()
            except WebSocketDisconnect:
                break
            except Exception:
                try:
                    await ws.send_json({'type': 'error', 'error': 'Invalid message'})
                except Exception:
                    break
                continue

            action = data.get('action')
            if action == 'list_models':
                await ws.send_json({
                    'type': 'models',
                    'models': llm.list_models(),
                    'default': DEFAULT_MODEL,
                    'engine': is_available(),
                })
            elif action == 'download':
                await _handle_download(ws, data)
            elif action == 'chat':
                await _handle_chat(ws, data)
            elif action == 'cancel':
                llm.cancel()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({'type': 'error', 'error': str(e)})
        except Exception:
            pass


async def _handle_download(ws, data):
    model_id = data.get('model') or DEFAULT_MODEL
    llm.reset_cancel()
    loop = asyncio.get_running_loop()
    q = thread_queue.Queue()

    def cb(frac, done, total):
        q.put_nowait((frac, done, total))

    task = loop.run_in_executor(None, lambda: llm.download(model_id, cb))
    await ws.send_json({'type': 'download_start', 'model': model_id})

    try:
        while not task.done():
            last = None
            while not q.empty():
                last = q.get_nowait()
            if last:
                await ws.send_json({
                    'type': 'download_progress', 'model': model_id,
                    'progress': last[0], 'downloaded': last[1], 'total': last[2],
                })
            await asyncio.sleep(0.2)
        await task
        await ws.send_json({'type': 'download_complete', 'model': model_id})
    except Exception as e:
        await ws.send_json({'type': 'download_error', 'model': model_id, 'error': str(e)})


async def _handle_chat(ws, data):
    model_id = data.get('model') or DEFAULT_MODEL
    user_messages = data.get('messages') or []

    if not llm.is_downloaded(model_id):
        await ws.send_json({'type': 'need_download', 'model': model_id})
        return

    # Prepend the system prompt and trim history.
    messages = [{'role': 'system', 'content': DEFAULT_SYSTEM_PROMPT}]
    messages.extend(user_messages[-MAX_HISTORY_MESSAGES:])

    llm.reset_cancel()
    loop = asyncio.get_running_loop()

    try:
        # Load (can take a few seconds the first time) with a status ping.
        status_q = thread_queue.Queue()
        load_task = loop.run_in_executor(
            None, lambda: llm.ensure_loaded(model_id, status_q.put_nowait)
        )
        while not load_task.done():
            while not status_q.empty():
                await ws.send_json({'type': 'status', 'message': status_q.get_nowait()})
            await asyncio.sleep(0.1)
        await load_task

        token_q = thread_queue.Queue()
        max_tokens = int(data.get('max_tokens', 512))
        # Resolve the answer style into sampling params; an explicit temperature
        # in the payload still wins (back-compat with older callers).
        preset = dict(STYLE_PRESETS.get(data.get('style'), STYLE_PRESETS[DEFAULT_STYLE]))
        if data.get('temperature') is not None:
            preset['temperature'] = float(data.get('temperature'))
        gen_task = loop.run_in_executor(
            None,
            lambda: llm.chat_stream(messages, token_q.put_nowait, max_tokens, **preset),
        )

        await ws.send_json({'type': 'start'})
        while not gen_task.done():
            while not token_q.empty():
                await ws.send_json({'type': 'token', 'text': token_q.get_nowait()})
            await asyncio.sleep(0.02)
        while not token_q.empty():
            await ws.send_json({'type': 'token', 'text': token_q.get_nowait()})
        await gen_task

        await ws.send_json({'type': 'done'})
    except Exception as e:
        await ws.send_json({'type': 'error', 'error': str(e)})
