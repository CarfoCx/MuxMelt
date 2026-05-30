import hashlib
import json
import os
import sys
import tempfile
import base64
import urllib.request
from pathlib import Path

import fitz

# Pin to a known-good SHA-256 of eng.traineddata from tessdata_fast to enforce
# integrity on the download. Set to None to skip pinning (computes+stores on
# first download and verifies on subsequent runs to detect tampering).
TESSDATA_SHA256 = None


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_terms(value):
    terms = []
    for item in value or []:
        term = str(item).strip()
        if term and term not in terms:
            terms.append(term)
    return terms


def color_tuple(value, default):
    if not value:
        return default
    if isinstance(value, str):
        value = value.lstrip("#")
        if len(value) == 6:
            return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return tuple((float(c) / 255.0) if float(c) > 1 else float(c) for c in value)
    return default


TESSDATA_URL = "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"


def app_data_dir():
    if os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "muxmelt"
    if os.environ.get("XDG_DATA_HOME"):
        return Path(os.environ["XDG_DATA_HOME"]) / "muxmelt"
    return Path.home() / ".muxmelt"


def configured_tessdata_dir():
    candidates = []
    env_path = os.environ.get("TESSDATA_PREFIX")
    if env_path:
        candidates.append(Path(env_path))

    candidates.extend([
        app_data_dir() / "tessdata",
        Path(__file__).resolve().parent / "tessdata",
        Path("C:/Program Files/Tesseract-OCR/tessdata"),
        Path("C:/Program Files (x86)/Tesseract-OCR/tessdata"),
        Path("/usr/share/tesseract-ocr/5/tessdata"),
        Path("/usr/share/tesseract-ocr/4.00/tessdata"),
        Path("/usr/share/tessdata"),
    ])

    for candidate in candidates:
        trained = candidate / "eng.traineddata"
        if not trained.exists():
            continue
        # For paths that have a stored hash manifest (i.e. previously downloaded
        # by MuxMelt), verify the file hasn't been tampered with before trusting it.
        hash_manifest = candidate / "eng.traineddata.sha256"
        if hash_manifest.exists():
            stored = hash_manifest.read_text("utf-8").strip()
            actual = _sha256_file(trained)
            if actual != stored:
                # Tampered — delete and fall through to re-download
                try:
                    trained.unlink(missing_ok=True)
                    hash_manifest.unlink(missing_ok=True)
                except Exception:
                    pass
                continue
        return candidate

    target = app_data_dir() / "tessdata"
    target.mkdir(parents=True, exist_ok=True)
    trained_data = target / "eng.traineddata"
    hash_manifest = target / "eng.traineddata.sha256"
    partial = target / "eng.traineddata.part"

    needs_download = not trained_data.exists() or trained_data.stat().st_size < 1_000_000

    # Tamper check: verify stored hash matches file on disk
    if not needs_download and hash_manifest.exists():
        stored = hash_manifest.read_text("utf-8").strip()
        actual = _sha256_file(trained_data)
        if actual != stored:
            needs_download = True
            try:
                trained_data.unlink(missing_ok=True)
                hash_manifest.unlink(missing_ok=True)
            except Exception:
                pass

    if needs_download:
        try:
            urllib.request.urlretrieve(TESSDATA_URL, partial)
            computed = _sha256_file(partial)
            if TESSDATA_SHA256 and computed != TESSDATA_SHA256.lower():
                partial.unlink(missing_ok=True)
                raise RuntimeError(
                    f"Downloaded OCR data failed integrity check "
                    f"(expected {TESSDATA_SHA256}, got {computed}). "
                    "The file may have been tampered with."
                )
            partial.replace(trained_data)
            hash_manifest.write_text(computed, "utf-8")
        except RuntimeError:
            raise
        except Exception as exc:
            try:
                partial.unlink(missing_ok=True)
            except Exception:
                pass
            raise RuntimeError(
                "OCR needs Tesseract English language data, but MuxMelt could not download it. "
                f"Check your internet connection or install Tesseract manually. Details: {exc}"
            )

    os.environ["TESSDATA_PREFIX"] = str(target)
    return target


def text_align(value):
    value = str(value or "left").lower()
    if value == "center":
        return fitz.TEXT_ALIGN_CENTER
    if value == "right":
        return fitz.TEXT_ALIGN_RIGHT
    return fitz.TEXT_ALIGN_LEFT


def draw_underlines(page, rect, text, fontname, fontsize, color, align, line_height):
    lines = str(text or "").splitlines() or [str(text or "")]
    line_step = fontsize * line_height
    underline_y_offset = fontsize * 1.12
    max_width = max(rect.width, 1)
    for index, line in enumerate(lines):
        if not line:
            continue
        try:
            text_width = fitz.get_text_length(line, fontname=fontname, fontsize=fontsize)
        except Exception:
            text_width = len(line) * fontsize * 0.55
        text_width = min(text_width, max_width)
        if align == fitz.TEXT_ALIGN_CENTER:
            x1 = rect.x0 + max((max_width - text_width) / 2, 0)
        elif align == fitz.TEXT_ALIGN_RIGHT:
            x1 = rect.x1 - text_width
        else:
            x1 = rect.x0
        y1 = rect.y0 + underline_y_offset + (index * line_step)
        if y1 > rect.y1:
            break
        page.draw_line(
            fitz.Point(x1, y1),
            fitz.Point(x1 + text_width, y1),
            color=color,
            width=max(fontsize * 0.055, 0.45),
        )


def base_font_name(edit):
    family = str(edit.get("fontFamily") or edit.get("originalFontFamily") or "").lower()
    weight = str(edit.get("fontWeight") or "normal").lower()
    style = str(edit.get("fontStyle") or "normal").lower()
    if family.startswith("courier"):
        if weight == "bold" and style == "italic":
            return "cobi"
        if weight == "bold":
            return "cobo"
        if style == "italic":
            return "coit"
        return "cour"
    if family.startswith("times"):
        if weight == "bold" and style == "italic":
            return "tibi"
        if weight == "bold":
            return "tibo"
        if style == "italic":
            return "tiit"
        return "tiro"
    if weight == "bold" and style == "italic":
        return "hebi"
    if weight == "bold":
        return "hebo"
    if style == "italic":
        return "heit"
    return "helv"


def normalized_font_family(font_name, flags=0):
    name = str(font_name or "").lower()
    flags = int(flags or 0)
    if "courier" in name or "mono" in name or (flags & 8):
        return "Courier"
    if "times" in name or "serif" in name or (flags & 4):
        return "Times"
    return "Helvetica"


def font_weight(font_name, flags=0):
    name = str(font_name or "").lower()
    flags = int(flags or 0)
    return "bold" if "bold" in name or (flags & 16) else "normal"


def font_style(font_name, flags=0):
    name = str(font_name or "").lower()
    flags = int(flags or 0)
    return "italic" if "italic" in name or "oblique" in name or (flags & 2) else "normal"


def span_color_hex(value):
    if isinstance(value, int):
        return f"#{(value >> 16) & 255:02x}{(value >> 8) & 255:02x}{value & 255:02x}"
    return "#000000"


def redaction_fill(value, default=None):
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in ("", "none", "null", "transparent"):
        return None
    return color_tuple(value, default)


# ============================================================================
# Font-faithful text rewriting
#
# When a user rewrites detected text we want the replacement glyphs to use the
# document's ORIGINAL typeface, not a base-14 substitute. Resolution order:
#   1. Re-embed the exact font program already inside the PDF (matched by name).
#   2. Embed a matching font installed on the operating system.
#   3. Fall back to the closest base-14 font (Helvetica/Times/Courier).
# Each candidate is only accepted if it can render every glyph in the new text.
# ============================================================================

_SYSTEM_FONT_CACHE = {}   # normalized (family, bold, italic) -> path or None
_FONT_OBJECT_CACHE = {}   # path -> fitz.Font (for glyph coverage checks)


def _font_search_dirs():
    dirs = []
    win_dir = os.environ.get("WINDIR") or "C:/Windows"
    local = os.environ.get("LOCALAPPDATA")
    candidates = [
        os.path.join(win_dir, "Fonts"),
        os.path.join(local, "Microsoft", "Windows", "Fonts") if local else None,
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
        os.path.expanduser("~/Library/Fonts"),
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        os.path.expanduser("~/.fonts"),
        os.path.expanduser("~/.local/share/fonts"),
    ]
    for c in candidates:
        if c and os.path.isdir(c):
            dirs.append(c)
    return dirs


# family key -> {(bold, italic): [candidate filenames]}.  Windows names first,
# then macOS, then Liberation/DejaVu so Linux gets a close metric-compatible
# substitute.  Listed by preference; first existing file on disk wins.
_FONT_FILE_MAP = {
    "arial": {
        (False, False): ["arial.ttf", "Arial.ttf", "LiberationSans-Regular.ttf", "DejaVuSans.ttf"],
        (True, False): ["arialbd.ttf", "Arial Bold.ttf", "LiberationSans-Bold.ttf", "DejaVuSans-Bold.ttf"],
        (False, True): ["ariali.ttf", "Arial Italic.ttf", "LiberationSans-Italic.ttf", "DejaVuSans-Oblique.ttf"],
        (True, True): ["arialbi.ttf", "Arial Bold Italic.ttf", "LiberationSans-BoldItalic.ttf", "DejaVuSans-BoldOblique.ttf"],
    },
    "calibri": {
        (False, False): ["calibri.ttf", "Calibri.ttf", "Carlito-Regular.ttf"],
        (True, False): ["calibrib.ttf", "Calibri Bold.ttf", "Carlito-Bold.ttf"],
        (False, True): ["calibrii.ttf", "Calibri Italic.ttf", "Carlito-Italic.ttf"],
        (True, True): ["calibriz.ttf", "Calibri Bold Italic.ttf", "Carlito-BoldItalic.ttf"],
    },
    "cambria": {
        (False, False): ["cambria.ttc", "Cambria.ttc", "Caladea-Regular.ttf"],
        (True, False): ["cambriab.ttf", "Caladea-Bold.ttf"],
        (False, True): ["cambriai.ttf", "Caladea-Italic.ttf"],
        (True, True): ["cambriaz.ttf", "Caladea-BoldItalic.ttf"],
    },
    "times": {
        (False, False): ["times.ttf", "Times New Roman.ttf", "LiberationSerif-Regular.ttf", "DejaVuSerif.ttf"],
        (True, False): ["timesbd.ttf", "Times New Roman Bold.ttf", "LiberationSerif-Bold.ttf", "DejaVuSerif-Bold.ttf"],
        (False, True): ["timesi.ttf", "Times New Roman Italic.ttf", "LiberationSerif-Italic.ttf", "DejaVuSerif-Italic.ttf"],
        (True, True): ["timesbi.ttf", "Times New Roman Bold Italic.ttf", "LiberationSerif-BoldItalic.ttf"],
    },
    "georgia": {
        (False, False): ["georgia.ttf", "Georgia.ttf", "Gelasio-Regular.ttf"],
        (True, False): ["georgiab.ttf", "Gelasio-Bold.ttf"],
        (False, True): ["georgiai.ttf", "Gelasio-Italic.ttf"],
        (True, True): ["georgiaz.ttf", "Gelasio-BoldItalic.ttf"],
    },
    "verdana": {
        (False, False): ["verdana.ttf", "Verdana.ttf", "DejaVuSans.ttf"],
        (True, False): ["verdanab.ttf", "DejaVuSans-Bold.ttf"],
        (False, True): ["verdanai.ttf", "DejaVuSans-Oblique.ttf"],
        (True, True): ["verdanaz.ttf", "DejaVuSans-BoldOblique.ttf"],
    },
    "tahoma": {
        (False, False): ["tahoma.ttf", "Tahoma.ttf", "DejaVuSans.ttf"],
        (True, False): ["tahomabd.ttf", "DejaVuSans-Bold.ttf"],
        (False, True): ["tahoma.ttf"],
        (True, True): ["tahomabd.ttf"],
    },
    "trebuchet": {
        (False, False): ["trebuc.ttf", "Trebuchet MS.ttf"],
        (True, False): ["trebucbd.ttf", "Trebuchet MS Bold.ttf"],
        (False, True): ["trebucit.ttf", "Trebuchet MS Italic.ttf"],
        (True, True): ["trebucbi.ttf", "Trebuchet MS Bold Italic.ttf"],
    },
    "segoeui": {
        (False, False): ["segoeui.ttf", "Segoe UI.ttf"],
        (True, False): ["segoeuib.ttf"],
        (False, True): ["segoeuii.ttf"],
        (True, True): ["segoeuiz.ttf"],
    },
    "couriernew": {
        (False, False): ["cour.ttf", "Courier New.ttf", "LiberationMono-Regular.ttf", "DejaVuSansMono.ttf"],
        (True, False): ["courbd.ttf", "LiberationMono-Bold.ttf", "DejaVuSansMono-Bold.ttf"],
        (False, True): ["couri.ttf", "LiberationMono-Italic.ttf", "DejaVuSansMono-Oblique.ttf"],
        (True, True): ["courbi.ttf", "LiberationMono-BoldItalic.ttf"],
    },
    "consolas": {
        (False, False): ["consola.ttf", "Consolas.ttf", "DejaVuSansMono.ttf"],
        (True, False): ["consolab.ttf", "DejaVuSansMono-Bold.ttf"],
        (False, True): ["consolai.ttf", "DejaVuSansMono-Oblique.ttf"],
        (True, True): ["consolaz.ttf"],
    },
    "comicsans": {
        (False, False): ["comic.ttf", "Comic Sans MS.ttf"],
        (True, False): ["comicbd.ttf", "Comic Sans MS Bold.ttf"],
        (False, True): ["comic.ttf"],
        (True, True): ["comicbd.ttf"],
    },
    "constantia": {(False, False): ["constan.ttf"], (True, False): ["constanb.ttf"], (False, True): ["constani.ttf"], (True, True): ["constanz.ttf"]},
    "candara": {(False, False): ["Candara.ttf"], (True, False): ["Candarab.ttf"], (False, True): ["Candarai.ttf"], (True, True): ["Candaraz.ttf"]},
    "corbel": {(False, False): ["corbel.ttf"], (True, False): ["corbelb.ttf"], (False, True): ["corbeli.ttf"], (True, True): ["corbelz.ttf"]},
    "palatino": {(False, False): ["pala.ttf", "Palatino Linotype.ttf"], (True, False): ["palab.ttf"], (False, True): ["palai.ttf"], (True, True): ["palabi.ttf"]},
    "impact": {(False, False): ["impact.ttf", "Impact.ttf"]},
    "garamond": {(False, False): ["gara.ttf", "EBGaramond-Regular.ttf"], (True, False): ["garabd.ttf"], (False, True): ["garait.ttf"]},
    "bookantiqua": {(False, False): ["BKANT.TTF", "Book Antiqua.ttf"]},
    "centurygothic": {(False, False): ["GOTHIC.TTF"], (True, False): ["GOTHICB.TTF"], (False, True): ["GOTHICI.TTF"], (True, True): ["GOTHICBI.TTF"]},
}

# alias normalized-name -> canonical family key in _FONT_FILE_MAP
_FONT_ALIASES = [
    ("timesnewroman", "times"), ("timesroman", "times"), ("liberationserif", "times"),
    ("helvetica", "arial"), ("helv", "arial"), ("liberationsans", "arial"), ("arialmt", "arial"),
    ("carlito", "calibri"),
    ("caladea", "cambria"),
    ("gelasio", "georgia"),
    ("couriernewps", "couriernew"), ("courier", "couriernew"), ("liberationmono", "couriernew"), ("cour", "couriernew"),
    ("segoe", "segoeui"),
    ("trebuchetms", "trebuchet"),
    ("comicsansms", "comicsans"),
    ("bookman", "bookantiqua"),
    ("gothic", "centurygothic"),
]


def _clean_font_name(name):
    """Strip subset prefix (ABCDEF+) and lowercase, keep alphanumerics only."""
    stripped = str(name or "").split("+", 1)[-1] if "+" in str(name or "") else str(name or "")
    return "".join(ch for ch in stripped.lower() if ch.isalnum())


def _font_family_key(name):
    cleaned = _clean_font_name(name)
    # drop common style suffixes/words so "calibribold" -> "calibri"
    for token in ("bolditalic", "boldoblique", "bold", "italic", "oblique", "regular",
                  "mt", "psmt", "ps", "ms", "linotype", "newroman", "new"):
        if cleaned.endswith(token) and len(cleaned) > len(token):
            cleaned = cleaned[: -len(token)]
    if cleaned in _FONT_FILE_MAP:
        return cleaned
    for alias, target in _FONT_ALIASES:
        if alias in cleaned:
            return target
    # last resort: any family key that is a prefix/substring match
    for key in _FONT_FILE_MAP:
        if cleaned.startswith(key) or key in cleaned:
            return key
    return None


def find_system_font_file(name, bold=False, italic=False):
    key = _font_family_key(name)
    if not key:
        return None
    cache_key = (key, bold, italic)
    if cache_key in _SYSTEM_FONT_CACHE:
        return _SYSTEM_FONT_CACHE[cache_key]

    variants = _FONT_FILE_MAP[key]
    # try requested style, then graceful degradations
    style_order = [(bold, italic), (bold, False), (False, italic), (False, False)]
    dirs = _font_search_dirs()
    found = None
    for style in style_order:
        for filename in variants.get(style, []):
            for directory in dirs:
                candidate = os.path.join(directory, filename)
                if os.path.exists(candidate):
                    found = candidate
                    break
            if found:
                break
        if found:
            break
    _SYSTEM_FONT_CACHE[cache_key] = found
    return found


def _font_for_file(path):
    if path not in _FONT_OBJECT_CACHE:
        try:
            _FONT_OBJECT_CACHE[path] = fitz.Font(fontfile=path)
        except Exception:
            _FONT_OBJECT_CACHE[path] = None
    return _FONT_OBJECT_CACHE[path]


def _font_covers(font, text):
    if font is None:
        return False
    try:
        for ch in set(str(text or "")):
            if ch in "\r\n\t":
                continue
            if not font.has_glyph(ord(ch)):
                return False
        return True
    except Exception:
        return False


def _match_embedded_font(page, name):
    """Find the page font xref whose name best matches `name`."""
    target = _clean_font_name(name)
    if not target:
        return None
    target_family = _font_family_key(name)
    try:
        fonts = page.get_fonts(full=True)
    except Exception:
        return None
    exact = None
    family = None
    for entry in fonts:
        xref = entry[0]
        basefont = entry[3] if len(entry) > 3 else ""
        cleaned = _clean_font_name(basefont)
        if cleaned == target:
            exact = xref
            break
        if family is None and target_family and _font_family_key(basefont) == target_family:
            family = xref
    return exact if exact is not None else family


def resolve_text_font(page, edit, text, inserted):
    """Return a fontname registered on `page` capable of rendering `text`.

    `inserted` is a per-page dict caching fonts already inserted so we never
    register the same program twice.
    """
    weight = str(edit.get("fontWeight") or "normal").lower()
    style = str(edit.get("fontStyle") or "normal").lower()
    bold = weight == "bold"
    italic = style in ("italic", "oblique")

    family_choice = str(edit.get("fontFamily") or "").strip().lower()
    raw_name = str(edit.get("fontName") or "").strip()

    # 1) Explicit base-14 pick from the UI overrides fidelity matching.
    if family_choice in ("helvetica", "times", "courier"):
        return base_font_name(edit)

    # 2) Decide which name to match. An explicit real-font pick (e.g. "Calibri")
    #    wins; otherwise ("original"/blank) we keep the document's own font.
    if family_choice and family_choice not in ("original", "match", "document", "auto"):
        name_for_match = family_choice
    else:
        name_for_match = raw_name
    if not name_for_match:
        return base_font_name(edit)

    doc = page.parent

    # 3) Re-embed the document's own font program.
    xref = _match_embedded_font(page, name_for_match)
    if xref is not None:
        cache_name = f"E{xref}"
        if cache_name in inserted:
            if inserted[cache_name]:
                return cache_name
        else:
            try:
                _basefont, ext, _ftype, buffer = doc.extract_font(xref)
                if buffer and ext in ("ttf", "otf", "cff", "ttc"):
                    font = fitz.Font(fontbuffer=buffer)
                    if _font_covers(font, text):
                        page.insert_font(fontname=cache_name, fontbuffer=buffer)
                        inserted[cache_name] = True
                        return cache_name
                inserted[cache_name] = False
            except Exception:
                inserted[cache_name] = False

    # 4) Embed a matching system font.
    path = find_system_font_file(name_for_match, bold, italic)
    if path:
        cache_name = "S" + "".join(ch for ch in os.path.basename(path) if ch.isalnum())[:24]
        if cache_name in inserted:
            if inserted[cache_name]:
                return cache_name
        else:
            try:
                if _font_covers(_font_for_file(path), text):
                    page.insert_font(fontname=cache_name, fontfile=path)
                    inserted[cache_name] = True
                    return cache_name
                inserted[cache_name] = False
            except Exception:
                inserted[cache_name] = False

    # 5) Base-14 fallback, normalized from the original name.
    fallback = dict(edit)
    fallback["fontFamily"] = normalized_font_family(name_for_match)
    return base_font_name(fallback)


def insert_text_autofit(page, rect, text, fontname, fontsize, color, align, line_height):
    """insert_textbox with gentle auto-shrink so edits rarely overflow.

    Returns (overflowed: bool). Tries the requested size first, then shrinks to
    at most 65% before giving up and stamping a single line at the top.
    """
    size = max(float(fontsize), 1.0)
    min_size = max(size * 0.65, 5.0)
    trial = size
    while trial >= min_size:
        rc = page.insert_textbox(
            rect, text, fontsize=trial, fontname=fontname,
            color=color, align=align, lineheight=line_height,
        )
        if rc >= 0:
            return False
        trial -= max(size * 0.06, 0.5)
    # Could not fit even shrunk — stamp first line so content is never lost.
    page.insert_textbox(
        rect, text, fontsize=min_size, fontname=fontname,
        color=color, align=align, lineheight=line_height,
    )
    return True


def apply_redactions(doc, terms, rects, covers):
    match_count = 0
    # Text-based redactions
    if terms:
        for page in doc:
            page_matches = 0
            for term in terms:
                matches = page.search_for(term)
                for rect in matches:
                    page.add_redact_annot(rect, fill=(0, 0, 0))
                    match_count += 1
                    page_matches += 1
            if page_matches:
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_PIXELS,
                    graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                    text=fitz.PDF_REDACT_TEXT_REMOVE,
                )

    # Coordinate-based secure redactions and replacement covers.
    for rect_data in (rects or []) + (covers or []):
        fill = color_tuple(rect_data.get("fill"), (0, 0, 0))
        page_idx = int(rect_data.get("page", 1)) - 1
        if 0 <= page_idx < len(doc):
            page = doc[page_idx]
            r = fitz.Rect(
                rect_data["x"],
                rect_data["y"],
                rect_data["x"] + rect_data["w"],
                rect_data["y"] + rect_data["h"]
            )
            page.add_redact_annot(r, fill=fill)
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_PIXELS,
                graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )
            match_count += 1

    return match_count


def is_replacement_edit(edit):
    return (
        str(edit.get("mode") or "").lower() == "replace"
        or str(edit.get("source") or "").lower() == "textmap"
        or all(key in edit for key in ("originalX", "originalY", "originalW", "originalH"))
    )


def replacement_rect(edit, page):
    x = float(edit.get("originalX", edit.get("x", 72)) or 72)
    y = float(edit.get("originalY", edit.get("y", 72)) or 72)
    w = max(float(edit.get("originalW", edit.get("w", 240)) or 240), 1)
    h = max(float(edit.get("originalH", edit.get("h", float(edit.get("size") or 12) * 1.6)) or 1), 1)
    size = max(float(edit.get("originalFontSize") or edit.get("size") or 12), 1)
    pad = min(max(size * 0.04, 0.35), 1.25)
    rect = fitz.Rect(x - pad, y - pad, x + w + pad, y + h + pad)
    return rect & page.rect


def reflow_rect(edit, page):
    """Insertion rect for replacement text: the CURRENT block width anchored at
    its top, extended down the page so wrapped text reflows at its own font size
    instead of being shrunk to fit the original box."""
    x = float(edit.get("x", edit.get("originalX", 72)) or 72)
    y = float(edit.get("y", edit.get("originalY", 72)) or 72)
    w = max(float(edit.get("w", edit.get("originalW", 240)) or 240), 1)
    size = max(float(edit.get("size") or edit.get("originalFontSize") or 12), 1)
    pad = min(max(size * 0.04, 0.35), 1.25)
    rect = fitz.Rect(x - pad, y - pad, x + w + pad, page.rect.height - 1)
    return rect & page.rect


def apply_text_replacements(doc, edits):
    page_edits = {}
    for edit in edits or []:
        page_number = int(edit.get("page") or 1)
        if page_number < 1 or page_number > len(doc):
            raise ValueError(f"Text edit page {page_number} is outside the PDF page range")
        page_edits.setdefault(page_number - 1, []).append(edit)

    edit_count = 0
    overflow_count = 0
    for page_idx, replacements in page_edits.items():
        page = doc[page_idx]
        touches_images = False
        prepared = []  # (edit, rect, text, fill)

        # --- Phase A: erase the original glyphs (no replacement text yet) ---
        for edit in replacements:
            text = str(edit.get("text") or "")
            rect = replacement_rect(edit, page)
            if rect.is_empty or rect.is_infinite:
                continue

            source_type = str(edit.get("sourceType") or "pdf").lower()
            fill = redaction_fill(edit.get("replacementFill"), None)
            if source_type == "ocr":
                # Scanned text lives in the page image, so paint over it.
                fill = redaction_fill(edit.get("replacementFill"), (1, 1, 1))
                touches_images = True

            page.add_redact_annot(rect, fill=fill)
            prepared.append((edit, rect, text))

        if not prepared:
            continue

        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_PIXELS if touches_images else fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )

        # --- Phase B: write the replacement text in the document's own font,
        #     reflowing within the (current) block width at the original size ---
        inserted_fonts = {}
        for edit, _orig_rect, text in prepared:
            edit_count += 1
            if not text:
                continue
            fontname = resolve_text_font(page, edit, text, inserted_fonts)
            fontsize = float(edit.get("size") or edit.get("originalFontSize") or 12)
            color = color_tuple(edit.get("color"), (0, 0, 0))
            align = text_align(edit.get("align"))
            line_height = float(edit.get("lineHeight") or 1.2)
            ins_rect = reflow_rect(edit, page)
            rc = page.insert_textbox(ins_rect, text, fontsize=fontsize, fontname=fontname, color=color, align=align, lineheight=line_height)
            if rc < 0:
                # Even reflowing to the page bottom overflows — shrink as a fallback.
                overflow_count += 1
                insert_text_autofit(page, ins_rect, text, fontname, fontsize, color, align, line_height)
            if str(edit.get("textDecoration") or "none").lower() == "underline":
                draw_underlines(page, ins_rect, text, base_font_name(edit), fontsize, color, align, line_height)

    return edit_count, overflow_count


def rect_overlap_ratio(a, b):
    try:
        inter = fitz.Rect(a) & fitz.Rect(b)
        if inter.is_empty:
            return 0
        area = max(min(fitz.Rect(a).get_area(), fitz.Rect(b).get_area()), 1)
        return inter.get_area() / area
    except Exception:
        return 0


def apply_widget_replacements(doc, edits):
    widget_count = 0
    remaining = []
    for edit in edits or []:
        if str(edit.get("sourceType") or "").lower() != "widget":
            remaining.append(edit)
            continue

        page_number = int(edit.get("page") or 1)
        if page_number < 1 or page_number > len(doc):
            raise ValueError(f"Text edit page {page_number} is outside the PDF page range")

        page = doc[page_number - 1]
        widgets = list(page.widgets() or [])
        field_name = str(edit.get("fieldName") or "")
        original = replacement_rect(edit, page)
        target = None

        for widget in widgets:
            if field_name and str(widget.field_name or "") == field_name:
                target = widget
                break

        if target is None:
            best = None
            best_ratio = 0
            for widget in widgets:
                ratio = rect_overlap_ratio(widget.rect, original)
                if ratio > best_ratio:
                    best = widget
                    best_ratio = ratio
            if best_ratio >= 0.70:
                target = best
            elif best_ratio >= 0.40 and best is not None:
                # Secondary check: centroid must be within half the larger dimension
                try:
                    r1 = fitz.Rect(best.rect)
                    r2 = fitz.Rect(original)
                    cx1, cy1 = (r1.x0 + r1.x1) / 2, (r1.y0 + r1.y1) / 2
                    cx2, cy2 = (r2.x0 + r2.x1) / 2, (r2.y0 + r2.y1) / 2
                    dist = ((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2) ** 0.5
                    max_dist = max(r2.width, r2.height) * 0.5
                    if dist <= max_dist:
                        target = best
                except Exception:
                    pass

        if target is None:
            remaining.append(edit)
            continue

        target.field_value = str(edit.get("text") or "")
        try:
            target.text_fontsize = float(edit.get("size") or edit.get("originalFontSize") or target.text_fontsize or 12)
        except Exception:
            pass
        try:
            target.text_color = color_tuple(edit.get("color"), (0, 0, 0))
        except Exception:
            pass
        target.update()
        widget_count += 1

    return widget_count, remaining


_LE_NONE = getattr(fitz, "PDF_ANNOT_LE_NONE", 0)
_LE_CLOSED_ARROW = getattr(fitz, "PDF_ANNOT_LE_CLOSED_ARROW", 5)


def _line_endpoints(item):
    """Resolve a line/arrow's two endpoints from explicit points or a bbox."""
    points = item.get("points")
    if isinstance(points, (list, tuple)) and len(points) >= 2:
        def pt(p):
            if isinstance(p, dict):
                return fitz.Point(float(p.get("x", 0)), float(p.get("y", 0)))
            return fitz.Point(float(p[0]), float(p[1]))
        return pt(points[0]), pt(points[-1])
    x = float(item.get("x", 0))
    y = float(item.get("y", 0))
    return fitz.Point(x, y), fitz.Point(x + float(item.get("w", 0)), y + float(item.get("h", 0)))


def apply_highlights(doc, highlights):
    """Vector shapes: rectangle, ellipse/circle, line and arrow."""
    count = 0
    for item in highlights or []:
        page_idx = int(item.get("page", 1)) - 1
        if not (0 <= page_idx < len(doc)):
            continue
        page = doc[page_idx]
        shape_type = str(item.get("type", "rect")).lower()
        color = color_tuple(item.get("stroke"), (0.9, 0.2, 0.2))
        has_fill = item.get("fill") not in (None, "", "none", "transparent")
        fill = color_tuple(item.get("fill"), None) if has_fill else None
        opacity = float(item.get("opacity", 1.0))
        width = float(item.get("width", item.get("strokeWidth", 2)) or 2)

        r = fitz.Rect(
            item.get("x", 0), item.get("y", 0),
            float(item.get("x", 0)) + float(item.get("w", 0)),
            float(item.get("y", 0)) + float(item.get("h", 0)),
        )

        if shape_type in ("rect", "rectangle", "square", "highlight"):
            annot = page.add_rect_annot(r)
            annot.set_colors(stroke=color, fill=fill)
            annot.set_border(width=width)
            annot.set_opacity(opacity)
            annot.update()
        elif shape_type in ("ellipse", "circle", "oval"):
            annot = page.add_circle_annot(r)
            annot.set_colors(stroke=color, fill=fill)
            annot.set_border(width=width)
            annot.set_opacity(opacity)
            annot.update()
        elif shape_type in ("line", "arrow"):
            p1, p2 = _line_endpoints(item)
            annot = page.add_line_annot(p1, p2)
            if shape_type == "arrow":
                annot.set_line_ends(_LE_NONE, _LE_CLOSED_ARROW)
            annot.set_colors(stroke=color)
            annot.set_border(width=width)
            annot.set_opacity(opacity)
            annot.update()
        else:
            continue
        count += 1
    return count


def apply_markups(doc, markups):
    """Text markup annotations: highlight, underline, strikeout."""
    count = 0
    for item in markups or []:
        page_idx = int(item.get("page", 1)) - 1
        if not (0 <= page_idx < len(doc)):
            continue
        page = doc[page_idx]
        r = fitz.Rect(
            item.get("x", 0), item.get("y", 0),
            float(item.get("x", 0)) + float(item.get("w", 0)),
            float(item.get("y", 0)) + float(item.get("h", 0)),
        )
        if r.is_empty or r.is_infinite:
            continue
        mtype = str(item.get("type", "highlight")).lower()
        default_color = (1, 0.86, 0.2) if mtype == "highlight" else (0.85, 0.1, 0.1)
        color = color_tuple(item.get("color") or item.get("stroke"), default_color)
        opacity = float(item.get("opacity", 1.0))
        try:
            if mtype == "highlight":
                annot = page.add_highlight_annot(r)
            elif mtype == "underline":
                annot = page.add_underline_annot(r)
            elif mtype in ("strikeout", "strikethrough"):
                annot = page.add_strikeout_annot(r)
            else:
                continue
            annot.set_colors(stroke=color)
            annot.set_opacity(opacity)
            annot.update()
            count += 1
        except Exception:
            continue
    return count


def apply_notes(doc, notes):
    """Sticky-note (text) comment annotations."""
    count = 0
    for item in notes or []:
        page_idx = int(item.get("page", 1)) - 1
        if not (0 <= page_idx < len(doc)):
            continue
        page = doc[page_idx]
        point = fitz.Point(float(item.get("x", 72)), float(item.get("y", 72)))
        try:
            annot = page.add_text_annot(point, str(item.get("text") or ""))
            annot.set_colors(stroke=color_tuple(item.get("color"), (1, 0.86, 0.2)))
            annot.update()
            count += 1
        except Exception:
            continue
    return count


def _normalize_uri(uri):
    low = uri.lower()
    if low.startswith(("http://", "https://", "mailto:", "tel:", "ftp://", "file:")):
        return uri
    return "https://" + uri


def apply_links(doc, links):
    """Create/update hyperlink regions (URI or internal page jumps).

    Re-drawing a link over an existing one (>60% overlap) replaces it, so links
    can be edited in place rather than stacking."""
    count = 0
    for item in links or []:
        page_idx = int(item.get("page", 1)) - 1
        if not (0 <= page_idx < len(doc)):
            continue
        page = doc[page_idx]
        rect = fitz.Rect(
            item.get("x", 0), item.get("y", 0),
            float(item.get("x", 0)) + float(item.get("w", 0)),
            float(item.get("y", 0)) + float(item.get("h", 0)),
        )
        if rect.is_empty or rect.is_infinite:
            continue

        uri = str(item.get("uri") or "").strip()
        target = item.get("targetPage")
        link = None
        if target:
            tp = int(target) - 1
            if 0 <= tp < len(doc):
                link = {"kind": fitz.LINK_GOTO, "from": rect, "page": tp, "to": fitz.Point(0, 0)}
        elif uri:
            link = {"kind": fitz.LINK_URI, "from": rect, "uri": _normalize_uri(uri)}
        if not link:
            continue

        # Replace any existing link covering roughly the same area.
        try:
            for existing in page.get_links():
                if rect_overlap_ratio(fitz.Rect(existing.get("from")), rect) > 0.6:
                    page.delete_link(existing)
        except Exception:
            pass
        page.insert_link(link)
        count += 1
    return count


def apply_paths(doc, paths):
    count = 0
    for item in paths or []:
        page_idx = int(item.get("page", 1)) - 1
        if 0 <= page_idx < len(doc):
            page = doc[page_idx]
            points = item.get("points", [])
            if len(points) < 2:
                continue
            fitz_points = [
                fitz.Point(float(point.get("x", 0)), float(point.get("y", 0)))
                if isinstance(point, dict)
                else fitz.Point(float(point[0]), float(point[1]))
                for point in points
            ]
            
            color = color_tuple(item.get("color"), (0, 0, 0))
            width = float(item.get("width", 2))
            opacity = float(item.get("opacity", 1.0))
            
            # Use polyline annotation for freehand/paths
            annot = page.add_polyline_annot(fitz_points)
            annot.set_colors(stroke=color)
            annot.set_border(width=width)
            annot.set_opacity(opacity)
            annot.update()
            count += 1
    return count


def apply_images(doc, images):
    count = 0
    for item in images or []:
        page_idx = int(item.get("page", 1)) - 1
        if page_idx < 0 or page_idx >= len(doc):
            continue

        source = str(item.get("data") or item.get("path") or "")
        if not source:
            continue

        image_bytes = None
        if source.startswith("data:image"):
            payload = source.split(",", 1)[1] if "," in source else ""
            image_bytes = base64.b64decode(payload)
        elif os.path.exists(source):
            with open(source, "rb") as fh:
                image_bytes = fh.read()

        if not image_bytes:
            continue

        x = float(item.get("x") or 72)
        y = float(item.get("y") or 72)
        w = max(float(item.get("w") or 120), 1)
        h = max(float(item.get("h") or 60), 1)
        page = doc[page_idx]
        page.insert_image(fitz.Rect(x, y, x + w, y + h), stream=image_bytes, keep_proportion=True)
        count += 1
    return count


def apply_text_edits(doc, edits):
    edit_count = 0
    overflow_count = 0
    inserted_fonts = {}  # page_idx -> per-page font cache
    for edit in edits or []:
        text = str(edit.get("text") or "")
        if not text:
            continue

        page_number = int(edit.get("page") or 1)
        if page_number < 1 or page_number > len(doc):
            raise ValueError(f"Text edit page {page_number} is outside the PDF page range")

        x = float(edit.get("x") or 72)
        y = float(edit.get("y") or 72)
        w = float(edit.get("w") or 240)
        h = float(edit.get("h") or (float(edit.get("size") or 12) * 1.6))
        size = float(edit.get("size") or 12)
        color = color_tuple(edit.get("color"), (0, 0, 0))

        page = doc[page_number - 1]
        line_height = float(edit.get("lineHeight") or 1.2)
        page_cache = inserted_fonts.setdefault(page_number - 1, {})
        fontname = resolve_text_font(page, edit, text, page_cache)
        align = text_align(edit.get("align"))
        rect = fitz.Rect(x, y, x + w, y + h)
        overflowed = insert_text_autofit(page, rect, text, fontname, size, color, align, line_height)
        if overflowed:
            overflow_count += 1
        if str(edit.get("textDecoration") or "none").lower() == "underline":
            draw_underlines(page, rect, text, base_font_name(edit), size, color, align, line_height)
        edit_count += 1
    return edit_count, overflow_count


def apply_form_fields(doc, forms):
    count = 0
    for item in forms or []:
        page_idx = int(item.get("page", 1)) - 1
        if page_idx < 0 or page_idx >= len(doc):
            continue

        page = doc[page_idx]
        x = float(item.get("x") or 72)
        y = float(item.get("y") or 72)
        w = max(float(item.get("w") or 120), 10)
        h = max(float(item.get("h") or 24), 10)
        field_type = str(item.get("type") or "text")
        name = str(item.get("name") or f"{field_type}_{page_idx + 1}_{count + 1}")

        widget = fitz.Widget()
        widget.rect = fitz.Rect(x, y, x + w, y + h)
        widget.field_name = name
        widget.field_label = str(item.get("placeholder") or name)
        widget.border_color = color_tuple(item.get("borderColor"), (0.4, 0.45, 0.52))
        widget.fill_color = color_tuple(item.get("fill"), (1, 1, 1))
        widget.text_color = color_tuple(item.get("color"), (0, 0, 0))
        widget.text_font = "Helv"
        widget.text_fontsize = float(item.get("size") or 12)
        widget.border_width = 1
        widget.field_flags = 0

        if item.get("required"):
            widget.field_flags |= fitz.PDF_FIELD_IS_REQUIRED

        if field_type == "radio":
            widget.field_type = fitz.PDF_WIDGET_TYPE_RADIOBUTTON
            # PyMuPDF validates newly-created radio buttons before assigning an
            # xref, so default-on values cannot be set reliably at creation time.
            widget.field_value = "Off"
            widget.button_caption = str(item.get("value") or "Yes")
            widget.field_flags |= fitz.PDF_BTN_FIELD_IS_RADIO
        else:
            widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
            widget.field_value = str(item.get("value") or "")
            if item.get("multiline"):
                widget.field_flags |= fitz.PDF_TX_FIELD_IS_MULTILINE

        page.add_widget(widget)
        count += 1
    return count


def render_pages(doc, dpi=150):
    temp_dir = tempfile.gettempdir()
    job_id = os.urandom(4).hex()
    page_images = []
    
    for i, page in enumerate(doc):
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi/72, dpi/72))
        img_path = os.path.join(temp_dir, f"muxmelt_pdf_{job_id}_{i}.png")
        pix.save(img_path)
        page_images.append({
            "path": img_path,
            "width": page.rect.width,
            "height": page.rect.height,
            "index": i + 1
        })
    
    return page_images


def _page_list(value, total):
    """Normalize a 1-based page list, clamp to range, dedupe, keep order."""
    out = []
    for v in (value or []):
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if 1 <= n <= total and n not in out:
            out.append(n)
    return out


def perform_page_op(doc, options):
    """Apply a structural page operation in memory.

    Returns a dict describing the result. Operations marked mutating expect the
    caller to persist `doc` back to its source path. 'extract' is non-mutating
    and writes a new file itself.
    """
    op = str(options.get("op") or "").lower()
    total = len(doc)

    if op == "rotate":
        pages = _page_list(options.get("pages"), total) or list(range(1, total + 1))
        degrees = int(options.get("degrees") or 90)
        for p in pages:
            page = doc[p - 1]
            page.set_rotation((page.rotation + degrees) % 360)
        return {"mutated": True, "op": op, "pages": pages, "totalPages": len(doc)}

    if op == "delete":
        pages = _page_list(options.get("pages"), total)
        if not pages:
            raise ValueError("No valid pages to delete.")
        if len(pages) >= total:
            raise ValueError("Cannot delete every page in the document.")
        doc.delete_pages([p - 1 for p in sorted(set(pages))])
        return {"mutated": True, "op": op, "pages": pages, "totalPages": len(doc)}

    if op == "reorder":
        order = _page_list(options.get("order"), total)
        if sorted(order) != list(range(1, total + 1)):
            raise ValueError("Reorder requires a full permutation of all pages.")
        doc.select([p - 1 for p in order])
        return {"mutated": True, "op": op, "order": order, "totalPages": len(doc)}

    if op == "duplicate":
        pages = _page_list(options.get("pages"), total) or _page_list([options.get("page")], total)
        if not pages:
            raise ValueError("No page selected to duplicate.")
        # Duplicate from the back so earlier insertions don't shift later indices.
        for p in sorted(set(pages), reverse=True):
            doc.fullcopy_page(p - 1, p)
        return {"mutated": True, "op": op, "pages": pages, "totalPages": len(doc)}

    if op == "insert_blank":
        after = int(options.get("afterPage") or 0)  # 0 = before first page
        after = max(0, min(after, total))
        ref = doc[min(max(after - 1, 0), total - 1)] if total else None
        width = float(options.get("width") or (ref.rect.width if ref else 595))
        height = float(options.get("height") or (ref.rect.height if ref else 842))
        doc.new_page(pno=after, width=width, height=height)
        return {"mutated": True, "op": op, "afterPage": after, "totalPages": len(doc)}

    if op == "import":
        source = options.get("sourcePath")
        if not source or not os.path.exists(source):
            raise ValueError("Could not find the PDF to import pages from.")
        after = int(options.get("afterPage") or total)
        after = max(0, min(after, total))
        src = fitz.open(source)
        try:
            pages = options.get("pages")
            if pages:
                wanted = [p - 1 for p in _page_list(pages, len(src))]
                if not wanted:
                    raise ValueError("No valid pages selected to import.")
                src.select(wanted)
            inserted = len(src)
            doc.insert_pdf(src, start_at=after)
        finally:
            src.close()
        return {"mutated": True, "op": op, "afterPage": after, "imported": inserted, "totalPages": len(doc)}

    if op == "extract":
        pages = _page_list(options.get("pages"), total)
        if not pages:
            raise ValueError("No valid pages to extract.")
        output_path = options.get("outputPath")
        if not output_path:
            raise ValueError("No output path provided for extraction.")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        out = fitz.open()
        try:
            for p in pages:
                out.insert_pdf(doc, from_page=p - 1, to_page=p - 1)
            tmp = output_path + ".mmtmp"
            out.save(tmp, garbage=4, deflate=True)
            os.replace(tmp, output_path)
        finally:
            out.close()
        return {"mutated": False, "op": op, "pages": pages, "output": output_path, "totalPages": total}

    raise ValueError(f"Unknown page operation: {op or '(none)'}")


def _stamp_position(page, where, margin, text_w, text_h):
    """Compute the top-left origin for a header/footer/page-number stamp."""
    where = str(where or "bottom-center").lower()
    pr = page.rect
    vert, _, horiz = where.partition("-")
    if not horiz:
        horiz = "center"
    y = margin if vert == "top" else pr.height - margin - text_h
    if horiz == "left":
        x = margin
    elif horiz == "right":
        x = pr.width - margin - text_w
    else:
        x = (pr.width - text_w) / 2
    return x, y


def perform_doc_op(doc, input_path, options):
    """Document-wide operations: metadata, security, watermark, page numbers,
    flatten, bookmarks, compression, and image export."""
    sub = str(options.get("docOp") or "").lower()

    if options.get("password"):
        try:
            doc.authenticate(str(options.get("password")))
        except Exception:
            pass

    if sub == "get_info":
        meta = dict(doc.metadata or {})
        try:
            toc = doc.get_toc(simple=True)
        except Exception:
            toc = []
        return {
            "mutated": False, "docOp": sub, "metadata": meta,
            "toc": toc, "pageCount": len(doc),
            "encrypted": bool(doc.needs_pass or doc.is_encrypted),
        }

    if sub == "set_metadata":
        meta = dict(doc.metadata or {})
        for key in ("title", "author", "subject", "keywords", "creator"):
            if key in options:
                meta[key] = str(options.get(key) or "")
        doc.set_metadata(meta)
        return {"mutated": True, "docOp": sub}

    if sub == "set_bookmarks":
        toc = options.get("toc") or []
        norm = []
        for entry in toc:
            try:
                level = int(entry[0]); title = str(entry[1]); pageno = int(entry[2])
                norm.append([max(1, level), title, max(1, min(pageno, len(doc)))])
            except Exception:
                continue
        doc.set_toc(norm)
        return {"mutated": True, "docOp": sub, "count": len(norm)}

    if sub == "watermark":
        text = str(options.get("text") or "DRAFT")
        opacity = float(options.get("opacity", 0.18))
        size = float(options.get("fontSize", 64))
        angle = float(options.get("angle", 45))
        color = color_tuple(options.get("color"), (0.5, 0.5, 0.5))
        pages = _page_list(options.get("pages"), len(doc)) or list(range(1, len(doc) + 1))
        font = fitz.Font("helv")
        for p in pages:
            page = doc[p - 1]
            center = fitz.Point(page.rect.width / 2, page.rect.height / 2)
            tw = fitz.TextWriter(page.rect, opacity=opacity, color=color)
            tlen = font.text_length(text, fontsize=size)
            tw.append(fitz.Point(center.x - tlen / 2, center.y + size * 0.35), text, font=font, fontsize=size)
            tw.write_text(page, morph=(center, fitz.Matrix(angle)))
        return {"mutated": True, "docOp": sub, "pages": pages}

    if sub == "stamp":
        template = str(options.get("text") or "{n}")
        where = str(options.get("position") or "bottom-center")
        size = float(options.get("fontSize", 10))
        margin = float(options.get("margin", 28))
        color = color_tuple(options.get("color"), (0, 0, 0))
        prefix = str(options.get("batesPrefix") or "")
        start = int(options.get("startNumber", 1))
        digits = int(options.get("batesDigits", 6))
        pages = _page_list(options.get("pages"), len(doc)) or list(range(1, len(doc) + 1))
        font = fitz.Font("helv")
        total = len(doc)
        for idx, p in enumerate(pages):
            page = doc[p - 1]
            bates = f"{prefix}{start + idx:0{digits}d}"
            label = template.replace("{n}", str(p)).replace("{N}", str(total)).replace("{bates}", bates)
            tlen = font.text_length(label, fontsize=size)
            x, y = _stamp_position(page, where, margin, tlen, size)
            page.insert_text(fitz.Point(x, y + size), label, fontsize=size, fontname="helv", color=color)
        return {"mutated": True, "docOp": sub, "pages": pages}

    if sub == "flatten":
        try:
            doc.bake(annots=True, widgets=True)
        except AttributeError:
            raise ValueError("Flattening requires a newer PyMuPDF (Document.bake).")
        return {"mutated": True, "docOp": sub}

    if sub == "compress":
        output_path = options["outputPath"]
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        try:
            doc.subset_fonts()
        except Exception:
            pass
        before = os.path.getsize(input_path) if os.path.exists(input_path) else 0
        tmp = output_path + ".mmtmp"
        doc.save(tmp, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
        os.replace(tmp, output_path)
        after = os.path.getsize(output_path)
        return {"mutated": False, "docOp": sub, "output": output_path, "sizeBefore": before, "sizeAfter": after}

    if sub in ("encrypt", "decrypt"):
        output_path = options["outputPath"]
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        tmp = output_path + ".mmtmp"
        if sub == "encrypt":
            perm = int(getattr(fitz, "PDF_PERM_ACCESSIBILITY", 0)
                       | getattr(fitz, "PDF_PERM_PRINT", 0) * (1 if options.get("allowPrint", True) else 0)
                       | getattr(fitz, "PDF_PERM_COPY", 0) * (1 if options.get("allowCopy", True) else 0)
                       | getattr(fitz, "PDF_PERM_ANNOTATE", 0) * (1 if options.get("allowModify", True) else 0))
            owner = str(options.get("ownerPassword") or options.get("userPassword") or "")
            user = str(options.get("userPassword") or "")
            doc.save(tmp, encryption=getattr(fitz, "PDF_ENCRYPT_AES_256", 5),
                     owner_pw=owner, user_pw=user, permissions=perm,
                     garbage=4, deflate=True)
        else:
            doc.save(tmp, encryption=getattr(fitz, "PDF_ENCRYPT_NONE", 0), garbage=4, deflate=True)
        os.replace(tmp, output_path)
        return {"mutated": False, "docOp": sub, "output": output_path}

    if sub == "export_images":
        out_dir = options["outputDir"]
        os.makedirs(out_dir, exist_ok=True)
        dpi = int(options.get("dpi", 150))
        fmt = str(options.get("format", "png")).lower()
        base = options.get("baseName") or "page"
        pages = _page_list(options.get("pages"), len(doc)) or list(range(1, len(doc) + 1))
        outputs = []
        for p in pages:
            pix = doc[p - 1].get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
            path = os.path.join(out_dir, f"{base}_{p:03d}.{ 'jpg' if fmt in ('jpg','jpeg') else 'png'}")
            if fmt in ("jpg", "jpeg"):
                pix.save(path, jpg_quality=int(options.get("quality", 90)))
            else:
                pix.save(path)
            outputs.append(path)
        return {"mutated": False, "docOp": sub, "outputs": outputs, "count": len(outputs)}

    raise ValueError(f"Unknown document operation: {sub or '(none)'}")


def make_text_item(page_index, item_index, text, bbox, first_span=None, source_type="pdf", method="dict", extra=None):
    text = str(text or "").strip()
    if not text:
        return None

    rect = fitz.Rect(bbox)
    if rect.is_empty or rect.is_infinite:
        return None

    first_span = first_span or {}
    font_name = str(first_span.get("font") or "Helvetica")
    flags = int(first_span.get("flags") or 0)
    font_size = float(first_span.get("size") or max(rect.height, 10))
    norm_family = normalized_font_family(font_name, flags)
    raw = font_name.lower()
    # Substituted when the original font name doesn't contain the normalized family
    # (e.g. "ArialMT" maps to "Helvetica" but "arial"/"sans" are acceptable aliases)
    _helvetica_aliases = ("helvetica", "arial", "sans")
    if norm_family.lower() == "helvetica":
        font_substituted = not any(a in raw for a in _helvetica_aliases)
    else:
        font_substituted = norm_family.lower() not in raw
    item = {
        "id": f"text-{page_index + 1}-{item_index + 1}",
        "page": page_index + 1,
        "text": text,
        "x": rect.x0,
        "y": rect.y0,
        "w": max(rect.width, 1),
        "h": max(rect.height, 1),
        "fontSize": font_size,
        "fontFamily": norm_family,
        "fontName": font_name,
        "fontSubstituted": font_substituted,
        "fontWeight": font_weight(font_name, flags),
        "fontStyle": font_style(font_name, flags),
        "color": span_color_hex(first_span.get("color")),
        "sourceType": source_type,
        "method": method,
    }
    if extra:
        item.update(extra)
    return item


def _line_geometry(line):
    """Return (text, bbox, first_span, size) for a dict line, or None if empty."""
    text = "".join(str(s.get("text") or "") for s in line.get("spans", [])).strip()
    if not text:
        return None
    bbox = line.get("bbox")
    if not bbox:
        sb = [s.get("bbox") for s in line.get("spans", []) if s.get("bbox")]
        if not sb:
            return None
        bbox = [min(b[0] for b in sb), min(b[1] for b in sb), max(b[2] for b in sb), max(b[3] for b in sb)]
    span = (line.get("spans") or [{}])[0]
    size = float(span.get("size") or (bbox[3] - bbox[1]) or 10)
    return {"text": text, "bbox": bbox, "span": span, "size": size}


def extract_paragraph_text_items(page, page_index, textpage=None, source_type="pdf"):
    """Group lines into paragraphs so editing reflows like Acrobat.

    Consecutive lines inside a PyMuPDF text block are merged when they share a
    similar font size and sit on tight (single-spaced) baselines. Wrapped lines
    join with spaces (so the editor re-wraps); a line that ends well short of the
    block's right edge keeps a hard break."""
    get_text_kwargs = {"textpage": textpage} if textpage is not None else {}
    try:
        data = page.get_text("dict", **get_text_kwargs)
    except Exception:
        return []

    items = []
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        lines = [g for g in (_line_geometry(l) for l in block.get("lines", [])) if g]
        if not lines:
            continue

        # Split the block into paragraphs on size change or large vertical gaps.
        paragraphs = [[lines[0]]]
        for prev, cur in zip(lines, lines[1:]):
            gap = cur["bbox"][1] - prev["bbox"][3]
            ratio = cur["size"] / max(prev["size"], 1)
            tight = gap <= max(prev["size"] * 0.9, 2.0)
            similar = 0.8 <= ratio <= 1.25
            if tight and similar:
                paragraphs[-1].append(cur)
            else:
                paragraphs.append([cur])

        for para in paragraphs:
            right = max(l["bbox"][2] for l in para)
            parts = []
            for i, l in enumerate(para):
                parts.append(l["text"])
                if i < len(para) - 1:
                    hard_break = l["bbox"][2] < right - max(l["size"] * 1.5, 6)
                    parts.append("\n" if hard_break else " ")
            text = "".join(parts)
            bbox = [
                min(l["bbox"][0] for l in para), min(l["bbox"][1] for l in para),
                max(l["bbox"][2] for l in para), max(l["bbox"][3] for l in para),
            ]
            # Line spacing from the first two baselines (falls back to bbox ratio).
            if len(para) >= 2:
                spacing = (para[1]["bbox"][1] - para[0]["bbox"][1]) / max(para[0]["size"], 1)
            else:
                spacing = (bbox[3] - bbox[1]) / max(para[0]["size"], 1)
            spacing = round(min(max(spacing, 0.9), 2.2), 3)
            item = make_text_item(
                page_index, len(items), text, bbox, para[0]["span"], source_type,
                "paragraph", {"lineHeight": spacing},
            )
            if item:
                items.append(item)
    return items


def extract_dict_text_items(page, page_index, textpage=None, source_type="pdf"):
    text_items = []
    get_text_kwargs = {"textpage": textpage} if textpage is not None else {}
    text_dict = page.get_text("dict", **get_text_kwargs)
    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            line_text = "".join(str(span.get("text") or "") for span in line.get("spans", [])).strip()
            if not line_text:
                continue

            bbox = line.get("bbox")
            if not bbox:
                span_boxes = [span.get("bbox") for span in line.get("spans", []) if span.get("bbox")]
                if not span_boxes:
                    continue
                bbox = [
                    min(box[0] for box in span_boxes),
                    min(box[1] for box in span_boxes),
                    max(box[2] for box in span_boxes),
                    max(box[3] for box in span_boxes),
                ]

            spans = line.get("spans", [])
            item = make_text_item(page_index, len(text_items), line_text, bbox, spans[0] if spans else {}, source_type, "dict")
            if item:
                text_items.append(item)
    return text_items


def extract_word_text_items(page, page_index, textpage=None, source_type="pdf"):
    try:
        get_text_kwargs = {"textpage": textpage} if textpage is not None else {}
        words = page.get_text("words", sort=True, **get_text_kwargs)
    except Exception:
        return []

    groups = {}
    for word in words:
        if len(word) < 5:
            continue
        text = str(word[4] or "").strip()
        if not text:
            continue
        block_no = word[5] if len(word) > 5 else 0
        line_no = word[6] if len(word) > 6 else len(groups)
        key = (block_no, line_no)
        groups.setdefault(key, []).append(word)

    text_items = []
    for _key, group in sorted(groups.items(), key=lambda item: (min(w[1] for w in item[1]), min(w[0] for w in item[1]))):
        group = sorted(group, key=lambda word: word[0])
        text = " ".join(str(word[4]) for word in group).strip()
        bbox = [
            min(word[0] for word in group),
            min(word[1] for word in group),
            max(word[2] for word in group),
            max(word[3] for word in group),
        ]
        item = make_text_item(
            page_index,
            len(text_items),
            text,
            bbox,
            {"font": "Helvetica", "size": max((bbox[3] - bbox[1]) * 0.78, 8), "color": 0},
            source_type,
            "words",
        )
        if item:
            text_items.append(item)
    return text_items


def tighten_ocr_text_item(item):
    if item.get("sourceType") != "ocr":
        return item

    font_size = float(item.get("fontSize") or item.get("h") or 10)
    x_pad = min(max(font_size * 0.05, 0.25), 1.5)
    y_pad = min(max(font_size * 0.12, 0.5), 2.5)
    item["x"] = float(item["x"]) + x_pad
    item["y"] = float(item["y"]) + y_pad
    item["w"] = max(float(item["w"]) - (x_pad * 2), 1)
    item["h"] = max(float(item["h"]) - (y_pad * 2), max(font_size * 0.72, 1))
    return item


def extract_raw_char_text_items(page, page_index, textpage=None, source_type="pdf"):
    try:
        get_text_kwargs = {"textpage": textpage} if textpage is not None else {}
        raw = page.get_text("rawdict", **get_text_kwargs)
    except Exception:
        return []

    text_items = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            chars = []
            first_span = {}
            for span in line.get("spans", []):
                if not first_span:
                    first_span = span
                for char in span.get("chars", []):
                    value = str(char.get("c") or "")
                    bbox = char.get("bbox")
                    if value and bbox:
                        chars.append((value, bbox))
            if not chars:
                continue

            parts = []
            last_x1 = None
            for value, bbox in chars:
                if last_x1 is not None:
                    gap = bbox[0] - last_x1
                    if gap > max(float(first_span.get("size") or 10) * 0.28, 2.5):
                        parts.append(" ")
                parts.append(value)
                last_x1 = bbox[2]
            text = "".join(parts).strip()
            bbox = [
                min(char_bbox[0] for _value, char_bbox in chars),
                min(char_bbox[1] for _value, char_bbox in chars),
                max(char_bbox[2] for _value, char_bbox in chars),
                max(char_bbox[3] for _value, char_bbox in chars),
            ]
            item = make_text_item(page_index, len(text_items), text, bbox, first_span, source_type, "rawchars")
            if item:
                text_items.append(item)
    return text_items


def extract_block_text_items(page, page_index, textpage=None, source_type="pdf"):
    try:
        get_text_kwargs = {"textpage": textpage} if textpage is not None else {}
        blocks = page.get_text("blocks", sort=True, **get_text_kwargs)
    except Exception:
        return []

    text_items = []
    for block in blocks:
        if len(block) < 5:
            continue
        if len(block) > 6 and block[6] != 0:
            continue
        text = str(block[4] or "").strip()
        if not text:
            continue
        bbox = [block[0], block[1], block[2], block[3]]
        item = make_text_item(page_index, len(text_items), text, bbox, {"font": "Helvetica", "size": max(block[3] - block[1], 10), "color": 0}, source_type, "blocks")
        if item:
            text_items.append(item)
    return text_items


def extract_widget_text_items(page, page_index):
    text_items = []
    try:
        widgets = list(page.widgets() or [])
    except Exception:
        return text_items

    for widget in widgets:
        value = str(getattr(widget, "field_value", "") or "").strip()
        if not value:
            continue
        rect = fitz.Rect(widget.rect)
        field_name = str(getattr(widget, "field_name", "") or "")
        try:
            font_size = float(getattr(widget, "text_fontsize", 0) or max(rect.height * 0.65, 9))
        except Exception:
            font_size = max(rect.height * 0.65, 9)
        item = make_text_item(
            page_index,
            len(text_items),
            value,
            rect,
            {"font": getattr(widget, "text_font", None) or "Helvetica", "size": font_size, "color": 0},
            "widget",
            "widget",
            {"fieldName": field_name, "widgetName": field_name},
        )
        if item:
            text_items.append(item)
    return text_items


def append_non_duplicate_items(items, candidates):
    for candidate in candidates:
        candidate_rect = fitz.Rect(candidate["x"], candidate["y"], candidate["x"] + candidate["w"], candidate["y"] + candidate["h"])
        duplicate = False
        for item in items:
            item_rect = fitz.Rect(item["x"], item["y"], item["x"] + item["w"], item["y"] + item["h"])
            same_text = str(item.get("text") or "").strip() == str(candidate.get("text") or "").strip()
            if same_text and rect_overlap_ratio(item_rect, candidate_rect) > 0.55:
                if candidate.get("sourceType") == "widget":
                    item["sourceType"] = "widget"
                    item["fieldName"] = candidate.get("fieldName")
                    item["widgetName"] = candidate.get("widgetName")
                    item["method"] = f"{item.get('method') or 'text'}+widget"
                duplicate = True
                break
        if not duplicate:
            candidate["id"] = f"text-{candidate['page']}-{len(items) + 1}"
            items.append(candidate)


def extract_page_text_items(page, page_index, textpage=None, source_type="pdf"):
    if source_type == "ocr":
        extractors = [
            extract_word_text_items,
            extract_raw_char_text_items,
            extract_dict_text_items,
            extract_block_text_items,
        ]
    else:
        extractors = [
            extract_paragraph_text_items,
            extract_dict_text_items,
            extract_word_text_items,
            extract_raw_char_text_items,
            extract_block_text_items,
        ]

    text_items = []
    for extractor in extractors:
        text_items = extractor(page, page_index, textpage=textpage, source_type=source_type)
        if text_items:
            break

    if source_type == "pdf":
        append_non_duplicate_items(text_items, extract_widget_text_items(page, page_index))

    if source_type == "ocr":
        text_items = [tighten_ocr_text_item(item) for item in text_items]

    return text_items


def extract_text_map(doc, use_ocr=False):
    text_items = []
    ocr_used = False
    ocr_error = None
    method_counts = {}

    for page_index, page in enumerate(doc):
        page_items = extract_page_text_items(page, page_index, source_type="pdf")
        if page_items or not use_ocr:
            text_items.extend(page_items)
            for item in page_items:
                method = item.get("method") or item.get("sourceType") or "unknown"
                method_counts[method] = method_counts.get(method, 0) + 1
            continue

        try:
            tessdata = configured_tessdata_dir()
            textpage = page.get_textpage_ocr(full=True, dpi=200, language="eng", tessdata=str(tessdata))
            ocr_items = extract_page_text_items(page, page_index, textpage=textpage, source_type="ocr")
            if ocr_items:
                ocr_used = True
                text_items.extend(ocr_items)
                for item in ocr_items:
                    method = item.get("method") or "ocr"
                    method_counts[method] = method_counts.get(method, 0) + 1
            elif ocr_error is None:
                ocr_error = "OCR ran but returned no text for the page."
        except Exception as exc:
            if ocr_error is None:
                ocr_error = str(exc)

    return text_items, ocr_used, ocr_error, method_counts


def main():
    # Page index convention:
    #   - JSON payloads (input/output): 1-based page numbers ("page": 1 = first page)
    #   - PyMuPDF doc[]: 0-based (doc[page_number - 1])
    #   - render_pages output: 1-based index field so the frontend matches
    if len(sys.argv) != 2:
        raise SystemExit("Usage: pdf_redact.py <options.json>")

    with open(sys.argv[1], "r", encoding="utf-8-sig") as fh:
        options = json.load(fh)

    action = options.get("action", "edit")
    input_path = options["inputPath"]

    doc = fitz.open(input_path)
    try:
        if action == "render":
            dpi = options.get("dpi", 150)
            pages = render_pages(doc, dpi)
            print(json.dumps({
                "success": True,
                "pages": pages,
                "totalPages": len(doc)
            }))
        elif action == "text_map":
            items, ocr_used, ocr_error, method_counts = extract_text_map(doc, bool(options.get("ocr")))
            print(json.dumps({
                "success": True,
                "items": items,
                "count": len(items),
                "ocrUsed": ocr_used,
                "ocrError": ocr_error,
                "methodCounts": method_counts,
            }))
        elif action == "page_op":
            result = perform_page_op(doc, options)
            if result.get("mutated"):
                tmp = input_path + ".mmtmp"
                doc.save(tmp, garbage=4, deflate=True, clean=True)
                doc.close()
                os.replace(tmp, input_path)
            result["success"] = True
            print(json.dumps(result))
        elif action == "document":
            result = perform_doc_op(doc, input_path, options)
            if result.get("mutated"):
                tmp = input_path + ".mmtmp"
                doc.save(tmp, garbage=4, deflate=True, clean=True)
                doc.close()
                os.replace(tmp, input_path)
            result["success"] = True
            print(json.dumps(result))
        else:
            output_path = options["outputPath"]
            terms = parse_terms(options.get("terms"))
            rects = options.get("rects") or []
            covers = options.get("covers") or []
            edits = options.get("edits") or []
            highlights = options.get("highlights") or []
            paths = options.get("paths") or []
            markups = options.get("markups") or []
            notes = options.get("notes") or []
            images = options.get("images") or []
            forms = options.get("forms") or []
            links = options.get("links") or []

            if not any([terms, edits, rects, covers, highlights, paths, markups, notes, images, forms, links]):
                raise ValueError("No changes specified (text edits or redactions)")

            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            replacement_edits = [edit for edit in edits if is_replacement_edit(edit)]
            insertion_edits = [edit for edit in edits if not is_replacement_edit(edit)]

            cover_count = apply_redactions(doc, [], [], covers)
            widget_replacements, replacement_edits = apply_widget_replacements(doc, replacement_edits)
            text_replacements, replace_overflow = apply_text_replacements(doc, replacement_edits)
            text_edits, text_overflow = apply_text_edits(doc, insertion_edits)
            text_overflow += replace_overflow
            redactions = cover_count + apply_redactions(doc, terms, rects, [])
            shape_count = apply_highlights(doc, highlights)
            markup_count = apply_markups(doc, markups)
            note_count = apply_notes(doc, notes)
            image_count = apply_images(doc, images)
            form_count = apply_form_fields(doc, forms)
            link_count = apply_links(doc, links)
            apply_paths(doc, paths)

            # Write to a temp file first; rename atomically so a failed save never
            # leaves a corrupt output at the intended path.
            tmp_output = output_path + ".mmtmp"
            try:
                doc.save(tmp_output, garbage=4, deflate=True, clean=True)
                os.replace(tmp_output, output_path)
            except Exception:
                try:
                    os.unlink(tmp_output)
                except Exception:
                    pass
                raise

            print(json.dumps({
                "success": True,
                "output": output_path,
                "redactions": redactions,
                "widgetReplacements": widget_replacements,
                "textReplacements": text_replacements,
                "textEdits": text_edits,
                "textOverflow": text_overflow,
                "shapes": shape_count,
                "markups": markup_count,
                "notes": note_count,
                "images": image_count,
                "forms": form_count,
                "links": link_count,
            }))
    finally:
        try:
            doc.close()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        raise SystemExit(1)
