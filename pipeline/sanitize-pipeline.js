/**
 * Privamon — Master Client-Side Visual Redaction Pipeline
 *
 * Implements the 100% in-browser visual sanitization pipeline.
 * Runs inside the offscreen document environment (Canvas, Web Workers, WASM, WebGPU).
 *
 * Pipeline Flow:
 *   1. Synchronous Viewport Mapping: maps CSS coordinates to physical screenshot pixels
 *   2. DOM PII Detection: regexes with Luhn/Verhoeff + input semantics
 *   3. Selective Pixel Region Identification: filters images/canvas candidates
 *   4. Parallel OCR & Vision Execution: Tesseract.js (eng+hin) + UltraFace (ONNX)
 *   5. In-Browser NER: Transformers.js token classification (quantized bert-base-NER)
 *   6. Multi-Modal Fusion: spatial grid indexing, IoU clustering, agreement boost, thresholding
 *   7. Canvas Redaction: fresh canvas solid-fill (#000000)
 *   8. Post-Redaction Verification: pixel inspection, 25% expansion retry loop, audit warnings
 *   9. DOM Sanitization: token replacement in extracted DOM tree
 *
 * Conforms strictly to the RedactionResult contract:
 * {
 *   sanitizedScreenshot: string,
 *   detections: DetectionCandidate[],
 *   verificationPassed: boolean,
 *   reRedactedCount: number,
 *   warnings: string[],
 *   timings: Record<string, number>
 * }
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.SanitizePipeline = (() => {
  'use strict';

  /**
   * Reads image dimensions from a Data URL.
   */
  function getImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => reject(new Error('Failed to load image for dimension resolution'));
      img.src = dataUrl;
    });
  }

  /**
   * Executes the full client-side visual redaction pipeline.
   *
   * @param {Object} params
   * @param {string} params.screenshot - Raw screenshot data URL
   * @param {Object} params.domData - Output from dom-extractor
   * @param {Function} [params.onProgress] - Callback for stage progress
   * @returns {Promise<Object>} RedactionResult object
   */
  async function run({ screenshot, domData, onProgress }) {
    const pipelineStart = performance.now();
    const timings = {};
    const warnings = [];

    const progress = (stageId, status, statusText) => {
      if (typeof onProgress === 'function') {
        onProgress(stageId, status, statusText);
      }
    };

    // ── 1. Image Dimensions & Coordinate Mapping Setup ──
    const screenshotDims = await getImageDimensions(screenshot);
    const mapper = Privamon.CoordinateMapper.create(domData.viewportInfo, screenshotDims);

    // ── 2. Stage: DOM PII Detection ──
    progress('domPii', 'active', 'Scanning DOM elements for sensitive patterns...');
    const tDomStart = performance.now();

    // Map and detect DOM candidates directly in screenshot pixel space
    const domCandidates = Privamon.PIIDetector.detectDOMBatch(domData.elements, mapper);

    // ── Cross-Element Confirmed User Identifier & Name Propagation ──
    // If a user identifier (such as roll number, student ID, username) or person name was confirmed in an input or high-confidence match,
    // ensure any exact occurrences across table cells, navbars, badges, and headers are also redacted.
    const confirmedIdentifiers = new Set();
    const confirmedNames = new Set();

    if (domData.elements && Array.isArray(domData.elements)) {
      for (const el of domData.elements) {
        // Headers are never data sources
        if (el.isHeader || el.tag === 'th') continue;

        // Collect from sensitive / credential / search inputs
        if (el.value) {
          const val = el.value.trim();
          const isSens = el.isSensitiveType || el.sensitiveNameMatch || el.definitelySensitive
            || /roll|student|user|login|enroll|reg|account/i.test(el.label || el.name || el.id || el.placeholder || '');
          if (isSens && val.length >= 4 && !val.includes(' ') && /\d/.test(val)) {
            confirmedIdentifiers.add(val);
          }
        }
        // Collect from table cells under RollNo / Student ID columns
        if (el.text && el.label && /roll|student\s*id|enroll|reg\s*no/i.test(el.label)) {
          const val = el.text.trim();
          if (val.length >= 6 && val.length <= 25 && /\d/.test(val) && !/roll/i.test(val)) {
            confirmedIdentifiers.add(val);
          }
        }
        // Collect from table cells under Name / FirstName columns
        if (el.text && el.label && /first\s*name|firstname|last\s*name|lastname|full\s*name|student\s*name/i.test(el.label)) {
          const val = el.text.trim();
          const isHeaderWord = /^(?:first\s*name|firstname|last\s*name|lastname|full\s*name|fullname|name|student|update|successful|unsuccessful|initiated|shipped|upi|payment|h)$/i.test(val);
          if (val.length >= 2 && val.length <= 40 && !isHeaderWord) {
            confirmedNames.add(val);
          }
        }
      }
    }

    for (const cand of domCandidates) {
      if (cand.confidence >= 0.80) {
        if (cand.type === 'username' || cand.type === 'password' || cand.type === 'aadhaar' || cand.type === 'pan') {
          const val = (cand.originalValue || (cand.text !== '[MASKED VALUE]' ? cand.text : '')).trim();
          if (val && val.length >= 4 && !val.includes(' ') && /\d/.test(val)) {
            confirmedIdentifiers.add(val);
          }
        } else if (cand.type === 'name') {
          const val = (cand.text || '').trim();
          const isHeaderWord = /^(?:home|dashboard|result|update|search|firstname|first\s*name|lastname|last\s*name|fullname|full\s*name|name)$/i.test(val);
          if (val && val.length >= 3 && !isHeaderWord) {
            confirmedNames.add(val);
          }
        }
      }
    }

    if ((confirmedIdentifiers.size > 0 || confirmedNames.size > 0) && domData.elements && Array.isArray(domData.elements)) {
      for (const el of domData.elements) {
        if (el.isContainer || el.isHeader || el.tag === 'th' || !el.text) continue;
        const elText = el.text;

        // Propagate confirmed identifiers (RollNo, Student IDs, Usernames)
        for (const idVal of confirmedIdentifiers) {
          const idx = elText.indexOf(idVal);
          if (idx !== -1) {
            const alreadyIn = domCandidates.some(c => c.elementId === (el.elementId || el.id) && c.text === idVal);
            if (!alreadyIn) {
              let targetBbox = mapper.mapBbox(el.bbox);
              let targetBoxes = [targetBbox];

              if (el.tokens && el.tokens.length > 0) {
                const spanTokens = el.tokens.filter(t => t.start < idx + idVal.length && t.end > idx);
                if (spanTokens.length > 0) {
                  const mappedBxs = spanTokens.map(t => mapper.mapBbox(t.bbox));
                  const minX = Math.min(...mappedBxs.map(b => b.x));
                  const minY = Math.min(...mappedBxs.map(b => b.y));
                  const maxX = Math.max(...mappedBxs.map(b => b.x + b.width));
                  const maxY = Math.max(...mappedBxs.map(b => b.y + b.height));
                  targetBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
                  targetBoxes = mappedBxs;
                }
              }

              domCandidates.push(Privamon.PIIDetector.toCandidate({
                type: 'username',
                source: 'dom',
                text: idVal,
                bbox: targetBbox,
                boxes: targetBoxes,
                confidence: 0.95,
                elementId: el.elementId || el.id || null,
                reason: 'propagated_identifier',
                coordinateSpace: 'screenshot'
              }));
            }
          }
        }

        // Propagate confirmed names (FirstName, Student Names)
        for (const nameVal of confirmedNames) {
          const idx = elText.indexOf(nameVal);
          if (idx !== -1) {
            const alreadyIn = domCandidates.some(c => c.elementId === (el.elementId || el.id) && c.text === nameVal);
            if (!alreadyIn) {
              let targetBbox = mapper.mapBbox(el.bbox);
              let targetBoxes = [targetBbox];

              if (el.tokens && el.tokens.length > 0) {
                const spanTokens = el.tokens.filter(t => t.start < idx + nameVal.length && t.end > idx);
                if (spanTokens.length > 0) {
                  const mappedBxs = spanTokens.map(t => mapper.mapBbox(t.bbox));
                  const minX = Math.min(...mappedBxs.map(b => b.x));
                  const minY = Math.min(...mappedBxs.map(b => b.y));
                  const maxX = Math.max(...mappedBxs.map(b => b.x + b.width));
                  const maxY = Math.max(...mappedBxs.map(b => b.y + b.height));
                  targetBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
                  targetBoxes = mappedBxs;
                }
              }

              domCandidates.push(Privamon.PIIDetector.toCandidate({
                type: 'name',
                source: 'dom',
                text: nameVal,
                bbox: targetBbox,
                boxes: targetBoxes,
                confidence: 0.95,
                elementId: el.elementId || el.id || null,
                reason: 'propagated_name',
                coordinateSpace: 'screenshot'
              }));
            }
          }
        }
      }
    }

    timings.domPiiDetection = Math.round(performance.now() - tDomStart);
    progress('domPii', 'done', `Found ${domCandidates.length} DOM candidates`);

    // ── 3. Stage: Pixel Region Selection ──
    progress('pixelId', 'active', 'Filtering pixel-bearing candidates...');
    const tPixelStart = performance.now();

    const allPixelRegions = domData.pixelRegions || [];
    const ocrRegions = Privamon.OCREngine.selectRegionsForOCR(allPixelRegions, domData.viewportInfo);
    
    // Prioritize largest candidate regions for closeup face analysis, cap at 6
    const candidateVision = allPixelRegions.filter(Privamon.FaceDetector.shouldProcess);
    candidateVision.sort((a, b) => {
      const areaA = (a.bbox?.width || 0) * (a.bbox?.height || 0);
      const areaB = (b.bbox?.width || 0) * (b.bbox?.height || 0);
      return areaB - areaA;
    });
    const visionRegions = candidateVision.slice(0, 6);

    timings.pixelIdentification = Math.round(performance.now() - tPixelStart);
    progress('pixelId', 'done', `OCR: ${ocrRegions.length}, Vision: ${visionRegions.length}`);

    // ── 4. Stage: Parallel OCR & Vision Analysis ──
    // Both passes run over independent region sets and are launched in parallel
    progress('ocr', 'active', 'Running parallel OCR and face detection...');
    progress('vision', 'active', 'Running vision analysis...');
    const tParallelStart = performance.now();

    const [ocrOutput, visionCandidates] = await Promise.all([
      // OCR Pass
      (async () => {
        const t0 = performance.now();
        const res = await Privamon.OCREngine.processRegions(screenshot, ocrRegions, mapper);
        timings.ocr = Math.round(performance.now() - t0);
        return res;
      })(),
      // Vision Pass: run both per-region and full-screenshot face detection
      (async () => {
        const t0 = performance.now();
        const allFaces = [];

        // Per-region detection (high-resolution closeups of DOM images)
        try {
          const regionFaces = await Privamon.FaceDetector.processRegions(screenshot, visionRegions, mapper);
          if (regionFaces && regionFaces.length > 0) {
            allFaces.push(...regionFaces);
          }
        } catch (e) {
          console.warn('[Pipeline] Per-region face detection failed:', e.message);
        }

        // Adaptive multi-scale tiled face detection for high small-face recall.
        // Splits the viewport into balanced overlapping tiles so faces remain high-res in ONNX inference.
        try {
          const sw = screenshotDims.width;
          const sh = screenshotDims.height;
          const overlapFrac = 0.20; // 20% overlap between tiles
          const cols = sw > 1200 ? 3 : 2;
          const rows = sh > 800 ? 2 : 2;

          const tileW = Math.ceil(sw / (cols - (cols - 1) * overlapFrac));
          const tileH = Math.ceil(sh / (rows - (rows - 1) * overlapFrac));
          const stepX = Math.floor(tileW * (1 - overlapFrac));
          const stepY = Math.floor(tileH * (1 - overlapFrac));

          const tiles = [];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const tx = Math.min(c * stepX, sw - 60);
              const ty = Math.min(r * stepY, sh - 60);
              const tw = Math.min(tileW, sw - tx);
              const th = Math.min(tileH, sh - ty);
              if (tw > 60 && th > 60) {
                tiles.push({ x: tx, y: ty, width: tw, height: th });
              }
            }
          }

          // Also scan the full screenshot as a catch-all for large foreground faces
          tiles.push({ x: 0, y: 0, width: sw, height: sh });

          for (const tile of tiles) {
            try {
              const cropUrl = await Privamon.Redactor.extractRegion(screenshot, tile);
              const tileFaces = await Privamon.FaceDetector.detect(cropUrl, tile);
              if (tileFaces && tileFaces.length > 0) {
                for (const face of tileFaces) {
                  let merged = false;
                  for (const existing of allFaces) {
                    if (!existing.bbox || !face.bbox) continue;
                    const ix1 = Math.max(existing.bbox.x, face.bbox.x);
                    const iy1 = Math.max(existing.bbox.y, face.bbox.y);
                    const ix2 = Math.min(existing.bbox.x + existing.bbox.width, face.bbox.x + face.bbox.width);
                    const iy2 = Math.min(existing.bbox.y + existing.bbox.height, face.bbox.y + face.bbox.height);
                    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
                    const a1 = existing.bbox.width * existing.bbox.height;
                    const a2 = face.bbox.width * face.bbox.height;
                    const union = a1 + a2 - inter;
                    const iou = union > 0 ? inter / union : 0;
                    const containment = Math.min(a1, a2) > 0 ? inter / Math.min(a1, a2) : 0;

                    if (iou > 0.30 || containment > 0.60) {
                      // Expand existing box to encompass full detection union
                      const ux1 = Math.min(existing.bbox.x, face.bbox.x);
                      const uy1 = Math.min(existing.bbox.y, face.bbox.y);
                      const ux2 = Math.max(existing.bbox.x + existing.bbox.width, face.bbox.x + face.bbox.width);
                      const uy2 = Math.max(existing.bbox.y + existing.bbox.height, face.bbox.y + face.bbox.height);
                      existing.bbox = { x: ux1, y: uy1, width: ux2 - ux1, height: uy2 - uy1 };
                      existing.boxes = [existing.bbox];
                      existing.confidence = Math.max(existing.confidence, face.confidence);
                      merged = true;
                      break;
                    }
                  }
                  if (!merged) {
                    allFaces.push(face);
                  }
                }
              }
            } catch (tileErr) {
              // Non-fatal: individual tile inference failure
            }
          }
        } catch (e) {
          console.warn('[Pipeline] Tiled face detection failed:', e.message);
        }

        timings.vision = Math.round(performance.now() - t0);
        return allFaces;
      })()
    ]);

    timings.parallelVisionAndOcr = Math.round(performance.now() - tParallelStart);
    progress('ocr', 'done', `OCR found ${ocrOutput.detections.length} matches`);
    progress('vision', 'done', `Vision detected ${visionCandidates.length} faces`);

    const ocrCandidates = ocrOutput.detections || [];
    const ocrWords = ocrOutput.words || [];
    const ocrRawText = ocrOutput.rawText || '';

    // ── 5. Stage: In-Browser NER (Transformers.js Token Classification) ──
    progress('ner', 'active', 'Running in-browser NER over batched text...');
    const tNerStart = performance.now();
    let nerCandidates = [];

    try {
      // Gather text nodes and OCR lines for batched NER
      const itemsForNER = [];

      // Add text-bearing DOM elements (skip structural containers)
      if (domData.elements && Array.isArray(domData.elements)) {
        for (const el of domData.elements) {
          if (el.isContainer) continue;
          const upperTag = (el.tag || '').toUpperCase();
          if (upperTag === 'BUTTON' || upperTag === 'SVG' || upperTag === 'PATH' || el.role === 'button') continue;
          if (el.text && el.text.trim().length > 2) {
            const mappedTokens = (el.tokens || []).map(t => ({
              ...t,
              bbox: mapper.mapBbox(t.bbox),
              boxes: (t.boxes || []).map(b => mapper.mapBbox(b))
            }));
            itemsForNER.push({
              text: el.text,
              tokens: mappedTokens,
              source: 'dom',
              label: el.label || '',
              bbox: mapper.mapBbox(el.bbox),
              elementId: el.elementId || el.id,
              coordinateSpace: 'screenshot'
            });
          }
        }
      }

      // Add OCR recognized lines
      if (ocrOutput.itemsForNER && Array.isArray(ocrOutput.itemsForNER)) {
        itemsForNER.push(...ocrOutput.itemsForNER);
      }

      if (itemsForNER.length > 0 && Privamon.NEREngine) {
        nerCandidates = await Privamon.NEREngine.detectEntities(itemsForNER, mapper);
      }
    } catch (nerErr) {
      console.warn('[Pipeline] In-browser NER failed gracefully:', nerErr.message);
      warnings.push(`NER skipped: ${nerErr.message}`);
    }

    timings.ner = Math.round(performance.now() - tNerStart);
    progress('ner', 'done', `NER extracted ${nerCandidates.length} entities`);

    progress('coordMap', 'done');

    // ── 6. Stage: Multi-Modal Coordinate Fusion ──
    progress('fusion', 'active', 'Merging multi-modal detections in screenshot space...');
    const tFusionStart = performance.now();

    const rawCandidates = [
      ...domCandidates,
      ...ocrCandidates,
      ...visionCandidates,
      ...nerCandidates
    ];

    const fusionResult = Privamon.PIIFusion.fuse(rawCandidates);
    timings.fusion = Math.round(performance.now() - tFusionStart);
    progress('fusion', 'done', `Fused: ${fusionResult.redactions.length} REDACT, ${fusionResult.reviews.length} REVIEW`);

    // ── 7. Stage: Canvas Redaction ──
    progress('redaction', 'active', 'Applying solid-fill redactions...');
    const tRedactStart = performance.now();

    const redactionResult = await Privamon.Redactor.redact(screenshot, fusionResult.redactions);
    timings.redaction = Math.round(performance.now() - tRedactStart);
    progress('redaction', 'done', `Redacted ${redactionResult.redactedRegions.length} regions`);

    // ── 8. Stage: Post-Redaction Verification ──
    progress('verify', 'active', 'Auditing redaction pixel opacity...');
    const tVerifyStart = performance.now();

    const verificationResult = Privamon.Verifier.verify(
      redactionResult.canvas,
      redactionResult.ctx,
      redactionResult.redactedRegions
    );

    timings.verification = Math.round(performance.now() - tVerifyStart);
    progress('verify', 'done', `Verification passed: ${verificationResult.verificationPassed}`);

    if (!verificationResult.verificationPassed) {
      warnings.push(...verificationResult.warnings);
    }

    const finalScreenshot = verificationResult.sanitizedDataUrl || redactionResult.sanitizedDataUrl;

    // ── 9. Stage: DOM Sanitization ──
    progress('sanitizeDom', 'active', 'Generating sanitized DOM tree...');
    const tDomSanStart = performance.now();

    const sanitizedDom = (Privamon.SanitizedDOM && typeof Privamon.SanitizedDOM.sanitize === 'function')
      ? Privamon.SanitizedDOM.sanitize(domData.elements, fusionResult.redactions)
      : [];

    timings.domSanitization = Math.round(performance.now() - tDomSanStart);
    progress('sanitizeDom', 'done');

    // ── 10. Stage: Pre-Transmission Screenshot Downscaling (for Server) ──
    progress('downscale', 'active', 'Optimizing sanitized screenshot for reasoning agent...');
    const tDownscaleStart = performance.now();
    let serverScreenshot = finalScreenshot;
    let downscaleMetadata = null;

    try {
      if (Privamon.ImageResizer && typeof Privamon.ImageResizer.prepareServerScreenshot === 'function') {
        const verifiedCanvas = redactionResult.canvas;
        const dpr = domData.viewportInfo?.devicePixelRatio || 1;
        const serverRes = await Privamon.ImageResizer.prepareServerScreenshot(verifiedCanvas, dpr);
        serverScreenshot = serverRes.serverDataUrl || finalScreenshot;
        downscaleMetadata = serverRes.metadata;
      }
    } catch (downscaleErr) {
      console.warn('[Pipeline] Server downscaling failed; safely falling back to full-resolution screenshot:', downscaleErr.message);
      warnings.push(`Downscaling fallback: ${downscaleErr.message}`);
      serverScreenshot = finalScreenshot;
    }

    timings.downscaling = Math.round(performance.now() - tDownscaleStart);
    progress('downscale', 'done');

    // ── Final Timings & Contract Compliance ──
    timings.total = Math.round(performance.now() - pipelineStart);

    return {
      // ── RedactionResult Core Contract ──
      sanitizedScreenshot: finalScreenshot, // Full resolution: preserved for local review & Results dashboard
      serverScreenshot: serverScreenshot,   // Downscaled: DPR normalized & capped at 1152px for server transmission
      detections: fusionResult.detections,
      verificationPassed: verificationResult.verificationPassed,
      reRedactedCount: verificationResult.reRedactedCount,
      warnings,
      timings,

      // ── Backward-Compatible Extensions for UI & Inspection ──
      allCandidates: fusionResult.detections,
      redactions: fusionResult.redactions,
      reviews: fusionResult.reviews,
      kept: fusionResult.kept,
      ocrWords,
      ocrRawText,
      detectionSummary: fusionResult.summary,
      sanitizedDom,
      metadata: {
        screenshotDimensions: screenshotDims,
        viewportInfo: domData.viewportInfo,
        coordinateScale: { x: mapper.info.scaleX, y: mapper.info.scaleY },
        domStats: domData.stats,
        verificationPassed: verificationResult.verificationPassed,
        reRedactedCount: verificationResult.reRedactedCount,
        warnings,
        downscaling: downscaleMetadata
      }
    };
  }

  return { run };
})();
