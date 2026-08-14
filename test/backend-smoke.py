#!/usr/bin/env python3
"""Smoke test for the MuxMelt backend's token authentication.

Four layers:
  Layer 1 (always runs, stdlib only): exercises the real auth decision in
    server_auth.py for representative HTTP/WebSocket scopes.
  Layer 2 (real HTTP, auto-skips): if fastapi/uvicorn/torch are importable,
    boots the actual server.py in a subprocess and asserts that /health is 403
    without the token and 200 with it.
  Layer 3 (stdlib): exercises the local llama-server adapter, hardware policy,
    local-model registry, and chat cancellation without llama.cpp.
  Layer 4 (stdlib): proves a stem batch uses one Demucs process and maps each
    track's outputs correctly without importing Demucs.

Exit code 0 = pass (Layer 2 may be skipped); 1 = a real failure.
"""

import os
import sys
import time
import socket
import secrets
import subprocess
import tempfile
import urllib.request
import urllib.error
from pathlib import Path
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_DIR = os.path.join(REPO, 'python')
sys.path.insert(0, PYTHON_DIR)

_results = []


def check(name, cond):
    _results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name)


# --------------------------------------------------------------------------
# Layer 1 — pure auth decision (no heavy deps)
# --------------------------------------------------------------------------
def layer1():
    from server_auth import request_authorized

    tok = secrets.token_hex(32)

    def http(q=b'', headers=None, method='GET'):
        return {'type': 'http', 'method': method, 'query_string': q, 'headers': headers or []}

    def ws(q=b'', headers=None):
        return {'type': 'websocket', 'query_string': q, 'headers': headers or []}

    print('--- Layer 1: auth decision (server_auth) ---')
    check('http with correct token allowed (~200)', request_authorized(http(b'token=' + tok.encode()), tok))
    check('http without token denied (~403)', request_authorized(http(b''), tok) is False)
    check('http with wrong token denied (~403)', request_authorized(http(b'token=nope'), tok) is False)
    check('http with duplicate token denied',
          request_authorized(http(b'token=' + tok.encode() + b'&token=' + tok.encode()), tok) is False)
    check('http with token + evil origin denied',
          request_authorized(http(b'token=' + tok.encode(), [(b'origin', b'https://evil.com')]), tok) is False)
    check('OPTIONS preflight allowed without token', request_authorized(http(b'', method='OPTIONS'), tok))
    check('ws with correct token allowed', request_authorized(ws(b'token=' + tok.encode()), tok))
    # The renderer is loaded via loadFile(), so its WebSocket handshake carries
    # the literal "Origin: file://" (whereas its fetch() calls send "null").
    # Both must be accepted, or /ws is wrongly rejected with 403.
    check('ws from file:// origin allowed',
          request_authorized(ws(b'token=' + tok.encode(), [(b'origin', b'file://')]), tok))
    check('http from null origin allowed (fetch from file://)',
          request_authorized(http(b'token=' + tok.encode(), [(b'origin', b'null')]), tok))
    check('ws with token + evil origin denied',
          request_authorized(ws(b'token=' + tok.encode(), [(b'origin', b'https://evil.com')]), tok) is False)
    check('ws without token denied', request_authorized(ws(b''), tok) is False)
    check('no-token-config allows all', request_authorized(http(b''), None) is True)


# --------------------------------------------------------------------------
# Layer 2 — real HTTP boot of server.py (auto-skips without deps)
# --------------------------------------------------------------------------
def backend_deps_available():
    try:
        import fastapi  # noqa: F401
        import uvicorn  # noqa: F401
        import torch    # noqa: F401
        import cv2      # noqa: F401
        import numpy    # noqa: F401
        return True
    except Exception:
        return False


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http_status(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def layer2():
    print('\n--- Layer 2: live backend HTTP ---')
    if not backend_deps_available():
        print('SKIPPED: core backend dependencies are not installed in '
              + os.path.basename(sys.executable) + '. Auth gate proven by Layer 1.')
        return

    token = secrets.token_hex(32)
    port = free_port()
    env = dict(os.environ)
    env['PYTHONPATH'] = PYTHON_DIR + os.pathsep + env.get('PYTHONPATH', '')

    proc = subprocess.Popen(
        [sys.executable, os.path.join(PYTHON_DIR, 'server.py'),
         '--port', str(port), '--token', token],
        cwd=PYTHON_DIR, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        base = f'http://127.0.0.1:{port}'
        # Wait until the (authenticated) health endpoint answers.
        ready = False
        for _ in range(90):
            if proc.poll() is not None:
                break
            if http_status(f'{base}/health?token={token}') == 200:
                ready = True
                break
            time.sleep(1)
        check('backend boots and answers authenticated /health (200)', ready)
        if ready:
            check('/health without token -> 403', http_status(f'{base}/health') == 403)
            check('/health with wrong token -> 403', http_status(f'{base}/health?token=bad') == 403)
            check('/vram without token -> 403', http_status(f'{base}/vram') == 403)
            check('/vram with token -> 200', http_status(f'{base}/vram?token={token}') == 200)
            # Graceful shutdown via the token-guarded endpoint.
            http_status(f'{base}/shutdown?token={token}')
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
            proc.wait(timeout=5)


def layer3_chat_cancellation():
    """Exercise the professional chat path without FastAPI or llama.cpp."""
    import asyncio
    import io
    import importlib
    import threading
    import types

    from modules import llm as llm_module
    from modules.llm import (
        ChatLLM,
        MODELS,
        PROFESSIONAL_MINIMUM_MODEL,
        default_model,
        recommend_tier,
        resolve_resource_profile,
    )

    print('\n--- Layer 3: local chat runtime ---')

    class CloseableResponse:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    # Even a machine-wide proxy must not become part of the private prompt hop.
    with mock.patch.dict(os.environ, {
        'HTTP_PROXY': 'http://proxy.invalid:9999',
        'HTTPS_PROXY': 'http://proxy.invalid:9999',
    }):
        engine = ChatLLM()
    download_response = CloseableResponse()
    inference_response = CloseableResponse()
    engine._active_download_response = download_response
    engine._active_chat_response = inference_response
    engine.cancel()
    check('chat cancellation closes a blocking model download response',
          download_response.closed)
    check('chat cancellation closes the active inference response',
          inference_response.closed)

    # A cancelled request must stop before it reaches the local server.
    class FakeServerProcess:
        def poll(self):
            return None

    class StreamResponse:
        def __init__(self):
            self.closed = False
            self.lines = iter((
                b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n',
                b'data: {"choices":[],"usage":{"completion_tokens":1}}\n',
                b'data: [DONE]\n',
            ))

        def __iter__(self):
            return self

        def __next__(self):
            return next(self.lines)

        def close(self):
            self.closed = True

    class CapturingOpener:
        def __init__(self, response):
            self.response = response
            self.calls = []

        def open(self, request, timeout=None):
            self.calls.append((request, timeout))
            return self.response

    # Python omits an explicitly empty ProxyHandler from the final handler list,
    # so success means there is no ProxyHandler carrying any configured proxy.
    proxy_free = not any(
        isinstance(handler, urllib.request.ProxyHandler) and handler.proxies
        for handler in engine._loopback_opener.handlers
    )
    check('private inference opener ignores ambient proxy settings', proxy_free)

    stream_response = StreamResponse()
    opener = CapturingOpener(stream_response)
    engine._loopback_opener = opener
    engine._server_proc = FakeServerProcess()
    engine._server_port = 49321
    engine._active_backend = 'cpu'
    engine._active_download_response = None
    engine._active_chat_response = None
    emitted = []
    engine.chat_stream([{'role': 'user', 'content': 'hello'}], emitted.append)
    check('pre-cancelled chat_stream never contacts llama-server', not opener.calls)
    check('pre-cancelled chat_stream emits no tokens', emitted == [])

    engine.reset_cancel()
    stats = engine.chat_stream(
        [{'role': 'user', 'content': 'hello'}], emitted.append
    )
    request = opener.calls[0][0] if opener.calls else None
    check('chat inference targets literal loopback only',
          request is not None
          and request.full_url == 'http://127.0.0.1:49321/v1/chat/completions')
    check('chat inference authenticates to the private llama-server',
          request is not None
          and request.get_header('Authorization') == f'Bearer {engine._api_key}')
    check('non-cancelled llama-server stream returns text and completion stats',
          emitted == ['ok']
          and stream_response.closed
          and stats.get('finish_reason') == 'stop'
          and stats.get('completion_tokens') == 1
          and stats.get('cancelled') is False)
    # Avoid leaving a fake process attached to the atexit cleanup callback.
    engine._server_proc = None

    weak_cpu = {'backend': 'cpu', 'ramMb': 8192, 'vramMb': 0, 'cpuCores': 4}
    balanced_boundary = {
        'backend': 'cpu', 'ramMb': 10_000, 'vramMb': 0, 'cpuCores': 8,
    }
    performance_boundary = {
        'backend': 'cpu', 'ramMb': 24_000, 'vramMb': 0, 'cpuCores': 8,
    }
    check('automatic resource profile selects eco for constrained hardware',
          resolve_resource_profile(weak_cpu)['resolved'] == 'eco')
    check('automatic resource profile selects balanced at the 10 GB boundary',
          resolve_resource_profile(balanced_boundary)['resolved'] == 'balanced')
    check('automatic resource profile selects performance at its RAM/CPU boundary',
          resolve_resource_profile(performance_boundary)['resolved'] == 'performance')
    check('manual eco profile caps CPU use even on strong hardware',
          resolve_resource_profile(performance_boundary, 'eco')['threads'] <= 4)

    expected_catalog = {
        'qwen3.5-4b-instruct',
        'qwen3.5-9b-instruct-q4',
        'qwen3.5-9b-instruct-q5',
        'qwen3.5-27b-instruct',
        'qwen3.5-35b-a3b-instruct',
    }
    check('curated chat catalog excludes experimental 0.8B and 2B models',
          set(MODELS) == expected_catalog
          and 'qwen3.5-0.8b-instruct' not in MODELS
          and 'qwen3.5-2b-instruct' not in MODELS)
    check('every curated model declares an explicit capability category',
          all(
              model.get('quality_tier') in {
                  'standard', 'recommended', 'advanced', 'expert',
              }
              and isinstance(model.get('quality_rank'), int)
              and model['quality_rank'] > 0
              and model.get('recommended_cpu_ram_mb', 0) >= model['min_ram_mb']
              and model.get('min_cpu_cores', 0) >= 1
              for model in MODELS.values()
          ))

    four_b = 'qwen3.5-4b-instruct'
    nine_b = 'qwen3.5-9b-instruct-q4'
    check('4B professional minimum requires CPU headroom and eight cores',
          recommend_tier(four_b, {
              'backend': 'cpu', 'ramMb': 12000, 'vramMb': 0, 'cpuCores': 7,
          }) == 'possible'
          and recommend_tier(four_b, {
              'backend': 'cpu', 'ramMb': 12000, 'vramMb': 0, 'cpuCores': 8,
          }) == 'recommended')
    check('9B recommendation changes at its VRAM boundary',
          recommend_tier(nine_b, {
              'backend': 'cuda', 'ramMb': 16_000, 'vramMb': 6999, 'cpuCores': 4,
          }) == 'possible'
          and recommend_tier(nine_b, {
              'backend': 'cuda', 'ramMb': 16_000, 'vramMb': 7000, 'cpuCores': 4,
          }) == 'recommended')
    check('Apple unified memory participates in model recommendations',
          recommend_tier(four_b, {
              'backend': 'metal', 'ramMb': 8192, 'vramMb': 0, 'cpuCores': 8,
          }) == 'recommended')
    check('dynamic default never falls below the curated quality floor',
          PROFESSIONAL_MINIMUM_MODEL == four_b
          and default_model(weak_cpu) == four_b
          and default_model({
              'backend': 'cpu', 'ramMb': 16_000, 'vramMb': 0,
              'cpuCores': 8,
          }) == nine_b
          and default_model({
              'backend': 'cuda', 'ramMb': 16_000, 'vramMb': 8000,
              'cpuCores': 8,
          }) == 'qwen3.5-9b-instruct-q5')

    with tempfile.TemporaryDirectory() as data_dir:
        gguf_path = os.path.join(data_dir, 'Private Assistant.gguf')
        with open(gguf_path, 'wb') as model_file:
            model_file.write(b'GGUF')
            model_file.seek(1024 * 1024 - 1)
            model_file.write(b'\0')
        with mock.patch.dict(os.environ, {'MUXMELT_DATA_DIR': data_dir}):
            registry_engine = ChatLLM()
            local_id = registry_engine.register_local_model(gguf_path)
            listed = {
                item['id']: item for item in ChatLLM().list_models()
            }
            local_entry = listed.get(local_id)
            check('local GGUF registration uses a stable local model id',
                  local_id.startswith('local-')
                  and registry_engine.model_path(local_id) == os.path.abspath(gguf_path))
            check('registered GGUF persists in the local model listing',
                  local_entry is not None
                  and local_entry.get('source') == 'local'
                  and local_entry.get('downloaded') is True
                  and local_entry.get('can_download') is False
                  and local_entry.get('quality_tier') == 'unverified'
                  and local_entry.get('quality_rank') == 0
                  and local_entry.get('fit') == local_entry.get('tier')
                  and local_entry.get('name') == 'Private Assistant')
            check('local GGUF registry stays inside MUXMELT_DATA_DIR',
                  os.path.isfile(os.path.join(
                      data_dir, 'models', 'local-models.json'
                  )))

    class FakeDownloadResponse(io.BytesIO):
        def __init__(self, body, declared_size=None):
            super().__init__(body)
            self.headers = {
                'Content-Length': str(len(body) if declared_size is None else declared_size)
            }

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    catalog_entry = {
        'name': 'Integrity test model',
        'file': 'integrity-test.gguf',
        'url': 'https://example.invalid/integrity-test.gguf',
        'sha256': '0' * 64,
        'approx_mb': 1,
        'min_vram_mb': 1,
        'min_ram_mb': 1,
    }
    with tempfile.TemporaryDirectory() as data_dir, \
            mock.patch.dict(os.environ, {'MUXMELT_DATA_DIR': data_dir}), \
            mock.patch.dict(llm_module.MODELS, {'integrity-test': catalog_entry}):
        body = b'GGUF' + (b'x' * 700_000)
        integrity_engine = ChatLLM()
        with mock.patch.object(
            llm_module.urllib.request, 'urlopen',
            return_value=FakeDownloadResponse(body),
        ):
            try:
                integrity_engine.download('integrity-test')
                mismatch_rejected = False
            except RuntimeError as exc:
                mismatch_rejected = 'integrity check' in str(exc).lower()
        model_dir = os.path.join(data_dir, 'models')
        leftovers = os.listdir(model_dir) if os.path.isdir(model_dir) else []
        check('model hash mismatch is rejected without publishing a GGUF',
              mismatch_rejected
              and not os.path.exists(integrity_engine.model_path('integrity-test'))
              and not any(name.endswith('.part') for name in leftovers))

        with mock.patch.object(
            llm_module.urllib.request, 'urlopen',
            return_value=FakeDownloadResponse(b'', declared_size=100 * 1024 * 1024),
        ):
            try:
                integrity_engine.download('integrity-test')
                oversized_rejected = False
            except RuntimeError as exc:
                oversized_rejected = 'larger than' in str(exc).lower()
        check('model download rejects an oversized declared response', oversized_rejected)

    # chat_routes imports only these FastAPI symbols at module import time.
    # A tiny stub keeps this focused regression runnable in the lightweight
    # smoke environment where the backend dependencies are intentionally absent.
    fastapi_stub = types.ModuleType('fastapi')

    class StubRouter:
        def websocket(self, _path):
            return lambda handler: handler

    class StubWebSocket:
        pass

    class StubWebSocketDisconnect(Exception):
        pass

    fastapi_stub.APIRouter = StubRouter
    fastapi_stub.WebSocket = StubWebSocket
    fastapi_stub.WebSocketDisconnect = StubWebSocketDisconnect

    missing = object()
    previous_fastapi = sys.modules.get('fastapi', missing)
    previous_chat_routes = sys.modules.pop('routers.chat_routes', missing)
    sys.modules['fastapi'] = fastapi_stub
    try:
        chat_routes = importlib.import_module('routers.chat_routes')

        class FakeRouteLLM:
            def __init__(self):
                self.dynamic_default = 'dynamic-default-model'
                self.cancel_event = threading.Event()
                self.load_started = threading.Event()
                self.load_release = threading.Event()
                self.load_returns = 0
                self.cancel_calls = 0
                self.chat_calls = 0
                self.fit_calls = 0
                self.unload_calls = 0
                self.loaded_model_ids = []
                self.default_calls = 0

            def reset_cancel(self):
                self.cancel_event.clear()

            def cancel(self):
                self.cancel_calls += 1
                self.cancel_event.set()
                self.load_release.set()

            def default_model(self):
                self.default_calls += 1
                return self.dynamic_default

            def has_model(self, model_id):
                return model_id == self.dynamic_default

            def is_downloaded(self, _model_id):
                return True

            def ensure_loaded(self, model_id, execution='auto', profile='auto',
                              status_cb=None):
                self.loaded_model_ids.append(model_id)
                self.load_started.set()
                if not self.load_release.wait(timeout=2):
                    raise RuntimeError('test timed out waiting for cancellation')
                self.load_returns += 1

            def fit_messages(self, messages, _max_tokens):
                self.fit_calls += 1
                return messages, False, 1

            def chat_stream(self, *_args, **_kwargs):
                self.chat_calls += 1

            def unload(self):
                self.unload_calls += 1

        class FakeSocket:
            def __init__(self, fake_llm, mode):
                self.fake_llm = fake_llm
                self.mode = mode
                self.receive_count = 0
                self.sent = []

            async def accept(self):
                pass

            async def send_json(self, payload):
                self.sent.append(payload)

            async def receive_json(self):
                self.receive_count += 1
                if self.receive_count == 1:
                    return {
                        'action': 'chat',
                        'messages': [{'role': 'user', 'content': 'hello'}],
                    }
                if self.receive_count == 2:
                    while not self.fake_llm.load_started.is_set():
                        await asyncio.sleep(0.001)
                    if self.mode == 'cancel':
                        return {'action': 'cancel'}
                raise StubWebSocketDisconnect()

        async def run_scenario(mode):
            fake_llm = FakeRouteLLM()
            socket = FakeSocket(fake_llm, mode)
            chat_routes.llm = fake_llm
            # Locks are loop-bound once used, so each isolated scenario gets a
            # fresh instance on the current test loop.
            chat_routes._operation_lock = asyncio.Lock()
            await asyncio.wait_for(chat_routes.chat_ws(socket), timeout=3)
            return fake_llm, socket

        async def run_scenarios():
            return await run_scenario('cancel'), await run_scenario('disconnect')

        (cancel_llm, cancel_socket), (disconnect_llm, disconnect_socket) = asyncio.run(
            run_scenarios()
        )
        check('cancel during model load returns from ensure_loaded',
              cancel_llm.load_returns == 1 and cancel_llm.cancel_calls >= 1)
        check('cold-load cancellation uses the runtime default model',
              cancel_llm.default_calls >= 1
              and cancel_llm.loaded_model_ids == [cancel_llm.dynamic_default])
        check('cancel after model load prevents context fitting, inference, and start',
              cancel_llm.chat_calls == 0
              and cancel_llm.fit_calls == 0
              and all(message.get('type') not in ('start', 'token', 'done')
                      for message in cancel_socket.sent))
        check('cancel during model load sends exactly one terminal acknowledgement',
              sum(message.get('type') == 'cancelled'
                  for message in cancel_socket.sent) == 1)
        check('disconnect during model load returns from ensure_loaded',
              disconnect_llm.load_returns == 1 and disconnect_llm.cancel_calls >= 1)
        check('disconnect after model load prevents inference and start',
              disconnect_llm.chat_calls == 0
              and disconnect_llm.fit_calls == 0
              and all(message.get('type') != 'start' for message in disconnect_socket.sent))
    finally:
        sys.modules.pop('routers.chat_routes', None)
        if previous_chat_routes is not missing:
            sys.modules['routers.chat_routes'] = previous_chat_routes
        if previous_fastapi is missing:
            sys.modules.pop('fastapi', None)
        else:
            sys.modules['fastapi'] = previous_fastapi


def layer4_stem_batch():
    """Exercise multi-track Demucs orchestration with a controlled process."""
    import modules.stem_separator as stem_module

    print('\n--- Layer 4: stem batch orchestration ---')
    calls = []

    class FakeStdout:
        def __init__(self):
            self.lines = iter(('100% complete\n', ''))

        def readline(self):
            return next(self.lines, '')

        def close(self):
            pass

    class FakeProcess:
        def __init__(self, command, **_kwargs):
            calls.append(command)
            output_root = Path(command[command.index('-o') + 1])
            model = command[command.index('-n') + 1]
            inputs = command[command.index('--filename') + 2:]
            model_dir = output_root / model
            model_dir.mkdir(parents=True, exist_ok=True)
            for input_path in inputs:
                base = Path(input_path).stem
                for stem in ('vocals', 'drums'):
                    (model_dir / f'{base}_{stem}.wav').write_bytes(b'RIFF-test')
            self.stdout = FakeStdout()
            self.returncode = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

    previous_available = stem_module._available
    try:
        stem_module._available = True
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            inputs = [root_path / 'alpha.wav', root_path / 'beta.wav']
            for input_path in inputs:
                input_path.write_bytes(b'input')
            output_dir = root_path / 'outputs'
            progress = []
            separator = stem_module.StemSeparator()
            with mock.patch.object(stem_module.subprocess, 'Popen', FakeProcess):
                results = separator.separate_batch(
                    [(str(path), str(output_dir)) for path in inputs],
                    stems=['vocals', 'drums'],
                    progress_callback=lambda path, pct, status: progress.append(
                        (path, pct, status)
                    ),
                )

            check('two unique tracks share one Demucs process', len(calls) == 1)
            check('stem batch maps outputs to both source tracks',
                  set(results) == {str(path) for path in inputs}
                  and all(set(outputs) == {'vocals', 'drums'}
                          for outputs in results.values()))
            check('stem batch publishes non-empty WAV outputs and per-file progress',
                  all(Path(path).is_file() and Path(path).stat().st_size > 0
                      for outputs in results.values() for path in outputs.values())
                  and {item[0] for item in progress} == {str(path) for path in inputs})
    finally:
        stem_module._available = previous_available


def main():
    layer1()
    layer2()
    layer3_chat_cancellation()
    layer4_stem_batch()
    passed = sum(_results)
    total = len(_results)
    ok = all(_results)
    print(f'\nTOTAL: {passed}/{total} -> {"ALL PASS" if ok else "FAILURES"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
