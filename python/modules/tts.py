import asyncio
import inspect
import os
import re
import threading

try:
    import edge_tts
    _available = True
except ImportError:
    _available = False


def is_available():
    return _available


_RATE_RE = re.compile(r'^[+-](?:100|[0-9]{1,2})%$')
_PITCH_RE = re.compile(r'^[+-](?:[0-9]{1,3})Hz$')
_VOICE_RE = re.compile(r'^[A-Za-z0-9-]{1,128}$')


async def _report(callback, progress, status):
    if callback:
        result = callback(progress, status)
        if inspect.isawaitable(result):
            await result


async def get_voices():
    if not _available:
        raise RuntimeError('edge-tts is not installed. Run: pip install edge-tts')
    voices = await edge_tts.list_voices()
    return [
        {
            'id': v.get('ShortName', ''),
            'name': v.get('FriendlyName') or v.get('ShortName', ''),
            'locale': v.get('Locale', ''),
            'gender': v.get('Gender', ''),
        }
        for v in voices
        if v.get('ShortName')
    ]


async def synthesize(text, voice, output_path, rate='+0%', pitch='+0Hz', progress_callback=None):
    if not _available:
        raise RuntimeError('edge-tts is not installed. Run: pip install edge-tts')

    if not isinstance(text, str) or not text.strip():
        raise ValueError('Text cannot be empty')
    if len(text) > 50_000:
        raise ValueError('Text is too long (maximum 50,000 characters)')
    if not isinstance(voice, str) or not _VOICE_RE.fullmatch(voice):
        raise ValueError('Invalid voice identifier')
    if not isinstance(rate, str) or not _RATE_RE.fullmatch(rate):
        raise ValueError('Rate must be between -99% and +100%')
    if not isinstance(pitch, str) or not _PITCH_RE.fullmatch(pitch):
        raise ValueError('Pitch must use the form +0Hz or -12Hz')
    if not isinstance(output_path, str) or not output_path:
        raise ValueError('Output path is required')

    output_format = os.path.splitext(output_path)[1].lower()
    if output_format not in ('.mp3', '.wav'):
        raise ValueError('TTS output format must be MP3 or WAV')

    await _report(progress_callback, 0.1, 'Generating speech...')

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    unique = f'{os.getpid()}.{threading.get_ident()}'
    temp_mp3 = f'{output_path}.{unique}.part.mp3'
    temp_output = temp_mp3 if output_format == '.mp3' else f'{output_path}.{unique}.part.wav'
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    try:
        # Edge's service returns MP3 audio regardless of the destination suffix.
        # Always receive to an MP3 temp file; WAV requests are explicitly
        # transcoded so they are not MP3 bytes hidden behind a .wav extension.
        await communicate.save(temp_mp3)
        if not os.path.isfile(temp_mp3) or os.path.getsize(temp_mp3) == 0:
            raise RuntimeError('The speech service returned an empty audio file')

        if output_format == '.wav':
            await _report(progress_callback, 0.85, 'Converting to WAV...')
            try:
                process = await asyncio.create_subprocess_exec(
                    'ffmpeg', '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
                    '-i', temp_mp3, '-vn', '-c:a', 'pcm_s16le', temp_output,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
            except FileNotFoundError as exc:
                raise RuntimeError('ffmpeg is required to create WAV speech output') from exc
            try:
                _, stderr = await process.communicate()
            except asyncio.CancelledError:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                raise
            if process.returncode != 0:
                details = stderr.decode('utf-8', errors='replace')[-500:]
                raise RuntimeError(f'Failed to convert speech to WAV: {details}')
            if not os.path.isfile(temp_output) or os.path.getsize(temp_output) == 0:
                raise RuntimeError('ffmpeg returned an empty WAV file')

        os.replace(temp_output, output_path)
    finally:
        for temp_path in {temp_mp3, temp_output}:
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass

    await _report(progress_callback, 1.0, 'Complete')

    return output_path
