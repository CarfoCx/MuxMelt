"""Small, dependency-free validators shared by the WebSocket routers."""

import os
import math
import re
from pathlib import Path


def _require_text(value, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f'{field} must be a string')
    if '\x00' in value:
        raise ValueError(f'{field} contains an invalid null character')
    return value


def validate_output_dir(output_dir: str | None) -> str | None:
    """Return a normalized absolute output directory.

    The backend deliberately supports any absolute directory selected by the
    user. Relative paths and explicit ``..`` components are rejected so a
    malformed renderer payload cannot make a path relative to the backend's
    working directory.
    """
    if output_dir in (None, ''):
        return None
    output_dir = _require_text(output_dir, 'Output directory')
    if '..' in Path(output_dir).parts:
        raise ValueError('Invalid output directory: path traversal not allowed')
    if not os.path.isabs(output_dir):
        raise ValueError('Output directory must be an absolute path')
    return os.path.abspath(os.path.normpath(output_dir))


def validate_files_payload(files, *, max_files: int = 1000) -> list[str]:
    """Validate the shape of a file-list payload without touching the files."""
    if not isinstance(files, list):
        raise ValueError('Files must be provided as a list')
    if len(files) > max_files:
        raise ValueError(f'Too many files (maximum {max_files})')
    clean = []
    for value in files:
        value = _require_text(value, 'File path')
        if not value:
            raise ValueError('File path cannot be empty')
        if not os.path.isabs(value):
            raise ValueError('File paths must be absolute')
        clean.append(os.path.abspath(os.path.normpath(value)))
    return clean


def validate_input_file(file_path: str, allowed_extensions=None) -> str:
    """Validate one existing regular file and, optionally, its extension."""
    file_path = _require_text(file_path, 'File path')
    if not os.path.isabs(file_path):
        raise ValueError('File path must be absolute')
    normalized = os.path.abspath(os.path.normpath(file_path))
    if not os.path.isfile(normalized):
        raise FileNotFoundError(f'File not found: {file_path}')
    if allowed_extensions is not None:
        suffix = Path(normalized).suffix.lower()
        if suffix not in allowed_extensions:
            raise ValueError(f'Unsupported file format: {suffix or "(none)"}')
    return normalized


def validate_choice(value, choices, field: str) -> str:
    value = _require_text(value, field)
    if value not in choices:
        allowed = ', '.join(sorted(choices))
        raise ValueError(f'Invalid {field.lower()}: {value!r}. Expected one of: {allowed}')
    return value


def validate_int(value, field: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f'{field} must be an integer')
    if not minimum <= value <= maximum:
        raise ValueError(f'{field} must be between {minimum} and {maximum}')
    return value


def validate_float(value, field: str, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f'{field} must be a number')
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ValueError(f'{field} must be between {minimum} and {maximum}')
    return result


def next_output_path(output_dir: str, stem: str, suffix: str) -> str:
    """Choose a non-existing output path, retaining the caller's safe suffix."""
    if (not isinstance(stem, str) or not stem
            or os.path.basename(stem) != stem or stem in ('.', '..')):
        raise ValueError('Invalid output filename')
    if not isinstance(suffix, str) or not re.fullmatch(r'\.[A-Za-z0-9]{1,10}', suffix):
        raise ValueError('Invalid output file extension')
    candidate = os.path.join(output_dir, f'{stem}{suffix}')
    counter = 1
    while os.path.exists(candidate):
        candidate = os.path.join(output_dir, f'{stem}_{counter}{suffix}')
        counter += 1
    return candidate
