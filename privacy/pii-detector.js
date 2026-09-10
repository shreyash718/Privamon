/**
 * Privamon — PII Detector (100% In-Browser, Zero-Server)
 *
 * Implements multi-modal client-side PII detection across:
 *   1. DOM Semantic Analysis (<input>, <textarea>, autocomplete, sensitive keywords)
 *   2. Shared High-Performance Regex Matching with Luhn & Verhoeff algorithmic checksums
 *   3. Context-aware confidence boosting and false-positive negative prefix filtering
 *
 * All detectors produce normalized `DetectionCandidate` objects via `toCandidate()`.
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.PIIDetector = (() => {
  'use strict';

  // ── Universal Candidate Factory ──
  /**
   * Normalizes any detection from DOM, OCR, Vision, or NER into the unified DetectionCandidate contract.
   */
  function toCandidate({
    type,
    source = 'dom',
    text = '',
    originalValue = null,
    bbox = null,
    boxes = null,
    tokens = [],
    confidence = 0.5,
    decision = null,
    elementId = null,
    reason = null,
    coordinateSpace = 'screenshot'
  }) {
    const conf = Math.max(0, Math.min(1.0, Number(confidence) || 0.5));
    const b = bbox ? {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height)
    } : null;

    const bx = (boxes && boxes.length > 0)
      ? boxes.map(box => ({
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height)
        }))
      : (b ? [b] : []);

    return {
      type: type || 'other',
      source,
      sources: [source],
      text: text || '',
      originalValue: originalValue || null,
      bbox: b,
      boxes: bx,
      tokens: Array.isArray(tokens) ? [...tokens] : [],
      confidence: conf,
      decision: decision || null, // Will be classified in Fusion based on confidence thresholds
      elementId: elementId || null,
      reason: reason || `${source}:${type}`,
      coordinateSpace: coordinateSpace || 'screenshot'
    };
  }

  // ── Verhoeff Checksum Algorithm (Indian Aadhaar validation) ──
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
    if (!digits || digits.length !== 12) return false;
    // Aadhaar numbers do not start with 0 or 1
    if (digits[0] === '0' || digits[0] === '1') return false;

    let c = 0;
    const reversed = digits.split('').reverse();
    for (let i = 0; i < reversed.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][parseInt(reversed[i], 10)]];
    }
    return c === 0;
  }

  // ── Luhn Checksum Algorithm (Credit/Debit Cards) ──
  function luhnValid(num) {
    const clean = String(num).replace(/\D/g, '');
    if (clean.length < 13 || clean.length > 19) return false;
    const digits = clean.split('').reverse().map(Number);
    const sum = digits.reduce((acc, d, i) =>
      acc + (i % 2 ? ((d * 2 > 9) ? d * 2 - 9 : d * 2) : d), 0);
    return sum % 10 === 0;
  }

  // ── Negative Prefix Context Filter ──
  // Suppresses false positives where order IDs, invoices, tracking codes, or pin codes resemble phone/card/aadhaar
  const NEGATIVE_PREFIX_REGEX = /(?:order\s*(?:id|#|no|num)?|invoice\s*(?:id|#|no|num)?|tracking\s*(?:id|#|no|num)?|product\s*(?:code|id|#)?|item\s*(?:code|id|#|no)?|sku\s*(?:#|no)?|pin\s*(?:code)?|pincode|postal\s*(?:code)?|zip\s*(?:code)?)\s*[:#\-]?\s*$/i;

  function hasNegativePrefix(fullText, matchStart, nearbyContext = '') {
    const windowStart = Math.max(0, matchStart - 50);
    const precedingInText = fullText.slice(windowStart, matchStart);
    if (NEGATIVE_PREFIX_REGEX.test(precedingInText)) return true;
    if (nearbyContext && NEGATIVE_PREFIX_REGEX.test(nearbyContext.trim())) return true;
    return false;
  }

  // ── Ordered Compiled Regex Patterns ──
  // Compiled once and reused to minimize garbage collection & regex compile overhead
  const PATTERNS = [
    {
      name: 'email',
      regex: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
      type: 'email',
      baseConfidence: 0.92,
      validator: (text) => !text.endsWith('.') && !text.endsWith(',') && text.includes('@'),
      checksum: false
    },
    {
      name: 'credit_card',
      regex: /\b(?:\d[ -]*?){13,19}\b/g,
      type: 'creditCard',
      baseConfidence: 0.75,
      validator: (text, ctx) => {
        if (ctx && /\b(?:imei|device|serial|sr\s*no)\b/i.test(ctx)) return false;
        return luhnValid(text);
      },
      contextValidator: true,
      checksum: true // Valid Luhn promotes to 1.0 confidence
    },
    {
      name: 'aadhaar',
      regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
      type: 'aadhaar',
      baseConfidence: 0.85,
      validator: validateVerhoeff,
      checksum: true // Valid Verhoeff promotes to 1.0 confidence
    },
    {
      name: 'aadhaar_vid',
      regex: /\b(?:VID\s*[:\-]?\s*)?([2-9]\d{3}\s\d{4}\s\d{4}\s\d{4})\b/g,
      type: 'aadhaar',
      baseConfidence: 0.95,
      matchGroup: 1,
      validator: (text, ctx) => {
        const digits = text.replace(/\s/g, '');
        if (digits.length !== 16) return false;
        if (!ctx) return true;
        const lowerCtx = ctx.toLowerCase();
        return /\b(?:vid|virtual\s*id|aadhaar|aadhar|मेरा|आधार|पहचान|government|india|unique)\b/i.test(lowerCtx);
      },
      contextValidator: true,
      checksum: false
    },
    {
      name: 'pan',
      regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
      type: 'pan',
      baseConfidence: 0.70, // No mathematical checksum; boosted via context keywords
      validator: (text) => {
        const clean = text.replace(/[\s\-]/g, '').toUpperCase();
        if (clean.length !== 10) return false;
        // 4th character indicates entity type in Indian tax system (P=Individual, C=Company, etc.)
        return 'ABCFGHLJPT'.includes(clean[3]);
      },
      checksum: false
    },
    {
      name: 'phone_indian',
      regex: /(?:(?:\+91[\s\-]?)|\b)[6-9](?:\d[\s\-]?){9}\b/g,
      type: 'phone',
      baseConfidence: 0.85,
      checksum: false
    },
    {
      name: 'phone_e164',
      regex: /(?:(?:\+)|(?<=\s|\b|\())\+(?:[1-9]\d{0,2})[\s.\-]?(?:\(?\d{1,4}\)?[\s.\-]?)?\d{1,4}[\s.\-]?\d{1,4}[\s.\-]?\d{1,9}\b/g,
      type: 'phone',
      baseConfidence: 0.75,
      checksum: false
    },
    {
      name: 'phone_us_intl',
      regex: /\b(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
      type: 'phone',
      baseConfidence: 0.70,
      checksum: false
    },
    {
      name: 'upi_id',
      regex: /\b[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}(?!\.[a-zA-Z])\b/g,
      type: 'financial',
      baseConfidence: 0.85,
      validator: (text) => {
        const lower = text.toLowerCase();
        const handles = ['okhdfcbank', 'okaxis', 'oksbi', 'okicici', 'paytm', 'ybl', 'ibl', 'axl', 'apl', 'upi', 'gpay', 'phonepe', 'barodampay', 'federal'];
        const parts = lower.split('@');
        if (parts.length !== 2 || parts[1].includes('.')) return false;
        return handles.includes(parts[1]) || /^[a-zA-Z]{3,20}$/.test(parts[1]);
      },
      checksum: false
    },
    {
      name: 'ssn',
      regex: /\b\d{3}-\d{2}-\d{4}\b/g,
      type: 'ssn',
      baseConfidence: 0.85,
      validator: (text) => {
        const parts = text.split('-');
        if (parts[0] === '000' || parts[0] === '666' || parseInt(parts[0], 10) >= 900) return false;
        if (parts[1] === '00' || parts[2] === '0000') return false;
        return true;
      },
      checksum: false
    },
    {
      name: 'jwt_token',
      regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      type: 'apiToken',
      baseConfidence: 0.95,
      checksum: false
    },
    {
      name: 'api_key',
      regex: /\b(?:sk_live|pk_live|bearer|ghp|gho|glpat|xoxb|xoxp)_[a-zA-Z0-9_\-]{16,}\b/gi,
      type: 'apiToken',
      baseConfidence: 0.95,
      checksum: false
    },
    {
      name: 'ip_address',
      regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      type: 'ip',
      baseConfidence: 0.85,
      validator: (text, ctx) => {
        const lowerCtx = (ctx || '').toLowerCase();
        // Reject amounts, item numbers, rates, invoice tables, or phone figures mistakenly parsed with periods
        if (/\b(?:total|amount|rate|qty|rs|inr|tax|gst|bill|price|particulars|subtotal|invoice|cgst|sgst|model|charger|battery|mob|name|date)\b/i.test(lowerCtx)) {
          return false;
        }
        if (text.startsWith('0.') || text.startsWith('10.') || text.startsWith('13.') || text.endsWith('.0') || text === '0.0.0.0' || text === '255.255.255.255') {
          return false;
        }
        // Require explicit networking context keyword to confirm it is truly an IP address
        return /\b(?:server|host|ip|client|network|dns|proxy|interface|subnet|router|dhcp|tcp|udp|gateway|port|listen)\b/i.test(lowerCtx);
      },
      contextValidator: true,
      checksum: false
    },
    {
      name: 'ipv6_address',
      regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:[0-9a-fA-F]{0,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*\b/g,
      type: 'ip',
      baseConfidence: 0.85,
      validator: (text) => {
        const parts = text.split(':');
        return parts.length >= 3 && parts.length <= 8 && parts.every(p => /^[0-9a-fA-F]{0,4}$/.test(p));
      },
      checksum: false
    },
    {
      name: 'dob',
      regex: /\b(?:0?[1-9]|[12]\d|3[01])[\/\-\.](?:0?[1-9]|1[0-2])[\/\-\.](?:19|20)\d{2}\b/g,
      type: 'dob',
      baseConfidence: 0.90,
      validator: (text, ctx) => {
        const lowerCtx = (ctx || '').toLowerCase();
        // If birth keywords are present, this IS a date of birth
        if (/\b(?:birth|dob|born|birthday|age)\b/i.test(lowerCtx) || /जन्म/i.test(lowerCtx)) {
          return true;
        }
        return false;
      },
      contextValidator: true,
      checksum: false
    },
    {
      name: 'ifsc_code',
      regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
      type: 'financial',
      baseConfidence: 0.85,
      checksum: false
    },
    {
      name: 'gstin_pan',
      regex: /\b[0-9]{2}[\s\-]?[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z][A-Za-z0-9][0-9A-Za-z]\b/gi,
      type: 'pan',
      baseConfidence: 0.95,
      checksum: false
    },
    {
      name: 'gstin_labeled',
      regex: /(?:gst(?:in)?(?:\s*no\.?)?|pan(?:\s*no\.?)?)\s*[:\-=_.\s]{1,15}([0-9]{2}[\s\-]?[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z][A-Za-z0-9][0-9A-Za-z]|[A-Za-z]{5}[0-9]{4}[A-Za-z])/gi,
      type: 'pan',
      baseConfidence: 0.95,
      matchGroup: 1,
      checksum: false
    },
    {
      name: 'imei_labeled',
      regex: /(?:imei(?:[^\S\r\n]*no\.?)?|device[^\S\r\n]*id|serial(?:[^\S\r\n]*no\.?)?|sr(?:[^\S\r\n]*no\.?)?)[^\S\r\n]*[.\-_=~*:\t ]{1,30}([0-9OIlSB\t .\-]{14,22})/gi,
      type: 'device_id',
      baseConfidence: 0.95,
      matchGroup: 1,
      validator: (text) => {
        const cleaned = text.replace(/O/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/\D/g, '');
        return cleaned.length >= 14 && cleaned.length <= 17;
      },
      checksum: false
    },
    {
      name: 'imei_number',
      regex: /\b[0-9]{15}\b/g,
      type: 'device_id',
      baseConfidence: 0.90,
      validator: (text, ctx) => {
        const lowerCtx = (ctx || '').toLowerCase();
        if (/\b(?:amount|rate|price|total|tax)\b/i.test(lowerCtx)) return false;
        return luhnValid(text);
      },
      contextValidator: true,
      checksum: true
    },
    {
      name: 'phone_labeled',
      regex: /(?:mob(?:ile)?(?:[^\S\r\n]*no\.?)?|phone(?:[^\S\r\n]*no\.?)?|contact(?:[^\S\r\n]*no\.?)?|tel(?:[^\S\r\n]*no\.?)?|m\.)[^\S\r\n]*[.\-_=~*:\t ]{1,50}([6-9][0-9\t .\-]{8,15}[0-9])/gi,
      type: 'phone',
      baseConfidence: 0.95,
      matchGroup: 1,
      validator: (text) => {
        const digits = text.replace(/\D/g, '');
        return digits.length >= 10 && digits.length <= 12 && ['6','7','8','9'].includes(digits[0]);
      },
      checksum: false
    },
    {
      name: 'name_labeled',
      regex: /\b(?:name|customer(?:[^\S\r\n]*name)?|client\s*name|patient(?:[^\S\r\n]*name)?|buyer(?:[^\S\r\n]*name)?|holder(?:[^\S\r\n]*name)?|m\/s|shri|smt|mr\.)(?:\s*[:=_~*]\s*|\s{2,}|\t+)([a-zA-Z\u0900-\u097F][a-zA-Z0-9\u0900-\u097F\.\'\-]+(?:[^\S\r\n]+[a-zA-Z0-9\u0900-\u097F\.\'\-]+){0,3})/gi,
      type: 'name',
      baseConfidence: 0.92,
      matchGroup: 1,
      validator: (text) => {
        let clean = text.trim();
        // Truncate before subsequent field labels if accidentally captured
        const labelCut = clean.search(/\b(?:email|mobile|phone|contact|aadhaar|aadhar|pan|address|date|id|code|order|invoice|vid|dob)\b/i);
        if (labelCut > 2) {
          clean = clean.slice(0, labelCut).trim();
        }
        const lower = clean.toLowerCase();
        const stopWords = new Set([
          'particulars', 'address', 'date', 'invoice', 'bill', 'model', 'amount', 'rate', 'total',
          'signature', 'sign', 'item', 'description', 'qty', 'status', 'gateway', 'home', 'no',
          'mob', 'mobile', 'phone', 'imei', 'battery', 'charger', 'tax', 'gst', 'gstin',
          'communication', 'communications', 'enterprises', 'store', 'shop', 'pvt', 'ltd', 'agency',
          'email', 'username', 'user', 'password', 'login', 'signup', 'submit', 'search', 'cancel', 'reset',
          'or', 'and', 'not', 'id', 'account', 'number', 'code',
          'aadhaar', 'aadhar', 'pan', 'ssn', 'cvv', 'cvc', 'ifsc', 'salary', 'income',
          'dob', 'bday', 'attribute', 'badge', 'input', 'field', 'button', 'form', 'class', 'type', 'value',
          'permanent', 'routing', 'swift', 'pin', 'otp', 'card', 'security',
          'side', 'ocr', 'validation', 'pipeline', 'token', 'tokens', 'synthetic', 'record', 'official',
          'slip', 'data', 'document', 'citizen', 'identity', 'resident', 'general', 'bilingual', 'english', 'hindi'
        ]);
        if (/\b(?:communication|enterprises|store|shop|pvt|ltd|agency|telecom|validation|pipeline)\b/i.test(lower)) {
          return false;
        }
        if (clean.includes('=') || clean.includes('"') || clean.includes("'") || /^["'].*["']$/.test(clean)) {
          return false;
        }
        return !stopWords.has(lower) && lower.length >= 3;
      },
      checksum: false
    },
    {
      name: 'aadhaar_name_dob',
      regex: /(?:^|\n)\s*([A-Za-z\u0900-\u097F]{2,25}(?:[^\S\r\n]+[A-Za-z\u0900-\u097F]{2,25}){0,3})\s*(?:\n\s*([A-Za-z\u0900-\u097F]{2,25}(?:[^\S\r\n]+[A-Za-z\u0900-\u097F]{2,25}){0,3})\s*)?(?=\n\s*(?:Date\s*of\s*Birth|DOB|जन्म\s*तिथि))/gi,
      type: 'name',
      baseConfidence: 0.92,
      matchGroup: 1,
      validator: (text) => {
        const clean = text.trim().toLowerCase();
        const nonNames = ['government', 'india', 'mera', 'aadhaar', 'meri', 'pehchan', 'unique', 'authority', 'male', 'female', 'transgender', 'purush', 'mahila'];
        return clean.length >= 3 && !nonNames.some(w => clean.includes(w));
      },
      checksum: false
    },
    {
      name: 'relative_guardian_name',
      regex: /\b(?:S\/O|D\/O|W\/O|C\/O|Care\s+of|Son\s+of|Daughter\s+of|Wife\s+of)\s*[:\-]?\s*([A-Za-z\u0900-\u097F]{2,25}(?:[^\S\r\n]+[A-Za-z\u0900-\u097F]{2,25}){1,3})/gi,
      type: 'name',
      baseConfidence: 0.92,
      matchGroup: 1,
      validator: (text) => {
        const clean = text.trim().toLowerCase();
        const stop = ['address', 'post', 'dist', 'district', 'village', 'state', 'pin', 'pincode', 'road', 'street', 'house'];
        return clean.length >= 3 && !stop.some(s => clean.startsWith(s));
      },
      checksum: false
    },
    {
      name: 'address_labeled',
      regex: /(?<!email\s)(?<!e-mail\s)\b(?:Address|पता)\s*[:\-]\s*([^\n\r]{10,120}(?:\n[^\n\r]{10,120}){0,3})/gi,
      type: 'location',
      baseConfidence: 0.88,
      matchGroup: 1,
      validator: (text) => {
        const clean = text.trim();
        if (/^[\w\.-]+@[\w\.-]+\.\w+$/.test(clean) || clean.startsWith('http') || clean.startsWith('www.')) return false;
        return clean.length >= 10;
      },
      checksum: false
    },
    {
      name: 'hindi_name',
      regex: /\b(?:राहुल|सौरभ|प्रिया|अमित|अंजलि|रोहित|दीपक|पूजा|संजय|कविता|विकास|नेहा|अजय|मनीष|सुरेश|राजेश|मनोज|सुनील|रवि|विजय|संदीप|आलोक|दिनेश|अशोक|पवन|विशाल|अंकित|राकेश|सचिन|नवीन|प्रदीप|सुधीर|कमल|मुकेश|नितिन|तरुण|गौरव|सुमित|विवेक|आशीष|प्रशांत|मोहित|कुलदीप|संतोष|हेमंत|धर्मेन्द्र|जितेन्द्र|योगेश|हरीश|अनिल)(?:[^\S\r\n]+(?:वर्मा|यादव|शर्मा|सिंह|कुमार|गुप्ता|मिश्रा|तिवारी|पांडेय|दुबे|चौबे|त्रिपाठी|पाठक|झा|ठाकुर|चौहान|राठौड़|राजपूत|प्रसाद|मौर्या|सोनी|साहू|प्रजापति|विश्वकर्मा))?\b/g,
      type: 'name',
      baseConfidence: 0.90,
      checksum: false
    },
    {
      name: 'signature_labeled',
      regex: /(?:customer\s*signature|auth(?:orized)?\s*sign(?:atory)?|for\s+[a-zA-Z\s]{3,30}\s*signature)\b/gi,
      type: 'signature',
      baseConfidence: 0.90,
      checksum: false
    },
    {
      name: 'indian_name',
      regex: /\b(?:Shreyash|Sanjeet|Lanjeet|Sangeet|Dahiya|Tanishq|Tanish|Tanmay|Tanuja|Tanvi|Tanya|Tara|Tarun|Tejas|Tina|Tirth|Trisha|Tulsi|Tushar|Aarav|Aayush|Aakash|Aarti|Aashish|Abhay|Abhilash|Abhimanyu|Abhishek|Aditi|Aditya|Ajay|Ajit|Akanksha|Akash|Akhil|Alok|Aman|Amarjeet|Ambar|Amit|Amita|Amrita|Anand|Ananya|Aneesh|Angad|Anil|Anita|Anjali|Ankit|Ankita|Ankur|Ankush|Anmol|Ansh|Anshu|Anshul|Anubhav|Anuj|Anurag|Anushka|Aparna|Archana|Arjun|Arnav|Arun|Aruna|Aryan|Ashish|Ashok|Ashu|Ashwin|Atharv|Atharva|Avani|Avneet|Ayush|Babita|Badal|Bala|Baldev|Balraj|Bharat|Bharti|Bhavana|Bhavesh|Bhavna|Bhavya|Bhushan|Bijoy|Bindu|Birendra|Chandan|Chandni|Chetan|Chirag|Daksh|Darshan|Deepa|Deepak|Deepali|Deepika|Dev|Devi|Devika|Dhananjay|Dheeraj|Dhruv|Dinesh|Dipika|Divya|Dolly|Durga|Ekta|Esha|Farhan|Gaurav|Gautam|Geeta|Girish|Gopal|Govind|Gul|Gunjan|Gurpreet|Guru|Harinder|Harish|Harpreet|Harsh|Harsha|Harshit|Harshita|Hemant|Himani|Himanshu|Inderjeet|Indira|Isha|Ishaan|Jagdish|Jatin|Jaya|Jayant|Jigar|Jitendra|Jyoti|Jyotsna|Kajal|Kajol|Kalyan|Kamal|Kanak|Kanchan|Karan|Kartik|Kashi|Kavita|Kavya|Kedar|Keshav|Khushi|Kiran|Kirti|Komal|Kshitij|Kunal|Lakshay|Lakshmi|Lakshya|Lalita|Lalit|Lata|Lokesh|Madhav|Madhavi|Madhur|Madhu|Mahesh|Maithili|Malini|Mamta|Manav|Mandeep|Mani|Manish|Manisha|Manjeet|Manju|Mansi|Mayank|Mayur|Meena|Meenakshi|Megha|Meghna|Mihir|Milan|Minal|Minakshi|Mira|Mitali|Mohini|Mohit|Moksh|Monika|Mridul|Mrinal|Mukesh|Mukul|Muskan|Naina|Namita|Nandini|Naresh|Naveen|Navneet|Nayan|Neelam|Neeru|Neha|Netra|Nidhi|Niharika|Nikhil|Nikita|Nilesh|Nimisha|Nisha|Nishant|Nitin|Nitya|Padma|Pallavi|Pankaj|Paras|Parth|Parveen|Parvati|Payal|Peyush|Pinky|Piyush|Pooja|Poornima|Prabha|Prabhat|Pradeep|Praful|Pragati|Pragya|Prakash|Pranav|Pranay|Pranjal|Prashant|Pratap|Prateek|Pratibha|Pratik|Preeti|Prem|Prerna|Priya|Priyam|Priyanka|Priyanshu|Puja|Pulkit|Puneet|Pushpa|Rachna|Radhika|Raghu|Rahul|Rajan|Rajat|Rajeev|Rajendra|Rajesh|Rajiv|Raju|Rakesh|Ram|Ramesh|Rashi|Rashmi|Ratan|Ravi|Ravinder|Reena|Rekha|Richa|Rinku|Rishi|Ritesh|Ritika|Ritu|Riya|Rohan|Rohit|Roshni|Ruhi|Rupal|Rupali|Rupesh|Saanvi|Sachin|Sahil|Saif|Sakshi|Salman|Sameer|Samiksha|Sandeep|Sandesh|Sangeeta|Sanjay|Sanjiv|Sankalp|Santosh|Sapna|Sarita|Sarthak|Saroj|Sarvesh|Satish|Saumya|Saurabh|Savita|Seema|Shailendra|Shailesh|Shakti|Shalini|Shambhu|Shankar|Shanti|Sharad|Sharda|Shashank|Shashi|Shekhar|Shilpa|Shipra|Shivam|Shivani|Shobha|Shreya|Shruti|Shubham|Shweta|Siddharth|Simran|Smita|Smriti|Sneha|Sonam|Sonia|Soniya|Sourav|Subhash|Sucheta|Suchitra|Sudha|Sudhir|Sujata|Suman|Sumit|Sunaina|Sunil|Sunita|Suraj|Suresh|Surya|Sushant|Sushil|Sushma|Swapnil|Swara|Swati|Udai|Udit|Ujjwal|Uma|Umesh|Urvashi|Utkarsh|Vaibhav|Vaishali|Vaishnavi|Vansh|Varun|Vedant|Veena|Vibha|Vibhor|Vidya|Vikas|Vikram|Vimal|Vinay|Vineet|Vinita|Vinod|Vipul|Virat|Vishal|Vishnu|Vivek|Yamini|Yash|Yashika|Yogesh|Yogita|Zara)(?:[^\S\r\n]+(?:Dahiya|Sharma|Verma|Gupta|Singh|Kumar|Patel|Shah|Joshi|Mehta|Rao|Reddy|Nair|Iyer|Pillai|Das|Banerjee|Chatterjee|Mukherjee|Bose|Ghosh|Sen|Dutta|Roy|Choudhury|Agarwal|Jain|Bansal|Goel|Mittal|Singhal|Garg|Bhatia|Arora|Kapoor|Malhotra|Khanna|Chopra|Sethi|Grover|Ahuja|Malik|Gill|Dhillon|Sandhu|Grewal|Sidhu|Mann|Kulkarni|Deshmukh|Patil|Shinde|Jadhav|Pawar|More|Gaikwad|Chavan|Bhatt|Trivedi|Shukla|Mishra|Tiwari|Pandey|Dubey|Chaubey|Tripathi|Pathak|Jha|Thakur|Chauhan|Rathore|Rajput|Yadav|Prasad|Maurya|Soni|Sahu|Prajapati|Vishwakarma))?\b/gi,
      type: 'name',
      baseConfidence: 0.90,
      validator: (text) => {
        const lower = text.trim().toLowerCase();
        const stopWords = new Set([
          'may', 'will', 'bill', 'can', 'about', 'for', 'with', 'and', 'or', 'to', 'in', 'on', 'at', 'by',
          'from', 'date', 'time', 'rate', 'total', 'amount', 'qty', 'tax', 'gst', 'name', 'customer',
          'phone', 'email', 'address', 'model', 'particulars', 'number', 'user', 'username', 'password',
          'login', 'mobile', 'status', 'view', 'edit', 'save', 'close', 'details', 'more', 'all', 'home'
        ]);
        return !stopWords.has(lower) && lower.length >= 3;
      },
      checksum: false
    },
    {
      name: 'common_name',
      regex: /\b(?:James|John|Robert|Michael|William|David|Richard|Joseph|Thomas|Charles|Daniel|Matthew|Anthony|Donald|Mark|Paul|Steven|Andrew|Kenneth|Joshua|Kevin|Brian|George|Edward|Ronald|Timothy|Jason|Jeffrey|Ryan|Jacob|Gary|Nicholas|Eric|Jonathan|Stephen|Larry|Justin|Scott|Brandon|Benjamin|Samuel|Gregory|Alexander|Frank|Patrick|Raymond|Jack|Dennis|Jerry|Tyler|Aaron|Jose|Adam|Nathan|Henry|Douglas|Zachary|Peter|Kyle|Walter|Ethan|Jeremy|Harold|Keith|Christian|Roger|Noah|Gerald|Carl|Terry|Sean|Austin|Arthur|Lawrence|Jesse|Dylan|Bryan|Joe|Jordan|Billy|Bruce|Albert|Willie|Gabriel|Logan|Alan|Juan|Wayne|Roy|Ralph|Randy|Eugene|Vincent|Russell|Elijah|Louis|Bobby|Philip|Johnny|Mary|Patricia|Jennifer|Linda|Elizabeth|Barbara|Susan|Jessica|Sarah|Karen|Nancy|Lisa|Betty|Margaret|Sandra|Ashley|Kimberly|Emily|Donna|Michelle|Dorothy|Carol|Amanda|Melissa|Deborah|Stephanie|Rebecca|Sharon|Laura|Cynthia|Kathleen|Amy|Shirley|Angela|Helen|Anna|Brenda|Pamela|Nicole|Emma|Samantha|Katherine|Christine|Debra|Rachel|Catherine|Carolyn|Janet|Ruth|Maria|Heather|Diane|Virginia|Julie|Joyce|Victoria|Olivia|Kelly|Christina|Lauren|Joan|Evelyn|Judith|Megan|Cheryl|Andrea|Hannah|Martha|Jacqueline|Frances|Gloria|Ann|Teresa|Kathryn|Sara|Janice|Jean|Alice|Madison|Doris|Abigail|Julia|Judy|Grace|Denise|Amber|Marilyn|Beverly|Danielle|Theresa|Sophia|Marie|Diana|Brittany|Natalie|Isabella|Charlotte|Rose|Alexis|Kayla)(?:[^\S\r\n]+[A-Z][a-zA-Z\.'\-]{1,25})?\b/g,
      type: 'name',
      baseConfidence: 0.88,
      checksum: false
    },
    {
      name: 'student_roll_no',
      regex: /\b[1-9]\d{7,13}\b/g,
      type: 'username',
      baseConfidence: 0.85,
      validator: (text, ctx) => {
        if (/^0+$/.test(text) || /^10+$/.test(text)) return false;
        if (text === '10000000' || text === '50000000') return false;
        if (ctx) {
          const lowerCtx = ctx.toLowerCase();
          // Suppress if negative prefix / transaction order context
          if (/\b(?:order|invoice|product|tracking|pin|pincode|postal|zip|item|sku|bill)\b/i.test(lowerCtx)) {
            return false;
          }
          if (/\b(?:roll\s*no|rollno|roll|enroll|student|reg\s*no|reg|user|account|hall|admission|id)\b/i.test(lowerCtx)) {
            return true;
          }
        }
        // 10-12 digit sequence starting with 1-9 (e.g. 24001003121) is strongly a student/account identifier
        if (text.length >= 10 && text.length <= 12) {
          return true;
        }
        return false;
      },
      contextValidator: true,
      checksum: false
    },
    {
      name: 'admission_reg_code',
      regex: /\b\d{2}-\d{4,6}\b/g,
      type: 'username',
      baseConfidence: 0.85,
      validator: (text, ctx) => {
        if (!ctx) return false;
        const lowerCtx = ctx.toLowerCase();
        return /\b(?:roll|reg|student|challen|challan|enroll|admission|ymca)\b/i.test(lowerCtx);
      },
      contextValidator: true,
      checksum: false
    },
    {
      name: 'person_name_context',
      regex: /\b[A-Z][a-zA-Z\.\'\-]{1,25}(?:[^\S\r\n]+[A-Z][a-zA-Z\.\'\-]{1,25}){0,2}\b/g,
      type: 'name',
      baseConfidence: 0.85,
      validator: (text, ctx) => {
        if (!ctx) return false;
        const lowerText = text.trim().toLowerCase();
        if (['firstname', 'first name', 'lastname', 'last name', 'fullname', 'full name', 'name', 'username', 'mob', 'mob no', 'mobile', 'mobile no', 'phone', 'phone no', 'contact', 'imei', 'imei no', 'gst', 'gstin'].includes(lowerText)) {
          return false;
        }
        // Reject common form field labels, banking terms, ID titles
        const nonNameKeywords = [
          'aadhaar', 'aadhar', 'pan', 'ssn', 'ifsc', 'cvv', 'cvc', 'salary', 'income',
          'permanent', 'account', 'number', 'security', 'code', 'branch', 'bank', 'date',
          'birth', 'card', 'payment', 'credit', 'debit', 'contact', 'emergency', 'billing',
          'identity', 'financial', 'attribute', 'expected', 'redact', 'keep', 'review', 'section',
          'token', 'tokens', 'email', 'address', 'verhoeff', 'valid', 'verhoeff-valid',
          'synthetic', 'record', 'official', 'slip', 'citizen', 'resident', 'bilingual',
          'english', 'hindi', 'side', 'ocr', 'validation', 'dob', 'gender', 'male', 'female'
        ];
        if (nonNameKeywords.some(kw => lowerText.includes(kw))) {
          return false;
        }
        const lowerCtx = ctx.toLowerCase();
        const nameMatch = lowerCtx.match(/\b(?:name|first\s*name|firstname|last\s*name|lastname|full\s*name|fullname|student\s*name|candidate|holder|patient|emp\s*name|employee\s*name|applicant)\b/);
        if (!nameMatch) return false;

        const nameIdx = nameMatch.index;
        const candIdx = lowerCtx.indexOf(lowerText);
        // Candidate must appear in context and be at or after the label (or within 10 chars before)
        if (candIdx === -1 || candIdx < nameIdx - 10) return false;

        const blockedWords = new Set([
          'Home', 'Dashboard', 'Result', 'Update', 'Payment', 'Amount', 'Status', 'Search',
          'Order', 'Gateway', 'Mode', 'Next', 'Previous', 'Show', 'Entries', 'RollNo',
          'ChallenNo', 'Successful', 'Unsuccessful', 'Initiated', 'Shipped', 'Pending', 'UPI', 'NetBanking',
          'Main', 'YMCA', 'Payment Gateway', 'Order_id', 'Order_status', 'Model', 'Particulars', 'Rate', 'Qty',
          'Battery', 'Charger', 'Smart Phone', 'Invoice', 'Bill', 'Tax', 'Date', 'All', 'Kind', 'Accessories',
          'Samsung', 'Nokia', 'Oppo', 'Vivo', 'MI', 'Apple', 'HTC', 'Lenovo', 'Xiaomi', 'Micromax', 'Lava', 'OnePlus', 'Realme',
          'Tokens', 'Token', 'Email', 'Address', 'Email Address', 'Verhoeff', 'Valid', 'Verhoeff-valid', 'Side', 'OCR', 'Validation', 'Male', 'Female'
        ]);
        return !blockedWords.has(text.trim());
      },
      contextValidator: true,
      checksum: false
    },
    {
      name: 'identifier_context',
      regex: /\b[A-Za-z0-9\/\-]{5,30}\b/g,
      type: 'username',
      baseConfidence: 0.85,
      validator: (text, ctx) => {
        if (!ctx) return false;
        const lowerCtx = ctx.toLowerCase();
        const isIdContext = /\b(?:roll\s*no|rollno|roll|enrollment|student\s*id|user\s*id|userid|username|account\s*no|acc\s*no|reg\s*no|registration\s*no|hall\s*ticket|admission\s*no)\b/i.test(lowerCtx);
        return isIdContext && /\d/.test(text);
      },
      contextValidator: true,
      checksum: false
    }
  ];

  // ── Context Keywords for Confidence Boosting ──
  const CONTEXT_KEYWORDS = {
    email:      ['email', 'e-mail', 'mail', 'contact', 'reach'],
    phone:      ['phone', 'mobile', 'cell', 'tel', 'telephone', 'contact', 'call', 'whatsapp', 'number'],
    creditCard: ['card', 'credit', 'debit', 'visa', 'master', 'amex', 'payment', 'cc', 'cvv', 'cardholder'],
    aadhaar:    ['aadhaar', 'aadhar', 'uid', 'uidai', 'identity', 'government id'],
    pan:        ['pan', 'permanent account', 'income tax', 'tax', 'itr', 'pan card', 'nsdl', 'uti'],
    financial:  ['ifsc', 'account', 'bank', 'routing', 'branch', 'swift', 'upi', 'paytm', 'gpay', 'phonepe'],
    ssn:        ['ssn', 'social security', 'tax id'],
    dob:        ['birth', 'dob', 'born', 'birthday', 'age', 'date of birth'],
    apiToken:   ['token', 'api key', 'bearer', 'auth', 'secret', 'jwt', 'credentials'],
    ip:         ['ip', 'address', 'server', 'host', 'gateway'],
    name:       ['name', 'firstname', 'first name', 'lastname', 'last name', 'fullname', 'full name', 'student', 'candidate', 'applicant', 'patient', 'holder'],
    username:   ['rollno', 'roll no', 'roll', 'enrollment', 'student id', 'userid', 'user id', 'username', 'login', 'account no', 'reg no']
  };

  const CONTEXT_BOOST = 0.25;

  function getContextBoost(fullText, matchStart, matchEnd, piiType) {
    const keywords = CONTEXT_KEYWORDS[piiType];
    if (!keywords) return 0;

    const windowStart = Math.max(0, matchStart - 100);
    const windowEnd = Math.min(fullText.length, matchEnd + 100);
    const context = fullText.slice(windowStart, windowEnd).toLowerCase();

    for (const kw of keywords) {
      if (context.includes(kw)) {
        return CONTEXT_BOOST;
      }
    }
    return 0;
  }

  // ── Core Shared PII Detection Function ──
  /**
   * Scans text for sensitive patterns. Shared across DOM text, OCR text, and user inputs.
   * @param {string} text - Raw text to inspect
   * @param {string} [nearbyContext=''] - Adjacent labels or attribute context
   * @param {string} [source='dom'] - 'dom' or 'ocr'
   * @returns {Array<Object>} Found matches with spans, confidence, and validated status
   */
  function detectPII(text, nearbyContext = '', source = 'dom') {
    if (!text || typeof text !== 'string') return [];

    const detections = [];
    const combinedContext = nearbyContext ? `${nearbyContext} ${text}` : text;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;

      while ((match = pattern.regex.exec(text)) !== null) {
        let matchText = match[0];
        let matchStart = match.index;
        let matchEnd = match.index + matchText.length;

        if (pattern.matchGroup && match[pattern.matchGroup]) {
          const val = match[pattern.matchGroup];
          const offset = match[0].indexOf(val);
          matchText = val;
          matchStart = match.index + offset;
          matchEnd = matchStart + matchText.length;
        }

        // 1. Negative prefix check
        if (['phone', 'creditCard', 'aadhaar', 'financial', 'username', 'device_id'].includes(pattern.type) && hasNegativePrefix(text, matchStart, nearbyContext)) {
          continue;
        }

        // 2. Algorithmic validator check (Luhn, Verhoeff, format rules)
        let isValid = true;
        if (pattern.validator) {
          const localWindow = text.slice(Math.max(0, matchStart - 80), Math.min(text.length, matchEnd + 80));
          const localContext = nearbyContext ? `${nearbyContext} ${localWindow}` : localWindow;
          isValid = pattern.contextValidator
            ? pattern.validator(matchText, localContext)
            : pattern.validator(matchText);
          if (!isValid) continue; // Drop invalid checksums/contexts immediately
        }

        // 3. Confidence determination
        let confidence = pattern.baseConfidence;
        if (pattern.checksum && isValid) {
          // Checksum-validated numbers get 1.0 confidence
          confidence = 1.0;
        } else {
          // Add context boost
          confidence += getContextBoost(combinedContext, matchStart, matchEnd, pattern.type);
          confidence = Math.min(1.0, confidence);
        }

        detections.push({
          type: pattern.type,
          patternName: pattern.name,
          text: matchText,
          confidence,
          source,
          checksumValidated: Boolean(pattern.checksum && isValid),
          span: { start: matchStart, end: matchEnd }
        });
      }
    }

    return detections;
  }

  // ── DOM Semantic Detection ──
  const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel']);
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'name', 'given-name', 'family-name', 'email', 'tel', 'tel-national',
    'cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc',
    'address-line1', 'address-line2', 'address-level1', 'address-level2',
    'postal-code', 'country', 'bday', 'bday-day', 'bday-month', 'bday-year',
    'sex', 'username', 'new-password', 'current-password', 'one-time-code'
  ]);
  const SENSITIVE_KEYWORDS = [
    'ssn', 'social_security', 'aadhaar', 'aadhar', 'pan', 'cvv', 'cvc',
    'salary', 'dob', 'birth', 'account', 'password', 'passwd', 'pwd',
    'pin', 'otp', 'credit_card', 'card_number', 'income',
    'username', 'user_name', 'user_id', 'userid', 'login', 'roll_no', 'rollno',
    'enrollment', 'student_id', 'ifsc', 'routing', 'swift'
  ];

  /**
   * Analyzes an extracted DOM element for semantic and text-level PII.
   * Produces an array of normalized `DetectionCandidate` objects.
   *
   * @param {Object} element - From dom-extractor
   * @param {Object} [mapper=null] - CoordinateMapper instance (if mapping immediately)
   * @returns {Array<Object>} DetectionCandidate array
   */
  function detectInDOMElement(element, mapper = null) {
    const candidates = [];
    if (!element || !element.bbox || element.isContainer || element.isHeader) return candidates;

    const upperTag = (element.tag || '').toUpperCase();
    const inputType = (element.inputType || element.type || '').toLowerCase();
    const { autocomplete, name, id, className, text, tokens, elementId } = element;
    const labelText = element.labelText || element.label || '';
    const contextStr = [name, id, className, labelText].filter(Boolean).join(' ');

    // ── 1. Form Inputs & Textareas ──
    if (upperTag === 'INPUT' || upperTag === 'TEXTAREA' || upperTag === 'SELECT') {
      let matchedType = null;
      let conf = 0.0;
      let reason = '';

      // Check input type
      if (inputType === 'password') {
        matchedType = 'password';
        conf = 1.0;
        reason = 'input[type=password]';
      } else if (inputType === 'email') {
        matchedType = 'email';
        conf = 0.90;
        reason = 'input[type=email]';
      } else if (inputType === 'tel') {
        matchedType = 'phone';
        conf = 0.90;
        reason = 'input[type=tel]';
      } else if (inputType === 'number' && /card|cc|cvv|account/i.test(contextStr)) {
        matchedType = 'creditCard';
        conf = 0.90;
        reason = 'input[type=number] with card keyword';
      }

      // Check autocomplete
      if (autocomplete && SENSITIVE_AUTOCOMPLETE.has(autocomplete.toLowerCase())) {
        const auto = autocomplete.toLowerCase();
        matchedType = auto.includes('cc') ? 'creditCard' : (auto.includes('tel') ? 'phone' : (auto.includes('bday') ? 'dob' : 'pii_input'));
        conf = Math.max(conf, 0.95);
        reason = `autocomplete=${autocomplete}`;
      }

      // Check name / id / class keywords
      if (!matchedType) {
        const lowerContext = contextStr.toLowerCase();
        for (const kw of SENSITIVE_KEYWORDS) {
          if (lowerContext.includes(kw)) {
            matchedType = (kw === 'password' || kw === 'passwd') ? 'password' :
                          (kw === 'aadhaar' || kw === 'aadhar') ? 'aadhaar' :
                          (kw === 'pan') ? 'pan' :
                          (kw === 'ssn') ? 'ssn' :
                          (kw === 'cvv' || kw === 'credit_card' || kw === 'card_number') ? 'creditCard' :
                          (kw === 'dob' || kw === 'birth') ? 'dob' :
                          (kw === 'ifsc' || kw === 'routing' || kw === 'swift') ? 'financial' :
                          (kw.includes('user') || kw.includes('login') || kw.includes('roll') || kw.includes('enroll') || kw.includes('student')) ? 'username' : 'sensitive_field';
            conf = Math.max(conf, 0.85);
            reason = `keyword:${kw}`;
            break;
          }
        }
      }

      // Check input value with regex patterns if name/id keywords didn't match
      if (!matchedType && element.value && typeof element.value === 'string' && element.value.trim().length >= 3) {
        const valMatches = detectPII(element.value.trim(), contextStr, 'dom');
        if (valMatches && valMatches.length > 0) {
          const best = valMatches[0];
          matchedType = best.type;
          conf = best.confidence;
          reason = `value:${best.patternName || best.type}`;
        }
      }

      if (matchedType) {
        const candidateBbox = mapper ? mapper.mapBbox(element.bbox) : element.bbox;
        candidates.push(toCandidate({
          type: matchedType,
          source: 'dom',
          text: element.value ? '[MASKED VALUE]' : '',
          originalValue: element.value || '',
          bbox: candidateBbox,
          boxes: [candidateBbox],
          tokens: [],
          confidence: conf,
          elementId: elementId || id || null,
          reason,
          coordinateSpace: mapper ? 'screenshot' : 'viewport'
        }));
      }
    }

    // ── 2. Rendered Visible Text Nodes ──
    if (text && text.trim().length > 0) {
      const piiMatches = detectPII(text, contextStr, 'dom');

      for (const match of piiMatches) {
        // Map match to exact word token rects if range tokens are available
        let matchedBbox = null;
        let matchedBoxes = [];
        let matchedTokens = [];

        if (tokens && tokens.length > 0) {
          const rangeMapper = (typeof Privamon !== 'undefined' && Privamon.DOMRangeMapper)
                           || (typeof window !== 'undefined' && window.Privamon && window.Privamon.DOMRangeMapper)
                           || (typeof globalThis !== 'undefined' && globalThis.Privamon && globalThis.Privamon.DOMRangeMapper);

          if (rangeMapper && typeof rangeMapper.mapSpanToDomBoxes === 'function') {
            const mapped = rangeMapper.mapSpanToDomBoxes(match.span.start, match.span.end, tokens);
            if (mapped.bbox && mapped.boxes && mapped.boxes.length > 0) {
              matchedBbox = mapped.bbox;
              matchedBoxes = mapped.boxes;
              matchedTokens = mapped.tokens;
            }
          }

          if (!matchedBbox) {
            // Find tokens overlapping this character span
            const spanTokens = tokens.filter(t => t.start < match.span.end && t.end > match.span.start);
            if (spanTokens.length > 0) {
              matchedTokens = spanTokens.map(t => t.id);
              matchedBoxes = spanTokens.flatMap(t => (t.boxes && t.boxes.length > 0) ? t.boxes : [t.bbox]);

              // Compute enclosing box for these tokens
              const minX = Math.min(...matchedBoxes.map(b => b.x));
              const minY = Math.min(...matchedBoxes.map(b => b.y));
              const maxX = Math.max(...matchedBoxes.map(b => b.x + b.width));
              const maxY = Math.max(...matchedBoxes.map(b => b.y + b.height));

              matchedBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            }
          }
        }

        // If tokens not available, interpolate sub-box — NEVER use a giant container bbox
        if (!matchedBbox) {
          if (element.bbox && element.bbox.width <= 350 && element.bbox.height <= 50 && match.text.length >= text.length * 0.6) {
            matchedBbox = element.bbox;
            matchedBoxes = [element.bbox];
          } else if (element.bbox && text.length > 0 && match.span) {
            const charWidth = element.bbox.width / Math.max(1, text.length);
            const subX = element.bbox.x + Math.round(match.span.start * charWidth);
            const subW = Math.max(20, Math.round(match.text.length * charWidth));
            const clampedW = Math.min(subW, (element.bbox.x + element.bbox.width) - subX);
            matchedBbox = { x: subX, y: element.bbox.y, width: clampedW, height: Math.min(element.bbox.height, 40) };
            matchedBoxes = [matchedBbox];
          } else {
            continue;
          }
        }

        const mappedBbox = mapper ? mapper.mapBbox(matchedBbox) : matchedBbox;
        const mappedBoxes = mapper ? matchedBoxes.map(b => mapper.mapBbox(b)) : matchedBoxes;

        candidates.push(toCandidate({
          type: match.type,
          source: 'dom',
          text: match.text,
          bbox: mappedBbox,
          boxes: mappedBoxes,
          tokens: matchedTokens,
          confidence: match.confidence,
          elementId: elementId || id || null,
          reason: `regex:${match.patternName}${match.checksumValidated ? ':checksum_valid' : ''}`,
          coordinateSpace: mapper ? 'screenshot' : 'viewport'
        }));
      }
    }

    return candidates;
  }

  /**
   * Batch processes all extracted DOM elements completely in-browser.
   * @param {Array<Object>} elements - From dom-extractor
   * @param {Object} [mapper=null] - CoordinateMapper instance
   * @returns {Array<Object>} Array of normalized DetectionCandidate objects
   */
  function detectDOMBatch(elements = [], mapper = null) {
    if (!elements || !elements.length) return [];
    const allCandidates = [];

    for (const el of elements) {
      const elCandidates = detectInDOMElement(el, mapper);
      if (elCandidates.length > 0) {
        allCandidates.push(...elCandidates);
      }
    }

    return allCandidates;
  }

  /**
   * Alias for detectPII with caller-expected parameter order.
   * Callers use detectInText(text, source, nearbyContext).
   * detectPII uses detectPII(text, nearbyContext, source).
   */
  function detectInText(text, source = 'dom', nearbyContext = '') {
    return detectPII(text, nearbyContext, source);
  }

  return {
    toCandidate,
    detectPII,
    detectInText,
    detectInDOMElement,
    detectDOMBatch,
    luhnValid,
    validateVerhoeff,
  };
})();
