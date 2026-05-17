import json
import os
import sys
import tempfile
import base64
from pathlib import Path

import fitz


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
    family = str(edit.get("fontFamily") or "").lower()
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


def span_color_hex(value):
    if isinstance(value, int):
        return f"#{(value >> 16) & 255:02x}{(value >> 8) & 255:02x}{value & 255:02x}"
    return "#000000"


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


def apply_highlights(doc, highlights):
    count = 0
    for item in highlights or []:
        page_idx = int(item.get("page", 1)) - 1
        if 0 <= page_idx < len(doc):
            page = doc[page_idx]
            r = fitz.Rect(
                item["x"],
                item["y"],
                item["x"] + item["w"],
                item["y"] + item["h"]
            )
            
            shape_type = item.get("type", "highlight")
            color = color_tuple(item.get("stroke"), (1, 0.78, 0))
            fill = color_tuple(item.get("fill"), (1, 0.92, 0.25))
            opacity = float(item.get("opacity", 0.35))
            
            if shape_type == "highlight":
                annot = page.add_rect_annot(r)
                annot.set_colors(stroke=color, fill=fill)
                annot.set_opacity(opacity)
                annot.update()
            elif shape_type == "circle":
                annot = page.add_circle_annot(r)
                annot.set_colors(stroke=color, fill=fill)
                annot.set_opacity(opacity)
                annot.update()
            elif shape_type == "line":
                p1 = fitz.Point(item["x"], item["y"])
                p2 = fitz.Point(item["x"] + item["w"], item["y"] + item["h"])
                annot = page.add_line_annot(p1, p2)
                annot.set_colors(stroke=color)
                annot.set_opacity(opacity)
                annot.update()
            elif shape_type == "arrow":
                p1 = fitz.Point(item["x"], item["y"])
                p2 = fitz.Point(item["x"] + item["w"], item["y"] + item["h"])
                annot = page.add_line_annot(p1, p2)
                annot.set_line_ends(fitz.PDF_LINE_SYMBOL_NONE, fitz.PDF_LINE_SYMBOL_CLOSED_ARROW)
                annot.set_colors(stroke=color)
                annot.set_opacity(opacity)
                annot.update()
                
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
        fontname = base_font_name(edit)
        align = text_align(edit.get("align"))
        rect = fitz.Rect(x, y, x + w, y + h)
        remaining = page.insert_textbox(
            rect,
            text,
            fontsize=size,
            fontname=fontname,
            color=color,
            align=align,
            lineheight=line_height,
        )
        if remaining < 0:
            page.insert_text(
                fitz.Point(x, y + size),
                text,
                fontsize=size,
                fontname=fontname,
                color=color,
            )
        if str(edit.get("textDecoration") or "none").lower() == "underline":
            draw_underlines(page, rect, text, fontname, size, color, align, line_height)
        edit_count += 1
    return edit_count


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


def extract_page_text_items(page, page_index, textpage=None):
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
            first_span = spans[0] if spans else {}
            text_items.append({
                "id": f"text-{page_index + 1}-{len(text_items) + 1}",
                "page": page_index + 1,
                "text": line_text,
                "x": bbox[0],
                "y": bbox[1],
                "w": max(bbox[2] - bbox[0], 1),
                "h": max(bbox[3] - bbox[1], 1),
                "fontSize": float(first_span.get("size") or max(bbox[3] - bbox[1], 10)),
                "fontFamily": str(first_span.get("font") or "Helvetica"),
                "color": span_color_hex(first_span.get("color")),
            })
    return text_items


def extract_text_map(doc, use_ocr=False):
    text_items = []
    ocr_used = False
    ocr_error = None

    for page_index, page in enumerate(doc):
        page_items = extract_page_text_items(page, page_index)
        if page_items or not use_ocr:
            text_items.extend(page_items)
            continue

        try:
            textpage = page.get_textpage_ocr(full=True, dpi=200)
            ocr_items = extract_page_text_items(page, page_index, textpage=textpage)
            if ocr_items:
                ocr_used = True
                text_items.extend(ocr_items)
        except Exception as exc:
            if ocr_error is None:
                ocr_error = str(exc)

    return text_items, ocr_used, ocr_error


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
        elif action == "text_map":
            items, ocr_used, ocr_error = extract_text_map(doc, bool(options.get("ocr")))
            print(json.dumps({
                "success": True,
                "items": items,
                "count": len(items),
                "ocrUsed": ocr_used,
                "ocrError": ocr_error,
            }))
        else:
            output_path = options["outputPath"]
            terms = parse_terms(options.get("terms"))
            rects = options.get("rects") or []
            covers = options.get("covers") or []
            edits = options.get("edits") or []

            if not terms and not edits and not rects and not covers:
                raise ValueError("No changes specified (text edits or redactions)")

            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            cover_count = apply_redactions(doc, [], [], covers)
            text_edits = apply_text_edits(doc, edits)
            redactions = cover_count + apply_redactions(doc, terms, rects, [])
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
