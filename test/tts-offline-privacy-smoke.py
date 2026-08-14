"""Focused checks for fail-closed, local-only TTS behavior."""

import asyncio
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))

from modules import tts  # noqa: E402
from routers import tts_routes  # noqa: E402


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


class OfflineTtsPrivacyTests(unittest.IsolatedAsyncioTestCase):
    def test_module_has_no_cloud_client_or_network_import(self):
        source = (ROOT / 'python' / 'modules' / 'tts.py').read_text(encoding='utf-8')
        html = (ROOT / 'renderer' / 'tools' / 'tts' / 'tts.html').read_text(encoding='utf-8')
        renderer = (ROOT / 'renderer' / 'tools' / 'tts' / 'tts.js').read_text(encoding='utf-8')
        self.assertNotIn('edge_tts', source)
        self.assertNotIn('edge-tts', source)
        self.assertNotRegex(source, r'\b(?:requests|httpx|aiohttp|urllib)\b')
        self.assertIn("'sapi'", source)
        self.assertIn("'say'", source)
        self.assertIn("'espeak'", source)
        self.assertIn("'-protocol_whitelist'", source)
        self.assertNotIn("'http,https'", source)
        self.assertIn('spellcheck="false"', html)
        self.assertNotIn('id="spellcheckToggle" checked', html)
        self.assertNotIn('settings.spellcheck', renderer)

    async def test_synthesis_accepts_only_an_enumerated_local_voice(self):
        voice = {
            'id': 'sapi:Test Voice', 'name': 'Test Voice', 'locale': 'en-US',
            'gender': '', 'engine': 'test', 'supports_pitch': True,
        }

        async def fake_native(_text, _voice, native_path, _rate, _pitch):
            Path(native_path).write_bytes(b'RIFF' + (b'\0' * 64))

        with tempfile.TemporaryDirectory() as temp_dir:
            output = os.path.join(temp_dir, 'speech.wav')
            with mock.patch.object(tts, 'get_voices', mock.AsyncMock(return_value=[voice])), \
                    mock.patch.object(tts, '_synthesize_native', fake_native):
                result = await tts.synthesize('private words', voice['id'], output)
                self.assertEqual(result, output)
                self.assertTrue(os.path.isfile(output))

                with self.assertRaisesRegex(ValueError, 'Select one of the offline voices'):
                    await tts.synthesize('private words', 'sapi:Not Installed', output)

    async def test_route_never_uses_private_text_as_a_filename(self):
        with tempfile.TemporaryDirectory() as output_dir:
            ws = FakeWebSocket()

            async def fake_synthesize(_text, _voice, output_path, **_kwargs):
                Path(output_path).write_bytes(b'local audio')
                return output_path

            data = {
                'text': 'medical diagnosis account secret',
                'voice': 'sapi:Test Voice',
                'output_dir': output_dir,
                'output_format': 'wav',
                'rate': '+0%',
                'pitch': '+0Hz',
                'is_preview': False,
            }
            with mock.patch.object(tts_routes, 'synthesize', fake_synthesize):
                await tts_routes._run_synthesis(ws, data)

            complete = next(message for message in ws.messages if message['type'] == 'complete')
            name = os.path.basename(complete['output'])
            self.assertRegex(name, r'^speech(?:_\d+)?\.wav$')
            self.assertNotIn('medical', name)
            self.assertNotIn('secret', name)

    def test_stale_cleanup_is_scoped_to_opaque_preview_names(self):
        with tempfile.TemporaryDirectory() as preview_dir:
            old_preview = Path(preview_dir, 'preview-0123456789abcdef.wav')
            new_preview = Path(preview_dir, 'preview-fedcba9876543210.mp3')
            unrelated = Path(preview_dir, 'keep-me.txt')
            for item in (old_preview, new_preview, unrelated):
                item.write_bytes(b'x')

            now = time.time()
            os.utime(old_preview, (now - (2 * 24 * 60 * 60),) * 2)
            old_dir = tts_routes._PREVIEW_DIR
            try:
                tts_routes._PREVIEW_DIR = preview_dir
                tts_routes.cleanup_stale_previews(now=now)
            finally:
                tts_routes._PREVIEW_DIR = old_dir

            self.assertFalse(old_preview.exists())
            self.assertTrue(new_preview.exists())
            self.assertTrue(unrelated.exists())


if __name__ == '__main__':
    unittest.main()
