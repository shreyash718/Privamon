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
  let isProcessing = false; // Mutex to prevent overlapping OCR pipeline executions

  // ── Selectivity Heuristics ──

  // Minimum region size in CSS pixels to consider for OCR
  const MIN_OCR_WIDTH = 40;
  const MIN_OCR_HEIGHT = 20;

  // Maximum fraction of viewport a single region can be to still qualify
  // Set to 1.0 to allow full-screen images (like documents opened directly in the browser)
  const MAX_VIEWPORT_FRACTION = 1.0;

  // Maximum absolute area for OCR (Tesseract is slow on huge images, but we need to support full-page documents)
  // Increased from 400k to 5 million (e.g., 2000x2500)
  const MAX_OCR_AREA = 5000000; 

  // Keywords in alt/src that suggest the image may contain text
  const TEXT_HINT_KEYWORDS = [
    'document', 'receipt', 'invoice', 'bill', 'statement', 'certificate',
    'license', 'passport', 'id', 'card', 'form', 'scan', 'screenshot',
    'cheque', 'check', 'letter', 'report', 'aadhaar', 'pan', 'text', 'doc'
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

      // 2. Skip absolutely massive images that will crash WASM memory (e.g., > 5MP)
      if (area > MAX_OCR_AREA) {
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

        // Check for text-hint keywords using exact word matching to avoid false positives 
        // (e.g., 'id' matching inside 'width' or 'pan' inside 'company')
        const words = [...altLower.split(/[^a-z0-9]+/), ...srcLower.split(/[^a-z0-9]+/)];
        for (const keyword of TEXT_HINT_KEYWORDS) {
          if (words.includes(keyword)) {
            return true;
          }
        }

        // Data URIs or blob URIs suggest generated/dynamic content
        // BUT they can also be massive photos. Only accept if relatively small.
        if (srcLower.startsWith('data:') || srcLower.startsWith('blob:')) {
          if (area < 150000) return true;
        }

        // Default: skip small/decorative images and arbitrary generic photos
        // (Tesseract is too slow on complex scenery/people photos)
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

        const tStart = performance.now();
        
        // Add a timeout for initialization to prevent indefinite buffering if traineddata is missing or stalled
        const initTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Tesseract initialization timeout')), 15000)
        );

        const workerPromise = Tesseract.createWorker('eng', 1, {
          workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/tesseract/tesseract-core-simd.wasm.js'),
          langPath: chrome.runtime.getURL('lib/tesseract/'),
          workerBlobURL: false,
        });

        worker = await Promise.race([workerPromise, initTimeout]);

        isInitialized = true;
        console.log(`[OCREngine] Initialized successfully in ${Math.round(performance.now() - tStart)}ms`);
      } catch (err) {
        console.error('[OCREngine] Initialization failed:', err);
        worker = null;
        isInitialized = false;
        initPromise = null;
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
      // Add a generous timeout (25s) for full-page dense images
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('OCR Timeout')), 25000)
      );
      
      const result = await Promise.race([
        worker.recognize(regionDataUrl),
        timeoutPromise
      ]);

      if (!result || !result.data || !result.data.words) return [];

      // Map Tesseract word bboxes back to screenshot coordinates
      return result.data.words
        .filter(w => w.confidence > 5 && w.text.trim()) // Lowered to 5 to avoid discarding valid text. Regex handles false positives.
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
      console.error('[OCREngine] Recognition failed or timed out:', err);
      // If we hit a timeout or serious error, kill the worker to prevent it from hanging future jobs
      if (err.message === 'OCR Timeout' || err.message.includes('Timeout')) {
         terminate(); // Do NOT await terminate, as a deadlocked worker will hang the promise forever!
      }
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

    // Simple queue/mutex
    while (isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    isProcessing = true;

    try {
      await initialize();
      if (!worker) return [];

      const allOcrDetections = [];
      console.log(`[OCR] Starting processing for ${regions.length} selected regions`);

      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        console.log(`[OCR] region detected`);
        
        // Map the region's CSS bbox to screenshot pixels
        const screenshotBbox = mapper.mapBbox(region.bbox);

        // Skip if region is too small after mapping
        if (screenshotBbox.width < 20 || screenshotBbox.height < 10) {
            console.log(`[OCR] skipped (too small after mapping)`);
            continue;
        }

        console.log(`[OCR] screenshot crop dimensions: ${screenshotBbox.width}x${screenshotBbox.height}`);

        const tStartExtract = performance.now();
        console.log(`[OCR] extractRegion START`);
        // Extract the region from the screenshot
        const regionDataUrl = await Privamon.Redactor.extractRegion(
          screenshotDataUrl,
          screenshotBbox
        );
        const tExtract = Math.round(performance.now() - tStartExtract);
        console.log(`[OCR] extractRegion END: ${tExtract} ms`);

        // We can't directly measure the OCR input dimensions here easily without loading the image again, 
        // but it's identical to the crop dimensions because extractRegion draws it 1:1.
        console.log(`[OCR] OCR input dimensions: ${screenshotBbox.width}x${screenshotBbox.height}`);

        const tStartRecognize = performance.now();
        console.log(`[OCR] worker.recognize START`);
        // Run OCR
        const ocrResults = await recognizeRegion(regionDataUrl, screenshotBbox);
        const tRecognize = Math.round(performance.now() - tStartRecognize);
        console.log(`[OCR] worker.recognize END: ${tRecognize} ms`);
        console.log(`[OCR] OCR words: ${ocrResults.length}`);

        const tStartPii = performance.now();
        console.log(`[OCR] PII detection START`);
        
        // Combine OCR text for this region and run PII detection
        const regionText = ocrResults.map(r => r.text).join(' ');
        let tPiiEnd = tStartPii;
        
        if (regionText.trim()) {
          const piiDetections = Privamon.PIIDetector.detectInText(regionText, 'ocr', '');
          tPiiEnd = performance.now();
          console.log(`[OCR] PII detection END: ${Math.round(tPiiEnd - tStartPii)} ms`);
          
          console.log(`[OCR] PII matching START`);
          const tStartMatching = performance.now();

          for (const pii of piiDetections) {
            if (!pii.span) continue;

            let currentIdx = 0;
            let matchStartIndex = -1;
            let matchEndIndex = -1;

            for (let i = 0; i < ocrResults.length; i++) {
              const wordStart = currentIdx;
              const wordEnd = currentIdx + ocrResults[i].text.length;

              // If the word overlaps with the PII character span
              if (wordEnd > pii.span.start && wordStart < pii.span.end) {
                if (matchStartIndex === -1) matchStartIndex = i;
                matchEndIndex = i;
              }

              // +1 for the space added by join(' ')
              currentIdx = wordEnd + 1;
            }

            if (matchStartIndex !== -1) {
              const x1 = Math.min(...ocrResults.slice(matchStartIndex, matchEndIndex + 1).map(w => w.bbox.x));
              const y1 = Math.min(...ocrResults.slice(matchStartIndex, matchEndIndex + 1).map(w => w.bbox.y));
              const x2 = Math.max(...ocrResults.slice(matchStartIndex, matchEndIndex + 1).map(w => w.bbox.x + w.bbox.width));
              const y2 = Math.max(...ocrResults.slice(matchStartIndex, matchEndIndex + 1).map(w => w.bbox.y + w.bbox.height));

              allOcrDetections.push({
                ...pii,
                source: 'ocr',
                bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
                coordinateSpace: 'screenshot' // ALREADY IN SCREENSHOT COORDINATES!
              });
            }
          }
          console.log(`[OCR] PII matching END: ${Math.round(performance.now() - tStartMatching)} ms`);
        } else {
            console.log(`[OCR] PII detection END: 0 ms`);
            console.log(`[OCR] PII matching START`);
            console.log(`[OCR] PII matching END: 0 ms`);
        }
      }

      return allOcrDetections;
    } finally {
      isProcessing = false;
    }
  }

  /**
   * Cleanup the worker when done.
   */
  function terminate() {
    if (worker) {
      // Fire and forget termination - don't await because a stuck worker hangs the Promise forever
      worker.terminate().catch(err => console.warn('Worker terminate error:', err));
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
