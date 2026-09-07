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
unless you have a clearly better one, and say why if you devi
<truncated 7201 bytes>
redact on the full-res
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