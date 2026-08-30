// piiText.js
// Rule-based PII detection over DOM text/values/attributes.
// This handles the majority of PII cheaply — no model needed.

const PII_PATTERNS = {
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  phone: /\b\d{10}\b/g,
  card: /\b(?:\d[ -]*?){13,16}\b/g,
  aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
};

const SENSITIVE_FIELD_TYPES = ['password'];
const SENSITIVE_AUTOCOMPLETE = ['cc-number', 'cc-csc', 'current-password', 'new-password'];

function redactText(text) {
  if (!text) return { text, hits: [] };
  const hits = [];
  let redacted = text;
  for (const [label, regex] of Object.entries(PII_PATTERNS)) {
    if (regex.test(redacted)) {
      hits.push(label);
      redacted = redacted.replace(regex, `[REDACTED_${label.toUpperCase()}]`);
    }
    regex.lastIndex = 0; // reset global regex state
  }
  return { text: redacted, hits };
}

export function sanitizeDomElements(elements) {
  return elements.map((el) => {
    const clone = { ...el };
    const piiHits = [];

    // Attribute/type-based redaction (highest confidence, checked first)
    const isSensitiveField =
      SENSITIVE_FIELD_TYPES.includes(clone.type) ||
      SENSITIVE_AUTOCOMPLETE.includes(clone.autocomplete);

    if (isSensitiveField) {
      if (clone.value) clone.value = '[REDACTED]';
      piiHits.push('sensitive_field_type');
    } else {
      // Pattern-based redaction on value
      if (clone.value) {
        const r = redactText(String(clone.value));
        clone.value = r.text;
        piiHits.push(...r.hits);
      }
    }

    // Pattern-based redaction on visible text / placeholder
    if (clone.text) {
      const r = redactText(clone.text);
      clone.text = r.text;
      piiHits.push(...r.hits);
    }
    if (clone.placeholder) {
      const r = redactText(clone.placeholder);
      clone.placeholder = r.text;
      piiHits.push(...r.hits);
    }

    clone.piiDetected = [...new Set(piiHits)];
    return clone;
  });
}
