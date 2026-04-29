import asyncio
import os

try:
    import edge_tts
    _available = True
except ImportError:
    _available = False


def is_available():
    return _available


async def get_voices():
    if not _available:
        return []
    voices = await edge_tts.list_voices()
    return [
        {
            'id': v['ShortName'],
            'name': v['FriendlyName'],
            'locale': v['Locale'],
            'gender': v['Gender'],
        }
        for v in voices
    ]


async def synthesize(text, voice, output_path, rate='+0%', progress_callback=None):
    if not _available:
        raise RuntimeError('edge-tts is not installed. Run: pip install edge-tts')

    if progress_callback:
        await progress_callback(0.1, 'Generating speech...')

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(output_path)

    if progress_callback:
        await progress_callback(1.0, 'Complete')

    return output_path
