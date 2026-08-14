"""Prove Local Chat does not send secrets or prompts to an unproven port."""

from pathlib import Path
import os
import queue
import re
import stat
import sys
import threading
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

from modules import llm  # noqa: E402


class _Pipe:
    def __init__(self):
        self.items = queue.Queue()

    def readline(self, _limit=-1):
        return self.items.get(timeout=5)

    def write_line(self, line):
        self.items.put((line + '\n').encode('utf-8'))

    def close_input(self):
        self.items.put(b'')

    def close(self):
        pass


class _Process:
    def __init__(self):
        self.stdout = _Pipe()
        self.returncode = None

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15
        self.stdout.close_input()

    def kill(self):
        self.returncode = -9
        self.stdout.close_input()

    def wait(self, timeout=None):
        return self.returncode


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _Opener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        return _Response()


class LlamaReadinessTests(unittest.TestCase):
    def test_catalog_urls_and_hashes_are_immutable(self):
        for model_id, model in llm.MODELS.items():
            with self.subTest(model=model_id):
                self.assertNotIn('/resolve/main/', model['url'])
                self.assertRegex(model['url'], r'/resolve/[0-9a-f]{40}/')
                self.assertTrue(re.fullmatch(r'[0-9a-f]{64}', model['sha256']))

    def test_listener_marker_parser_is_port_and_host_specific(self):
        self.assertTrue(llm._is_llama_listener_proof(
            'srv llama_server: server is listening on http://127.0.0.1:49321',
            49321,
        ))
        self.assertTrue(llm._is_llama_listener_proof(
            'main: HTTP server is listening, hostname: 127.0.0.1, port: 49321',
            49321,
        ))
        self.assertTrue(llm._is_llama_listener_proof(
            '{"msg":"HTTP server listening","hostname":"127.0.0.1","port":"49321"}',
            49321,
        ))
        self.assertFalse(llm._is_llama_listener_proof(
            'server is listening on http://127.0.0.1:49322',
            49321,
        ))
        self.assertFalse(llm._is_llama_listener_proof(
            'server is listening on http://192.168.1.1:49321',
            49321,
        ))

    def test_health_token_waits_for_exact_child_bind_proof(self):
        engine = llm.ChatLLM()
        opener = _Opener()
        engine._loopback_opener = opener
        process = _Process()
        result = {}

        def launch():
            try:
                result['value'] = engine._launch_and_wait(
                    'managed-llama-server',
                    'private-model.gguf',
                    {
                        'context_size': 4096,
                        'threads': 4,
                        'batch_size': 512,
                        'ubatch_size': 128,
                        'idle_seconds': 60,
                    },
                    [],
                )
            except BaseException as error:  # pragma: no cover
                result['error'] = error

        launched = {}

        def capture_launch(command, **_kwargs):
            launched['command'] = command
            key_index = command.index('--api-key-file') + 1
            launched['key_path'] = command[key_index]
            with open(launched['key_path'], 'r', encoding='ascii') as key_file:
                launched['key'] = key_file.read().rstrip('\n')
            launched['file_mode'] = stat.S_IMODE(os.stat(launched['key_path']).st_mode)
            launched['directory_mode'] = stat.S_IMODE(
                os.stat(os.path.dirname(launched['key_path'])).st_mode
            )
            return process

        with mock.patch.object(llm, '_find_free_port', return_value=49321), \
                mock.patch.object(llm.subprocess, 'Popen', side_effect=capture_launch):
            thread = threading.Thread(target=launch)
            thread.start()
            time.sleep(0.15)
            self.assertEqual(opener.requests, [])
            process.stdout.write_line('loading model from private-model.gguf')
            time.sleep(0.15)
            self.assertEqual(opener.requests, [])
            process.stdout.write_line(
                'srv llama_server: server is listening on http://127.0.0.1:49321'
            )
            thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertNotIn('error', result)
        self.assertEqual(result.get('value'), (process, 49321))
        self.assertNotIn('--api-key', launched['command'])
        self.assertIn('--api-key-file', launched['command'])
        self.assertNotIn(launched['key'], launched['command'])
        self.assertEqual(launched['key'], engine._api_key)
        if os.name != 'nt':
            # Windows protects the file through the per-user temp directory's
            # inherited DACL; its stat mode does not expose Windows ACL entries.
            self.assertEqual(launched['file_mode'] & 0o077, 0)
            self.assertEqual(launched['directory_mode'] & 0o077, 0)
        self.assertEqual(len(opener.requests), 1)
        request = opener.requests[0][0]
        self.assertEqual(
            request.get_header('Authorization'),
            f'Bearer {engine._api_key}',
        )
        process.terminate()
        deadline = time.monotonic() + 3
        while os.path.exists(launched['key_path']) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(os.path.exists(launched['key_path']))
        self.assertFalse(os.path.exists(os.path.dirname(launched['key_path'])))

    def test_spawn_failure_removes_private_api_key_file(self):
        engine = llm.ChatLLM()
        launched = {}

        def fail_launch(command, **_kwargs):
            launched['command'] = command
            launched['key_path'] = command[command.index('--api-key-file') + 1]
            with open(launched['key_path'], 'r', encoding='ascii') as key_file:
                launched['key'] = key_file.read().rstrip('\n')
            raise OSError('synthetic spawn failure')

        with mock.patch.object(llm, '_find_free_port', return_value=49321), \
                mock.patch.object(llm.subprocess, 'Popen', side_effect=fail_launch):
            with self.assertRaisesRegex(OSError, 'synthetic spawn failure'):
                engine._launch_and_wait(
                    'managed-llama-server',
                    'private-model.gguf',
                    {
                        'context_size': 4096,
                        'threads': 4,
                        'batch_size': 512,
                        'ubatch_size': 128,
                        'idle_seconds': 60,
                    },
                    [],
                )

        self.assertNotIn('--api-key', launched['command'])
        self.assertNotIn(launched['key'], launched['command'])
        self.assertFalse(os.path.exists(launched['key_path']))
        self.assertFalse(os.path.exists(os.path.dirname(launched['key_path'])))

    def test_child_startup_failure_removes_private_api_key_file(self):
        engine = llm.ChatLLM()
        process = _Process()
        process.returncode = 2
        launched = {}

        def capture_failed_child(command, **_kwargs):
            launched['key_path'] = command[command.index('--api-key-file') + 1]
            return process

        with mock.patch.object(llm, '_find_free_port', return_value=49321), \
                mock.patch.object(
                    llm.subprocess, 'Popen', side_effect=capture_failed_child
                ):
            with self.assertRaisesRegex(RuntimeError, 'exited during startup'):
                engine._launch_and_wait(
                    'managed-llama-server',
                    'private-model.gguf',
                    {
                        'context_size': 4096,
                        'threads': 4,
                        'batch_size': 512,
                        'ubatch_size': 128,
                        'idle_seconds': 60,
                    },
                    [],
                )

        self.assertFalse(os.path.exists(launched['key_path']))
        self.assertFalse(os.path.exists(os.path.dirname(launched['key_path'])))


if __name__ == '__main__':
    unittest.main()
