"""Focused stdlib-only tests for backend bootstrap and offline boundaries."""

import ast
import ctypes
import hashlib
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import importlib.util


ROOT = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / 'python'
SERVER_PATH = PYTHON_DIR / 'server.py'


def load_server_bootstrap():
    """Load only the stdlib bootstrap definitions, never FastAPI/Torch."""
    tree = ast.parse(SERVER_PATH.read_text(encoding='utf-8'), str(SERVER_PATH))
    constants = {
        '_WAIT_OBJECT_0', '_WAIT_TIMEOUT', '_WAIT_FAILED',
        '_PARENT_POLL_MS', '_GRACEFUL_SHUTDOWN_SECONDS',
        '_HARD_SHUTDOWN_SECONDS', '_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION',
        '_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
    }
    functions = {
        '_argument_value', '_early_parent_pid', '_valid_auth_token',
        '_read_stdin_auth_token', '_bootstrap_auth_token',
        '_cancel_known_runtime_work', '_create_windows_kill_on_close_job',
        '_signal_isolated_posix_group', '_hard_stop_windows_job',
        '_watch_parent_windows', '_watch_parent_posix',
    }
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = {target.id for target in targets if isinstance(target, ast.Name)}
            if names & constants:
                selected.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in functions:
                selected.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == '_ParentWatchdog':
            selected.append(node)

    namespace = {
        '__name__': 'server_bootstrap_test',
        '_thread': __import__('_thread'),
        'os': os,
        'signal': signal,
        'sys': sys,
        'threading': threading,
        'time': time,
    }
    module = ast.Module(body=selected, type_ignores=[])
    exec(compile(module, str(SERVER_PATH), 'exec'), namespace)
    return namespace


class CallableApi:
    def __init__(self, result=1):
        self.result = result
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        if callable(self.result):
            return self.result(*args)
        return self.result


class FakeKernel32:
    def __init__(self, waits=()):
        self.CreateJobObjectW = CallableApi(101)
        self.SetInformationJobObject = CallableApi(1)
        self.GetCurrentProcess = CallableApi(202)
        self.AssignProcessToJobObject = CallableApi(1)
        self.OpenProcess = CallableApi(303)
        wait_values = iter(waits)
        self.WaitForSingleObject = CallableApi(lambda *_args: next(wait_values))
        self.CloseHandle = CallableApi(1)


class ServerBootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bootstrap = load_server_bootstrap()

    def test_watchdog_and_secret_pipe_precede_heavy_imports(self):
        source = SERVER_PATH.read_text(encoding='utf-8')
        heavy_import = source.index('from PIL import Image')
        self.assertLess(
            source.index('_ParentWatchdog(_EARLY_PARENT_PID).start()'),
            heavy_import,
        )
        self.assertLess(
            source.index('_create_windows_kill_on_close_job()'),
            heavy_import,
        )
        self.assertLess(
            source.index('_bootstrap_auth_token(\n            sys.argv[1:], sys.stdin'),
            heavy_import,
        )
        self.assertNotIn('os._exit', source)
        self.assertIn('timeout_graceful_shutdown=_GRACEFUL_SHUTDOWN_SECONDS', source)

    def test_production_token_comes_from_stdin_not_argv(self):
        token = 'a1' * 32
        read_token = self.bootstrap['_bootstrap_auth_token'](
            ['--port', '8765'], io.StringIO(token + '\n')
        )
        self.assertEqual(read_token, token)

        class NeverRead:
            def readline(self, _limit):
                raise AssertionError('the dev argv fallback should not read stdin')

        self.assertEqual(
            self.bootstrap['_bootstrap_auth_token'](
                ['--token', token], NeverRead()
            ),
            token,
        )
        for contents in (
            '', token, 'not-a-token\n', ('b' * 65) + '\n',
            token + '\nextra\n',
        ):
            with self.subTest(contents=contents[:16]):
                with self.assertRaises(ValueError):
                    self.bootstrap['_bootstrap_auth_token'](
                        ['--port', '8765'], io.StringIO(contents)
                    )

    def test_early_parent_parser_supports_both_arg_forms(self):
        parse = self.bootstrap['_early_parent_pid']
        self.assertEqual(parse(['--parent-pid', '42']), 42)
        self.assertEqual(parse(['--parent-pid=43']), 43)
        self.assertEqual(parse(['--parent-pid', '42', '--parent-pid=44']), 44)
        self.assertIsNone(parse(['--parent-pid', 'not-a-pid']))
        self.assertIsNone(parse(['--parent-pid', '1']))

    def test_windows_job_is_configured_and_assignment_is_mandatory(self):
        create_job = self.bootstrap['_create_windows_kill_on_close_job']
        api = FakeKernel32()
        captured_limits = []

        def capture_limits(_handle, _info_class, pointer, size):
            captured_limits.append(ctypes.string_at(pointer, size))
            return 1

        api.SetInformationJobObject.result = capture_limits
        self.assertEqual(create_job(api), 101)
        self.assertEqual(len(api.SetInformationJobObject.calls), 1)
        self.assertEqual(
            api.SetInformationJobObject.calls[0][1],
            self.bootstrap['_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION'],
        )
        self.assertIn(b'\x00\x20\x00\x00', captured_limits[0])
        self.assertEqual(api.AssignProcessToJobObject.calls[0], (101, 202))
        self.assertEqual(api.CloseHandle.calls, [])

        failing_api = FakeKernel32()
        failing_api.AssignProcessToJobObject.result = 0
        with self.assertRaisesRegex(OSError, 'AssignProcessToJobObject'):
            create_job(failing_api)
        self.assertEqual(failing_api.CloseHandle.calls, [(101,)])

    def test_windows_wait_statuses_are_explicit(self):
        wait_parent = self.bootstrap['_watch_parent_windows']
        timeout = self.bootstrap['_WAIT_TIMEOUT']
        exited = self.bootstrap['_WAIT_OBJECT_0']
        failed = self.bootstrap['_WAIT_FAILED']

        for waits, expected in (
            ([timeout, exited], 'parent process exited'),
            ([failed], 'WaitForSingleObject failed'),
            ([0x12345678], 'unexpected status'),
        ):
            with self.subTest(waits=waits):
                api = FakeKernel32(waits)
                reasons = []
                with mock.patch.object(
                    ctypes, 'WinDLL', return_value=api, create=True
                ), mock.patch.object(
                    ctypes, 'get_last_error', return_value=87, create=True
                ):
                    wait_parent(1234, reasons.append)
                self.assertEqual(len(reasons), 1)
                self.assertIn(expected, reasons[0])
                self.assertEqual(api.CloseHandle.calls, [(303,)])

    def test_posix_signaling_requires_backend_to_be_group_leader(self):
        signal_group = self.bootstrap['_signal_isolated_posix_group']
        killpg = mock.Mock()
        shared_group_os = types.SimpleNamespace(
            name='posix', getpgrp=lambda: 10, getpid=lambda: 20,
            killpg=killpg,
        )
        with mock.patch.dict(self.bootstrap, {'os': shared_group_os}):
            self.assertFalse(signal_group(signal.SIGTERM))
        killpg.assert_not_called()

        isolated_os = types.SimpleNamespace(
            name='posix', getpgrp=lambda: 20, getpid=lambda: 20,
            killpg=killpg,
        )
        with mock.patch.dict(self.bootstrap, {'os': isolated_os}):
            self.assertTrue(signal_group(signal.SIGTERM))
        killpg.assert_called_once_with(20, signal.SIGTERM)

    def test_parent_loss_requests_cancel_and_server_exit(self):
        watchdog_type = self.bootstrap['_ParentWatchdog']
        server = types.SimpleNamespace(should_exit=False, force_exit=False)
        watchdog = watchdog_type(1234)
        watchdog.backend_stopped.set()
        watchdog.attach_server(server)

        cancel = mock.Mock()
        with mock.patch.dict(
            self.bootstrap,
            {
                '_cancel_known_runtime_work': cancel,
                '_signal_isolated_posix_group': mock.Mock(return_value=False),
            },
        ):
            watchdog._on_parent_lost('unit test')

        self.assertTrue(watchdog.parent_lost.is_set())
        self.assertTrue(server.should_exit)
        cancel.assert_called_once_with()

    def test_parent_loss_before_server_still_starts_hard_deadline(self):
        watchdog_type = self.bootstrap['_ParentWatchdog']
        watchdog = watchdog_type(1234)
        interrupt = mock.Mock()
        with mock.patch.dict(
            self.bootstrap,
            {
                '_cancel_known_runtime_work': mock.Mock(),
                '_thread': types.SimpleNamespace(interrupt_main=interrupt),
            },
        ):
            watchdog._on_parent_lost('during import')
            self.assertTrue(watchdog._deadline_started)
            interrupt.assert_called_once_with()
            watchdog.backend_stopped.set()

    def test_pre_server_deadline_reaches_os_process_boundary(self):
        watchdog_type = self.bootstrap['_ParentWatchdog']
        watchdog = watchdog_type(1234)
        hard_stop = mock.Mock(return_value=True)
        with mock.patch.dict(
            self.bootstrap,
            {
                '_HARD_SHUTDOWN_SECONDS': 0,
                '_cancel_known_runtime_work': mock.Mock(),
                '_hard_stop_windows_job': hard_stop,
                '_WINDOWS_JOB_HANDLE': 987,
            },
        ):
            watchdog._enforce_deadline(None)
        hard_stop.assert_called_once_with(987)


class OfflineBoundaryTests(unittest.TestCase):
    def test_reverse_dns_apis_are_fail_closed(self):
        code = r'''
import os
import socket
os.environ['MUXMELT_OFFLINE'] = '1'
import offline_guard

calls = []
offline_guard._original_gethostbyaddr = lambda host: calls.append(('addr', host)) or ('localhost', [], [host])
offline_guard._original_getnameinfo = lambda address, flags: calls.append(('info', address, flags)) or ('localhost', '1234')
assert offline_guard.install_if_requested() is True
assert socket.gethostbyaddr('127.0.0.1')[0] == 'localhost'
assert socket.getnameinfo(('::1', 1234, 0, 0), 0)[0] == 'localhost'
assert [item[0] for item in calls] == ['addr', 'info']
for operation in (
    lambda: socket.gethostbyaddr('8.8.8.8'),
    lambda: socket.gethostbyaddr('example.com'),
    lambda: socket.getnameinfo(('8.8.8.8', 53), 0),
):
    try:
        operation()
    except offline_guard.OfflineModeError:
        pass
    else:
        raise AssertionError('external reverse lookup was not blocked')
'''
        env = os.environ.copy()
        env['PYTHONPATH'] = str(PYTHON_DIR)
        result = subprocess.run(
            [sys.executable, '-c', code], cwd=PYTHON_DIR, env=env,
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


class DemucsCacheIntegrityTests(unittest.TestCase):
    def load_runner_with_stubs(
        self, torch_root, model_urls, remote_root, bag_data=None
    ):
        numpy = types.ModuleType('numpy')
        torch = types.ModuleType('torch')
        torch.hub = types.SimpleNamespace(get_dir=lambda: str(torch_root))
        torchaudio = types.ModuleType('torchaudio')
        demucs = types.ModuleType('demucs')
        demucs.__path__ = []
        separate = types.ModuleType('demucs.separate')
        separate.main = lambda _argv: None
        pretrained = types.ModuleType('demucs.pretrained')
        pretrained.REMOTE_ROOT = remote_root
        pretrained._parse_remote_files = lambda _path: model_urls
        yaml = types.ModuleType('yaml')
        yaml.safe_load = lambda _text: bag_data or {}

        module_name = 'muxmelt_demucs_runner_test'
        module_path = PYTHON_DIR / 'modules' / 'demucs_runner.py'
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        module = importlib.util.module_from_spec(spec)
        stubs = {
            'numpy': numpy,
            'torch': torch,
            'torchaudio': torchaudio,
            'demucs': demucs,
            'demucs.separate': separate,
            'demucs.pretrained': pretrained,
            'yaml': yaml,
            module_name: module,
        }
        with mock.patch.dict(sys.modules, stubs), mock.patch.dict(
            os.environ, {'MUXMELT_OFFLINE': '0'}
        ):
            spec.loader.exec_module(module)
        return module, stubs

    def test_offline_checkpoint_requires_filename_hash_match(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_dir = root / 'torch' / 'checkpoints'
            cache_dir.mkdir(parents=True)
            remote_root = root / 'remote'
            remote_root.mkdir()
            payload = b'verified demucs checkpoint bytes'
            digest = hashlib.sha256(payload).hexdigest()
            filename = f'model-signature-{digest[:8]}.th'
            checkpoint = cache_dir / filename
            checkpoint.write_bytes(payload)
            model_urls = {
                'model-signature': f'https://models.invalid/{filename}'
            }
            runner, stubs = self.load_runner_with_stubs(
                root / 'torch', model_urls, remote_root
            )

            self.assertEqual(
                runner._checkpoint_hash_prefix(filename), digest[:8]
            )
            with mock.patch.dict(sys.modules, stubs), mock.patch.dict(
                os.environ, {'MUXMELT_OFFLINE': '1'}
            ):
                runner._require_cached_model_when_offline(
                    ['-n', 'model-signature']
                )
                checkpoint.write_bytes(payload + b'tampered')
                with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                    runner._require_cached_model_when_offline(
                        ['-n', 'model-signature']
                    )

    def test_unhashed_official_filename_is_not_trusted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_dir = root / 'torch' / 'checkpoints'
            cache_dir.mkdir(parents=True)
            remote_root = root / 'remote'
            remote_root.mkdir()
            filename = 'model-signature.th'
            (cache_dir / filename).write_bytes(b'unverifiable')
            runner, stubs = self.load_runner_with_stubs(
                root / 'torch',
                {'model-signature': f'https://models.invalid/{filename}'},
                remote_root,
            )
            with mock.patch.dict(sys.modules, stubs), mock.patch.dict(
                os.environ, {'MUXMELT_OFFLINE': '1'}
            ):
                with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                    runner._require_cached_model_when_offline(
                        ['--name', 'model-signature']
                    )

    def test_every_checkpoint_in_a_model_bag_is_verified(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_dir = root / 'torch' / 'checkpoints'
            cache_dir.mkdir(parents=True)
            remote_root = root / 'remote'
            remote_root.mkdir()
            (remote_root / 'test-bag.yaml').write_text(
                'models: [first, second]\n', encoding='utf-8'
            )
            model_urls = {}
            checkpoints = []
            for signature, payload in (
                ('first', b'first checkpoint'),
                ('second', b'second checkpoint'),
            ):
                digest = hashlib.sha256(payload).hexdigest()
                filename = f'{signature}-{digest[:8]}.th'
                checkpoint = cache_dir / filename
                checkpoint.write_bytes(payload)
                checkpoints.append(checkpoint)
                model_urls[signature] = f'https://models.invalid/{filename}'

            runner, stubs = self.load_runner_with_stubs(
                root / 'torch', model_urls, remote_root,
                bag_data={'models': ['first', 'second']},
            )
            with mock.patch.dict(sys.modules, stubs), mock.patch.dict(
                os.environ, {'MUXMELT_OFFLINE': '1'}
            ):
                runner._require_cached_model_when_offline(
                    ['-n', 'test-bag']
                )
                checkpoints[1].write_bytes(b'tampered second checkpoint')
                with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                    runner._require_cached_model_when_offline(
                        ['-n', 'test-bag']
                    )


if __name__ == '__main__':
    unittest.main()
