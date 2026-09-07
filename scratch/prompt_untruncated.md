# Agent Task Prompt: Privamon Client-Side Redaction Pipeline

You are implementing the **client-side visual redaction pipeline** for Privamon, a
Manifest V3 Chrome/Firefox extension that acts as a privacy firewall between a live
browser tab and a server-side AI agent. Your job is the **redaction quality**, not
the whole extension — assume `background.js`, the offscreen document scaffolding,
and DOM extraction already exist and are wired up.

## Hard constraints (do not violate)

1. **No terminal, no local server, no manual process the user has to start.**
   All ML inference (OCR, face detection, PII/NER) must run *inside the browser*
   — offscreen document, Web Worker, or content script — using WASM/WebGPU.
   Do not introduce a Python backend, a `localhost` fallback, or any component
   that requires `pip install` / `python app.py` / a native messaging host.
   If a model is too heavy to ship, pick a smaller quantized one instead of
   reaching for a server.
2. **Raw screenshot pixels and unredacted DOM must never leave the client.**
   Only the final sanitized artifact is allowed to cross the network boundary
   (and only later, when the server-integration step is built — not your concern
   here).
3. **Redaction must be verified, not assumed.** Every redacted region must be
   re-inspected after drawing to confirm no original pixel data survives
   (anti-aliasing bleed, sub-pixel offset, font rendering artifacts).

## What "good redaction" means for this SIH evaluation

Judges score on: (a) recall/precision of PII detection, (b) precision of the
redaction itself (tight boxes, no over/under-redaction), (c) client resource
usage, (d) end-to-end latency. Optimize for all four — don't trade one for
another silently; if you make a tradeoff, say so explicitly in comments/output.

Build (or improve) the following, in this order. Each section states the
requirement *and* the concrete implementation approach — follow the approach
unless you have a clearly better one, and say why if you deviate.

### 1. Detection — multi-modal, not regex-only

**DOM-level**
- Walk extracted DOM nodes; for each `<input>`/`<textarea>`, check
  `type` (`password`, `email`, `tel`, `number` + `cc-*` name), `autocomplete`
  attribute, and `name`/`id`/`class` against a keyword list
  (`ssn`, `aadhaar`, `cvv`, `salary`, `dob`, `pan`, `account`).
- For visible text nodes, run a single ordered set of regexes (compile once,
  reuse): email, phone (libphonenumber-js if bundle size allows, else a
  solid E.164-ish regex), credit card candidates validated with **Luhn**:
  ```js
  function luhnValid(num) {
    const digits = num.replace(/\D/g, '').split('').reverse().map(Number);
    const sum = digits.reduce((acc, d, i) =>
      acc + (i % 2 ? ((d*2>9)?d*2-9:d*2) : d), 0);
    return sum % 10 === 0;
  }
  ```
- Aadhaar: regex `\b\d{4}\s?\d{4}\s?\d{4}\b` then verify with **Verhoeff**
  (implement the standard multiplication/permutation/inverse tables — this
  is a well-known ~30-line algorithm, don't hand-roll a weaker check).
- PAN: regex `[A-Z]{5}[0-9]{4}[A-Z]` — no checksum exists, so DOM/label
  context (nearby "PAN" label text) is what pushes confidence up.
- Every match → build a `DetectionCandidate` immediately with `source:'dom'`,
  `bbox` from `getBoundingClientRect()` (or the range-mapper's per-token
  rects for wrapped/inline text), and a `confidence` (1.0 for
  checksum-validated, ~0.7 for pattern-only, boosted if label text nearby
  matches a keyword).

**OCR-level**
- Only run OCR on regions flagged in Stage 2 (pixel-bearing elements above
  a size threshold) — never the full viewport, that's your biggest latency
  cost.
- Crop each candidate region onto a small offscreen `<canvas>`, pass its
  `toDataURL()`/`ImageBitmap` into a **persistent** Tesseract.js worker
  (`createWorker({ langPath: 'lib/tesseract/', workerPath: ... })` loaded
  once, reused across regions — recreating workers per-region is a common
  and expensive mistake).
- Load `eng` + `hin` traineddata; get word-level output via
  `worker.recognize(image, { rectangle })` and read `data.words[i].bbox`,
  `data.words[i].confidence`, `data.words[i].text`.
- Feed each word/line of OCR text through the *same* regex/NER function
  used for DOM text (factor it into one shared `detectPII(text)` module so
  DOM and OCR never diverge in what they flag) — tag results `source:'ocr'`.

**Vision-level (faces)**
- Preprocess each candidate image region to the model's expected tensor
  (BlazeFace: 128×128; UltraFace/`version-RFB-320`: 320×240), normalize per
  the model's documented mean/std.
- Run via `ort.InferenceSession.create(modelPath, { executionProviders:
  ['webgpu','wasm'] })` — always list `wasm` as fallback since WebGPU
  support is inconsistent across judges' machines.
- Decode output boxes + scores, apply **NMS** (IoU threshold ~0.3) to
  collapse duplicate detections, scale boxes back to the crop's original
  pixel size, then to viewport-relative, `source:'vision'`.

**NER-level (catches what regex can't — names, addresses)**
- Use Transformers.js with a small quantized token-classification model
  (e.g. a distilled BERT-NER, int8/q8 build) run via WASM/WebGPU backend:
  ```js
  import { pipeline } from '@xenova/transformers';
  const ner = await pipeline('token-classification', 'Xenova/bert-base-NER',
    { quantized: true });
  const entities = await ner(text);
  ```
- Run this over concatenated DOM text + OCR text (batched, not per-node, to
  amortize model overhead), map returned character offsets back to bounding
  boxes via the DOM range-mapper's token IDs (for DOM text) or Tesseract's
  word boxes (for OCR text).
- Load the model once, lazily, on first `startAnalysis` call; cache the
  downloaded weights in IndexedDB (Transformers.js does this by default via
  its own cache — don't disable it).

Every candidate, regardless of source, must be normalized into the shared
`DetectionCandidate` shape before moving on — write one `toCandidate()`
helper all four detectors call, so fusion never has to special-case sources.

### 2. Coordinate fusion

- Convert every candidate's bbox into physical screenshot pixels using the
  scale factors already defined in your coordinate-mapper
  (`scaleX = screenshotWidth / cssViewportWidth`, same for Y) — do this
  once per candidate immediately after detection, not lazily in fusion.
- Sort candidates, then pairwise-compare boxes (spatial bucketing/grid if
  candidate count is large, to avoid O(n²) on busy pages) and compute IoU:
  ```js
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x+a.width, b.x+b.width);
    const y2 = Math.min(a.y+a.height, b.y+b.height);
    const inter = Math.max(0, x2-x1) * Math.max(0, y2-y1);
    const union = a.width*a.height + b.width*b.height - inter;
    return union > 0 ? inter/union : 0;
  }
  ```
- Merge any pair with `iou > 0.4` or full containment into one cluster;
  the merged candidate keeps the **union bbox**, the **highest-confidence
  label**, and a `source` array listing every contributing modality
  (agreement across sources should *raise* confidence, not just pick one).
- Assign `decision`: `REDACT` if confidence ≥ 0.8 (or checksum-validated),
  `REVIEW` if 0.4–0.8, `KEEP` below that — make these thresholds named
  constants, not magic numbers, so they're easy to tune during testing.

### 3. Redaction

- Load the raw screenshot into a **new** canvas (don't touch the one still
  needed for the before/after UI):
  ```js
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ```
- For every `REDACT` candidate: `ctx.fillStyle = '#000000'; ctx.fillRect(x, y,
  width, height);` — solid fill only, no blur/pixelate for text/PII (blur is
  reversible via deconvolution and shouldn't be presented as "redaction" to
  judges). Faces may optionally get a blur *preview* but ship a solid-fill
  mode as the default/audited one.
- Export with `canvas.toDataURL('image/png')` once all boxes for the frame
  are drawn — don't re-export per box, that's wasted work.

### 4. Verification (do not skip this — it's a named eval criterion)

- Re-draw the sanitized canvas into an `ImageData`-readable context, then
  for each redacted box:
  ```js
  const data = ctx.getImageData(x, y, width, height).data;
  let clean = true;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0 || data[i+3] !== 255) {
      clean = false; break;
    }
  }
  ```
- If `clean` is false, expand the box 25% in each direction
  (`x -= width*0.125; y -= height*0.125; width *= 1.25; height *= 1.25;`
  clamped to canvas bounds), re-fill, re-check. Cap retries at 3; if still
  dirty, push a warning string (`"box #12 failed verification after 3
  expansions"`) instead of looping forever.
- Track `reRedactedCount` and set `verificationPassed = warnings.length === 0`.

### 5. Performance budget

- Downscale (e.g. `createImageBitmap(img, {resizeWidth, resizeHeight})`) for
  the OCR/vision detection passes only — always redact on the full-res
  canvas so box edges stay accurate.
- Kick off OCR and face-detection as **parallel** Web Workers/promises over
  independent region sets (`Promise.all([runOCR(regions), runVision(regions)])`)
  instead of awaiting them sequentially — they don't depend on each other's
  output, only fusion does.
- Initialize Tesseract worker, ONNX session, and the Transformers.js
  pipeline **once**, lazily, on first use; keep them alive in the offscreen
  document for the session rather than recreating per run.
- Wrap each pipeline stage with `performance.now()` timing and push into
  the `timings` object — this is what you'll show live to judges as your
  latency evidence, so make it real, not decorative.

## Output contract

Return a single pipeline result object (extend if useful, don't remove
fields):

```typescript
interface RedactionResult {
  sanitizedScreenshot: string;   // base64 PNG, solid-fill redactions applied
  detections: DetectionCandidate[]; // all candidates with decision + source
  verificationPassed: boolean;
  reRedactedCount: number;
  warnings: string[];
  timings: Record<string, number>; // per stage, ms
}
```

## Deliverable

Working code for: detection (DOM + OCR + vision + NER), fusion, redaction,
and verification stages, runnable entirely inside the extension's offscreen
document with zero external processes. Include brief inline comments
explaining any accuracy/latency/resource tradeoff you made, since that's
something I'll need to defend to evaluators.
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-09-06T21:13:33+05:30.

The user's current state is as follows:
Active Document: /home/mishrazi/ProjectContributed/Privamon/localreadme.md (LANGUAGE_MARKDOWN)
Cursor is on line: 444
Other open documents:
- /home/mishrazi/ProjectContributed/Privamon/localreadme.md (LANGUAGE_MARKDOWN)
Running terminal commands:
- uvicorn main:app --reload --port 8000 (in /home/mishrazi/ProjectContributed/Privamon/server_side_agent, running for 21m21s)
</ADDITIONAL_METADATA>