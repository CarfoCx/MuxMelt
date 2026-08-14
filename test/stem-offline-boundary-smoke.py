"""Dependency-free checks for the native-code boundary in Offline Mode."""

from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

from modules import stem_separator  # noqa: E402


class _CompletedFfmpeg:
    def __init__(self, command, **_kwargs):
        self.command = command
        self.returncode = 0
        Path(command[-1]).write_bytes(b'RIFF' + (b'\0' * 64))

    def poll(self):
        return self.returncode


class StemOfflineBoundaryTests(unittest.TestCase):
    def test_predecode_allows_local_protocols_only(self):
        protocols = set(stem_separator.FFMPEG_LOCAL_PROTOCOLS.split(','))
        self.assertTrue({'file', 'pipe', 'fd', 'concat'}.issubset(protocols))
        self.assertTrue({
            'http', 'https', 'tcp', 'tls', 'udp', 'ftp', 'sftp', 'rtmp', 'srt',
        }.isdisjoint(protocols))

        captured = {}

        def fake_popen(command, **kwargs):
            captured['command'] = command
            captured['kwargs'] = kwargs
            return _CompletedFfmpeg(command, **kwargs)

        with tempfile.TemporaryDirectory() as temp_dir, \
                mock.patch.object(stem_separator.subprocess, 'Popen', fake_popen):
            source = str(Path(temp_dir, 'private.m3u8'))
            output = str(Path(temp_dir, 'decoded.wav'))
            result = stem_separator._decode_offline_input(
                source, output, threading.Event(),
            )

        self.assertEqual(result, output)
        command = captured['command']
        option_index = command.index('-protocol_whitelist')
        input_index = command.index('-i')
        self.assertLess(option_index, input_index)
        self.assertEqual(command[option_index + 1], stem_separator.FFMPEG_LOCAL_PROTOCOLS)
        self.assertEqual(captured['kwargs']['stderr'], stem_separator.subprocess.DEVNULL)

    def test_offline_paths_predecode_before_demucs(self):
        source = (ROOT / 'python' / 'modules' / 'stem_separator.py').read_text(
            encoding='utf-8',
        )
        self.assertGreaterEqual(source.count('_decode_offline_input('), 3)
        self.assertIn("if _offline_mode_enabled():", source)


if __name__ == '__main__':
    unittest.main()
