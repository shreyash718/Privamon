"""
Privamon — Exact Coordinate Mapping & Geometry Unit Tests

Tests:
1. Stable token ID assignment and preservation.
2. Partial token overlap calculation (proportional sub-box).
3. Multi-line entity segmentation into separate line bounding boxes.
4. End-to-end pixel verification ensuring exact PII coverage and preservation
   of non-sensitive text and whitespace between lines.
"""

import pytest
from engine.span_mapper import (
    align_tokens_with_text,
    compute_token_sub_box,
    map_span_to_bboxes,
    map_detections_to_tokens
)
from PIL import Image, ImageDraw


def test_stable_token_ids_assignment():
    """Verify tokens without IDs receive deterministic IDs (ocr_0001, etc.)."""
    tokens = [
        {"text": "Hello", "bbox": {"x": 10, "y": 10, "width": 40, "height": 15}},
        {"text": "Rahul", "bbox": {"x": 60, "y": 10, "width": 50, "height": 15}}
    ]
    text = "Hello Rahul"
    aligned = align_tokens_with_text(text, tokens)

    assert len(aligned) == 2
    assert aligned[0]["id"] == "ocr_0001"
    assert aligned[1]["id"] == "ocr_0002"
    assert aligned[0]["start"] == 0
    assert aligned[0]["end"] == 5
    assert aligned[1]["start"] == 6
    assert aligned[1]["end"] == 11


def test_token_id_preservation_when_provided():
    """Verify existing token IDs are preserved."""
    tokens = [
        {"id": "custom_tok_99", "text": "Sharma", "start": 0, "end": 6, "bbox": {"x": 10, "y": 10, "width": 50, "height": 15}}
    ]
    aligned = align_tokens_with_text("Sharma", tokens)
    assert aligned[0]["id"] == "custom_tok_99"


def test_partial_token_overlap_sub_box():
    """
    Test proportional sub-box geometry when detected PII overlaps
    only part of an OCR token.
    Example: Token is 'Rahul123' (len 8, width 80px, x=100)
    PII span covers 'Rahul' (first 5 chars: start=0, end=5).
    Expected sub-box: x=100, width=50px (5/8 of 80px).
    """
    token = {
        "id": "ocr_0001",
        "text": "Rahul123",
        "start": 0,
        "end": 8,
        "bbox": {"x": 100, "y": 50, "width": 80, "height": 20}
    }

    # Case A: PII covers 'Rahul' (0..5)
    sub_box = compute_token_sub_box(token, span_start=0, span_end=5)
    assert sub_box["x"] == 100
    assert sub_box["width"] == 50
    assert sub_box["height"] == 20

    # Case B: PII covers '123' (5..8)
    sub_box_tail = compute_token_sub_box(token, span_start=5, span_end=8)
    assert sub_box_tail["x"] == 150
    assert sub_box_tail["width"] == 30

    # Case C: PII covers whole token (0..8)
    sub_box_full = compute_token_sub_box(token, span_start=0, span_end=8)
    assert sub_box_full["x"] == 100
    assert sub_box_full["width"] == 80


def test_multi_line_segmented_boxes():
    """
    Verify multi-line entity creates distinct per-line boxes in 'boxes'
    instead of one giant union that blanks out everything in between.
    """
    aligned_tokens = [
        {"id": "ocr_0001", "text": "42", "start": 0, "end": 2, "bbox": {"x": 50, "y": 100, "width": 20, "height": 20}},
        {"id": "ocr_0002", "text": "Park", "start": 3, "end": 7, "bbox": {"x": 75, "y": 100, "width": 40, "height": 20}},
        {"id": "ocr_0003", "text": "Street", "start": 8, "end": 14, "bbox": {"x": 120, "y": 100, "width": 50, "height": 20}},
        {"id": "ocr_0004", "text": "Kolkata", "start": 15, "end": 22, "bbox": {"x": 50, "y": 180, "width": 70, "height": 20}},
        {"id": "ocr_0005", "text": "700016", "start": 23, "end": 29, "bbox": {"x": 130, "y": 180, "width": 60, "height": 20}}
    ]

    res = map_span_to_bboxes(span_start=0, span_end=29, aligned_tokens=aligned_tokens)
    assert len(res["tokens"]) == 5
    assert res["tokens"] == ["ocr_0001", "ocr_0002", "ocr_0003", "ocr_0004", "ocr_0005"]

    # Must produce 2 distinct line boxes
    assert len(res["boxes"]) == 2

    # Line 1 box (y=100)
    line1 = res["boxes"][0]
    assert line1["y"] == 100
    assert line1["x"] == 50
    assert line1["width"] == (120 + 50) - 50  # 120
    assert line1["height"] == 20

    # Line 2 box (y=180)
    line2 = res["boxes"][1]
    assert line2["y"] == 180
    assert line2["x"] == 50
    assert line2["width"] == (130 + 60) - 50  # 140
    assert line2["height"] == 20

    # The region between y=120 and y=180 is empty/unrelated and MUST NOT be covered by either box
    assert line1["y"] + line1["height"] <= 125
    assert line2["y"] >= 180


def test_pixel_verification_partial_token_redaction(tmp_path):
    """
    End-to-end pixel check:
    Image has token 'Rahul123'.
    PII is 'Rahul' (0..5).
    Redaction must color 'Rahul' black, while '123' remains white background.
    """
    img_w, img_h = 300, 100
    image = Image.new("RGB", (img_w, img_h), color=(255, 255, 255))
    draw = ImageDraw.Draw(image)

    # Draw word 'Rahul123' at (50, 40)
    token = {
        "id": "ocr_0001",
        "text": "Rahul123",
        "start": 0,
        "end": 8,
        "bbox": {"x": 50, "y": 40, "width": 80, "height": 20}
    }

    detections = [{
        "type": "PERSON",
        "start": 0,
        "end": 5,
        "confidence": 0.95
    }]

    mapped = map_detections_to_tokens(detections, [token], "Rahul123")
    assert len(mapped) == 1
    det = mapped[0]

    assert det["tokens"] == ["ocr_0001"]
    sub_box = det["bbox"]

    # Redact using sub-box
    redacted = image.copy()
    redact_draw = ImageDraw.Draw(redacted)

    rx1 = sub_box["x"]
    ry1 = sub_box["y"]
    rx2 = sub_box["x"] + sub_box["width"]
    ry2 = sub_box["y"] + sub_box["height"]
    redact_draw.rectangle([rx1, ry1, rx2, ry2], fill=(0, 0, 0))

    # Center of 'Rahul' at (x=70, y=50) must be black
    assert redacted.getpixel((70, 50)) == (0, 0, 0), "Rahul portion was not redacted"

    # Area of '123' at (x=115, y=50) must be white (preserved)
    assert redacted.getpixel((115, 50)) == (255, 255, 255), "123 portion was erroneously redacted"
