/**
 * Privamon — OCR Engine (Tesseract.js wrapper)
 *
 * Local OCR using Tesseract.js. Only processes selected pixel regions,
 * NOT the entire screenshot.
 *
 * ── SELECTIVE PROCESSING (Correction #3) ──
 *
 * Not every <img>/<canvas>/<video> needs OCR. We use heuristics to decide:
 *
 *   1. Size threshold: Skip tiny icons (<40×40 px) and huge decorative images
 *      (>80% of viewport — likely hero images)
 *   2. Alt text analysis: If alt text contains PII keywords, prioritize
 *   3. Context: Images near form fields or labeled content are higher priority
 *   4. Element type: <canvas> with no text children is higher priority
 *   5. Image source: Data URIs and blob URIs suggest dynamic/generated content
 *
 * OCR returns: { text, bbox, confidence } for each detected text block.
 * The text is then passed through the PII detector.
 */
var Privamon = Privamon || {};

Privamon.OCREngine = (() => {
  'use strict';

  let worker = null;
  let isInitialized = false;
  let initPromise = null;

  // ── Selectivity Heuristics ──

  // Minimum region size in CSS pixels to consider for OCR
  const MIN_OCR_WIDTH = 40;
  const MIN_OCR_HEIGHT = 20;

  // Maximum fraction of viewport a single region can be to still qualify
  // (very large regions are likely hero images, not documents)
  const MAX_VIEWPORT_FRACTION = 0.8;

  // Keywords in alt/src that suggest the image may contain text
  const TEXT_HINT_KEYWORDS = [
    'document', 'receipt', 'invoice', 'bill', 'statement', 'certificate',
    'license', 'passport', 'id', 'card', 'form', 'scan', 'screenshot',
    'cheque', 'check', 'letter', 'report', 'aadhaar', 'pan',
  ];

  /**
   * Filter pixel regions to only those worth running OCR on.
   *
   * @param {Array} pixelRegions - From dom-extractor's pixelRegions array
   * @param {Object} viewportInfo - { cssViewportWidth, cssViewportHeight }
   * @returns {Array} Filtered regions worth processing
   */
  function selectRegionsForOCR(pixelRegions, viewportInfo) {
    const viewportArea = viewportInfo.cssViewportWidth * viewportInfo.cssViewportHeight;

    return pixelRegions.filter(region => {
      const { bbox, tag, alt, src, area } = region;

      // 1. Size filter — skip tiny icons
      if (bbox.width < MIN_OCR_WIDTH || bbox.height < MIN_OCR_HEIGHT) {
        return false;
      }

      // 2. Skip enormous decorative regions (hero images)
      if (area > viewportArea * MAX_VIEWPORT_FRACTION) {
        return false;
      }

      // 3. Canvas elements are higher priority (likely generated content)
      if (tag === 'CANVAS') return true;

      // 4. SVG — skip (usually vector graphics, not text documents)
      if (tag === 'SVG') return false;

      // 5. Video — skip for OCR (would need frame extraction)
      if (tag === 'VIDEO') return false;

      // 6. IFRAME — skip (separate document, can't easily extract)
      if (tag === 'IFRAME') return false;

      // 7. Image: check for text hints in alt/src
      if (tag === 'IMG') {
        const altLower = (alt || '').toLowerCase();
        const srcLower = (src || '').toLowerCase();

        // Data URIs or blob URIs suggest generated/dynamic content — prioritize
        if (srcLower.startsWith('data:') || srcLower.startsWith('blob:')) {
          return true;
        }

        // Check for text-hint keywords
        for (const keyword of TEXT_HINT_KEYWORDS) {
          if (altLower.includes(keyword) || srcLower.includes(keyword)) {
            return true;
          }
        }

        // Medium-sized images (between icon and hero) in reasonable aspect ratio
        // could be documents or screenshots
        const aspectRatio = bbox.width / bbox.height;
        if (aspectRatio > 0.5 && aspectRatio < 3.0 && area > 10000) {
          return true;
        }

        // Default: skip small/decorative images
        return false;
      }

      // Default: include (OBJECT, EMBED, etc.)
      return true;
    });
  }

  /**
   * Initialize the Tesseract.js worker.
   * Lazy initialization — only called when OCR is actually needed.
   */
  async function initialize() {
    if (isInitialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        // Check if Tesseract is available
        if (typeof Tesseract === 'undefined') {
          console.warn('[OCREngine] Tesseract.js not loaded — OCR will be unavailable');
          return;
        }

        worker = await Tesseract.createWorker('eng', 1, {
          workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/tesseract/tesseract-core-simd.wasm.js'),
          langPath: chrome.runtime.getURL('lib/tesseract/'),
          workerBlobURL: false,
          // Disable logger in production to avoid noise
          // logger: (m) => console.log('[OCR]', m),
        });

        isInitialized = true;
        console.log('[OCREngine] Initialized successfully');
      } catch (err) {
        console.error('[OCREngine] Initialization failed:', err);
        worker = null;
      }
    })();

    return initPromise;
  }

  /**
   * Run OCR on a specific image region.
   *
   * @param {string} regionDataUrl - The image region as a data URL
   * @param {Object} regionBbox - The bbox of this region in screenshot coordinates
   * @returns {Promise<Array>} Array of { text, bbox, confidence }
   */
  async function recognizeRegion(regionDataUrl, regionBbox) {
    if (!isInitialized || !worker) {
      await initialize();
      if (!worker) return [];
    }

    try {
      const result = await worker.recognize(regionDataUrl);

      if (!result || !result.data || !result.data.words) return [];

      // Map Tesseract word bboxes back to screenshot coordinates
      return result.data.words
        .filter(w => w.confidence > 30) // Filter low-confidence noise
        .map(w => ({
          text: w.text,
          confidence: w.confidence / 100, // Normalize to 0–1
          // Tesseract bbox is relative to the region image.
          // We need to offset by the region's position in the screenshot.
          bbox: {
            x: regionBbox.x + w.bbox.x0,
            y: regionBbox.y + w.bbox.y0,
            width: w.bbox.x1 - w.bbox.x0,
            height: w.bbox.y1 - w.bbox.y0,
          },
          source: 'ocr',
        }));
    } catch (err) {
      console.error('[OCREngine] Recognition failed:', err);
      return [];
    }
  }

  /**
   * Process multiple regions sequentially.
   *
   * @param {string} screenshotDataUrl - Full screenshot
   * @param {Array} regions - Filtered regions to process
   * @param {Object} mapper - CoordinateMapper instance
   * @returns {Promise<Array>} All OCR results with PII detection applied
   */
  async function processRegions(screenshotDataUrl, regions, mapper) {
    if (regions.length === 0) return [];

    await initialize();
    if (!worker) return [];

    const allOcrDetections = [];

    for (const region of regions) {
      // Map the region's CSS bbox to screenshot pixels
      const screenshotBbox = mapper.mapBbox(region.bbox);

      // Skip if region is too small after mapping
      if (screenshotBbox.width < 20 || screenshotBbox.height < 10) continue;

      // Extract the region from the screenshot
      const regionDataUrl = await Privamon.Redactor.extractRegion(
        screenshotDataUrl,
        screenshotBbox
      );

      // Run OCR
      const ocrResults = await recognizeRegion(regionDataUrl, screenshotBbox);

      // Combine OCR text for this region and run PII detection
      const regionText = ocrResults.map(r => r.text).join(' ');
      if (regionText.trim()) {
        const piiDetections = Privamon.PIIDetector.detectInText(regionText, 'ocr', '');

        for (const pii of piiDetections) {
          // Find the OCR word(s) that matched this PII
          const matchingWords = ocrResults.filter(w =>
            regionText.indexOf(pii.text) !== -1 // simplified match
          );

          if (matchingWords.length > 0) {
            // Use the bbox of the first matching word
            allOcrDetections.push({
              ...pii,
              source: 'ocr',
              bbox: matchingWords[0].bbox,
            });
          }
        }
      }
    }

    return allOcrDetections;
  }

  /**
   * Cleanup the worker when done.
   */
  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      isInitialized = false;
      initPromise = null;
    }
  }

  return {
    selectRegionsForOCR,
    initialize,
    recognizeRegion,
    processRegions,
    terminate,
  };
})();
