import json
import os
import sys

import fitz


def parse_terms(value):
    terms = []
    for item in value or []:
        term = str(item).strip()
        if term and term not in terms:
            terms.append(term)
    return terms


def apply_redactions(doc, terms):
    match_count = 0
    for page in doc:
        for term in terms:
            matches = page.search_for(term)
            for rect in matches:
                page.add_redact_annot(rect, fill=(0, 0, 0))
                match_count += 1
        if match_count:
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_PIXELS,
                graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )
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

        page = doc[page_number - 1]
        page.insert_text(
            fitz.Point(x, y),
            text,
            fontsize=size,
            fontname="helv",
            color=(0, 0, 0),
        )
        edit_count += 1
    return edit_count


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: pdf_redact.py <options.json>")

    with open(sys.argv[1], "r", encoding="utf-8-sig") as fh:
        options = json.load(fh)

    input_path = options["inputPath"]
    output_path = options["outputPath"]
    terms = parse_terms(options.get("terms"))
    edits = options.get("edits") or []

    if not terms and not edits:
        raise ValueError("Add at least one redaction term or text edit")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    doc = fitz.open(input_path)
    try:
        redactions = apply_redactions(doc, terms)
        text_edits = apply_text_edits(doc, edits)
        doc.save(output_path, garbage=4, deflate=True, clean=True)
    finally:
        doc.close()

    print(json.dumps({
        "success": True,
        "output": output_path,
        "redactions": redactions,
        "textEdits": text_edits,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        raise SystemExit(1)
