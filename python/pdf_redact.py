import json
import os
import sys
import tempfile
from pathlib import Path

import fitz


def parse_terms(value):
    terms = []
    for item in value or []:
        term = str(item).strip()
        if term and term not in terms:
            terms.append(term)
    return terms


def apply_redactions(doc, terms, rects):
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

    # Coordinate-based redactions
    if rects:
        for rect_data in rects:
            page_idx = int(rect_data.get("page", 1)) - 1
            if 0 <= page_idx < len(doc):
                page = doc[page_idx]
                r = fitz.Rect(
                    rect_data["x"],
                    rect_data["y"],
                    rect_data["x"] + rect_data["w"],
                    rect_data["y"] + rect_data["h"]
                )
                page.add_redact_annot(r, fill=(0, 0, 0))
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_PIXELS,
                    graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                    text=fitz.PDF_REDACT_TEXT_REMOVE,
                )
                match_count += 1
    
    return match_count


def apply_text_edits(doc, edits):
    edit_count = 0
    for edit in edits or []:
        text = str(edit.get("text") or "").strip()
        if not text:
            continue

        page_number = int(edit.get("page") or 1)
        if page_number < 1 or page_number > len(doc):
            raise ValueError(f"Text edit page {page_number} is outside the PDF page range")

        x = float(edit.get("x") or 72)
        y = float(edit.get("y") or 72)
        size = float(edit.get("size") or 12)
        color = edit.get("color", [0, 0, 0])
        if len(color) == 3: # Normalize 0-255 to 0-1
            color = [c / 255.0 for c in color]

        page = doc[page_number - 1]
        page.insert_text(
            fitz.Point(x, y),
            text,
            fontsize=size,
            fontname="helv",
            color=color,
        )
        edit_count += 1
    return edit_count


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


def main():
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
        else:
            output_path = options["outputPath"]
            terms = parse_terms(options.get("terms"))
            rects = options.get("rects") or []
            edits = options.get("edits") or []

            if not terms and not edits and not rects:
                raise ValueError("No changes specified (terms, rects, or edits)")

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            redactions = apply_redactions(doc, terms, rects)
            text_edits = apply_text_edits(doc, edits)
            doc.save(output_path, garbage=4, deflate=True, clean=True)
            
            print(json.dumps({
                "success": True,
                "output": output_path,
                "redactions": redactions,
                "textEdits": text_edits,
            }))
    finally:
        doc.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        raise SystemExit(1)
