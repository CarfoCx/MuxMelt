import fitz
import os
import glob
import time

_SYSTEM_FONT_CACHE = None

def get_system_font_map():
    global _SYSTEM_FONT_CACHE
    if _SYSTEM_FONT_CACHE is not None:
        return _SYSTEM_FONT_CACHE
        
    _SYSTEM_FONT_CACHE = {}
    font_dir = "C:/Windows/Fonts"
    if os.path.exists(font_dir):
        files = glob.glob(os.path.join(font_dir, "*.ttf")) + glob.glob(os.path.join(font_dir, "*.otf"))
        for f in files:
            try:
                font = fitz.Font(fontfile=f)
                name = font.name.lower()
                _SYSTEM_FONT_CACHE[name] = f
            except Exception:
                pass
    return _SYSTEM_FONT_CACHE

def find_system_font_file(font_name, is_bold=False, is_italic=False):
    font_map = get_system_font_map()
    if not font_map:
        return None
        
    font_name = str(font_name or "").lower()
    if "+" in font_name:
        font_name = font_name.split("+", 1)[1]
        
    if "timesnewroman" in font_name or "times new roman" in font_name:
        font_name = "times new roman"
    elif "arial" in font_name:
        font_name = "arial"
    elif "calibri" in font_name:
        font_name = "calibri"
    elif "couriernew" in font_name or "courier new" in font_name:
        font_name = "courier new"
    elif "segoe" in font_name:
        font_name = "segoe ui"
    elif "verdana" in font_name:
        font_name = "verdana"
    elif "georgia" in font_name:
        font_name = "georgia"
        
    candidates = []
    for name, path in font_map.items():
        if font_name in name:
            candidates.append((name, path))
            
    if not candidates:
        return None
        
    best_path = None
    best_score = -1
    
    for name, path in candidates:
        score = 0
        has_bold = "bold" in name or "bd" in name or "black" in name
        has_italic = "italic" in name or "it" in name or "oblique" in name
        
        if is_bold == has_bold:
            score += 2
        if is_italic == has_italic:
            score += 2
            
        if not is_bold and not is_italic and "regular" in name:
            score += 1
            
        if score > best_score:
            best_score = score
            best_path = path
            
    return best_path

# Test the function
tests = [
    ("Calibri", False, False),
    ("Calibri", True, False),
    ("Calibri", False, True),
    ("Arial", False, False),
    ("Arial", True, True),
    ("TimesNewRomanPSMT", False, False),
    ("TimesNewRomanPS-BoldItalicMT", True, True)
]

for name, bold, italic in tests:
    path = find_system_font_file(name, bold, italic)
    print(f"Resolve: {name} (bold={bold}, italic={italic}) -> {os.path.basename(path) if path else 'Not Found'}")

# Verify that registering works
doc = fitz.open()
page = doc.new_page()

font_file = find_system_font_file("Calibri", False, False)
if font_file:
    font_ref = page.insert_font(fontname="Calibri", fontfile=font_file)
    print("Registered Calibri! Ref name:", font_ref)
    page.insert_textbox(
        fitz.Rect(50, 50, 200, 100),
        "Hello custom Calibri!",
        fontsize=12,
        fontname="Calibri"
    )
    print("Text inserted successfully!")
else:
    print("Calibri not found")

doc.close()
