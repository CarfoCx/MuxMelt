// Shared font helpers for the PDF editor.
//
// The Python save pipeline rewrites detected text using the document's own
// embedded font (matched by `fontName`). On the canvas we approximate that
// font with a CSS stack so inline editing looks close to the final output.

export const ORIGINAL_FONT = 'original';

// Font choices offered in the Inspector. `value` is sent to Python as
// `fontFamily`; "original" means "keep the document's own font".
export interface FontChoice {
  value: string;
  label: string;
}

export const FONT_CHOICES: FontChoice[] = [
  { value: ORIGINAL_FONT, label: 'Match document font' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Calibri', label: 'Calibri' },
  { value: 'Cambria', label: 'Cambria' },
  { value: 'Times', label: 'Times' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Tahoma', label: 'Tahoma' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
  { value: 'Segoe UI', label: 'Segoe UI' },
  { value: 'Courier', label: 'Courier' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Comic Sans MS', label: 'Comic Sans MS' },
];

// Map a raw/normalized font name to a CSS font-family stack for preview.
export function mapFontNameToCss(name?: string): string {
  const stripped = (name || '').replace(/^[A-Z]{6}\+/, '');
  const f = stripped.toLowerCase().replace(/[-_\s]/g, '');
  if (!f) return "Helvetica, Arial, sans-serif";

  if (/courier|consolas|inconsolata|lucidaconsole|firacode|sourcecodemono|ocr/.test(f) || f.endsWith('mono')) {
    return "'Courier New', Courier, monospace";
  }
  if (/timesnewroman|timesroman/.test(f) || f === 'times' || /^times/.test(f)) return "'Times New Roman', Times, serif";
  if (/cambria|caladea/.test(f)) return "Cambria, Georgia, serif";
  if (/georgia|gelasio/.test(f)) return "Georgia, serif";
  if (/garamond/.test(f)) return "Garamond, 'EB Garamond', Georgia, serif";
  if (/palatino|bookantiqua|bookman/.test(f)) return "'Palatino Linotype', Palatino, serif";
  if (/constantia/.test(f)) return "Constantia, Cambria, Georgia, serif";
  if (/minion/.test(f)) return "Garamond, Georgia, serif";

  if (/calibri|carlito/.test(f)) return "Calibri, Carlito, 'Segoe UI', sans-serif";
  if (/segoe/.test(f)) return "'Segoe UI', Calibri, sans-serif";
  if (/^arial|arialmt|liberationsans/.test(f)) return "Arial, Helvetica, sans-serif";
  if (/^helv|helvetica/.test(f)) return "Helvetica, Arial, sans-serif";
  if (/verdana/.test(f)) return "Verdana, Geneva, sans-serif";
  if (/tahoma/.test(f)) return "Tahoma, Geneva, sans-serif";
  if (/trebuchet/.test(f)) return "'Trebuchet MS', Helvetica, sans-serif";
  if (/candara/.test(f)) return "Candara, Calibri, sans-serif";
  if (/corbel/.test(f)) return "Corbel, Calibri, sans-serif";
  if (/centurygothic|futura/.test(f)) return "'Century Gothic', Futura, Arial, sans-serif";
  if (/gillsans/.test(f)) return "'Gill Sans', 'Gill Sans MT', Arial, sans-serif";
  if (/franklin/.test(f)) return "'Franklin Gothic Medium', Arial, sans-serif";
  if (/impact/.test(f)) return "Impact, 'Arial Narrow', sans-serif";
  if (/comicsans|comic/.test(f)) return "'Comic Sans MS', cursive";
  if (/myriad/.test(f)) return "'Myriad Pro', Arial, sans-serif";
  if (/optima/.test(f)) return "Optima, Candara, sans-serif";

  return "Helvetica, Arial, sans-serif";
}

// Resolve the CSS font stack for an annotation: when the family is "original"
// (or unset) we fall back to the detected raw font name.
export function annotationFontCss(ann: { fontFamily?: string; fontName?: string; originalFontName?: string }): string {
  const family = (ann.fontFamily || '').trim();
  if (!family || family.toLowerCase() === ORIGINAL_FONT) {
    return mapFontNameToCss(ann.fontName || ann.originalFontName);
  }
  return mapFontNameToCss(family);
}

// A short human label for the document's detected font (subset prefix removed).
export function prettyFontName(name?: string): string {
  if (!name) return 'Document font';
  return name.replace(/^[A-Z]{6}\+/, '').replace(/[-_]/g, ' ').trim() || 'Document font';
}
