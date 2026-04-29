"""Shared validation utilities for all Python routers."""

import os


def validate_output_dir(output_dir: str) -> str | None:
    """Validate and normalize output directory to prevent path traversal.

    Returns the normalized absolute path, or the original value if falsy.
    Raises ValueError on invalid/unsafe paths.
    """
    if not output_dir:
        return output_dir
    normalized = os.path.normpath(output_dir)
    if '..' in normalized.split(os.sep):
        raise ValueError('Invalid output directory: path traversal not allowed')
    if not os.path.isabs(normalized):
        raise ValueError('Output directory must be an absolute path')
    return normalized
