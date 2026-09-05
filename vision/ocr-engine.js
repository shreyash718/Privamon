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
      const { regionId, bbox, tag, alt, src, area } = region;
      const rId = regionId || 'unknown';

      // 1. Size filter — skip tiny icons
      if (bbox.width < MIN_OCR_WIDTH || bbox.height < MIN_OCR_HEIGHT) {
        console.log(`[OCR][${rId}][REJECTED] Reason: size_too_small, tag: ${tag}, bbox: ${bbox.width}x${bbox.height}`);
        return false;
      }

      // 2. Skip absolutely massive images that will crash WASM memory (e.g., > 5MP)
      if (area > MAX_OCR_AREA) {
        console.log(`[OCR][${rId}][REJECTED] Reason: area_too_large, tag: ${tag}, area: ${area}`);
        return false;
      }

      // 3. Canvas elements are higher priority (likely generated content)
      if (tag === 'CANVAS') {
        console.log(`[OCR][${rId}][ACCEPTED] Reason: canvas_tag, bbox: ${bbox.width}x${bbox.height}`);
        return true;
      }

      // 4. SVG — skip (usually vector graphics, not text documents)
      if (tag === 'SVG') {
        console.log(`[OCR][${rId}][REJECTED] Reason: svg_tag`);
        return false;
      }

      // 5. Video — skip for OCR (would need frame extraction)
      if (tag === 'VIDEO') {
        console.log(`[OCR][${rId}][REJECTED] Reason: video_tag`);
        return false;
      }

      // 6. IFRAME — skip (separate document, can't easily extract)
      if (tag === 'IFRAME') {
        console.log(`[OCR][${rId}][REJECTED] Reason: iframe_tag`);
        return false;
      }

      // 7. Image: Accept all images that passed the size constraints
      if (tag === 'IMG') {
        console.log(`[OCR][${rId}][ACCEPTED] Reason: valid_image, bbox: ${bbox.width}x${bbox.height}`);
        return true;
      }

      // Default: include (OBJECT, EMBED, etc.)
      console.log(`[OCR][${rId}][ACCEPTED] Reason: default_allow, tag: ${tag}`);
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

      if (!result || !result.data) return [];

      const regX = Math.round(regionBbox.x);
      const regY = Math.round(regionBbox.y);

      // 1. Prefer Tesseract's native layout engine lines
      if (result.data.lines && result.data.lines.length > 0) {
        const lineItems = [];
        result.data.lines.forEach((line, lineIdx) => {
          const words = (line.words || []).filter(w => (w.confidence === undefined || w.confidence > 5) && w.text && w.text.trim());
          words.forEach((w, wordIdx) => {
            lineItems.push({
              text: w.text.trim(),
              confidence: (w.confidence ?? 80) / 100,
              lineIndex: lineIdx,
              wordIndex: wordIdx,
              bbox: {
                x: regX + Math.round(w.bbox.x0),
                y: regY + Math.round(w.bbox.y0),
                width: Math.max(1, Math.round(w.bbox.x1 - w.bbox.x0)),
                height: Math.max(1, Math.round(w.bbox.y1 - w.bbox.y0)),
              },
              source: 'ocr',
            });
          });
        });
        if (lineItems.length > 0) {
          return lineItems;
        }
      }

      if (!result.data.words) return [];

      // 2. Fallback: Map Tesseract word bboxes back to screenshot coordinates
      return result.data.words
        .filter(w => (w.confidence === undefined || w.confidence > 5) && w.text && w.text.trim())
        .map(w => ({
          text: w.text.trim(),
          confidence: (w.confidence ?? 80) / 100,
          bbox: {
            x: regX + Math.round(w.bbox.x0),
            y: regY + Math.round(w.bbox.y0),
            width: Math.max(1, Math.round(w.bbox.x1 - w.bbox.x0)),
            height: Math.max(1, Math.round(w.bbox.y1 - w.bbox.y0)),
          },
          source: 'ocr',
        }));
    } catch (err) {
      console.error('[OCREngine] Recognition failed or timed out:', err);
      if (err.message === 'OCR Timeout' || err.message.includes('Timeout')) {
         terminate();
      }
      return [];
    }
  }

  /**
   * Group OCR word tokens into lines and reconstruct text with layout preservation.
   * Produces aligned tokens with character offsets (start, end) in the reconstructed string.
   */
  function buildTextAndTokens(ocrResults) {
    if (!ocrResults || ocrResults.length === 0) {
      return { text: '', tokens: [] };
    }

    const lines = [];

    // Case 1: Tesseract provided native lineIndex
    const hasLineIndex = ocrResults.some(item => item.lineIndex !== undefined);
    if (hasLineIndex) {
      const lineMap = new Map();
      for (const item of ocrResults) {
        const lIdx = item.lineIndex ?? 0;
        if (!lineMap.has(lIdx)) lineMap.set(lIdx, []);
        lineMap.get(lIdx).push(item);
      }
      const sortedKeys = Array.from(lineMap.keys()).sort((a, b) => a - b);
      for (const k of sortedKeys) {
        const line = lineMap.get(k);
        line.sort((a, b) => a.bbox.x - b.bbox.x);
        lines.push(line);
      }
    } else {
      // Case 2: Robust vertical clustering with transitive numeric comparator
      const sorted = [...ocrResults].sort((a, b) => a.bbox.y - b.bbox.y);

      for (const item of sorted) {
        const itemMidY = item.bbox.y + item.bbox.height / 2;
        let placed = false;
        for (const line of lines) {
          const lineMidY = line.reduce((sum, w) => sum + (w.bbox.y + w.bbox.height / 2), 0) / line.length;
          const avgH = line.reduce((sum, w) => sum + w.bbox.height, 0) / line.length;
          if (Math.abs(itemMidY - lineMidY) < avgH * 0.55) {
            line.push(item);
            placed = true;
            break;
          }
        }
        if (!placed) {
          lines.push([item]);
        }
      }

      // Sort lines vertically by average y
      lines.sort((l1, l2) => {
        const y1 = l1.reduce((sum, w) => sum + w.bbox.y, 0) / l1.length;
        const y2 = l2.reduce((sum, w) => sum + w.bbox.y, 0) / l2.length;
        return y1 - y2;
      });

      // Sort each line horizontally
      for (const line of lines) {
        line.sort((a, b) => a.bbox.x - b.bbox.x);
      }
    }

    // Build text with \n between lines and space between words
    let fullText = '';
    const tokens = [];
    let tokenIndex = 0;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      for (let wi = 0; wi < line.length; wi++) {
        const word = line[wi];
        const start = fullText.length;
        fullText += word.text;
        const end = fullText.length;
        tokenIndex++;
        tokens.push({
          id: `ocr_${String(tokenIndex).padStart(4, '0')}`,
          text: word.text,
          start,
          end,
          bbox: word.bbox,
          confidence: word.confidence,
        });
        if (wi < line.length - 1) {
          fullText += ' ';
        }
      }
      if (li < lines.length - 1) {
        fullText += '\n';
      }
    }

    return { text: fullText, tokens };
  }

  /**
   * Proportional sub-box calculation for partial token overlaps.
   */
  function computeTokenSubBox(token, spanStart, spanEnd) {
    const box = token.bbox;
    const tStart = token.start;
    const tEnd = token.end;

    if (spanStart <= tStart && spanEnd >= tEnd) {
      return { ...box };
    }

    const tokenLen = Math.max(1, (token.text || '').length);
    const charW = box.width / tokenLen;

    const clampedStart = Math.max(tStart, spanStart);
    const clampedEnd = Math.min(tEnd, spanEnd);

    const offsetChars = clampedStart - tStart;
    const spanChars = Math.max(1, clampedEnd - clampedStart);

    const subX = box.x + Math.round(offsetChars * charW);
    const subW = Math.max(2, Math.round(spanChars * charW));
    const maxRight = box.x + box.width;

    return {
      x: Math.min(subX, maxRight - 2),
      y: box.y,
      width: Math.min(subW, maxRight - subX),
      height: box.height
    };
  }

  /**
   * Fallback multi-line aware token-to-bbox mapper with partial overlap precision.
   */
  function mapSpanToBoxes(spanStart, spanEnd, tokens) {
    const matched = tokens.filter(t => t.end > spanStart && t.start < spanEnd);
    if (matched.length === 0) return { bbox: null, boxes: [], tokens: [] };

    // Calculate exact sub-boxes for each overlapping token
    const items = matched.map(t => ({
      id: t.id,
      bbox: computeTokenSubBox(t, spanStart, spanEnd)
    }));

    // Group matched items by line
    const lines = [];
    for (const item of items) {
      const midY = item.bbox.y + item.bbox.height / 2;
      let placed = false;
      for (const line of lines) {
        const refMidY = line[0].bbox.y + line[0].bbox.height / 2;
        const avgH = (item.bbox.height + line[0].bbox.height) / 2;
        if (Math.abs(midY - refMidY) < avgH * 0.6) {
          line.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) lines.push([item]);
    }

    const perLineBoxes = lines.map(line => {
      const x1 = Math.min(...line.map(w => w.bbox.x));
      const y1 = Math.min(...line.map(w => w.bbox.y));
      const x2 = Math.max(...line.map(w => w.bbox.x + w.bbox.width));
      const y2 = Math.max(...line.map(w => w.bbox.y + w.bbox.height));
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    });

    const x1 = Math.min(...items.map(w => w.bbox.x));
    const y1 = Math.min(...items.map(w => w.bbox.y));
    const x2 = Math.max(...items.map(w => w.bbox.x + w.bbox.width));
    const y2 = Math.max(...items.map(w => w.bbox.y + w.bbox.height));
    const unionBox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };

    return {
      tokens: matched.map(w => w.id),
      bbox: unionBox,
      boxes: perLineBoxes.length > 1 ? perLineBoxes : [unionBox],
    };
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
      let fullRawText = '';
      console.log(`[OCR] Starting processing for ${regions.length} selected regions`);

      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const rId = region.regionId || `region_${i}`;
        
        // Map the region's CSS bbox to screenshot pixels
        const rawMapped = mapper.mapBbox(region.bbox);
        const screenshotBbox = {
          x: Math.max(0, Math.round(rawMapped.x)),
          y: Math.max(0, Math.round(rawMapped.y)),
          width: Math.round(rawMapped.width),
          height: Math.round(rawMapped.height),
        };

        // Skip if region is too small after mapping
        if (screenshotBbox.width < 20 || screenshotBbox.height < 10) {
            console.log(`[OCR][${rId}][REJECTED] Reason: mapped_size_too_small, bbox: ${screenshotBbox.width}x${screenshotBbox.height}`);
            continue;
        }

        console.log(`[OCR][${rId}][CROP] CSS: ${Math.round(region.bbox.x)},${Math.round(region.bbox.y)} ${Math.round(region.bbox.width)}x${Math.round(region.bbox.height)} | Screenshot: ${screenshotBbox.x},${screenshotBbox.y} ${screenshotBbox.width}x${screenshotBbox.height} | ScaleX: ${mapper.info.scaleX.toFixed(3)}, ScaleY: ${mapper.info.scaleY.toFixed(3)}`);

        const tStartExtract = performance.now();
        // Extract the region from the screenshot
        const regionDataUrl = await Privamon.Redactor.extractRegion(
          screenshotDataUrl,
          screenshotBbox
        );
        const tExtract = Math.round(performance.now() - tStartExtract);

        const tStartRecognize = performance.now();
        // Run OCR
        const ocrResults = await recognizeRegion(regionDataUrl, screenshotBbox);
        const tRecognize = Math.round(performance.now() - tStartRecognize);
        
        console.log(`[OCR][${rId}][TESSERACT] words=${ocrResults.length} in ${tRecognize}ms (extract: ${tExtract}ms)`);

        const tStartPii = performance.now();
        
        // Reconstruct coherent text and word tokens preserving layout & lines
        const { text: regionText, tokens: tokenList } = buildTextAndTokens(ocrResults);
        let tPiiEnd = tStartPii;
        
        if (regionText.trim()) {
          fullRawText += `\n--- Region ${rId} ---\n${regionText}\n`;
          console.log(`[OCR][${rId}][TEXT] "${regionText.replace(/\n/g, '\\n')}"`);
          // Query Python PII engine (Presidio + GLiNER) with fallback to JS detector
          const piiDetections = await Privamon.PIIDetector.detectAsync(regionText, 'ocr', '', tokenList);
          tPiiEnd = performance.now();
          console.log(`[OCR][${rId}][PII_DETECTION] found=${piiDetections.length} in ${Math.round(tPiiEnd - tStartPii)}ms`);
          
          const tStartMatching = performance.now();

          for (const pii of piiDetections) {
            // If already enriched with bounding boxes by the engine
            if (pii.bbox) {
              allOcrDetections.push({
                ...pii,
                source: 'ocr',
                tokens: pii.tokens || [],
                boxes: pii.boxes || [pii.bbox],
                coordinateSpace: 'screenshot' // In screenshot pixels
              });
              continue;
            }

            // Fallback JS span mapping if bbox wasn't provided
            const spanStart = pii.span ? pii.span.start : (pii.start ?? -1);
            const spanEnd = pii.span ? pii.span.end : (pii.end ?? -1);
            if (spanStart === -1 || spanEnd === -1) continue;

            const mappedBoxes = mapSpanToBoxes(spanStart, spanEnd, tokenList);
            if (mappedBoxes.bbox) {
              allOcrDetections.push({
                ...pii,
                source: 'ocr',
                tokens: mappedBoxes.tokens || [],
                bbox: mappedBoxes.bbox,
                boxes: mappedBoxes.boxes,
                coordinateSpace: 'screenshot'
              });
            }
          }
          console.log(`[OCR][${rId}] PII matching END: ${Math.round(performance.now() - tStartMatching)} ms`);
        } else {
            console.log(`[OCR][${rId}] Empty OCR text — skipping PII detection.`);
        }
      }

      return { detections: allOcrDetections, rawText: fullRawText };
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
