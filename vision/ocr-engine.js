/**
 * Privamon — OCR Engine (Tesseract.js wrapper)
 *
 * Runs client-side OCR using Tesseract.js WebAssembly.
 * Only processes selected pixel-bearing regions, NEVER the entire screenshot.
 *
 * Implements:
 *   - Persistent worker loaded once and reused across regions & pipeline runs
 *   - Offline traineddata from lib/tesseract/ (eng + hin)
 *   - Token-level layout preservation and word bounding boxes
 *   - Feeds recognized text through the shared Privamon.PIIDetector.detectPII module
 *   - Character-span-to-word-box alignment for tight redaction boundaries
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.OCREngine = (() => {
  'use strict';

  let worker = null;
  let isInitialized = false;
  let initPromise = null;
  let isProcessing = false;

  // ── Selectivity Heuristics ──
  const MIN_OCR_WIDTH = 60;
  const MIN_OCR_HEIGHT = 25;
  const MAX_OCR_AREA = 5000000;
  const MAX_OCR_REGIONS = 6; // Cap at top 6 regions to prevent multi-minute stalls on complex pages

  /**
   * Filter pixel regions to only those worth running OCR on.
   */
  function selectRegionsForOCR(pixelRegions, viewportInfo) {
    if (!pixelRegions || !Array.isArray(pixelRegions)) return [];

    const candidates = pixelRegions.filter(region => {
      const { bbox, tag, area } = region;
      if (!bbox) return false;

      // 1. Size filter — skip tiny icons, badges, indicators
      if (bbox.width < MIN_OCR_WIDTH || bbox.height < MIN_OCR_HEIGHT) {
        return false;
      }

      // 2. Skip massive images that will crash WASM memory
      if (area && area > MAX_OCR_AREA) {
        return false;
      }

      // 3. Canvas elements are high priority (graphs, charts, document previewers)
      if (tag === 'CANVAS') return true;

      // 4. Vector/video elements skip
      if (tag === 'SVG' || tag === 'VIDEO' || tag === 'IFRAME') return false;

      // 5. Small square images (<140x140) are almost always icons, avatars, or decorative graphics
      if (tag === 'IMG' && bbox.width < 140 && bbox.height < 140 && Math.abs(bbox.width - bbox.height) < 25) {
        return false;
      }

      // 6. Image tags
      if (tag === 'IMG') return true;

      return true;
    });

    // Prioritize CANVAS elements first, then largest pixel areas (bills, documents, receipts)
    candidates.sort((a, b) => {
      if (a.tag === 'CANVAS' && b.tag !== 'CANVAS') return -1;
      if (b.tag === 'CANVAS' && a.tag !== 'CANVAS') return 1;
      const areaA = (a.bbox?.width || 0) * (a.bbox?.height || 0);
      const areaB = (b.bbox?.width || 0) * (b.bbox?.height || 0);
      return areaB - areaA;
    });

    return candidates.slice(0, MAX_OCR_REGIONS);
  }

  /**
   * Preprocess a crop image on a canvas for OCR.
   * Upscales moderate regions with smooth bicubic interpolation and applies neutral padding
   * to maximize Tesseract character recognition and prevent boundary clipping.
   */
  async function preprocessCropForOCR(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const minDim = Math.min(img.width, img.height);
        const maxDim = Math.max(img.width, img.height);

        // Skip non-text slices, thin borders/dividers, or tiny graphics that trigger Leptonica scaling warnings
        if (minDim < 25 || img.width < 50 || (maxDim / Math.max(minDim, 1)) > 8) {
          resolve({ dataUrl, scale: 1.0, pad: 0, skipped: true });
          return;
        }

        let scale = 1.0;
        if (maxDim < 500) {
          scale = Math.min(2.0, 900 / maxDim);
        } else if (maxDim > 2000) {
          scale = 2000 / maxDim; // Downscale extreme images while keeping resolution crisp for OCR
        }

        const pad = 30; // 30px boundary margin for Tesseract line segmenter
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale) + pad * 2;
        canvas.height = Math.round(img.height * scale) + pad * 2;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, pad, pad, Math.round(img.width * scale), Math.round(img.height * scale));

        resolve({
          dataUrl: canvas.toDataURL('image/png'),
          scale: scale,
          pad: pad,
          skipped: false,
        });
      };
      img.onerror = () => resolve({ dataUrl, scale: 1.0, pad: 0, skipped: true });
      img.src = dataUrl;
    });
  }

  function resolveUrl(relativePath) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(relativePath);
    }
    return relativePath.startsWith('/') ? relativePath : '/' + relativePath;
  }

  /**
   * Initialize the persistent Tesseract.js worker.
   * Loaded once and kept alive across runs.
   */
  async function initialize() {
    if (isInitialized && worker) return worker;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const tess = (typeof Tesseract !== 'undefined') ? Tesseract
                   : (typeof window !== 'undefined' && window.Tesseract) ? window.Tesseract
                   : (typeof globalThis !== 'undefined' && globalThis.Tesseract) ? globalThis.Tesseract
                   : (typeof self !== 'undefined' && self.Tesseract) ? self.Tesseract
                   : null;

        if (!tess) {
          console.warn('[OCREngine] Tesseract.js not loaded — OCR unavailable');
          return null;
        }

        const tStart = performance.now();
        console.log('[OCREngine] Initializing persistent Tesseract.js worker (eng+hin)...');

        const workerOptions = {
          workerPath: resolveUrl('lib/tesseract/worker.min.js'),
          corePath: resolveUrl('lib/tesseract/tesseract-core-simd.wasm.js'),
          langPath: resolveUrl('lib/tesseract/'),
          workerBlobURL: false,
          gzip: false,
          cacheMethod: 'none',
          errorHandler: (err) => {
            // Suppress non-fatal internal Leptonica scaling warnings from flooding the console
            const errStr = String(err?.message || err || '');
            if (errStr.includes('too small to scale') || errStr.includes('cannot be recognized')) {
              return;
            }
            console.warn('[OCREngine Worker]', err);
          },
        };

        let createdWorker = null;
        try {
          // Attempt dual eng+hin language support
          createdWorker = await tess.createWorker('eng+hin', 1, workerOptions);
        } catch (dualErr) {
          console.warn('[OCREngine] eng+hin load failed, falling back to eng:', dualErr.message);
          createdWorker = await tess.createWorker('eng', 1, workerOptions);
        }

        worker = createdWorker;
        isInitialized = true;
        console.log(`[OCREngine] Tesseract worker ready in ${Math.round(performance.now() - tStart)}ms`);
        return worker;
      } catch (err) {
        console.error('[OCREngine] Worker initialization failed:', err);
        worker = null;
        isInitialized = false;
        initPromise = null;
        return null;
      }
    })();

    return initPromise;
  }

  /**
   * Run OCR on a specific cropped region.
   */
  async function recognizeRegion(regionDataUrl, regionBbox) {
    const w = await initialize();
    if (!w) return [];

    try {
      const preprocessed = await preprocessCropForOCR(regionDataUrl);
      if (preprocessed.skipped) return [];

      const invScale = 1.0 / (preprocessed.scale || 1.0);
      const pad = preprocessed.pad || 0;

      // Ensure single uniform block of text mode for structured invoices/documents
      await w.setParameters({ tessedit_pageseg_mode: '6' });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OCR Timeout')), 15000)
      );

      const result = await Promise.race([
        w.recognize(preprocessed.dataUrl),
        timeoutPromise
      ]);

      if (!result || !result.data) return [];

      const regX = Math.round(regionBbox.x);
      const regY = Math.round(regionBbox.y);

      // Prefer native Tesseract layout engine lines
      if (result.data.lines && result.data.lines.length > 0) {
        const lineItems = [];
        result.data.lines.forEach((line, lineIdx) => {
          const words = (line.words || []).filter(w => (w.confidence === undefined || w.confidence > 5) && w.text && w.text.trim());
          words.forEach((wrd, wordIdx) => {
            lineItems.push({
              text: wrd.text.trim(),
              confidence: (wrd.confidence ?? 80) / 100,
              lineIndex: lineIdx,
              wordIndex: wordIdx,
              bbox: {
                x: regX + Math.round((wrd.bbox.x0 - pad) * invScale),
                y: regY + Math.round((wrd.bbox.y0 - pad) * invScale),
                width: Math.max(1, Math.round((wrd.bbox.x1 - wrd.bbox.x0) * invScale)),
                height: Math.max(1, Math.round((wrd.bbox.y1 - wrd.bbox.y0) * invScale)),
              },
              source: 'ocr',
            });
          });
        });
        if (lineItems.length > 0) return lineItems;
      }

      if (!result.data.words) return [];

      return result.data.words
        .filter(wrd => (wrd.confidence === undefined || wrd.confidence > 5) && wrd.text && wrd.text.trim())
        .map(wrd => ({
          text: wrd.text.trim(),
          confidence: (wrd.confidence ?? 80) / 100,
          bbox: {
            x: regX + Math.round((wrd.bbox.x0 - pad) * invScale),
            y: regY + Math.round((wrd.bbox.y0 - pad) * invScale),
            width: Math.max(1, Math.round((wrd.bbox.x1 - wrd.bbox.x0) * invScale)),
            height: Math.max(1, Math.round((wrd.bbox.y1 - wrd.bbox.y0) * invScale)),
          },
          source: 'ocr',
        }));
    } catch (err) {
      console.warn('[OCREngine] Recognition failed or timed out:', err.message);
      // If timed out, terminate hung worker so subsequent OCR calls do not stall
      if (err.message && err.message.includes('Timeout')) {
        try {
          if (worker && typeof worker.terminate === 'function') {
            worker.terminate().catch(() => {});
          }
        } catch (tErr) {}
        worker = null;
        isInitialized = false;
        initPromise = null;
      }
      return [];
    }
  }

  /**
   * Group OCR word tokens into lines and reconstruct text with layout preservation.
   */
  function buildTextAndTokens(ocrResults) {
    if (!ocrResults || ocrResults.length === 0) {
      return { text: '', tokens: [] };
    }

    const lines = [];
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
        if (!placed) lines.push([item]);
      }

      lines.sort((l1, l2) => {
        const y1 = l1.reduce((sum, w) => sum + w.bbox.y, 0) / l1.length;
        const y2 = l2.reduce((sum, w) => sum + w.bbox.y, 0) / l2.length;
        return y1 - y2;
      });

      for (const line of lines) {
        line.sort((a, b) => a.bbox.x - b.bbox.x);
      }
    }

    let fullText = '';
    const tokens = [];
    const lineItems = [];
    let tokenIndex = 0;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let lineText = '';
      const lineTokens = [];

      for (let wi = 0; wi < line.length; wi++) {
        const word = line[wi];
        const start = fullText.length;
        fullText += word.text;
        const end = fullText.length;
        tokenIndex++;
        const tok = {
          id: `ocr_${String(tokenIndex).padStart(4, '0')}`,
          text: word.text,
          start,
          end,
          bbox: word.bbox,
          confidence: word.confidence,
        };
        tokens.push(tok);

        const lStart = lineText.length;
        lineText += word.text;
        const lEnd = lineText.length;
        lineTokens.push({
          id: tok.id,
          text: word.text,
          start: lStart,
          end: lEnd,
          bbox: word.bbox,
          confidence: word.confidence,
        });

        if (wi < line.length - 1) {
          fullText += ' ';
          lineText += ' ';
        }
      }

      if (line.length > 0 && lineText.trim()) {
        const lx1 = Math.min(...line.map(w => w.bbox.x));
        const ly1 = Math.min(...line.map(w => w.bbox.y));
        const lx2 = Math.max(...line.map(w => w.bbox.x + w.bbox.width));
        const ly2 = Math.max(...line.map(w => w.bbox.y + w.bbox.height));
        lineItems.push({
          text: lineText,
          tokens: lineTokens,
          bbox: { x: lx1, y: ly1, width: lx2 - lx1, height: ly2 - ly1 },
          source: 'ocr',
          coordinateSpace: 'screenshot'
        });
      }

      if (li < lines.length - 1) {
        fullText += '\n';
      }
    }

    return { text: fullText, tokens, lineItems };
  }

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

  function mapSpanToBoxes(spanStart, spanEnd, tokens) {
    const matched = tokens.filter(t => t.end > spanStart && t.start < spanEnd);
    if (matched.length === 0) return { bbox: null, boxes: [], tokens: [] };

    const items = matched.map(t => ({
      id: t.id,
      bbox: computeTokenSubBox(t, spanStart, spanEnd)
    }));

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
   * Detects official identity card documents (Aadhaar, PAN, Passport, Voter ID, Driving Licence).
   * Rather than relying solely on character-level OCR across complex Devanagari scripts and small fonts,
   * high-confidence header/authority and card signatures trigger an opaque full-card privacy shield.
   * This also protects unparsed embedded QR codes, barcodes, and printed biometric photos.
   */
  function detectIdentityDocumentShield(regionText, regionBbox, ocrWords = [], piiMatches = []) {
    if (!regionBbox) return null;
    const regW = regionBbox.width;
    const regH = regionBbox.height;
    if (regW < 80 || regH < 50) return null;

    const lower = (regionText || '').toLowerCase();

    // ── Direct Check: Check if PII detector already found confirmed identity credentials in this region ──
    const hasAadhaarPii = Array.isArray(piiMatches) && piiMatches.some(m => 
      m.type === 'aadhaar' || 
      (m.patternName && m.patternName.includes('aadhaar'))
    );
    const hasPanPii = Array.isArray(piiMatches) && piiMatches.some(m => 
      m.type === 'pan' || 
      (m.patternName && m.patternName.includes('pan'))
    );
    const hasVoterPii = Array.isArray(piiMatches) && piiMatches.some(m => 
      m.type === 'voter_id' || 
      (m.patternName && m.patternName.includes('voter'))
    );

    // ── 1. PAN Card Signature (Permanent Account Number) ──
    const hasPanNumber = hasPanPii || /\b[A-Z]{5}[0-9]{4}[A-Z]\b/.test(regionText);
    const hasPanAuth = (
      /inco?me\s*tax\s*dep[a-z]*|आयकर\s*विभाग/i.test(regionText) ||
      /govt\.?\s*of\s*ind[li1|]a.*?(?:tax|pan|income|nsdl|utiitsl)/i.test(regionText) ||
      /\b(?:nsdl|utiitsl|protean)\b/i.test(lower)
    );
    const hasPanDoc = (
      /permanent\s*account\s*number|स्थायी\s*लेखा\s*संख्या/i.test(regionText) ||
      /\bpan\s*(?:card|no|number)\b/i.test(regionText)
    );

    if (
      (hasPanNumber && (hasPanAuth || hasPanDoc || /father|birth|signature|permanent/i.test(lower))) ||
      (hasPanAuth && hasPanDoc) ||
      /permanent\s*account\s*number|स्थायी\s*लेखा\s*संख्या/i.test(regionText)
    ) {
      return {
        id: 'pan',
        label: 'PAN Card Document',
        reason: 'document_shield:pan_card',
        confidence: 1.0,
        bbox: regionBbox
      };
    }

    // ── 2. Aadhaar Card Signature ──
    // a. Checksum-validated Aadhaar number OR 16-digit VID pattern in region text
    const hasAadhaarNumber = hasAadhaarPii || /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/.test(regionText) || /\b\d{4}\s\d{4}\s\d{4}\s\d{4}\b/.test(regionText);
    
    // b. Authority keywords (tolerant of OCR typos like Govemment, Indla, U1DAI, Uldai)
    const hasAadhaarAuth = (
      /uni?que\s*identifi?cation\s*auth?ori?ty|भारतीय\s*विशिष्ट\s*पहचान|uidai|u1dai|uldai/i.test(regionText) ||
      /gove?rn?me?nt\s*of\s*ind[li1|]a|govt\.?\s*of\s*ind[li1|]a|भारत\s*सरकार/i.test(regionText)
    );

    // c. Identity anchors
    const hasAadhaarDoc = (
      /\b(?:aadhaar|aadhar|आधार)\b/i.test(regionText) ||
      /\b(?:vid|virtual\s*id)\b/i.test(regionText) ||
      /mera\s*aadhaar|मेरा\s*आधार|meri\s*pehchan|मेरी\s*पहचान|uidai\.gov\.in|helpdesk\s*:\s*1947|\b1947\b/i.test(regionText) ||
      /enrol(?:l)?ment\s*(?:no|number)|नामांकन\s*संख्या/i.test(regionText)
    );

    // Trigger Aadhaar Shield:
    // 1) Aadhaar number / VID is present in the image
    // 2) UIDAI or Mera Aadhaar keyword is present
    // 3) Aadhaar doc keyword is present
    // 4) Govt of India + identity anchor (DOB, Gender, Address, Enrollment)
    if (
      hasAadhaarNumber ||
      /uidai|u1dai|uldai|mera\s*aadhaar|मेरा\s*आधार|meri\s*pehchan|मेरी\s*पहचान/i.test(regionText) ||
      hasAadhaarDoc ||
      (hasAadhaarAuth && /dob|birth|male|female|gender|address|s\/o|d\/o|w\/o|enrol/i.test(regionText))
    ) {
      return {
        id: 'aadhaar',
        label: 'Aadhaar Card Document',
        reason: 'document_shield:aadhaar_card',
        confidence: 1.0,
        bbox: regionBbox
      };
    }

    // ── 3. Voter ID / EPIC Card (Election Commission of India) ──
    const hasVoterNumber = hasVoterPii || /\b[A-Z]{3}[0-9]{7}\b/.test(regionText);
    const hasVoterAuth = /election\s*commission\s*of\s*ind[li1|]a|भारत\s*निर्वाचन\s*आयोग/i.test(regionText);
    const hasVoterDoc = (
      /elector\s*photo\s*identity\s*card|मतदाता\s*फोटो\s*पहचान\s*पत्र/i.test(regionText) ||
      /\b(?:epic\s*no|voter\s*id|elector\s*name)\b/i.test(regionText)
    );
    if ((hasVoterNumber && (hasVoterAuth || hasVoterDoc)) || (hasVoterAuth && hasVoterDoc) || /elector\s*photo\s*identity/i.test(regionText)) {
      return {
        id: 'voter_id',
        label: 'Voter ID Card Document',
        reason: 'document_shield:voter_id',
        confidence: 1.0,
        bbox: regionBbox
      };
    }

    // ── 4. Indian Passport ──
    const hasPassportAuth = (
      /republic\s*of\s*ind[li1|]a|भारत\s*गणराज्य/i.test(regionText) ||
      /ministry\s*of\s*external\s*affairs|विदेश\s*मंत्रालय/i.test(regionText)
    );
    const hasPassportDoc = (
      /\b(?:passport|पासपोर्ट)\b/i.test(regionText) ||
      /type\s*<\s*p|p\s*<\s*ind|country\s*code\s*ind/i.test(regionText) ||
      /passport\s*no|पासपोर्ट\s*संख्या/i.test(regionText)
    );
    if ((hasPassportAuth && hasPassportDoc) || /p\s*<\s*ind/i.test(regionText)) {
      return {
        id: 'passport',
        label: 'Indian Passport Document',
        reason: 'document_shield:passport',
        confidence: 1.0,
        bbox: regionBbox
      };
    }

    // ── 5. Driving Licence (Union of India / State Transport Department) ──
    const hasDlAuth = (
      /union\s*of\s*ind[li1|]a|transport\s*dep[a-z]*|motor\s*vehicles/i.test(regionText) ||
      /state\s*transport|regional\s*transport|\brto\b/i.test(regionText)
    );
    const hasDlDoc = (
      /driving\s*licen[cs]e|ड्राइविंग\s*लाइसेंस/i.test(regionText) ||
      /\b(?:dl\s*no|form\s*7|authorisation\s*to\s*drive)\b/i.test(regionText)
    );
    if ((hasDlAuth && hasDlDoc) || /driving\s*licen[cs]e/i.test(regionText)) {
      return {
        id: 'driving_licence',
        label: 'Driving Licence Document',
        reason: 'document_shield:driving_licence',
        confidence: 1.0,
        bbox: regionBbox
      };
    }

    return null;
  }

  /**
   * Detect form field anchors in documents, receipts, and invoices.
   * Cursive handwriting on paper forms cannot be reliably transcribed by typographic OCR,
   * but the printed labels define the geometric location of the sensitive handwritten values.
   */
  function detectFormFieldAnchors(ocrWords, regionBbox, existingMatches = []) {
    if (!ocrWords || !ocrWords.length) return [];
    const anchors = [];
    const regX = regionBbox.x;
    const regY = regionBbox.y;
    const regW = regionBbox.width;
    const regH = regionBbox.height;
    const rightEdge = regX + regW - 6;

    // Group words into lines
    const lines = [];
    const sorted = [...ocrWords].sort((a, b) => a.bbox.y - b.bbox.y);
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
      if (!placed) lines.push([item]);
    }

    const fullDocText = ocrWords.map(w => w.text).join(' ').toLowerCase();
    const isInvoiceOrForm = /\b(?:tax\s*invoice|retail\s*invoice|invoice|bill\s*of\s*supply|cash\s*memo|cash\s*receipt|challan)\b/i.test(fullDocText);

    let foundName = existingMatches.some(m => m.type === 'name');
    let foundMob = existingMatches.some(m => m.type === 'phone');
    let foundImei = existingMatches.some(m => m.type === 'device_id');
    let foundSignature = false;

    for (const line of lines) {
      line.sort((a, b) => a.bbox.x - b.bbox.x);
      const lineClean = line.map(w => w.text).join(' ').toLowerCase();

      for (let wi = 0; wi < line.length; wi++) {
        const w = line[wi];
        const clean = w.text.toLowerCase().replace(/[^a-z0-9!]/g, '');

        const getSubsequent = (fromX) => line.filter(other => other.bbox.x > fromX);

        // ── Anchor 1: Customer Name ──
        if (!foundName && w.bbox.y < regY + regH * 0.48 &&
            (/^(?:name|buyer|patient|applicant)$/i.test(clean) ||
             (clean === 'customer' && !lineClean.includes('signature')) ||
             (clean === 'nam' && line[wi + 1] && /^(?:e|is)$/i.test(line[wi + 1].text.toLowerCase().replace(/[^a-z]/g, ''))))) {
          let refWord = w;
          if (line[wi + 1] && /^[:\-\.]$/.test(line[wi + 1].text.trim())) {
            refWord = line[wi + 1];
          }
          const startX = refWord.bbox.x + refWord.bbox.width + 4;
          const dateWord = line.find(other => other.bbox.x > startX && /date/i.test(other.text));
          const limitRight = dateWord ? (dateWord.bbox.x - 8) : (regX + regW * 0.78);
          const subsequent = getSubsequent(startX).filter(sw => sw.bbox.x < limitRight);
          let valW = Math.round(regW * 0.40);
          if (subsequent.length > 0) {
            const maxRight = Math.max(...subsequent.map(sw => sw.bbox.x + sw.bbox.width));
            valW = Math.max(valW, maxRight - startX + 10);
          }
          valW = Math.min(limitRight - startX, Math.min(220, valW));

          anchors.push({
            type: 'name',
            text: 'Customer Name (Handwritten Field)',
            confidence: 0.98,
            decision: 'REDACT',
            reason: 'form_field_anchor:name',
            bbox: {
              x: startX,
              y: Math.max(regY + 2, refWord.bbox.y - 4),
              width: Math.max(80, valW),
              height: Math.max(refWord.bbox.height + 10, 26)
            }
          });
          foundName = true;
        }

        // ── Anchor 2: Mobile / Phone ──
        // Only accept phone labels in the customer details section (top 42% of document)
        if (!foundMob && w.bbox.y < regY + regH * 0.42 &&
            /^(?:mob|mod|mobile|phone|contact|tel|cell|ono)$/i.test(clean)) {
          const prevWord = line[wi - 1];
          if (prevWord && /smart|feature|cell|mobile|charger|battery/i.test(prevWord.text)) continue;

          let refWord = w;
          const nextW = line[wi + 1];
          if (nextW && /^(?:no|num|nos)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
            refWord = nextW;
          }
          if (line[wi + 1] && /^[:\-\.]$/.test(line[wi + 1].text.trim())) {
            refWord = line[wi + 1];
          }
          const startX = refWord.bbox.x + refWord.bbox.width + 4;
          const limitRight = regX + regW * 0.85;
          const subsequent = getSubsequent(startX).filter(sw => sw.bbox.x < limitRight);
          let valW = Math.round(regW * 0.45);
          if (subsequent.length > 0) {
            const maxRight = Math.max(...subsequent.map(sw => sw.bbox.x + sw.bbox.width));
            valW = Math.max(valW, maxRight - startX + 10);
          }
          valW = Math.min(limitRight - startX, Math.min(220, valW));

          anchors.push({
            type: 'phone',
            text: 'Mobile Number (Handwritten Field)',
            confidence: 0.98,
            decision: 'REDACT',
            reason: 'form_field_anchor:phone',
            bbox: {
              x: startX,
              y: Math.max(regY + 2, refWord.bbox.y - 4),
              width: Math.max(80, valW),
              height: Math.max(refWord.bbox.height + 10, 26)
            }
          });
          foundMob = true;
        }

        // ── Anchor 3: IMEI / Serial No ──
        if (!foundImei && /^(?:imei|ime|ime!|me!|serial|sr|sl)$/i.test(clean)) {
          let refWord = w;
          const nextW = line[wi + 1];
          if (nextW && /^(?:no|num|nos)$/i.test(nextW.text.toLowerCase().replace(/[^a-z]/g, ''))) {
            refWord = nextW;
          }
          const startX = refWord.bbox.x + refWord.bbox.width + 4;
          const limitRight = regX + regW * 0.72;
          const subsequent = getSubsequent(startX).filter(sw => sw.bbox.x < limitRight);
          let valW = Math.round(regW * 0.45);
          if (subsequent.length > 0) {
            const maxRight = Math.max(...subsequent.map(sw => sw.bbox.x + sw.bbox.width));
            valW = Math.max(valW, maxRight - startX + 10);
          }
          valW = Math.min(limitRight - startX, Math.min(220, valW));

          anchors.push({
            type: 'device_id',
            text: 'Device IMEI (Handwritten Field)',
            confidence: 0.98,
            decision: 'REDACT',
            reason: 'form_field_anchor:imei',
            bbox: {
              x: startX,
              y: Math.max(regY + 2, refWord.bbox.y - 4),
              width: Math.max(80, valW),
              height: Math.max(refWord.bbox.height + 10, 28)
            }
          });
          foundImei = true;
        }

        // ── Anchor 4: Signature ──
        if (!foundSignature && (/signature|signatory|bugnacure|bgnarure/i.test(clean) || (clean === 'sign' && line.length <= 4))) {
          if (w.bbox.x > regX + regW * 0.5 && w.bbox.y > regY + regH * 0.70) {
            const sigX = Math.max(regX + Math.round(regW * 0.68), w.bbox.x - 30);
            const sigY = Math.max(regY + Math.round(regH * 0.82), w.bbox.y - 50);
            const sigW = Math.min(rightEdge - sigX, Math.round(regW * 0.29));
            anchors.push({
              type: 'signature',
              text: 'Authorized Signature Ink',
              confidence: 0.95,
              decision: 'REDACT',
              reason: 'form_field_anchor:signature',
              bbox: { x: sigX, y: sigY, width: Math.max(90, sigW), height: 58 }
            });
            foundSignature = true;
          }
        }
      }
    }

    // ── Form Structure Fallback (only for confirmed printed tax invoices/bills) ──
    if (isInvoiceOrForm) {
      if (!foundName) {
        const nameX = regX + Math.round(regW * 0.17);
        const nameY = regY + Math.round(regH * 0.27);
        const nameW = Math.min(220, Math.round(regW * 0.50));
        anchors.push({
          type: 'name',
          text: 'Customer Name Field (Form Region)',
          confidence: 0.96,
          decision: 'REDACT',
          reason: 'form_field_anchor:name_slot',
          bbox: { x: nameX, y: nameY, width: nameW, height: 26 }
        });
      }

      if (!foundMob) {
        const mobX = regX + Math.round(regW * 0.18);
        const mobY = regY + Math.round(regH * 0.32);
        const mobW = Math.min(220, Math.round(regW * 0.50));
        anchors.push({
          type: 'phone',
          text: 'Mobile Number Field (Form Region)',
          confidence: 0.96,
          decision: 'REDACT',
          reason: 'form_field_anchor:phone_slot',
          bbox: { x: mobX, y: mobY, width: mobW, height: 28 }
        });
      }

      if (!foundImei) {
        const imeiX = regX + Math.round(regW * 0.28);
        const imeiY = regY + Math.round(regH * 0.47);
        const imeiW = Math.min(220, Math.round(regW * 0.50));
        anchors.push({
          type: 'device_id',
          text: 'IMEI / Serial Field (Form Region)',
          confidence: 0.96,
          decision: 'REDACT',
          reason: 'form_field_anchor:imei_slot',
          bbox: { x: imeiX, y: imeiY, width: imeiW, height: 28 }
        });
      }
    }

    return anchors;
  }

  /**
   * Processes selected regions for OCR and applies the shared PII detector.
   */
  async function processRegions(screenshotDataUrl, regions, mapper) {
    if (!regions || regions.length === 0) {
      return { detections: [], rawText: '', words: [], itemsForNER: [] };
    }

    while (isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    isProcessing = true;

    try {
      await initialize();
      if (!worker) return { detections: [], rawText: '', words: [], itemsForNER: [] };

      const allOcrDetections = [];
      let fullRawText = '';
      const allWords = [];
      const itemsForNER = [];

      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const rId = region.regionId || `region_${i}`;

        const rawMapped = mapper.mapBbox(region.bbox);
        const screenshotBbox = {
          x: Math.max(0, Math.round(rawMapped.x)),
          y: Math.max(0, Math.round(rawMapped.y)),
          width: Math.round(rawMapped.width),
          height: Math.round(rawMapped.height),
        };

        const minDim = Math.min(screenshotBbox.width, screenshotBbox.height);
        const maxDim = Math.max(screenshotBbox.width, screenshotBbox.height);
        if (minDim < 25 || screenshotBbox.width < 50 || (maxDim / Math.max(minDim, 1)) > 8) {
          continue; // Skip thin lines, dividers, or tiny graphics that trigger Leptonica scaling warnings
        }

        const cropDataUrl = await Privamon.Redactor.extractRegion(screenshotDataUrl, screenshotBbox);
        const ocrResults = await recognizeRegion(cropDataUrl, screenshotBbox);

        for (const w of ocrResults) {
          allWords.push({
            text: w.text,
            bbox: w.bbox,
            confidence: w.confidence,
            source: 'ocr'
          });
        }

        const { text: regionText, tokens: tokenList, lineItems } = buildTextAndTokens(ocrResults);

        if (regionText.trim()) {
          fullRawText += `\n--- Region ${rId} ---\n${regionText}\n`;

          // Feed into shared PII detector FIRST so detected PII matches can be used for document shielding
          const piiMatches = Privamon.PIIDetector.detectPII(regionText, '', 'ocr');

          // 1. Identity Document Shield Detection (Full-Card Redaction for Aadhaar, PAN, Passport, Voter ID, Driving Licence)
          const docShield = detectIdentityDocumentShield(regionText, screenshotBbox, ocrResults, piiMatches);
          if (docShield) {
            console.log(`[OCREngine] 🛡️ Identity Document Shield activated: ${docShield.label} for region ${rId}`);
            allOcrDetections.push(Privamon.PIIDetector.toCandidate({
              type: 'identity_document',
              source: 'ocr_document_shield',
              text: `[${docShield.label} - Full Shield]`,
              bbox: docShield.bbox,
              boxes: [docShield.bbox],
              tokens: tokenList.map(t => t.id),
              confidence: docShield.confidence,
              decision: 'REDACT',
              reason: docShield.reason,
              coordinateSpace: 'screenshot'
            }));
          }

          // Track line-level items for NER batching with accurate line bounding boxes
          if (lineItems && lineItems.length > 0) {
            itemsForNER.push(...lineItems);
          } else {
            itemsForNER.push({
              text: regionText,
              tokens: tokenList,
              source: 'ocr',
              bbox: screenshotBbox,
              coordinateSpace: 'screenshot'
            });
          }

          for (const match of piiMatches) {
            const mappedBoxes = mapSpanToBoxes(match.span.start, match.span.end, tokenList);
            if (mappedBoxes.bbox) {
              allOcrDetections.push(Privamon.PIIDetector.toCandidate({
                type: match.type,
                source: 'ocr',
                text: match.text,
                bbox: mappedBoxes.bbox,
                boxes: mappedBoxes.boxes,
                tokens: mappedBoxes.tokens,
                confidence: match.confidence,
                reason: `ocr_regex:${match.patternName}${match.checksumValidated ? ':checksum_valid' : ''}`,
                coordinateSpace: 'screenshot'
              }));
            }
          }

          // Form field anchor detection (handles handwritten cursive names, phones, IMEIs, and signatures)
          const formAnchors = detectFormFieldAnchors(ocrResults, screenshotBbox, piiMatches);
          for (const anchor of formAnchors) {
            allOcrDetections.push(Privamon.PIIDetector.toCandidate({
              type: anchor.type,
              source: 'ocr',
              text: anchor.text,
              bbox: anchor.bbox,
              boxes: [anchor.bbox],
              tokens: [],
              confidence: anchor.confidence,
              decision: anchor.decision || 'REDACT',
              reason: anchor.reason,
              coordinateSpace: 'screenshot'
            }));
          }
        }
      }

      return {
        detections: allOcrDetections,
        rawText: fullRawText,
        words: allWords,
        itemsForNER
      };
    } finally {
      isProcessing = false;
    }
  }

  function terminate() {
    if (worker) {
      worker.terminate().catch(() => {});
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
