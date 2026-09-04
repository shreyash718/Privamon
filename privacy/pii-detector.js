/**
 * Privamon — PII Detector
 *
 * Detects Personally Identifiable Information (PII) in text using:
 *   A) HTML semantic analysis (input types, autocomplete, name attributes)
 *   B) Regex-based pattern matching with context boosting and negative prefix suppression
 *   C) High-accuracy local ML/NLP engine bridge (Presidio + GLiNER) via detectAsync()
 *
 * Each detection produces:
 *   { type, text, confidence, span: {start, end}, source: 'dom'|'ocr', bbox?, boxes? }
 */
var Privamon = Privamon || {};

Privamon.PIIDetector = (() => {
  'use strict';

  const LOCAL_ENGINE_URL = 'http://127.0.0.1:8765/detect';
  const LOCAL_ENGINE_BATCH_URL = 'http://127.0.0.1:8765/detect/batch';
  const ENGINE_TIMEOUT_MS = 3000;

  // ── Verhoeff Checksum Tables (for Aadhaar validation) ──
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];

  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];

  function validateVerhoeff(numStr) {
    const digits = String(numStr).replace(/\D/g, '');
    if (!digits) return false;
    let c = 0;
    const reversed = digits.split('').reverse();
    for (let i = 0; i < reversed.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][parseInt(reversed[i], 10)]];
    }
    return c === 0;
  }

  // ── Luhn Check for Credit Cards ──
  function luhnCheck(text) {
    const digits = text.replace(/[\s\-]/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    if (!/^\d+$/.test(digits)) return false;

    let sum = 0;
    let isEven = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = parseInt(digits[i], 10);
      if (isEven) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      isEven = !isEven;
    }
    return sum % 10 === 0;
  }

  // ── Aadhaar Full Validation (Format + Verhoeff Checksum) ──
  function aadhaarCheck(text) {
    const digits = text.replace(/[\s\-]/g, '');
    if (digits.length !== 12) return false;
    if (!/^\d{12}$/.test(digits)) return false;
    // Aadhaar does not start with 0 or 1
    if (digits[0] === '0' || digits[0] === '1') return false;
    return validateVerhoeff(digits);
  }

  // ── Negative Prefix Context Filter ──
  // Suppresses false positives where order IDs, invoices, tracking codes, or PIN codes resemble PII
  const NEGATIVE_PREFIX_REGEX = /(?:order\s*(?:id|#|no|num)?|invoice\s*(?:id|#|no|num)?|tracking\s*(?:id|#|no|num)?|product\s*(?:code|id|#)?|item\s*(?:code|id|#|no)?|sku\s*(?:#|no)?|pin\s*(?:code)?|pincode|postal\s*(?:code)?|zip\s*(?:code)?)\s*[:#\-]?\s*$/i;

  function hasNegativePrefix(fullText, matchStart) {
    const windowStart = Math.max(0, matchStart - 40);
    const preceding = fullText.slice(windowStart, matchStart);
    return NEGATIVE_PREFIX_REGEX.test(preceding);
  }

  // ── Regex Patterns ──
  const PATTERNS = [
    {
      name: 'email',
      // OCR safe, ignores sentence trailing punctuation
      regex: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
      type: 'email',
      baseConfidence: 0.92,
      validator: (text) => {
        return !text.endsWith('.') && !text.endsWith(',') && text.includes('@');
      }
    },
    {
      name: 'upi_id',
      regex: /\b[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}(?!\.[a-zA-Z])\b/gi,
      type: 'financial',
      baseConfidence: 0.85,
      validator: (text) => {
        const lower = text.toLowerCase();
        const handles = ['okhdfcbank', 'okaxis', 'oksbi', 'okicici', 'paytm', 'ybl', 'ibl', 'axl', 'apl', 'upi', 'gpay', 'phonepe', 'barodampay', 'federal'];
        const parts = lower.split('@');
        if (parts.length !== 2) return false;
        if (parts[1].includes('.')) return false; // Email domains contain dots, UPI handles don't
        return handles.includes(parts[1]) || /^[a-zA-Z]{3,20}$/.test(parts[1]);
      }
    },
    {
      name: 'phone_indian',
      regex: /\b(?:\+91[\s\-]?)?(?:\(?0?\)?[\s\-]?)?[6-9](?:\d[\s\-]?){9}\b/g,
      type: 'phone',
      baseConfidence: 0.80,
    },
    {
      name: 'phone_intl',
      regex: /\b(?:\+\d{1,3}[\s.\-]?)?\(?\d{3,4}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
      type: 'phone',
      baseConfidence: 0.70,
    },
    {
      name: 'credit_card',
      regex: /\b(?:\d[\s\-]?){13,19}\b/g,
      type: 'creditCard',
      baseConfidence: 0.75,
      validator: luhnCheck,
    },
    {
      name: 'aadhaar',
      regex: /\b(?:\d[\s\-]?){12}\b/g,
      type: 'aadhaar',
      baseConfidence: 0.85,
      validator: aadhaarCheck,
    },
    {
      name: 'pan',
      regex: /\b(?:[A-Z][\s\-]*){5}(?:\d[\s\-]*){4}[A-Z]\b/gi,
      type: 'pan',
      baseConfidence: 0.85,
      // PAN format: AAAAA9999A — 4th char indicates entity type
      validator: (text) => {
        const clean = text.replace(/[\s\-]/g, '').toUpperCase();
        if (clean.length !== 10) return false;
        const fourthChar = clean[3];
        return 'ABCFGHLJPT'.includes(fourthChar);
      },
    },
    {
      name: 'driving_licence_indian',
      regex: /\b[A-Z]{2}[-\s]?\d{2}[-\s]?(?:19|20)\d{2}[-\s]?\d{7}\b/gi,
      type: 'id',
      baseConfidence: 0.85,
    },
    {
      name: 'voter_id_indian',
      regex: /\b[A-Z]{3}[0-9]{7}\b/gi,
      type: 'id',
      baseConfidence: 0.85,
    },
    {
      name: 'ip_address',
      regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)[\s]*\.[\s]*){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      type: 'ip',
      baseConfidence: 0.60,
    },
    {
      name: 'passport_indian',
      // Indian Passport: 1 letter (except Q, X, Z), 7 digits (first digit non-zero)
      regex: /\b[A-PR-WYa-pr-wy][1-9]\d{6}\b/gi,
      type: 'passport',
      baseConfidence: 0.85,
    },
    {
      name: 'ifsc_code',
      // Indian Bank IFSC Code: 4 letters, '0', 6 alphanumeric
      regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,
      type: 'financial',
      baseConfidence: 0.85,
    },
    {
      name: 'jwt_token',
      regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      type: 'apiToken',
      baseConfidence: 0.95,
    },
    {
      name: 'api_key',
      regex: /\b(?:sk_live|pk_live|bearer|api_key)_[a-zA-Z0-9]+\b/gi,
      type: 'apiToken',
      baseConfidence: 0.95,
    },
    {
      name: 'otp',
      regex: /\b\d{4,8}\b/g,
      type: 'otp',
      baseConfidence: 0.10, // Must be boosted by context
    },
    {
      name: 'coordinates',
      regex: /\b[-+]?(?:90(?:\.0{1,6})?|[1-8]?\d(?:\.\d{1,6})?)[,\s]+[-+]?(?:180(?:\.0{1,6})?|(?:1[0-7]\d|[1-9]?\d)(?:\.\d{1,6})?)\b/g,
      type: 'location',
      baseConfidence: 0.85,
    },
    {
      name: 'dob',
      regex: /\b(?:0?[1-9]|[12]\d|3[01])[\/\-\.](?:0?[1-9]|1[0-2])[\/\-\.](?:19|20)\d{2}\b/g,
      type: 'dob',
      baseConfidence: 0.40,
    },
  ];

  // Context Keywords for confidence boosting
  const CONTEXT_KEYWORDS = {
    email:      ['email', 'e-mail', 'mail', 'contact', 'send', 'reach'],
    phone:      ['phone', 'mobile', 'cell', 'tel', 'telephone', 'contact', 'call', 'whatsapp', 'number'],
    creditCard: ['card', 'credit', 'debit', 'visa', 'master', 'amex', 'payment', 'cc'],
    aadhaar:    ['aadhaar', 'aadhar', 'uid', 'uidai', 'identity', 'verification'],
    pan:        ['pan', 'permanent account', 'income tax', 'tax', 'itr'],
    passport:   ['passport', 'travel document', 'nationality', 'visa'],
    financial:  ['ifsc', 'account', 'bank', 'routing', 'branch', 'swift', 'upi', 'paytm', 'gpay', 'phonepe'],
    ip:         ['ip', 'address', 'server', 'host', 'network'],
    dob:        ['birth', 'dob', 'born', 'birthday', 'age', 'date of birth'],
    name:       ['name', 'first name', 'last name', 'full name', 'fname', 'lname'],
    password:   ['password', 'passwd', 'pwd', 'secret'],
    otp:        ['otp', 'code', 'pin', 'verification code', 'one time password', 'auth code'],
    apiToken:   ['token', 'api key', 'bearer', 'auth token', 'session', 'jwt'],
    location:   ['lat', 'long', 'latitude', 'longitude', 'coordinates', 'location', 'gps'],
    address:    ['address', 'addr', 'street', 'city', 'state', 'zip', 'postal', 'pin code', 'pincode'],
  };

  const CONTEXT_BOOST = 0.35;

  function getContextBoost(fullText, matchStart, matchEnd, piiType) {
    const keywords = CONTEXT_KEYWORDS[piiType];
    if (!keywords) return 0;

    const windowStart = Math.max(0, matchStart - 100);
    const windowEnd = Math.min(fullText.length, matchEnd + 100);
    const context = fullText.slice(windowStart, windowEnd).toLowerCase();

    for (const keyword of keywords) {
      if (context.includes(keyword)) {
        return CONTEXT_BOOST;
      }
    }
    return 0;
  }

  // ── Main Detection Functions ──

  /**
   * Detect PII in a text string using local regex patterns.
   * @param {string} text - Text to analyze
   * @param {string} source - 'dom' or 'ocr'
   * @param {string} [nearbyContext=''] - Additional context text (e.g., label)
   * @returns {Array} Detections
   */
  function detectInText(text, source = 'dom', nearbyContext = '') {
    if (!text || typeof text !== 'string') return [];

    console.log(`[PII][${source.toUpperCase()}] detectInText INPUT: "${text}"`);
    const detections = [];
    const combinedText = nearbyContext ? `${nearbyContext} ${text}` : text;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;

      let match;
      while ((match = pattern.regex.exec(text)) !== null) {
        const matchText = match[0];

        // 1. Negative prefix filter: suppress false positives like Order ID, PIN Code, etc.
        if (['phone', 'otp', 'aadhaar', 'financial'].includes(pattern.type) && hasNegativePrefix(text, match.index)) {
          console.log(`[PII][${source.toUpperCase()}][SUPPRESSED] pattern=${pattern.name} text="${matchText}" near negative prefix.`);
          continue;
        }

        // 2. Run validator if present
        if (pattern.validator && !pattern.validator(matchText)) {
          console.log(`[PII][${source.toUpperCase()}][MATCH_FAILED] pattern=${pattern.name} matched="${matchText}" but failed validation.`);
          continue;
        }

        // 3. Calculate confidence with context boost
        let confidence = pattern.baseConfidence;
        confidence += getContextBoost(combinedText, match.index, match.index + matchText.length, pattern.type);
        confidence = Math.min(1.0, confidence);

        // Discard low confidence OTP matches without context boost
        if (pattern.type === 'otp' && confidence < 0.4) {
          continue;
        }

        console.log(`[PII][${source.toUpperCase()}][MATCH] pattern=${pattern.name} type=${pattern.type} text="${matchText}" span=[${match.index}, ${match.index + matchText.length}] conf=${confidence.toFixed(2)}`);

        detections.push({
          type: pattern.type,
          text: matchText,
          confidence,
          source,
          span: {
            start: match.index,
            end: match.index + matchText.length,
          },
          patternName: pattern.name,
        });
      }
    }

    console.log(`[PII][${source.toUpperCase()}] detectInText OUTPUT: ${detections.length} detections`);
    return detections;
  }

  /**
   * Asynchronously detect PII by querying the local Privamon Python engine
   * (Presidio + GLiNER) with bounding-box-aware tokens.
   * If the local engine is unreachable or errors, seamlessly falls back
   * to the enhanced local JS detector.
   *
   * @param {string} text - Text to analyze
   * @param {string} [source='ocr'] - 'dom' or 'ocr'
   * @param {string} [nearbyContext=''] - Additional context
   * @param {Array} [tokens=[]] - Optional OCR tokens with bounding boxes
   * @returns {Promise<Array>} Detections
   */
  async function detectAsync(text, source = 'ocr', nearbyContext = '', tokens = []) {
    if (!text || typeof text !== 'string') return [];

    console.log(`[PII][${source.toUpperCase()}] detectAsync invoked (text length: ${text.length}, tokens: ${tokens.length})`);

    // 1. Attempt local Python service
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);

      const payload = {
        text: text,
        source: source,
        context: nearbyContext || '',
        tokens: (tokens && tokens.length > 0) ? tokens : []
      };

      const response = await fetch(LOCAL_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        console.log(`[PII][${source.toUpperCase()}][ENGINE] Success: ${data.detections.length} detections (${data.processing_ms}ms)`);
        return data.detections.map(d => ({
          type: d.type,
          text: d.text,
          confidence: d.confidence,
          source: d.source || source,
          span: { start: d.start, end: d.end },
          bbox: d.bbox || null,
          boxes: d.boxes || (d.bbox ? [d.bbox] : null),
          reason: d.reason || `engine:${d.engine || 'hybrid'}`,
          patternName: d.pattern_name || d.type
        }));
      } else {
        console.warn(`[PII][${source.toUpperCase()}] Python engine responded status ${response.status}. Using JS fallback.`);
      }
    } catch (err) {
      console.log(`[PII][${source.toUpperCase()}] Python engine offline/unreachable (${err.message}). Using JS fallback.`);
    }

    // 2. Fallback: local JS detection
    return detectInText(text, source, nearbyContext);
  }

  /**
   * Batch detection for multiple text blocks in a single HTTP roundtrip.
   * @param {Array<{text: string, source?: string, context?: string, tokens?: Array}>} items
   * @returns {Promise<Array<Array>>} Array of detections per input item
   */
  async function detectBatchAsync(items) {
    if (!items || !items.length) return [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS * 2);

      const payload = {
        items: items.map(it => ({
          text: it.text || '',
          source: it.source || 'ocr',
          context: it.context || '',
          tokens: it.tokens || []
        }))
      };

      const response = await fetch(LOCAL_ENGINE_BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return (data.results || []).map((res, idx) => {
          const itemSource = items[idx]?.source || 'ocr';
          return (res.detections || []).map(d => ({
            type: d.type,
            text: d.text,
            confidence: d.confidence,
            source: d.source || itemSource,
            span: { start: d.start, end: d.end },
            bbox: d.bbox || null,
            boxes: d.boxes || (d.bbox ? [d.bbox] : null),
            reason: d.reason || `engine:${d.engine || 'hybrid'}`,
            patternName: d.pattern_name || d.type
          }));
        });
      }
    } catch (err) {
      console.log(`[PII] Python engine batch offline/error (${err.message}). Falling back to local JS.`);
    }

    // Fallback: local JS detection per item
    return items.map(it => detectInText(it.text || '', it.source || 'ocr', it.context || ''));
  }

  /**
   * Analyze a DOM element entry from the extractor for PII.
   * Combines semantic HTML analysis with regex-based text detection.
   *
   * @param {Object} element - Element entry from dom-extractor
   * @returns {Array} Detections with bounding boxes
   */
  function detectInElement(element) {
    const detections = [];

    // A) HTML Semantic Analysis for input elements
    if (element.inputType) {
      if (element.inputType === 'password') {
        detections.push({
          type: 'password',
          text: '[password field]',
          confidence: 1.0,
          source: 'dom',
          bbox: element.bbox,
          reason: 'input[type=password]',
        });
      }

      if (element.isSensitiveType && element.value) {
        const typeMap = { email: 'email', tel: 'phone', number: 'other' };
        detections.push({
          type: typeMap[element.inputType] || 'other',
          text: element.value,
          confidence: 0.90,
          source: 'dom',
          bbox: element.bbox,
          reason: `input[type=${element.inputType}]`,
        });
      }

      if (element.isSensitiveAutocomplete && element.value) {
        const acMap = {
          'cc-number': 'creditCard', 'cc-exp': 'creditCard', 'cc-csc': 'creditCard',
          'cc-name': 'creditCard', 'email': 'email', 'tel': 'phone', 'tel-national': 'phone',
          'name': 'name', 'given-name': 'name', 'family-name': 'name',
          'bday': 'dob', 'bday-day': 'dob', 'bday-month': 'dob', 'bday-year': 'dob',
          'address-line1': 'address', 'address-line2': 'address',
          'postal-code': 'address', 'country': 'address',
          'one-time-code': 'otp'
        };
        detections.push({
          type: acMap[element.autocomplete] || 'other',
          text: element.value,
          confidence: 0.88,
          source: 'dom',
          bbox: element.bbox,
          reason: `autocomplete=${element.autocomplete}`,
        });
      }

      if (element.sensitiveNameMatch && element.value) {
        detections.push({
          type: element.sensitiveNameMatch === 'password' ? 'password' : 'other',
          text: element.value,
          confidence: 0.75,
          source: 'dom',
          bbox: element.bbox,
          reason: `name/id contains '${element.sensitiveNameMatch}'`,
        });
      }
    }

    // B) Regex-based detection on text content
    const textToScan = element.text || element.value || '';
    const contextText = [element.label, element.placeholder, element.name, element.id]
      .filter(Boolean)
      .join(' ');

    if (textToScan) {
      const textDetections = detectInText(textToScan, 'dom', contextText);
      for (const det of textDetections) {
        let mapped = null;
        if (element.tokens && element.tokens.length > 0 && typeof Privamon !== 'undefined' && Privamon.DOMRangeMapper) {
          mapped = Privamon.DOMRangeMapper.mapSpanToDomBoxes(det.span.start, det.span.end, element.tokens);
        }

        const bbox = (mapped && mapped.bbox) ? mapped.bbox : element.bbox;
        const boxes = (mapped && mapped.boxes && mapped.boxes.length > 0) ? mapped.boxes : (bbox ? [bbox] : []);
        const tokenIds = (mapped && mapped.tokens) ? mapped.tokens : [];

        detections.push({
          ...det,
          bbox,
          boxes,
          tokens: tokenIds,
          elementId: element.id || element.testId || null,
        });
      }
    }

    if (element.label) {
      const labelDetections = detectInText(element.label, 'dom', '');
      for (const det of labelDetections) {
        detections.push({
          ...det,
          bbox: element.bbox,
          boxes: [element.bbox],
          reason: 'label text',
        });
      }
    }

    return detections;
  }

  /**
   * Detect PII across all extracted DOM elements.
   * @param {Array} elements - Elements from dom-extractor
   * @returns {Array} All detections
   */
  function detectAllDom(elements) {
    const allDetections = [];
    for (const element of elements) {
      if (element.isPixelContent) continue;
      const detections = detectInElement(element);
      allDetections.push(...detections);
    }
    return allDetections;
  }

  return {
    detectInText,
    detectAsync,
    detectBatchAsync,
    detectInElement,
    detectAllDom,
    validateVerhoeff,
    aadhaarCheck,
    hasNegativePrefix,
    PATTERNS,
    CONTEXT_KEYWORDS,
  };
})();
