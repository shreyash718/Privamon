"""
Privamon — Local PII Engine FastAPI Server

Endpoints:
- GET /health -> Health check and model readiness
- POST /detect -> Full PII detection, normalization, fusion & span mapping

Security:
- Binds strictly to 127.0.0.1:8765 (Local loopback only)
- No outbound network transmission of user text or screenshots
"""

import os
import time
import hashlib
import logging
from collections import OrderedDict
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from engine.normalizer import normalize_text
from engine.presidio_detector import PresidioDetector
from engine.gliner_detector import GLiNERDetector
from engine.fusion_engine import fuse_detections
from engine.span_mapper import map_detections_to_tokens

# Configurable log level via environment variable
_LOG_LEVEL = os.environ.get("PRIVAMON_LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, _LOG_LEVEL, logging.INFO),
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("privamon.server")

# ---------------------------------------------------------------------------
# Bounded LRU detection cache
# ---------------------------------------------------------------------------
_CACHE_MAX_SIZE = int(os.environ.get("PRIVAMON_CACHE_SIZE", "256"))
_detection_cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()


def _cache_key(text: str, context: str) -> str:
    """SHA-256 of (text + context). Never stores raw PII in cache keys."""
    return hashlib.sha256(f"{text}|{context}".encode("utf-8")).hexdigest()


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    if key in _detection_cache:
        _detection_cache.move_to_end(key)
        return _detection_cache[key]
    return None


def _cache_put(key: str, value: Dict[str, Any]) -> None:
    _detection_cache[key] = value
    _detection_cache.move_to_end(key)
    while len(_detection_cache) > _CACHE_MAX_SIZE:
        _detection_cache.popitem(last=False)

# Global detector instances
presidio_detector: Optional[PresidioDetector] = None
gliner_detector: Optional[GLiNERDetector] = None


def get_presidio() -> PresidioDetector:
    global presidio_detector
    if presidio_detector is None:
        presidio_detector = PresidioDetector()
    return presidio_detector


def get_gliner() -> GLiNERDetector:
    global gliner_detector
    if gliner_detector is None:
        gliner_detector = GLiNERDetector.get_instance()
        gliner_detector.initialize()
    return gliner_detector


import threading

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Privamon PII Engine...")
    get_presidio()
    # Warm up GLiNER in a background thread so HTTP server socket opens immediately
    threading.Thread(target=get_gliner, daemon=True).start()
    logger.info("Privamon PII Engine server bound and listening.")
    yield
    logger.info("Privamon PII Engine shutdown.")


app = FastAPI(
    title="Privamon Local PII Engine",
    version="1.0.0",
    lifespan=lifespan
)

# Allow local browser extension origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Extension origins (chrome-extension://*)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TokenModel(BaseModel):
    text: str
    start: Optional[int] = None
    end: Optional[int] = None
    bbox: Dict[str, Any]
    confidence: Optional[float] = None


class DetectRequest(BaseModel):
    text: str = Field(..., description="Text content to scan for PII")
    tokens: Optional[List[Dict[str, Any]]] = Field(default=[], description="Optional OCR word tokens with bounding boxes")
    source: Optional[str] = Field(default="ocr", description="Source of text: 'ocr' or 'dom'")
    context: Optional[str] = Field(default="", description="Nearby context keywords or labels")


class DetectResponse(BaseModel):
    detections: List[Dict[str, Any]]
    discarded: List[Dict[str, Any]]
    engine_version: str = "1.0.0"
    processing_ms: float
    cache_hit: bool = False


class BatchDetectRequest(BaseModel):
    items: List[DetectRequest] = Field(..., max_length=20, description="Up to 20 detection requests in a single batch")


@app.get("/health")
def health_check():
    g_det = gliner_detector
    p_det = presidio_detector
    return {
        "status": "ok",
        "engine_version": "1.0.0",
        "gliner_ready": g_det.is_ready if (g_det and hasattr(g_det, "is_ready")) else False,
        "presidio_ready": p_det is not None,
        "local_only": True
    }


@app.post("/detect", response_model=DetectResponse)
def detect_pii(request: DetectRequest):
    t_start = time.perf_counter()
    raw_text = request.text or ""

    if not raw_text.strip():
        return DetectResponse(
            detections=[],
            discarded=[],
            engine_version="1.0.0",
            processing_ms=0.0
        )

    # --- Cache lookup ---
    c_key = _cache_key(raw_text, request.context or "")
    cached = _cache_get(c_key)
    if cached is not None:
        t_elapsed = round((time.perf_counter() - t_start) * 1000, 2)
        return DetectResponse(
            detections=cached["detections"],
            discarded=cached["discarded"],
            engine_version="1.0.0",
            processing_ms=t_elapsed,
            cache_hit=True
        )

    # 1. Conservative text normalization with index mapping
    norm_result = normalize_text(raw_text)
    norm_text = norm_result.normalized_text

    raw_detections = []

    # 2. Presidio Deterministic Detection
    p_det = get_presidio()
    if p_det:
        p_results = p_det.detect(norm_text, request.context)
        for d in p_results:
            # Map normalized character span back to original text span
            orig_start, orig_end = norm_result.map_span_to_original(d["start"], d["end"])
            raw_detections.append({
                **d,
                "start": orig_start,
                "end": orig_end,
                "text": raw_text[orig_start:orig_end]
            })

    # 3. GLiNER Contextual NER Detection
    g_det = get_gliner()
    if g_det and g_det.is_ready:
        g_results = g_det.detect(norm_text)
        for d in g_results:
            orig_start, orig_end = norm_result.map_span_to_original(d["start"], d["end"])
            raw_detections.append({
                **d,
                "start": orig_start,
                "end": orig_end,
                "text": raw_text[orig_start:orig_end]
            })

    # 4. Detection Fusion & Confidence Calibration
    fused_detections, discard_log = fuse_detections(raw_detections, raw_text)

    # 5. OCR Token Span Mapping (Bounding Box Generation)
    if request.tokens:
        final_detections = map_detections_to_tokens(fused_detections, request.tokens, raw_text)
    else:
        final_detections = fused_detections

    t_elapsed = round((time.perf_counter() - t_start) * 1000, 2)

    # --- Store in cache (only if no tokens — token-mapped results are position-specific) ---
    if not request.tokens:
        _cache_put(c_key, {"detections": final_detections, "discarded": discard_log})

    return DetectResponse(
        detections=final_detections,
        discarded=discard_log,
        engine_version="1.0.0",
        processing_ms=t_elapsed
    )


@app.post("/detect/batch")
def detect_pii_batch(request: BatchDetectRequest):
    """Process up to 20 detection requests in a single HTTP roundtrip."""
    results = []
    for item in request.items:
        results.append(detect_pii(item))
    return {"results": [r.dict() for r in results]}


class FaceDetectRequest(BaseModel):
    image: str = Field(..., description="Base64 or data URL of image to scan for faces")
    bbox: Optional[Dict[str, Any]] = Field(default=None, description="Optional bounding box in screenshot pixels")
    threshold: Optional[float] = Field(default=0.60, description="Confidence threshold")


face_session = None


def get_face_session():
    global face_session
    if face_session is None:
        import onnxruntime as ort
        model_path = os.path.join("lib", "onnx", "blazeface.onnx")
        if not os.path.exists(model_path):
            model_path = os.path.join("lib", "onnx", "version-RFB-320-clean.onnx")
        if not os.path.exists(model_path):
            logger.warning(f"[VisionEngine] ONNX face model not found at {model_path}. Please download it.")
            return None
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        face_session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
    return face_session


@app.post("/detect/face")
def detect_faces(request: FaceDetectRequest):
    t_start = time.perf_counter()
    import io
    import base64
    from PIL import Image
    import numpy as np

    data_url = request.image or ""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]

    try:
        raw_bytes = base64.b64decode(data_url)
        img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    except Exception as e:
        logger.error(f"[VisionEngine] Failed to decode image: {e}")
        raise HTTPException(status_code=400, detail=f"Invalid image: {str(e)}")

    orig_w, orig_h = img.size
    region_bbox = request.bbox or {"x": 0, "y": 0, "width": orig_w, "height": orig_h}

    thresh = request.threshold or 0.50
    logger.info(f"[VisionEngine] Face scan requested for image {orig_w}x{orig_h} (threshold={thresh})")

    sess = get_face_session()
    if sess is None:
        return {"faces": [], "processing_ms": 0, "error": "ONNX face model not found"}

    img_resized = img.resize((320, 240))
    arr = (np.array(img_resized, dtype=np.float32) - 127.0) / 128.0
    inp = np.transpose(arr, (2, 0, 1))[np.newaxis, ...].astype(np.float32)

    confidences, boxes = sess.run(None, {"input": inp})
    scores = confidences[0, :, 1]
    boxes = boxes[0]

    mask = scores >= thresh
    scores = scores[mask]
    boxes = boxes[mask]

    if len(scores) == 0:
        proc_time = round((time.perf_counter() - t_start) * 1000, 2)
        logger.info(f"[VisionEngine] No faces detected ({proc_time}ms)")
        return {"faces": [], "processing_ms": proc_time}

    def iou(b1, b2):
        xA = max(b1[0], b2[0])
        yA = max(b1[1], b2[1])
        xB = min(b1[2], b2[2])
        yB = min(b1[3], b2[3])
        inter = max(0, xB - xA) * max(0, yB - yA)
        areaA = (b1[2] - b1[0]) * (b1[3] - b1[1])
        areaB = (b2[2] - b2[0]) * (b2[3] - b2[1])
        return inter / max(1e-6, areaA + areaB - inter)

    order = scores.argsort()[::-1]
    keep = []
    while len(order) > 0:
        i = order[0]
        keep.append(i)
        ovr = np.array([iou(boxes[i], boxes[o]) for o in order[1:]])
        inds = np.where(ovr <= 0.3)[0]
        order = order[inds + 1]

    faces = []
    for k in keep:
        s = float(scores[k])
        b = boxes[k]
        xmin, ymin, xmax, ymax = float(b[0]), float(b[1]), float(b[2]), float(b[3])
        rx = int(region_bbox["x"] + xmin * region_bbox["width"])
        ry = int(region_bbox["y"] + ymin * region_bbox["height"])
        rw = int((xmax - xmin) * region_bbox["width"])
        rh = int((ymax - ymin) * region_bbox["height"])
        faces.append({
            "type": "face",
            "source": "vision",
            "text": "[face detected]",
            "confidence": round(s, 4),
            "bbox": {"x": rx, "y": ry, "width": rw, "height": rh},
            "boxes": [{"x": rx, "y": ry, "width": rw, "height": rh}]
        })

    proc_time = round((time.perf_counter() - t_start) * 1000, 2)
    logger.info(f"[VisionEngine] Successfully detected {len(faces)} face(s) in {proc_time}ms")
    return {
        "faces": faces,
        "processing_ms": proc_time
    }


if __name__ == "__main__":
    import uvicorn
    # Bind exclusively to localhost
    uvicorn.run("engine.server:app", host="127.0.0.1", port=8765, log_level="info")
