/**
 * Privamon — Sanitization Pipeline
 *
 * Master orchestrator that runs inside the offscreen document.
 * Coordinates all stages of the local sanitization process:
 *
 * 1. DOM PII Detection
 * 2. Pixel Region Identification (selective)
 * 3. OCR on selected pixel regions
 * 4. Vision model on selected regions (face detection)
 * 5. PII Fusion — merge all detections, deduplicate
 * 6. Coordinate Mapping — CSS viewport → screenshot pixels
 * 7. Redaction — opaque masking on canvas
 * 8. Verification — confirm redaction succeeded
 * 9. DOM Sanitization — strip PII from DOM data
 *
 * Each stage is timed. The pipeline reports progress to the background
 * service worker which forwards it to the popup UI.
 */
var Privamon = Privamon || {};

Privamon.SanitizePipeline = (() => {
  'use strict';

  /**
   * Run the full sanitization pipeline.
   *
   * @param {Object} params
   * @param {string} params.screenshot - Raw screenshot data URL
   * @param {Object} params.domData - Output from dom-extractor
   * @param {Function} params.onProgress - (stageId, status, statusText) => void
   * @returns {Promise<Object>} Pipeline results
   */
  async function run({ screenshot, domData, onProgress }) {
    const timings = {};
    const progress = (stageId, status, statusText) => {
      if (typeof onProgress === 'function') {
        onProgress(stageId, status, statusText);
      }
    };

    // ── Get screenshot dimensions ──
    const screenshotDims = await getImageDimensions(screenshot);
    console.log(`[Pipeline] Screenshot: ${screenshotDims.width}×${screenshotDims.height}`);
    console.log(`[Pipeline] Viewport: ${domData.viewportInfo.cssViewportWidth}×${domData.viewportInfo.cssViewportHeight}`);
    console.log(`[Pipeline] DPR: ${domData.viewportInfo.devicePixelRatio}, Zoom: ${domData.viewportInfo.estimatedZoom}`);

    // ── Stage 1: DOM PII Detection ──
    progress('domPii', 'active', 'Detecting PII in DOM elements...');
    const t1 = performance.now();
    const domDetections = Privamon.PIIDetector.detectAllDom(domData.elements);
    timings.domPiiDetection = Math.round(performance.now() - t1);
    progress('domPii', 'done');
    console.log(`[Pipeline] DOM PII: ${domDetections.length} detections in ${timings.domPiiDetection}ms`);

    // ── Stage 2: Identify pixel regions (SELECTIVE) ──
    progress('pixelId', 'active', 'Identifying pixel-based regions...');
    const t2 = performance.now();
    const allPixelRegions = domData.pixelRegions || [];
    console.log(`[PIPELINE] Extracted ${allPixelRegions.length} pixel regions from DOM`);
    
    const ocrCandidates = Privamon.OCREngine.selectRegionsForOCR(allPixelRegions, domData.viewportInfo);
    timings.pixelIdentification = Math.round(performance.now() - t2);
    progress('pixelId', 'done');
    console.log(`[PIPELINE] OCR Selection: ${ocrCandidates.length} ACCEPTED, ${allPixelRegions.length - ocrCandidates.length} REJECTED`);

    // ── Create Coordinate Mapper ──
    const mapper = Privamon.CoordinateMapper.create(domData.viewportInfo, screenshotDims);
    console.log(`[Pipeline] Scale: X=${mapper.info.scaleX.toFixed(3)}, Y=${mapper.info.scaleY.toFixed(3)}`);

    // ── Stage 3: OCR on selected pixel regions ──
    progress('ocr', 'active', 'Running OCR on selected regions...');
    const t3 = performance.now();
    let ocrDetections = [];
    if (ocrCandidates.length > 0) {
      try {
        ocrDetections = await Privamon.OCREngine.processRegions(screenshot, ocrCandidates, mapper);
      } catch (err) {
        console.warn('[Pipeline] OCR failed (non-fatal):', err.message);
      }
    } else {
      console.log('[PIPELINE] No pixel regions selected for OCR — skipping OCR stage');
    }
    timings.ocr = Math.round(performance.now() - t3);
    progress('ocr', ocrCandidates.length > 0 ? 'done' : 'skipped');
    console.log(`[PIPELINE] OCR raw output: ${ocrDetections.length} detections in ${timings.ocr}ms`);
    if (ocrDetections.length > 0) {
      console.log('[PIPELINE] Raw OCR detections:', JSON.stringify(ocrDetections, null, 2));
    }

    // ── Stage 4: Vision model (face detection) ──
    progress('vision', 'active', 'Running vision analysis...');
    const t4 = performance.now();
    let visionDetections = [];
    try {
      visionDetections = await Privamon.VisionModel.processRegions(screenshot, allPixelRegions, mapper);
    } catch (err) {
      console.warn('[Pipeline] Vision processing failed (non-fatal):', err.message);
    }
    timings.vision = Math.round(performance.now() - t4);
    progress('vision', visionDetections.length > 0 ? 'done' : 'skipped');
    console.log(`[Pipeline] Vision: ${visionDetections.length} detections in ${timings.vision}ms`);

    // Tag vision detections with coordinate space
    visionDetections.forEach(d => d.coordinateSpace = 'screenshot');

    // ── Stage 5: Coordinate Mapping (DOM CSS -> Screenshot pixels) ──
    // Normalize DOM detections to physical screenshot pixels BEFORE fusion
    // so that IoU deduplication and containment checks compare matching units.
    progress('coordMap', 'active', 'Mapping DOM coordinates to screenshot pixels...');
    const tCoord = performance.now();
    const mappedDomDetections = mapper.mapAll(domDetections);
    timings.coordinateMapping = Math.round(performance.now() - tCoord);
    progress('coordMap', 'done');
    console.log(`[PIPELINE] DOM coordinates mapped: ${mappedDomDetections.length} detections in ${timings.coordinateMapping}ms`);

    // ── Stage 6: PII Fusion (Unified Screenshot Pixel Space) ──
    progress('fusion', 'active', 'Merging detections in screenshot space...');
    const t5 = performance.now();
    
    console.log(`[PIPELINE] Fusion inputs -> DOM: ${mappedDomDetections.length}, OCR: ${ocrDetections.length}, Vision: ${visionDetections.length}`);
    
    const { detections: fusedDetections, summary: detectionSummary } =
      Privamon.PIIFusion.fuse(mappedDomDetections, ocrDetections, visionDetections);
    timings.fusion = Math.round(performance.now() - t5);
    progress('fusion', 'done');
    console.log(`[PIPELINE] Fusion output -> ${fusedDetections.length} fused detections`);
    if (fusedDetections.length > 0) {
      console.log(`[PIPELINE] Fused detections:`, JSON.stringify(fusedDetections, null, 2));
    }

    // ── Stage 7: Redaction ──
    progress('redaction', 'active', 'Redacting sensitive regions...');
    const t7 = performance.now();
    let redactionResult;
    if (fusedDetections.length > 0) {
      console.log(`[PIPELINE][REDACTION] Redacting ${fusedDetections.length} regions...`);
      redactionResult = await Privamon.Redactor.redact(screenshot, fusedDetections);
      console.log(`[PIPELINE][REDACTION] Successfully redacted ${redactionResult.redactedRegions.length} regions`);
    } else {
      // No PII found — return original screenshot unchanged
      console.log(`[PIPELINE][REDACTION] No regions to redact.`);
      redactionResult = {
        sanitizedDataUrl: screenshot,
        redactedRegions: [],
        dimensions: screenshotDims,
      };
    }
    timings.redaction = Math.round(performance.now() - t7);
    progress('redaction', 'done');

    // ── Stage 8: Verification ──
    progress('verify', 'active', 'Verifying redaction...');
    const t8 = performance.now();
    let verificationResult;
    if (redactionResult.redactedRegions.length > 0) {
      verificationResult = await Privamon.Verifier.verify(
        redactionResult.sanitizedDataUrl,
        redactionResult.redactedRegions
      );
    } else {
      verificationResult = {
        verified: true,
        sanitizedDataUrl: redactionResult.sanitizedDataUrl,
        reRedacted: false,
      };
    }
    timings.verification = Math.round(performance.now() - t8);
    progress('verify', 'done');

    // ── Stage 9: Sanitized DOM ──
    progress('sanitizeDom', 'active', 'Sanitizing DOM...');
    const t9 = performance.now();
    const sanitizedDom = Privamon.SanitizedDOM.sanitize(domData.elements, fusedDetections);
    timings.domSanitization = Math.round(performance.now() - t9);
    progress('sanitizeDom', 'done');

    // ── Cleanup ──
    await Privamon.OCREngine.terminate();
    await Privamon.VisionModel.disposeAll();

    // ── Final Result ──
    const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
    timings.total = totalTime;

    console.log('[Pipeline] Timings:', timings);

    return {
      sanitizedScreenshot: verificationResult.sanitizedDataUrl,
      detections: fusedDetections,
      detectionSummary,
      sanitizedDom,
      timings,
      metadata: {
        screenshotDimensions: screenshotDims,
        viewportInfo: domData.viewportInfo,
        coordinateScale: { x: mapper.info.scaleX, y: mapper.info.scaleY },
        domStats: domData.stats,
        verificationPassed: verificationResult.verified,
        reRedacted: verificationResult.reRedacted,
      },
    };
  }

  /**
   * Get the dimensions of an image from its data URL.
   */
  function getImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => reject(new Error('Failed to load image for dimension check'));
      img.src = dataUrl;
    });
  }

  return { run };
})();
