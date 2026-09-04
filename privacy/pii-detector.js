/**
 * Privamon — PII Detector
 *
 * Detects Personally Identifiable Information (PII) in text using:
 *   A) HTML semantic analysis (input types, autocomplete, name attributes)
 *   B) Regex-based pattern matching with context boosting
 *
 * Each detection produces:
 *   { type, text, confidence, span: {start, end}, source: 'dom'|'ocr' }
 *
 * Designed to be extensible — additional NER/ML detectors can be plugged
 * into the PIIClassifier later.
 */
var Privamon = Privamon || {};

Privamon.PIIDetector = (() => {
  'use strict';

  // ── Regex Patterns ──
  // Each pattern has: regex, type, baseConfidence, validator (optional)
  const PATTERNS = [
    {
      name: 'email',
      // OCR might inject spaces around @ or .
      regex: /\b[a-zA-Z0-9._%+\-]+[\s]*@[\s]*[a-zA-Z0-9.\-]+[\s]*\.[\s]*[a-zA-Z]{2,}\b/g,
      type: 'email',
      baseConfidence: 0.92,
    },
    {
      name: 'phone_indian',
      // Added word boundaries \b to prevent matching inside longer random numbers
      regex: /\b(?:\+91[\s\-]?)?(?:\(?0?\)?[\s\-]?)?[6-9](?:\d[\s\-]?){9}\b/g,
      type: 'phone',
      baseConfidence: 0.80,
    },
    {
      name: 'phone_intl',
      // Stricter international phone number, must have \b
      regex: /\b(?:\+\d{1,3}[\s.\-]?)?\(?\d{3,4}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
      type: 'phone',
      baseConfidence: 0.70,
    },
    {
      name: 'credit_card',
      // OCR might space digits differently
      regex: /\b(?:\d[\s\-]?){13,19}\b/g,
      type: 'creditCard',
      baseConfidence: 0.75,
      validator: luhnCheck,
    },
    {
      name: 'aadhaar',
      // OCR might space digits differently, but it must be 12 digits
      regex: /\b(?:\d[\s\-]?){12}\b/g,
      type: 'aadhaar',
      baseConfidence: 0.70,
      validator: aadhaarCheck,
    },
    {
      name: 'pan',
      // OCR might inject spaces
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
      // JSON Web Token
      regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      type: 'apiToken',
      baseConfidence: 0.95,
    },
    {
      name: 'api_key',
      // Generic high-entropy API keys (Stripe, etc.)
      regex: /\b(?:sk_live|pk_live|bearer|api_key)_[a-zA-Z0-9]+\b/gi,
      type: 'apiToken',
      baseConfidence: 0.95,
    },
    {
      name: 'otp',
      // 4 to 8 digit numbers (Needs VERY high context boost)
      regex: /\b\d{4,8}\b/g,
      type: 'otp',
      baseConfidence: 0.10, // Basically 0 unless boosted by context
    },
    {
      name: 'coordinates',
      // Lat/Long coordinates
      regex: /\b[-+]?(?:90(?:\.0{1,6})?|[1-8]?\d(?:\.\d{1,6})?)[,\s]+[-+]?(?:180(?:\.0{1,6})?|(?:1[0-7]\d|[1-9]?\d)(?:\.\d{1,6})?)\b/g,
      type: 'location',
      baseConfidence: 0.85,
    },
    {
      name: 'dob',
      // DD/MM/YYYY or DD-MM-YYYY
      regex: /\b(?:0?[1-9]|[12]\d|3[01])[\/\-\.](?:0?[1-9]|1[0-2])[\/\-\.](?:19|20)\d{2}\b/g,
      type: 'dob',
      baseConfidence: 0.40, // Low base — needs context boost
    },
  ];

  // Context Keywords ──
  // Words near a match that boost confidence
  const CONTEXT_KEYWORDS = {
    email:      ['email', 'e-mail', 'mail', 'contact', 'send', 'reach'],
    phone:      ['phone', 'mobile', 'cell', 'tel', 'telephone', 'contact', 'call', 'whatsapp', 'number'],
    creditCard: ['card', 'credit', 'debit', 'visa', 'master', 'amex', 'payment', 'cc'],
    aadhaar:    ['aadhaar', 'aadhar', 'uid', 'uidai', 'identity', 'verification'],
    pan:        ['pan', 'permanent account', 'income tax', 'tax', 'itr'],
    passport:   ['passport', 'travel document', 'nationality', 'visa'],
    financial:  ['ifsc', 'account', 'bank', 'routing', 'branch', 'swift'],
    ip:         ['ip', 'address', 'server', 'host', 'network'],
    dob:        ['birth', 'dob', 'born', 'birthday', 'age', 'date of birth'],
    name:       ['name', 'first name', 'last name', 'full name', 'fname', 'lname'],
    password:   ['password', 'passwd', 'pwd', 'secret'],
    otp:        ['otp', 'code', 'pin', 'verification code', 'one time password', 'auth code'],
    apiToken:   ['token', 'api key', 'bearer', 'auth token', 'session', 'jwt'],
    location:   ['lat', 'long', 'latitude', 'longitude', 'coordinates', 'location', 'gps'],
    address:    ['address', 'addr', 'street', 'city', 'state', 'zip', 'postal', 'pin code', 'pincode'],
  };

  // Context boost amount
  const CONTEXT_BOOST = 0.35; // Increased to ensure context-dependent items (OTPs) cross the threshold

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

  // ── Aadhaar Basic Validation ──
  function aadhaarCheck(text) {
    const digits = text.replace(/[\s\-]/g, '');
    if (digits.length !== 12) return false;
    if (!/^\d{12}$/.test(digits)) return false;
    // Aadhaar doesn't start with 0 or 1
    if (digits[0] === '0' || digits[0] === '1') return false;
    return true;
  }

  // ── Context Analysis ──

  /**
   * Search for context keywords near a match position.
   * @param {string} fullText - The full text being analyzed
   * @param {number} matchStart - Start index of the match
   * @param {number} matchEnd - End index of the match
   * @param {string} piiType - The PII type to check context for
   * @returns {number} Context boost (0 to CONTEXT_BOOST)
   */
  function getContextBoost(fullText, matchStart, matchEnd, piiType) {
    const keywords = CONTEXT_KEYWORDS[piiType];
    if (!keywords) return 0;

    // Look at 100 characters before and after the match
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
   * Detect PII in a text string using regex patterns.
   * @param {string} text - Text to analyze
   * @param {string} source - 'dom' or 'ocr'
   * @param {string} [nearbyContext=''] - Additional context text (e.g., label)
   * @returns {Array} Detections
   */
  function detectInText(text, source = 'dom', nearbyContext = '') {
    if (!text || typeof text !== 'string') return [];

    const detections = [];
    const combinedText = nearbyContext ? `${nearbyContext} ${text}` : text;

    for (const pattern of PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.regex.lastIndex = 0;

      let match;
      while ((match = pattern.regex.exec(text)) !== null) {
        const matchText = match[0];

        // Run validator if present
        if (pattern.validator && !pattern.validator(matchText)) {
          continue;
        }

        // Calculate confidence with context boost
        let confidence = pattern.baseConfidence;
        confidence += getContextBoost(combinedText, match.index, match.index + matchText.length, pattern.type);
        confidence = Math.min(1.0, confidence);

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

    return detections;
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
      // Password fields are always sensitive
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

      // Sensitive input types
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

      // Sensitive autocomplete
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

      // Sensitive name/id attribute match
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
        detections.push({
          ...det,
          bbox: element.bbox,
          elementId: element.id || element.testId || null,
        });
      }
    }

    // Also scan label/placeholder for PII
    if (element.label) {
      const labelDetections = detectInText(element.label, 'dom', '');
      for (const det of labelDetections) {
        detections.push({
          ...det,
          bbox: element.bbox,
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
      if (element.isPixelContent) continue; // Skip pixel regions (handled by OCR/Vision)
      const detections = detectInElement(element);
      allDetections.push(...detections);
    }
    return allDetections;
  }

  return {
    detectInText,
    detectInElement,
    detectAllDom,
    PATTERNS,
    CONTEXT_KEYWORDS,
  };
})();
