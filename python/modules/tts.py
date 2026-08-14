"""Offline text-to-speech using only speech engines installed on the device.

There is deliberately no network or cloud fallback in this module.  Windows
uses SAPI through the built-in Windows PowerShell, macOS uses ``say``, and
Linux/other Unix systems use an installed ``espeak-ng`` or ``espeak`` binary.
"""

import asyncio
import inspect
import json
import os
import re
import secrets
import shutil
import subprocess
import sys


_RATE_RE = re.compile(r'^[+-](?:100|[0-9]{1,2})%$')
_PITCH_RE = re.compile(r'^[+-](?:[0-9]{1,3})Hz$')

_WINDOWS_LIST_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
        [PSCustomObject]@{
            id = 'sapi:' + $_.VoiceInfo.Name
            name = $_.VoiceInfo.Name
            locale = $_.VoiceInfo.Culture.Name
            gender = $_.VoiceInfo.Gender.ToString()
            engine = 'Windows SAPI'
            supports_pitch = $true
        }
    })
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject $voices))
} finally {
    $synth.Dispose()
}
'''

_WINDOWS_SYNTH_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$payload = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $voiceName = ([string]$payload.voice) -replace '^sapi:', ''
    $installed = $synth.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Name -eq $voiceName
    } | Select-Object -First 1
    if ($null -eq $installed) { throw 'The selected local voice is no longer installed.' }

    $synth.SelectVoice($installed.VoiceInfo.Name)
    $escapedText = [System.Security.SecurityElement]::Escape([string]$payload.text)
    $culture = $installed.VoiceInfo.Culture.Name
    $rate = [string]$payload.rate
    $pitch = [string]$payload.pitch
    $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' +
        $culture + '"><prosody rate="' + $rate + '" pitch="' + $pitch + '">' +
        $escapedText + '</prosody></speak>'
    $synth.SetOutputToWaveFile([string]$payload.output)
    $synth.SpeakSsml($ssml)
} finally {
    try { $synth.SetOutputToNull() } catch {}
    $synth.Dispose()
}
'''


def _powershell_command():
    if os.name != 'nt':
        return None
    return shutil.which('powershell.exe') or shutil.which('powershell') or shutil.which('pwsh')


def _detect_backend():
    if os.name == 'nt':
        command = _powershell_command()
        return ('sapi', command) if command else (None, None)
    if sys.platform == 'darwin':
        command = shutil.which('say')
        return ('say', command) if command else (None, None)
    command = shutil.which('espeak-ng') or shutil.which('espeak')
    return ('espeak', command) if command else (None, None)


def is_available():
    """Return whether a supported local speech executable is present."""
    backend, command = _detect_backend()
    return bool(backend and command)


async def _report(callback, progress, status):
    if callback:
        result = callback(progress, status)
        if inspect.isawaitable(result):
            await result


async def _run_process(args, input_text=None):
    kwargs = {
        'stdin': asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL,
        'stdout': asyncio.subprocess.PIPE,
        'stderr': asyncio.subprocess.PIPE,
    }
    if os.name == 'nt' and hasattr(subprocess, 'CREATE_NO_WINDOW'):
        kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW

    process = await asyncio.create_subprocess_exec(*args, **kwargs)
    try:
        stdout, stderr = await process.communicate(
            input_text.encode('utf-8') if input_text is not None else None
        )
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
        details = stderr.decode('utf-8', errors='replace').strip()
        if not details:
            details = stdout.decode('utf-8', errors='replace').strip()
        raise RuntimeError(details[-1000:] or 'The local speech engine failed.')
    return stdout.decode('utf-8', errors='replace')


async def _windows_voices(command):
    output = await _run_process([
        command, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        _WINDOWS_LIST_SCRIPT,
    ])
    try:
        voices = json.loads(output or '[]')
    except json.JSONDecodeError as exc:
        raise RuntimeError('Windows returned an invalid installed-voice list.') from exc
    if isinstance(voices, dict):
        voices = [voices]
    return voices if isinstance(voices, list) else []


async def _macos_voices(command):
    output = await _run_process([command, '-v', '?'])
    voices = []
    for line in output.splitlines():
        match = re.match(r'^(.*?)\s{2,}([A-Za-z]{2,3}_[A-Za-z0-9_]+)\s+#', line)
        if not match:
            continue
        name = match.group(1).strip()
        locale = match.group(2).replace('_', '-')
        if name:
            voices.append({
                'id': f'say:{name}', 'name': name, 'locale': locale,
                'gender': '', 'engine': 'macOS Speech', 'supports_pitch': False,
            })
    return voices


async def _espeak_voices(command):
    output = await _run_process([command, '--voices'])
    voices = []
    seen = set()
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 4 or not parts[0].isdigit():
            continue
        identifier = parts[1]
        if identifier in seen:
            continue
        seen.add(identifier)
        gender = parts[2][-1:] if parts[2] else ''
        name = parts[3].replace('_', ' ')
        voices.append({
            'id': f'espeak:{identifier}', 'name': name,
            'locale': identifier.replace('_', '-'), 'gender': gender,
            'engine': 'eSpeak', 'supports_pitch': True,
        })
    return voices


async def get_voices():
    """List installed voices without contacting a network service."""
    backend, command = _detect_backend()
    if not backend or not command:
        raise RuntimeError(
            'No supported offline speech engine was found. On Linux, install '
            'espeak-ng. Windows and macOS use their built-in local voices.'
        )

    if backend == 'sapi':
        voices = await _windows_voices(command)
    elif backend == 'say':
        voices = await _macos_voices(command)
    else:
        voices = await _espeak_voices(command)

    voices = [
        voice for voice in voices
        if isinstance(voice, dict)
        and isinstance(voice.get('id'), str)
        and isinstance(voice.get('name'), str)
        and isinstance(voice.get('locale'), str)
    ]
    if not voices:
        raise RuntimeError('No enabled offline voices are installed on this computer.')
    return voices


def _parse_rate(rate):
    if not isinstance(rate, str) or not _RATE_RE.fullmatch(rate):
        raise ValueError('Rate must be between -99% and +100%')
    value = int(rate[:-1])
    if not -99 <= value <= 100:
        raise ValueError('Rate must be between -99% and +100%')
    return value


def _parse_pitch(pitch):
    if not isinstance(pitch, str) or not _PITCH_RE.fullmatch(pitch):
        raise ValueError('Pitch must use the form +0Hz or -12Hz')
    value = int(pitch[:-2])
    if not -100 <= value <= 100:
        raise ValueError('Pitch must be between -100Hz and +100Hz')
    return value


async def _synthesize_native(text, selected_voice, native_path, rate, pitch):
    backend, command = _detect_backend()
    voice_id = selected_voice['id']
    if not backend or not command or not voice_id.startswith(f'{backend}:'):
        raise RuntimeError('The selected offline speech engine is unavailable.')

    rate_percent = _parse_rate(rate)
    pitch_hz = _parse_pitch(pitch)
    if backend == 'sapi':
        payload = json.dumps({
            'text': text, 'voice': voice_id, 'output': native_path,
            'rate': rate, 'pitch': pitch,
        }, ensure_ascii=False)
        await _run_process([
            command, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            _WINDOWS_SYNTH_SCRIPT,
        ], payload)
        return

    local_voice = voice_id.split(':', 1)[1]
    words_per_minute = max(80, min(400, round(180 * (1 + rate_percent / 100))))
    if backend == 'say':
        # macOS `say` has no safe, documented per-utterance pitch flag. The UI
        # disables pitch for these voices, and synthesis remains fully local.
        await _run_process([
            command, '-v', local_voice, '-r', str(words_per_minute),
            '-o', native_path,
        ], text)
        return

    espeak_pitch = max(0, min(99, 50 + (pitch_hz * 2)))
    await _run_process([
        command, '-v', local_voice, '-s', str(words_per_minute),
        '-p', str(espeak_pitch), '-w', native_path, '--stdin',
    ], text)


async def _convert_audio(source_path, output_path, output_format):
    codec_args = ['-c:a', 'pcm_s16le'] if output_format == '.wav' else [
        '-c:a', 'libmp3lame', '-q:a', '2',
    ]
    try:
        await _run_process([
            'ffmpeg', '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-protocol_whitelist',
            'file,pipe,fd,crypto,data,concat,concatf,subfile,async,cache',
            '-i', source_path, '-vn', *codec_args, output_path,
        ])
    except FileNotFoundError as exc:
        raise RuntimeError('ffmpeg is required to create this speech format.') from exc


async def synthesize(text, voice, output_path, rate='+0%', pitch='+0Hz', progress_callback=None):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Text cannot be empty')
    if len(text) > 50_000:
        raise ValueError('Text is too long (maximum 50,000 characters)')
    if not isinstance(voice, str) or not voice or len(voice) > 256 or '\x00' in voice:
        raise ValueError('Invalid voice identifier')
    _parse_rate(rate)
    _parse_pitch(pitch)
    if not isinstance(output_path, str) or not output_path:
        raise ValueError('Output path is required')

    output_format = os.path.splitext(output_path)[1].lower()
    if output_format not in ('.mp3', '.wav'):
        raise ValueError('TTS output format must be MP3 or WAV')

    voices = await get_voices()
    selected_voice = next((item for item in voices if item['id'] == voice), None)
    if selected_voice is None:
        raise ValueError('Select one of the offline voices installed on this computer.')

    await _report(progress_callback, 0.1, 'Generating speech on this device...')
    output_path = os.path.abspath(output_path)
    output_dir = os.path.dirname(output_path)
    os.makedirs(output_dir, exist_ok=True)

    unique = f'{os.getpid()}-{secrets.token_hex(8)}'
    backend = voice.split(':', 1)[0]
    native_extension = '.aiff' if backend == 'say' else '.wav'
    native_path = f'{output_path}.{unique}.part{native_extension}'
    temp_output = f'{output_path}.{unique}.part{output_format}'

    try:
        await _synthesize_native(text, selected_voice, native_path, rate, pitch)
        if not os.path.isfile(native_path) or os.path.getsize(native_path) == 0:
            raise RuntimeError('The local speech engine returned an empty audio file.')

        if output_format == '.wav' and native_extension == '.wav':
            temp_output = native_path
        else:
            await _report(progress_callback, 0.85, f'Creating {output_format[1:].upper()}...')
            await _convert_audio(native_path, temp_output, output_format)
            if not os.path.isfile(temp_output) or os.path.getsize(temp_output) == 0:
                raise RuntimeError('ffmpeg returned an empty speech file.')

        os.replace(temp_output, output_path)
    finally:
        for temp_path in {native_path, temp_output}:
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass

    await _report(progress_callback, 1.0, 'Complete')
    return output_path
