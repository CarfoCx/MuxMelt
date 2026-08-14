import _thread
import hashlib
import hmac
import os
import signal
import sys
import threading
import time


_WAIT_OBJECT_0 = 0x00000000
_WAIT_TIMEOUT = 0x00000102
_WAIT_FAILED = 0xFFFFFFFF
_PARENT_POLL_MS = 500
_GRACEFUL_SHUTDOWN_SECONDS = 10
_HARD_SHUTDOWN_SECONDS = 20
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000


def _argument_value(argv, flag):
    """Return the last value supplied for a simple ``--flag value`` option."""
    value = None
    for index, item in enumerate(argv):
        if item == flag and index + 1 < len(argv):
            value = argv[index + 1]
        elif item.startswith(flag + '='):
            value = item[len(flag) + 1:]
    return value


def _early_parent_pid(argv):
    """Read --parent-pid without importing argparse or the media runtime."""
    raw = _argument_value(argv, '--parent-pid')
    try:
        parent_pid = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None
    return parent_pid if parent_pid is not None and parent_pid > 1 else None


def _valid_auth_token(token):
    return (
        isinstance(token, str)
        and len(token) == 64
        and all(character in '0123456789abcdefABCDEF' for character in token)
    )


def _read_stdin_auth_token(stream):
    """Read exactly one bounded, newline-delimited bearer token from stdin."""
    line = stream.readline(66)
    if not line.endswith('\n'):
        raise ValueError('missing or unterminated authentication token')
    token = line[:-1]
    if token.endswith('\r'):
        token = token[:-1]
    if not _valid_auth_token(token):
        raise ValueError('malformed authentication token')
    if stream.read(1) != '':
        raise ValueError('unexpected data after authentication token')
    return token


def _bootstrap_auth_token(argv, stream):
    """Prefer the explicit dev flag; production reads the inherited pipe."""
    argv_token = _argument_value(argv, '--token')
    token = argv_token if argv_token is not None else _read_stdin_auth_token(stream)
    if not _valid_auth_token(token):
        raise ValueError('malformed authentication token')
    return token


def _cancel_known_runtime_work():
    """Best-effort, non-blocking cancellation callable from the watch thread."""
    current_upscaler = globals().get('upscaler')
    if current_upscaler is not None:
        try:
            current_upscaler.cancel()
        except Exception:
            pass

    chat_routes = sys.modules.get('routers.chat_routes')
    chat_llm = getattr(chat_routes, 'llm', None) if chat_routes else None
    if chat_llm is not None:
        try:
            chat_llm.cancel()
        except Exception:
            pass


def _create_windows_kill_on_close_job(kernel32=None):
    """Put this process in a non-inheritable, kill-on-close Windows job.

    The retained job handle is an OS-level backstop: if Python crashes, Windows
    closes its handle and terminates ffmpeg, Demucs, llama-server, and any other
    descendants which inherited membership in the job.
    """
    import ctypes
    from ctypes import wintypes

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ('PerProcessUserTimeLimit', ctypes.c_longlong),
            ('PerJobUserTimeLimit', ctypes.c_longlong),
            ('LimitFlags', wintypes.DWORD),
            ('MinimumWorkingSetSize', ctypes.c_size_t),
            ('MaximumWorkingSetSize', ctypes.c_size_t),
            ('ActiveProcessLimit', wintypes.DWORD),
            ('Affinity', ctypes.c_size_t),
            ('PriorityClass', wintypes.DWORD),
            ('SchedulingClass', wintypes.DWORD),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ('ReadOperationCount', ctypes.c_ulonglong),
            ('WriteOperationCount', ctypes.c_ulonglong),
            ('OtherOperationCount', ctypes.c_ulonglong),
            ('ReadTransferCount', ctypes.c_ulonglong),
            ('WriteTransferCount', ctypes.c_ulonglong),
            ('OtherTransferCount', ctypes.c_ulonglong),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ('BasicLimitInformation', JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ('IoInfo', IO_COUNTERS),
            ('ProcessMemoryLimit', ctypes.c_size_t),
            ('JobMemoryLimit', ctypes.c_size_t),
            ('PeakProcessMemoryUsed', ctypes.c_size_t),
            ('PeakJobMemoryUsed', ctypes.c_size_t),
        ]

    if kernel32 is None:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL

    def last_error():
        getter = getattr(ctypes, 'get_last_error', None)
        return getter() if getter is not None else 0

    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise OSError(last_error(), 'CreateJobObjectW failed')
    try:
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = (
            _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        if not kernel32.SetInformationJobObject(
            handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            raise OSError(last_error(), 'SetInformationJobObject failed')
        if not kernel32.AssignProcessToJobObject(
            handle, kernel32.GetCurrentProcess()
        ):
            raise OSError(last_error(), 'AssignProcessToJobObject failed')
        return handle
    except BaseException:
        kernel32.CloseHandle(handle)
        raise


def _signal_isolated_posix_group(sig):
    """Signal only the process group that Electron created for this backend."""
    if os.name == 'nt' or not hasattr(os, 'getpgrp'):
        return False
    try:
        process_group = os.getpgrp()
        if process_group != os.getpid():
            # Manual/dev launches may share a shell's group. Never signal it.
            return False
        os.killpg(process_group, sig)
        return True
    except (OSError, ValueError):
        return False


def _hard_stop_windows_job(job_handle):
    if os.name != 'nt' or not job_handle:
        return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        return bool(kernel32.TerminateJobObject(job_handle, 1))
    except Exception:
        return False


def _watch_parent_windows(parent_pid, parent_lost):
    """Wait for a Windows process handle and classify every wait result."""
    import ctypes

    synchronize = 0x00100000
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.OpenProcess.argtypes = [
        ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong
    ]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int

    handle = kernel32.OpenProcess(synchronize, False, parent_pid)
    if not handle:
        parent_lost(f'OpenProcess failed with Windows error {ctypes.get_last_error()}')
        return
    try:
        while True:
            result = kernel32.WaitForSingleObject(handle, _PARENT_POLL_MS)
            if result == _WAIT_TIMEOUT:
                continue
            if result == _WAIT_OBJECT_0:
                parent_lost('parent process exited')
                return
            if result == _WAIT_FAILED:
                parent_lost(
                    f'WaitForSingleObject failed with Windows error '
                    f'{ctypes.get_last_error()}'
                )
                return
            parent_lost(f'WaitForSingleObject returned unexpected status {result:#x}')
            return
    finally:
        kernel32.CloseHandle(handle)


def _watch_parent_posix(parent_pid, parent_lost):
    """Poll the original POSIX parent without confusing EPERM with exit."""
    while True:
        time.sleep(_PARENT_POLL_MS / 1000)
        if os.getppid() != parent_pid:
            parent_lost('parent process changed')
            return
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            parent_lost('parent process exited')
            return
        except PermissionError:
            # Permission denial still proves that a process owns this PID.
            continue
        except OSError as exc:
            parent_lost(f'parent liveness check failed: {exc}')
            return


class _ParentWatchdog:
    """Translate parent loss into a bounded Uvicorn shutdown request."""

    def __init__(self, parent_pid):
        self.parent_pid = parent_pid
        self.parent_lost = threading.Event()
        self.backend_stopped = threading.Event()
        self._lock = threading.Lock()
        self._server = None
        self._deadline_started = False

    def start(self):
        target = (
            self._watch_windows if os.name == 'nt' else self._watch_posix
        )
        threading.Thread(
            target=target, name='muxmelt-parent-watch', daemon=True
        ).start()
        return self

    def attach_server(self, server):
        with self._lock:
            self._server = server
            lost = self.parent_lost.is_set()
        if lost:
            self._request_server_exit(server)

    def mark_backend_stopped(self):
        self.backend_stopped.set()

    def _watch_windows(self):
        _watch_parent_windows(self.parent_pid, self._on_parent_lost)

    def _watch_posix(self):
        _watch_parent_posix(self.parent_pid, self._on_parent_lost)

    def _on_parent_lost(self, reason):
        if self.parent_lost.is_set():
            return
        self.parent_lost.set()
        print(f'Electron parent unavailable ({reason}); shutting down backend.',
              file=sys.stderr)
        _cancel_known_runtime_work()
        with self._lock:
            server = self._server
        self._start_deadline(server)
        if server is None:
            # This can happen while Torch or another heavyweight module is
            # importing. KeyboardInterrupt unwinds Python normally and runs
            # registered cleanup; the already-running deadline remains an OS
            # backstop if native import code does not return to the interpreter.
            _thread.interrupt_main()
            return
        self._request_server_exit(server)
        # Electron launches the POSIX backend as its own process-group leader.
        # SIGTERM therefore reaches native descendants as well as Uvicorn,
        # whose installed signal handler keeps the Python shutdown graceful.
        _signal_isolated_posix_group(signal.SIGTERM)

    def _request_server_exit(self, server):
        server.should_exit = True
        self._start_deadline(server)

    def _start_deadline(self, server):
        with self._lock:
            if self._deadline_started:
                return
            self._deadline_started = True
        threading.Thread(
            target=self._enforce_deadline,
            args=(server,),
            name='muxmelt-shutdown-deadline',
            daemon=True,
        ).start()

    def _enforce_deadline(self, server):
        if self.backend_stopped.wait(_HARD_SHUTDOWN_SECONDS):
            return
        # Graceful cancellation has a finite budget. The OS-level boundary is
        # the last resort which guarantees that a wedged native worker cannot
        # survive the backend after Electron has disappeared.
        _cancel_known_runtime_work()
        if server is not None:
            server.force_exit = True
        if _hard_stop_windows_job(globals().get('_WINDOWS_JOB_HANDLE')):
            return
        hard_signal = getattr(signal, 'SIGKILL', signal.SIGTERM)
        if _signal_isolated_posix_group(hard_signal):
            return
        try:
            os.kill(
                os.getpid(), signal.SIGTERM if os.name == 'nt' else hard_signal
            )
        except OSError:
            _thread.interrupt_main()


_EARLY_PARENT_PID = (
    _early_parent_pid(sys.argv[1:]) if __name__ == '__main__' else None
)
_PARENT_WATCHDOG = (
    _ParentWatchdog(_EARLY_PARENT_PID).start() if _EARLY_PARENT_PID else None
)
_WINDOWS_JOB_HANDLE = None
if __name__ == '__main__' and os.name == 'nt':
    try:
        _WINDOWS_JOB_HANDLE = _create_windows_kill_on_close_job()
    except OSError as exc:
        # Continuing would make a Python crash capable of orphaning ffmpeg or
        # model workers. Fail before importing or starting any of them.
        print(f'ERROR: Cannot establish the Windows child-process boundary: {exc}',
              file=sys.stderr)
        raise SystemExit(3)

# Production receives the per-session bearer secret over an inherited stdin
# pipe so it never appears in process argv. --token remains an explicit
# development/test fallback. This read happens after the parent watcher starts
# but before importing Torch and the rest of the media runtime.
_BOOTSTRAP_AUTH_TOKEN = None
if (__name__ == '__main__'
        and '-h' not in sys.argv[1:]
        and '--help' not in sys.argv[1:]):
    try:
        _BOOTSTRAP_AUTH_TOKEN = _bootstrap_auth_token(
            sys.argv[1:], sys.stdin
        )
    except (OSError, ValueError):
        print('ERROR: A valid backend authentication token is required.',
              file=sys.stderr)
        raise SystemExit(2)

import argparse
import asyncio
import math
import queue as thread_queue
import secrets
from pathlib import Path

# Install the fail-closed outbound socket guard before importing Torch, model
# routers, or any other dependency that may perform an implicit download.
from offline_guard import install_if_requested

OFFLINE_MODE = install_if_requested()

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


def _close_known_runtime():
    """Cancel and reap long-lived native workers during every shutdown path."""
    _cancel_known_runtime_work()

    chat_routes = sys.modules.get('routers.chat_routes')
    chat_llm = getattr(chat_routes, 'llm', None) if chat_routes else None
    if chat_llm is not None:
        try:
            chat_llm.unload()
        except Exception:
            pass

    current_upscaler = globals().get('upscaler')
    if current_upscaler is not None:
        try:
            current_upscaler.close()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app):
    global upscaler
    upscaler = Upscaler()
    try:
        yield
    finally:
        _close_known_runtime()

AUTH_TOKEN = None  # populated by the executable bootstrap before serving

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
        'offline_mode': OFFLINE_MODE,
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
    parser.add_argument(
        '--token', type=str, default=None,
        help='development/test fallback; production supplies the token on stdin',
    )
    parser.add_argument('--parent-pid', type=int, default=None)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if args.parent_pid is not None and args.parent_pid <= 1:
        parser.error('--parent-pid must identify a real parent process')

    auth_token = args.token if args.token is not None else _BOOTSTRAP_AUTH_TOKEN
    if not _valid_auth_token(auth_token):
        parser.error('a valid 64-character authentication token is required')

    app.state.token = auth_token
    AUTH_TOKEN = auth_token
    # Drop redundant bootstrap references. Strings cannot be reliably scrubbed
    # from managed memory, but the production token was never exposed in argv.
    _BOOTSTRAP_AUTH_TOKEN = None
    args.token = None

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
        timeout_graceful_shutdown=_GRACEFUL_SHUTDOWN_SECONDS,
    )
    class _ReadinessProofServer(uvicorn.Server):
        """Emit a child-pipe proof only after this process owns the port."""

        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.should_exit or not self.started:
                return
            message = f'muxmelt-ready-v1:{args.port}'.encode('ascii')
            proof = hmac.new(
                auth_token.encode('ascii'), message, hashlib.sha256,
            ).hexdigest()
            print(f'MUXMELT_READY {proof}', flush=True)

    server = _ReadinessProofServer(config)
    app.state.uvicorn_server = server
    if _PARENT_WATCHDOG is not None:
        _PARENT_WATCHDOG.attach_server(server)

    try:
        server.run()
    finally:
        # Lifespan normally performs this work. Repeating it here covers a
        # startup failure or the watchdog's bounded force-exit path.
        _close_known_runtime()
        if _PARENT_WATCHDOG is not None:
            _PARENT_WATCHDOG.mark_backend_stopped()
