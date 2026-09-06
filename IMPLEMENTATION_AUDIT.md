# Privamon — Full Repository Audit (Phase 0)

**Date**: 2026-09-04  
**Status**: Completed  
**Objective**: Comprehensive inspection of the existing Privamon repository, data structures, and pipeline tracing prior to any code modification.

---

## 1. Current Architecture

Privamon is currently implemented as a **Google Chrome Extension (Manifest V3)** with the following execution model:

1. **Popup UI (`popup.html` / `popup.js`)**: User initiates an analysis task. It sends `startAnalysis` to the background service worker.
2. **Background Service Worker (`background.js`)**:
   - Takes a synchronous viewport snapshot using `chrome.tabs.captureVisibleTab(null, { format: 'png' })`.
   - Injects `content/dom-extractor.js` into the active tab to extract interactive and semantic DOM elements plus pixel-bearing elements (`<img>`, `<canvas>`, etc.).
   - Ensures an offscreen document (`offscreen/offscreen.html`) is active.
   - Posts `runPipeline` message containing the raw screenshot data URL and extracted `domData`.
3. **Offscreen Document (`offscreen/offscreen.html` / `offscreen/offscreen.js`)**:
   - Hosts the long-running client-side computational pipeline (`Privamon.SanitizePipeline.run`).
   - Has access to DOM APIs (Canvas, Image, Web Workers) not available in MV3 service workers.
4. **Execution Pipeline (`pipeline/sanitize-pipeline.js`)**:
   ```
   Screenshot + DOM Data
            │
            ▼
   Stage 1: DOM PII Detection (regex & semantic attributes)
            │
            ▼
   Stage 2: Pixel Region Selection (heuristics on size/tags)
            │
            ▼
   Stage 3: OCR Processing (Tesseract.js WASM on cropped regions)
            │
            ▼
   Stage 4: Vision Analysis (BlazeFace face detection via ONNX Runtime Web)
            │
            ▼
   Stage 5: PII Fusion (IoU & containment bbox deduplication)
            │
            ▼
   Stage 6: Coordinate Mapping (CSS viewport -> screenshot pixels)
            │
            ▼
   Stage 7: Redaction (Canvas opaque black rectangle fill)
            │
            ▼
   Stage 8: Verification (Monochrome pixel sampling & re-redaction)
            │
            ▼
   Stage 9: DOM Sanitization (Redact PII in DOM text/values)
            │
            ▼
   Store results in chrome.storage.session -> open results.html
   ```

---

## 2. Relevant Files

| File | Role | Status / Action |
|------|------|-----------------|
| `manifest.json` | Extension manifest (MV3 permissions, CSP, resources) | Needs `host_permissions` for localhost/127.0.0.1 to query local Python service |
| `package.json` | Node dependencies (`tesseract.js`, `onnxruntime-web`) | Add npm script/config for engine startup |
| `background.js` | Service worker orchestrating screenshot, DOM injection, offscreen messaging | Preserve core orchestration |
| `offscreen/offscreen.html` | Offscreen document loading vendor scripts and privacy modules | Add script bridge if needed |
| `offscreen/offscreen.js` | Controller receiving pipeline requests and relaying progress | Preserve |
| `content/dom-extractor.js` | Extracts DOM elements, viewport coordinates, and pixel regions | Preserve; already handles viewport-relative coordinates |
| `pipeline/sanitize-pipeline.js` | Orchestrator running stages 1 through 9 | Enhance tracing and route OCR blocks through engine |
| `vision/ocr-engine.js` | Tesseract.js wrapper, crop extraction, word bounding boxes | Modify text reconstruction and token-to-span mapping |
| `vision/vision-model.js` | Abstract registry for vision models | Preserve |
| `vision/face-detector.js` | BlazeFace face detection via ONNX | Preserve |
| `privacy/pii-detector.js` | Regex-based detector and HTML semantic detector | Add Indian PII regexes + async bridge to Python service |
| `privacy/pii-classifier.js` | Extensible classifier interface | Preserve / integrate |
| `privacy/fusion.js` | IoU deduplication and bbox merging | Enhance fusion rules, provenance tracking, and discard logging |
| `privacy/coordinate-mapper.js` | Derives scale factors between CSS viewport and screenshot pixels | Preserve (vital for alignment) |
| `privacy/redactor.js` | Canvas-based opaque black rectangle fill | Preserve (tested and working) |
| `privacy/verifier.js` | Post-redaction opacity verification and 25% expansion re-redaction | Preserve |
| `dom/sanitized-dom.js` | Strips detected PII from extracted DOM elements | Preserve |
| `popup.html`, `popup.js`, `popup.css` | Extension user interface | Preserve |
| `results.html`, `results.js`, `results.css` | Results review interface | Preserve |

---

## 3. Current OCR Data Structure

In `vision/ocr-engine.js`:
- Words returned by Tesseract worker:
  ```javascript
  {
    text: w.text,                     // Raw OCR string (e.g. "Rahul")
    confidence: w.confidence / 100,  // Normalized 0.0 - 1.0
    bbox: {
      x: regionBbox.x + w.bbox.x0,   // Mapped to screenshot coordinate space
      y: regionBbox.y + w.bbox.y0,
      width: w.bbox.x1 - w.bbox.x0,
      height: w.bbox.y1 - w.bbox.y0
    },
    source: 'ocr'
  }
  ```
- Current text reconstruction:
  ```javascript
  const regionText = ocrResults.map(r => r.text).join(' ');
  ```
  *Deficiency*: Naive `join(' ')` strips line breaks, vertical structure, and character-level alignment.

---

## 4. Current PII Data Structure

### Detection Object produced by `PIIDetector.detectInText`:
```javascript
{
  type: 'phone',                      // Pattern type name
  text: '+919876543210',              // Matched substring
  confidence: 0.80,                   // Base confidence + optional context boost (0.35)
  source: 'ocr',                      // 'dom' | 'ocr'
  span: {
    start: 25,                        // Character offset in reconstructed string
    end: 39
  },
  patternName: 'phone_indian'
}
```

### Detection Object after OCR Token Bounding Box Attachment (in `ocr-engine.js`):
```javascript
{
  type: 'phone',
  text: '+919876543210',
  confidence: 0.80,
  source: 'ocr',
  span: { start: 25, end: 39 },
  patternName: 'phone_indian',
  bbox: { x: 120, y: 350, width: 210, height: 28 }, // Bounding box union
  coordinateSpace: 'screenshot'
}
```

### Final Common Representation after Fusion (`fusion.js`):
```javascript
{
  type: 'phone',
  source: 'ocr',
  text: '+919876543210',
  bbox: { x: 120, y: 350, width: 210, height: 28 },
  confidence: 0.80,
  elementId: null,
  reason: null,
  coordinateSpace: 'screenshot',
  mergedSources: ['ocr']
}
```

---

## 5. Current Fusion Behavior

In `privacy/fusion.js`:
- Filters `confidence >= 0.3` and existence of `bbox`.
- Sorts descending by `confidence`.
- Deduplication using IoU (`IOU_THRESHOLD = 0.4`) and bounding box containment (`contains(outer, inner)`).
- When two bounding boxes overlap or enclose each other:
  - Bboxes are merged into an enclosing rectangle: `mergeBboxes(a, b)`.
  - Confidence is set to `Math.max(current.confidence, other.confidence)`.
  - Specific type preferred if one detection is `'other'`.
  - Merged sources appended to `mergedSources`.
- *Deficiencies*:
  - No entity type normalization (`PER` vs `person` vs `name`).
  - No evidence combination (simply takes `Math.max`, ignoring consensus).
  - Multi-line entities merged into a single huge rectangle covering intervening text.
  - Discarded detections are silently dropped without structured logging.

---

## 6. Current Redaction Behavior

In `privacy/redactor.js`:
- Loads screenshot onto an HTML5 Canvas at native pixel resolution.
- Adds `DEFAULT_PADDING = 4` px around each bounding box.
- Redacts by filling an opaque black rectangle (`#000000`) via `ctx.fillRect(rx, ry, rw, rh)`.
- Verified by `privacy/verifier.js`:
  - Samples 200 pixels across the redacted area to ensure monochrome consistency.
  - If non-uniform pixels exist, expands the bbox by 25% with 8px padding and re-applies redaction once.
- *Status*: Redaction mechanism is sound and should be preserved intact.

---

## 7. Current Coordinate Mapping

In `privacy/coordinate-mapper.js`:
- Viewport and screenshot are both viewport-relative (no scroll offset subtraction required).
- Derives scale factors:
  - `scaleX = screenshotDims.width / viewportInfo.cssViewportWidth`
  - `scaleY = screenshotDims.height / viewportInfo.cssViewportHeight`
- Detections originating from DOM elements (`coordinateSpace === 'css-viewport'`) are scaled by `(scaleX, scaleY)`.
- Detections originating from OCR or Vision (`coordinateSpace === 'screenshot'`) are passed through unchanged.
- *Status*: Verified mathematically and empirically correct.

---

## 8. Existing Fallback Behavior

- If Tesseract worker fails or times out (25s), `recognizeRegion` catches the error, calls `terminate()`, and returns `[]`.
- If BlazeFace model is missing or ONNX fails, it logs a warning and returns `[]`.
- In `sanitize-pipeline.js`, if OCR returns 0 detections, `mappedDetections` is empty and the original screenshot is returned unchanged.
- *Deficiency*: When OCR detects text that cannot be parsed by regex (e.g. names, addresses), the pipeline reports "No PII detected" and leaves sensitive text exposed.

---

## 9. Current Test Coverage

- **Automated Tests**: None exist in the repository. No test runner (Jest/Mocha/Pytest) configured.
- **Test HTML**: `test.html` exists with a placeholder image, but lacks realistic test documents.

---

## 10. Identified Failure Points

1. **Complete Absence of Contextual NER**:
   - `privacy/pii-detector.js` only contains regexes for structured identifiers (Email, Phone, CC, PAN, Aadhaar, IP, Passport, IFSC, JWT, API Key, OTP, Coordinates, DOB).
   - There are **no recognizers for PERSON names, ADDRESSES, LOCATIONS, ORGANIZATIONS, or USERNAMES**.
   - Any screenshot or image containing a person's name or street address (e.g. WhatsApp messages, letters, ID cards) produces 0 detections.
2. **Missing India-Specific Recognizers**:
   - Missing recognizers for: UPI IDs (`*@okhdfcbank`, `*@upi`), GSTIN, Voter ID (EPIC), Driving Licence, Bank Account numbers, Vehicle Registration numbers.
   - Aadhaar validation only checks 12 digits and non-zero/one start; it lacks Verhoeff checksum validation.
3. **Naive OCR Text Joining**:
   - `ocrResults.map(r => r.text).join(' ')` flattens all lines into a single line separated by single spaces.
   - Layout, line breaks, and relative spacing are discarded, breaking multi-line patterns.
4. **Bounding Box Multi-Line Collapse**:
   - In `ocr-engine.js`, overlapping words for a detected span are merged using `min(x), min(y), max(x), max(y)`.
   - If an entity spans two lines, this forms a giant box redacting everything between line 1 and line 2.
5. **False Positives on Loose Digits**:
   - Standalone 10-digit or 12-digit strings (Order IDs, Invoice IDs, Reference Numbers, PIN codes) risk false-positive detection or false-negative omission due to lack of contextual validation.
6. **Lack of Traceability & Discard Logging**:
   - Detections dropped during confidence filtering or fusion leave no trace, making it impossible to diagnose why a detected element was not redacted.

---

## 11. Minimal Files Requiring Modification

To resolve the root causes while adhering to minimal invasiveness:

1. **`manifest.json`**: Add `host_permissions: ["http://127.0.0.1/*", "http://localhost/*"]` to permit the extension to communicate with the local Python service.
2. **`vision/ocr-engine.js`**:
   - Preserve line structure during text reconstruction.
   - Maintain precise character-to-token span mapping.
   - Query local PII engine (with fallback to client-side detector).
   - Generate segmented per-line bounding boxes for multi-line entities.
3. **`privacy/pii-detector.js`**:
   - Add missing India-specific regexes with Verhoeff/Luhn checksums.
   - Integrate asynchronous query to local Python engine.
   - Keep synchronous regex engine as instant offline fallback.
4. **`privacy/fusion.js`**:
   - Standardize entity types.
   - Combine evidence from multiple detectors.
   - Add structured discard logging.
5. **`pipeline/sanitize-pipeline.js`**:
   - Add structured logging at every stage boundary.
6. **New `engine/` directory**:
   - Python FastAPI local service (`127.0.0.1:8765`) hosting Presidio (deterministic + India recognizers) and GLiNER (`urchade/gliner_multi_pii-v1`).
7. **New `tests/` directory**:
   - Comprehensive test suite for structured PII, contextual PII, false positives, OCR corruption, and end-to-end image redaction.
