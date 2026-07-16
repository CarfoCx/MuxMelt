"""WebSocket router for the local chatbot. Mirrors the streaming pattern used
by the TTS/bg-remover routers: heavy work runs in a thread executor and pushes
to a thread queue that the async loop drains and forwards to the client."""

import asyncio
import queue as thread_queue

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from modules.llm import ChatLLM, DEFAULT_MODEL, MODELS, is_available
from routers.validation import validate_choice, validate_float, validate_int

llm = ChatLLM()
router = APIRouter()
_operation_lock = asyncio.Lock()

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
MAX_MESSAGE_CHARS = 8_000


def _validate_messages(value):
    if not isinstance(value, list) or not value:
        raise ValueError('Messages must be a non-empty list')
    result = []
    total_chars = 0
    for message in value[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(message, dict):
            raise ValueError('Each chat message must be an object')
        role = message.get('role')
        if role not in ('user', 'assistant'):
            raise ValueError('Chat message roles must be user or assistant')
        content = message.get('content')
        if not isinstance(content, str) or not content.strip():
            raise ValueError('Chat message content cannot be empty')
        if len(content) > MAX_MESSAGE_CHARS:
            raise ValueError('A chat message is too long')
        total_chars += len(content)
        result.append({'role': role, 'content': content})
    if total_chars > MAX_MESSAGE_CHARS:
        raise ValueError('Chat history is too long; start a new conversation')
    if result[-1]['role'] != 'user':
        raise ValueError('The last chat message must be from the user')
    return result


async def _run_locked(handler, ws, data):
    try:
        await handler(ws, data)
    finally:
        _operation_lock.release()


async def _send_cancelled(ws):
    """Terminate the renderer's pending state when a live socket cancels."""
    try:
        await ws.send_json({'type': 'cancelled'})
    except (WebSocketDisconnect, RuntimeError):
        # A disconnect is itself a cancellation; there is no client left to
        # acknowledge it and it should not be converted into an error.
        pass


@router.websocket('/ws')
async def chat_ws(ws: WebSocket):
    await ws.accept()
    job_task = None
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

            if not isinstance(data, dict):
                await ws.send_json({'type': 'error', 'error': 'Message must be an object'})
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
                if job_task is not None and not job_task.done():
                    await ws.send_json({'type': 'download_error', 'error': 'Another chat operation is already running'})
                    continue
                if _operation_lock.locked():
                    await ws.send_json({'type': 'download_error', 'error': 'The chat engine is busy'})
                    continue
                await _operation_lock.acquire()
                llm.reset_cancel()
                job_task = asyncio.create_task(
                    _run_locked(_handle_download, ws, data)
                )
            elif action == 'chat':
                if job_task is not None and not job_task.done():
                    await ws.send_json({'type': 'error', 'error': 'Another chat operation is already running'})
                    continue
                if _operation_lock.locked():
                    await ws.send_json({'type': 'error', 'error': 'The chat engine is busy'})
                    continue
                await _operation_lock.acquire()
                llm.reset_cancel()
                job_task = asyncio.create_task(
                    _run_locked(_handle_chat, ws, data)
                )
            elif action == 'cancel':
                if job_task is not None and not job_task.done():
                    llm.cancel()
            else:
                await ws.send_json({'type': 'error', 'error': f'Unknown action: {action}'})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({'type': 'error', 'error': str(e)})
        except Exception:
            pass
    finally:
        if job_task is not None and not job_task.done():
            llm.cancel()
        if job_task is not None:
            try:
                await job_task
            except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
                pass
            except Exception:
                pass


async def _handle_download(ws, data):
    model_id = data.get('model') or DEFAULT_MODEL
    if model_id not in MODELS:
        await ws.send_json({
            'type': 'download_error', 'model': model_id,
            'error': f'Unknown model: {model_id}',
        })
        return
    loop = asyncio.get_running_loop()
    q = thread_queue.Queue()

    def cb(frac, done, total):
        q.put_nowait((frac, done, total))

    task = loop.run_in_executor(None, lambda: llm.download(model_id, cb))
    try:
        await ws.send_json({'type': 'download_start', 'model': model_id})
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
    except BaseException as exc:
        llm.cancel()
        try:
            await task
        except BaseException:
            pass
        if isinstance(exc, asyncio.CancelledError):
            raise
        await ws.send_json({
            'type': 'download_error', 'model': model_id, 'error': str(exc),
        })


async def _handle_chat(ws, data):
    model_id = data.get('model') or DEFAULT_MODEL
    if model_id not in MODELS:
        await ws.send_json({'type': 'error', 'error': f'Unknown model: {model_id}'})
        return
    try:
        user_messages = _validate_messages(data.get('messages'))
        max_tokens = validate_int(data.get('max_tokens', 512), 'max_tokens', 1, 1024)
        style = validate_choice(
            data.get('style', DEFAULT_STYLE), set(STYLE_PRESETS), 'Style'
        )
        explicit_temperature = data.get('temperature')
        if explicit_temperature is not None:
            explicit_temperature = validate_float(
                explicit_temperature, 'temperature', 0.0, 2.0
            )
    except Exception as exc:
        await ws.send_json({'type': 'error', 'error': str(exc)})
        return

    if not llm.is_downloaded(model_id):
        await ws.send_json({'type': 'need_download', 'model': model_id})
        return

    # Prepend the system prompt and trim history.
    messages = [{'role': 'system', 'content': DEFAULT_SYSTEM_PROMPT}]
    messages.extend(user_messages)
    loop = asyncio.get_running_loop()
    active_task = None

    try:
        # Load (can take a few seconds the first time) with a status ping.
        status_q = thread_queue.Queue()
        active_task = loop.run_in_executor(
            None, lambda: llm.ensure_loaded(model_id, status_q.put_nowait)
        )
        while not active_task.done():
            while not status_q.empty():
                await ws.send_json({'type': 'status', 'message': status_q.get_nowait()})
            await asyncio.sleep(0.1)
        while not status_q.empty():
            await ws.send_json({'type': 'status', 'message': status_q.get_nowait()})
        await active_task
        active_task = None

        # Cancel/disconnect can happen while a cold model is loading. In that
        # case the completed load must not fall through into inference or emit
        # a misleading start event for a request the client no longer wants.
        if llm.cancel_event.is_set():
            await _send_cancelled(ws)
            return

        token_q = thread_queue.Queue()
        # Resolve the answer style into sampling params; an explicit temperature
        # in the payload still wins (back-compat with older callers).
        preset = dict(STYLE_PRESETS[style])
        if explicit_temperature is not None:
            preset['temperature'] = explicit_temperature
        active_task = loop.run_in_executor(
            None,
            lambda: llm.chat_stream(messages, token_q.put_nowait, max_tokens, **preset),
        )

        if llm.cancel_event.is_set():
            await active_task
            active_task = None
            await _send_cancelled(ws)
            return
        await ws.send_json({'type': 'start'})
        while not active_task.done():
            while not token_q.empty():
                await ws.send_json({'type': 'token', 'text': token_q.get_nowait()})
            await asyncio.sleep(0.02)
        while not token_q.empty():
            await ws.send_json({'type': 'token', 'text': token_q.get_nowait()})
        await active_task
        active_task = None

        await ws.send_json({'type': 'done'})
    except BaseException as exc:
        llm.cancel()
        if active_task is not None:
            try:
                await active_task
            except BaseException:
                pass
        if isinstance(exc, asyncio.CancelledError):
            raise
        await ws.send_json({'type': 'error', 'error': str(exc)})
