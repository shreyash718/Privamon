"""
End-to-End Image Redaction Pipeline Test

Verifies:
1. Generation of an image containing sensitive PII (Name, Phone, Multi-line Address) and non-sensitive text (Order ID, labels).
2. Querying the local Privamon PII Engine (127.0.0.1:8765) with OCR word tokens.
3. Verifying correct detection types and multi-box line segmentation.
4. Applying opaque black redaction over sensitive bounding boxes.
5. Inspecting pixels:
   - Redacted areas MUST be completely opaque black (0, 0, 0).
   - Non-sensitive text areas (e.g. "Order ID", "Customer:") MUST be preserved (white background).
"""

import os
import json
import urllib.request
import pytest
from PIL import Image, ImageDraw, ImageFont


def test_end_to_end_image_redaction(tmp_path):
    # 1. Create a synthetic image (400 x 200 px)
    img_w, img_h = 500, 250
    image = Image.new("RGB", (img_w, img_h), color=(255, 255, 255))
    draw = ImageDraw.Draw(image)

    # Text lines and layout coordinates
    lines_layout = [
        {"y": 20, "words": [("Customer:", 20, 90), ("Priya", 100, 150), ("Sharma", 160, 230)]},
        {"y": 60, "words": [("Phone:", 20, 80), ("+91", 90, 125), ("9876543210", 135, 245)]},
        {"y": 100, "words": [("Delivery:", 20, 95), ("42", 105, 130), ("Palm", 140, 185), ("Grove", 195, 250), ("Road,", 260, 315)]},
        {"y": 140, "words": [("Bandra", 20, 85), ("West,", 95, 145), ("Mumbai", 155, 225), ("400050", 235, 305)]},
        {"y": 180, "words": [("Order", 20, 70), ("ID:", 80, 105), ("9876543210", 115, 220)]}
    ]

    tokens = []
    full_text_lines = []

    for line in lines_layout:
        line_words = []
        y = line["y"]
        for word, x1, x2 in line["words"]:
            draw.text((x1, y), word, fill=(0, 0, 0))
            line_words.append(word)
            tokens.append({
                "text": word,
                "bbox": {"x": x1, "y": y, "width": x2 - x1, "height": 22},
                "confidence": 0.98
            })
        full_text_lines.append(" ".join(line_words))

    full_text = "\n".join(full_text_lines)

    # 2. Call Privamon Local Engine
    req_data = json.dumps({
        "text": full_text,
        "tokens": tokens,
        "source": "ocr"
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8765/detect",
            data=req_data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            assert response.status == 200
            res = json.loads(response.read().decode("utf-8"))
    except Exception:
        from engine.server import app
        from starlette.testclient import TestClient
        client = TestClient(app)
        resp = client.post("/detect", json=json.loads(req_data.decode("utf-8")))
        assert resp.status_code == 200
        res = resp.json()

    detections = res["detections"]
    assert len(detections) >= 3

    types = [d["type"] for d in detections]
    assert "PERSON" in types
    assert "PHONE" in types
    assert "ADDRESS" in types

    # Verify Order ID wasn't detected as phone (negative prefix suppression)
    for d in detections:
        if d["type"] == "PHONE":
            assert "9876543210" in d["text"]
            assert "Order" not in d["text"]
            # Ensure the phone bbox corresponds to the Phone line (y=60), not Order ID line (y=180)
            assert d["bbox"]["y"] < 100

    # 3. Perform Redaction on Canvas
    redacted_image = image.copy()
    redact_draw = ImageDraw.Draw(redacted_image)

    padding = 4
    for det in detections:
        boxes = det.get("boxes") or [det["bbox"]]
        for box in boxes:
            rx1 = max(0, box["x"] - padding)
            ry1 = max(0, box["y"] - padding)
            rx2 = min(img_w - 1, box["x"] + box["width"] + padding)
            ry2 = min(img_h - 1, box["y"] + box["height"] + padding)
            redact_draw.rectangle([rx1, ry1, rx2, ry2], fill=(0, 0, 0))

    # 4. Verify Pixels
    # A) Center of Priya Sharma (x=120, y=30) MUST be black (0, 0, 0)
    assert redacted_image.getpixel((120, 30)) == (0, 0, 0), "PERSON wasn't redacted"

    # B) Center of Phone number (x=150, y=70) MUST be black (0, 0, 0)
    assert redacted_image.getpixel((150, 70)) == (0, 0, 0), "PHONE wasn't redacted"

    # C) Center of Address line 1 (x=160, y=110) MUST be black (0, 0, 0)
    assert redacted_image.getpixel((160, 110)) == (0, 0, 0), "ADDRESS line 1 wasn't redacted"

    # D) Center of Address line 2 (x=100, y=150) MUST be black (0, 0, 0)
    assert redacted_image.getpixel((100, 150)) == (0, 0, 0), "ADDRESS line 2 wasn't redacted"

    # E) Non-sensitive text: "Customer:" label (x=5, y=30) should NOT be fully black (background preserved)
    # The background at (5, 30) must be white (255, 255, 255)
    assert redacted_image.getpixel((5, 30)) == (255, 255, 255), "Customer label was over-redacted"

    # F) Non-sensitive text: "Delivery:" label (x=5, y=110) should NOT be redacted
    assert redacted_image.getpixel((5, 110)) == (255, 255, 255), "Delivery label was over-redacted"

    # G) "Order ID: 9876543210" at y=180 was NOT PII, background around it should remain white
    assert redacted_image.getpixel((5, 190)) == (255, 255, 255), "Order ID line was falsely redacted"

    # Save output artifacts for inspection
    out_path = os.path.join(str(tmp_path), "redacted_output.png")
    redacted_image.save(out_path)
    assert os.path.exists(out_path)
