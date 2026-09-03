/**
 * Privamon — Sanitized DOM Generator
 *
 * Takes raw DOM data + PII detections → produces a sanitized DOM
 * that preserves structural information but removes sensitive values.
 *
 * This sanitized DOM is intended for future server-side VLM consumption.
 * It should help the model understand the page structure without exposing PII.
 */
var Privamon = Privamon || {};

Privamon.SanitizedDOM = (() => {
  'use strict';

  /**
   * Generate a sanitized version of the extracted DOM.
   *
   * @param {Array} elements - Raw elements from dom-extractor
   * @param {Array} detections - PII detections with bboxes
   * @returns {Array} Sanitized element entries
   */
  function sanitize(elements, detections) {
    // Build a lookup: which element bboxes overlap with PII detections?
    const piiRegions = detections.map(d => d.bbox).filter(Boolean);

    return elements.map(el => {
      const sanitized = {
        tag: el.tag,
        bbox: el.bbox, // Bbox itself is not sensitive
      };

      // Preserve structural attributes
      if (el.role) sanitized.role = el.role;
      if (el.inputType) sanitized.inputType = el.inputType;
      if (el.id) sanitized.id = el.id;
      if (el.testId) sanitized.testId = el.testId;

      // Check if this element overlaps with any PII detection
      const isRedacted = isPIIRegion(el.bbox, piiRegions);

      // Sanitize text content
      if (el.text) {
        sanitized.text = isRedacted ? '[REDACTED]' : sanitizeText(el.text, detections);
      }

      // Input fields
      if (el.inputType) {
        sanitized.interactionType = getInteractionType(el);

        // Always redact values of sensitive input types
        if (el.value) {
          sanitized.hasValue = true;
          sanitized.value = isRedacted || el.isSensitiveType || el.definitelySensitive
            ? '[REDACTED]'
            : sanitizeText(el.value, detections);
        }

        // Labels can be kept (they describe the field, not the data)
        if (el.label) {
          sanitized.label = sanitizeText(el.label, detections);
        }

        // Keep placeholder as UI context (usually not PII)
        if (el.placeholder) {
          sanitized.placeholder = el.placeholder;
        }
      }

      // Pixel content marker
      if (el.isPixelContent) {
        sanitized.isPixelContent = true;
        if (el.alt) sanitized.alt = sanitizeText(el.alt, detections);
      }

      // Link context
      if (el.href) {
        // Sanitize URLs — strip query params that might contain PII
        sanitized.hasLink = true;
      }

      return sanitized;
    });
  }

  /**
   * Check if a bbox overlaps with any PII detection region.
   */
  function isPIIRegion(bbox, piiRegions) {
    if (!bbox) return false;
    for (const pii of piiRegions) {
      if (!pii) continue;
      // Check overlap
      if (
        bbox.x < pii.x + pii.width &&
        bbox.x + bbox.width > pii.x &&
        bbox.y < pii.y + pii.height &&
        bbox.y + bbox.height > pii.y
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sanitize text by replacing detected PII patterns.
   */
  function sanitizeText(text, detections) {
    if (!text) return text;

    // Run PII detector on this text
    const localDetections = Privamon.PIIDetector.detectInText(text, 'dom', '');
    if (localDetections.length === 0) return text;

    // Sort by span start descending (replace from end to preserve indices)
    localDetections.sort((a, b) => (b.span?.start || 0) - (a.span?.start || 0));

    let sanitized = text;
    for (const d of localDetections) {
      if (d.span) {
        sanitized =
          sanitized.slice(0, d.span.start) +
          '[REDACTED]' +
          sanitized.slice(d.span.end);
      }
    }

    return sanitized;
  }

  /**
   * Determine the interaction type for an input element.
   */
  function getInteractionType(el) {
    switch (el.inputType) {
      case 'text': case 'email': case 'tel': case 'number':
      case 'password': case 'search': case 'url':
        return 'text_input';
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'submit': return 'submit_button';
      case 'button': return 'button';
      case 'file': return 'file_upload';
      case 'date': case 'time': case 'datetime-local':
        return 'date_picker';
      case 'range': return 'slider';
      case 'color': return 'color_picker';
      default: return 'input';
    }
  }

  return { sanitize };
})();
