#!/usr/bin/env python3
"""Smoke test for the MuxMelt backend's token authentication.

Two layers:
  Layer 1 (always runs, stdlib only): exercises the real auth decision in
    server_auth.py for representative HTTP/WebSocket scopes.
  Layer 2 (real HTTP, auto-skips): if fastapi/uvicorn/torch are importable,
    boots the actual server.py in a subprocess and asserts that /health is 403
    without the token and 200 with it.

Exit code 0 = pass (Layer 2 may be skipped); 1 = a real failure.
"""

import os
import sys
import time
import socket
import secrets
import subprocess
import urllib.request
import urllib.error

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

    tok = secrets.token_hex(16)

    def http(q=b'', headers=None, method='GET'):
        return {'type': 'http', 'method': method, 'query_string': q, 'headers': headers or []}

    def ws(q=b'', headers=None):
        return {'type': 'websocket', 'query_string': q, 'headers': headers or []}

    print('--- Layer 1: auth decision (server_auth) ---')
    check('http with correct token allowed (~200)', request_authorized(http(b'token=' + tok.encode()), tok))
    check('http without token denied (~403)', request_authorized(http(b''), tok) is False)
    check('http with wrong token denied (~403)', request_authorized(http(b'token=nope'), tok) is False)
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
        print('SKIPPED: backend deps (fastapi/uvicorn/torch) not installed in '
              + os.path.basename(sys.executable) + '. Auth gate proven by Layer 1.')
        return

    token = secrets.token_hex(16)
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


def main():
    layer1()
    layer2()
    passed = sum(_results)
    total = len(_results)
    ok = all(_results)
    print(f'\nTOTAL: {passed}/{total} -> {"ALL PASS" if ok else "FAILURES"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
