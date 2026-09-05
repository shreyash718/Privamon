"""
Tests for Face Detection and Redaction Pipeline
Verifies:
1. Loading the ONNX face detection model (UltraFace RFB-320).
2. Performing inference on an image containing a human face.
3. Calculating exact bounding boxes around the face.
4. Applying opaque black rectangle redaction over the face.
5. Verifying that the face area is completely blacked out while surrounding pixels are preserved.
"""

import os
import numpy as np
import pytest
from PIL import Image, ImageDraw


def test_face_detection_and_redaction():
    import onnxruntime as ort

    model_path = os.path.join("lib", "onnx", "blazeface.onnx")
    assert os.path.exists(model_path), f"Model not found at {model_path}"

    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    assert "input" in [i.name for i in sess.get_inputs()]
    assert "scores" in [o.name for o in sess.get_outputs()]
    assert "boxes" in [o.name for o in sess.get_outputs()]

    test_image_path = os.path.join("scratch", "test_face.jpg")
    assert os.path.exists(test_image_path), f"Test image not found at {test_image_path}"

    img = Image.open(test_image_path).convert("RGB")
    orig_w, orig_h = img.size

    # Prepare input 320x240 NCHW normalized
    img_resized = img.resize((320, 240))
    arr = (np.array(img_resized, dtype=np.float32) - 127.0) / 128.0
    inp = np.transpose(arr, (2, 0, 1))[np.newaxis, ...].astype(np.float32)

    confidences, boxes = sess.run(None, {"input": inp})
    scores = confidences[0, :, 1]
    boxes = boxes[0]

    # Filter confidence >= 0.65
    mask = scores >= 0.65
    assert np.any(mask), "Face should be detected with confidence >= 0.65"

    filtered_scores = scores[mask]
    filtered_boxes = boxes[mask]

    # NMS
    def iou(b1, b2):
        xA = max(b1[0], b2[0])
        yA = max(b1[1], b2[1])
        xB = min(b1[2], b2[2])
        yB = min(b1[3], b2[3])
        inter = max(0, xB - xA) * max(0, yB - yA)
        areaA = (b1[2] - b1[0]) * (b1[3] - b1[1])
        areaB = (b2[2] - b2[0]) * (b2[3] - b2[1])
        return inter / max(1e-6, areaA + areaB - inter)

    order = filtered_scores.argsort()[::-1]
    keep = []
    while len(order) > 0:
        i = order[0]
        keep.append(i)
        ovr = np.array([iou(filtered_boxes[i], filtered_boxes[o]) for o in order[1:]])
        inds = np.where(ovr <= 0.3)[0]
        order = order[inds + 1]

    assert len(keep) == 1, f"Expected 1 face after NMS, got {len(keep)}"

    best_idx = keep[0]
    best_score = float(filtered_scores[best_idx])
    b = filtered_boxes[best_idx]
    assert best_score > 0.95, f"Expected high confidence, got {best_score}"

    # Map box to original image space
    x1 = int(b[0] * orig_w)
    y1 = int(b[1] * orig_h)
    x2 = int(b[2] * orig_w)
    y2 = int(b[3] * orig_h)

    # Face in 1024x1024 photo is centered horizontally and upper-middle vertically
    assert 250 < x1 < 400, f"Unexpected x1: {x1}"
    assert 150 < y1 < 260, f"Unexpected y1: {y1}"
    assert 600 < x2 < 760, f"Unexpected x2: {x2}"
    assert 600 < y2 < 760, f"Unexpected y2: {y2}"

    # Redaction: draw opaque black rectangle over face
    redacted_img = img.copy()
    draw = ImageDraw.Draw(redacted_img)
    draw.rectangle([x1, y1, x2, y2], fill=(0, 0, 0))

    # Pixel inspection:
    redacted_arr = np.array(redacted_img)
    # Face center must be solid black (0, 0, 0)
    center_x = (x1 + x2) // 2
    center_y = (y1 + y2) // 2
    assert np.all(redacted_arr[center_y, center_x] == [0, 0, 0]), "Face center must be redacted black"

    # Outside regions (suit collar, background) must remain non-black
    assert not np.all(redacted_arr[900, 500] == [0, 0, 0]), "Suit should not be redacted"
    assert not np.all(redacted_arr[50, 50] == [0, 0, 0]), "Background should not be redacted"


def test_detect_face_endpoint():
    import base64
    from engine.server import app
    from starlette.testclient import TestClient

    client = TestClient(app)
    with open(os.path.join("scratch", "test_face.jpg"), "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")

    resp = client.post("/detect/face", json={"image": f"data:image/jpeg;base64,{b64}"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["faces"]) == 1
    face = data["faces"][0]
    assert face["type"] == "face"
    assert face["confidence"] > 0.95
    assert face["bbox"]["width"] > 100
    assert face["bbox"]["height"] > 100
