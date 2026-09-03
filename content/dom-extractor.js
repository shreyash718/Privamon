/**
 * Privamon — DOM Extractor (Content Script)
 *
 * Injected into the active tab via chrome.scripting.executeScript().
 * Extracts only visible, viewport-intersecting, relevant DOM elements
 * with their bounding boxes and metadata.
 *
 * This is a self-contained IIFE that returns a structured result.
 *
 * IMPORTANT: getBoundingClientRect() returns viewport-relative CSS coordinates.
 * captureVisibleTab() captures the viewport. Both share the same origin.
 * NO scroll offset subtraction is needed for coordinate mapping.
 */
(() => {
  'use strict';

  // ── Configuration ──
  const MAX_ELEMENTS = 500;       // Safety cap
  const MIN_ELEMENT_SIZE = 4;     // Skip elements smaller than 4px in either dimension
  const TEXT_MAX_LENGTH = 500;    // Truncate very long text content

  // Tags that contain pixel-based (non-text-addressable) content
  const PIXEL_TAGS = new Set(['IMG', 'CANVAS', 'VIDEO', 'SVG', 'OBJECT', 'EMBED', 'IFRAME']);

  // Tags worth extracting (text-bearing, interactive, semantic)
  const RELEVANT_TAGS = new Set([
    'A', 'ABBR', 'ADDRESS', 'ARTICLE', 'ASIDE', 'B', 'BLOCKQUOTE',
    'BUTTON', 'CAPTION', 'CITE', 'CODE', 'DD', 'DEL', 'DETAILS',
    'DFN', 'DIV', 'DL', 'DT', 'EM', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
    'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'I', 'IMG', 'INPUT', 'INS', 'KBD', 'LABEL', 'LEGEND', 'LI', 'MAIN',
    'MARK', 'NAV', 'OL', 'OPTION', 'OUTPUT', 'P', 'PRE', 'Q', 'S',
    'SAMP', 'SECTION', 'SELECT', 'SMALL', 'SPAN', 'STRONG', 'SUB',
    'SUMMARY', 'SUP', 'TABLE', 'TBODY', 'TD', 'TEXTAREA', 'TFOOT',
    'TH', 'THEAD', 'TIME', 'TR', 'U', 'UL', 'VAR',
    // Pixel content tags
    'CANVAS', 'VIDEO', 'SVG', 'OBJECT', 'EMBED', 'IFRAME'
  ]);

  // Sensitive input attributes (for HTML-semantic PII detection)
  const SENSITIVE_INPUT_TYPES = new Set([
    'password', 'email', 'tel', 'number'
  ]);

  const SENSITIVE_AUTOCOMPLETE = new Set([
    'name', 'given-name', 'family-name', 'email', 'tel', 'tel-national',
    'cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc',
    'address-line1', 'address-line2', 'address-level1', 'address-level2',
    'postal-code', 'country', 'bday', 'bday-day', 'bday-month', 'bday-year',
    'sex', 'username', 'new-password', 'current-password', 'one-time-code'
  ]);

  const SENSITIVE_NAME_KEYWORDS = [
    'password', 'passwd', 'pwd', 'ssn', 'social_security', 'aadhaar', 'aadhar',
    'pan', 'pan_number', 'card', 'credit_card', 'debit_card', 'cvv', 'cvc',
    'otp', 'pin', 'account', 'routing', 'bank', 'tax', 'salary', 'income',
    'dob', 'birth', 'age', 'gender', 'sex', 'phone', 'mobile', 'email',
    'address', 'zip', 'postal', 'name', 'fname', 'lname', 'first_name',
    'last_name', 'full_name'
  ];

  // ── Viewport Info ──
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  // Zoom detection heuristic: outerWidth/innerWidth gives zoom factor
  // on some browsers, but it's not reliable everywhere.
  // We rely on the screenshotWidth / viewportWidth ratio in the coordinate
  // mapper instead — that naturally incorporates zoom + DPR.
  const estimatedZoom = Math.round((window.outerWidth / window.innerWidth) * 100) / 100;

  const viewportInfo = {
    cssViewportWidth: viewportWidth,
    cssViewportHeight: viewportHeight,
    devicePixelRatio: dpr,
    scrollX,
    scrollY,
    estimatedZoom,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    timestamp: Date.now(),
  };

  // ── Helpers ──

  /**
   * Check if an element is truly visible in the viewport.
   */
  function isVisible(el) {
    if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      // offsetParent is null for display:none, fixed position, or detached elements
      // Fixed elements are still visible, so we check computed style
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) < 0.05) return false;
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    }

    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) < 0.05) return false;

    return true;
  }

  /**
   * Check if a bounding rect intersects the viewport.
   */
  function intersectsViewport(rect) {
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth &&
      rect.width >= MIN_ELEMENT_SIZE &&
      rect.height >= MIN_ELEMENT_SIZE
    );
  }

  /**
   * Get the direct text content of a node (not including children).
   */
  function getDirectText(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
    }
    return text.trim().slice(0, TEXT_MAX_LENGTH);
  }

  /**
   * Find the associated label for an input element.
   */
  function findLabel(el) {
    // Explicit label via 'for' attribute
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim().slice(0, 200);
    }

    // Implicit label (input nested inside label)
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Get label text excluding the input's own text
      const clone = parentLabel.cloneNode(true);
      const inputs = clone.querySelectorAll('input, select, textarea');
      inputs.forEach(i => i.remove());
      return clone.textContent.trim().slice(0, 200);
    }

    // aria-label
    if (el.getAttribute('aria-label')) {
      return el.getAttribute('aria-label').trim().slice(0, 200);
    }

    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim().slice(0, 200);
    }

    // Nearby text: check previous sibling or parent's text
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'P')) {
      return prev.textContent.trim().slice(0, 200);
    }

    return '';
  }

  /**
   * Determine if a name/id attribute looks sensitive.
   */
  function matchesSensitiveKeyword(value) {
    if (!value) return null;
    const lower = value.toLowerCase().replace(/[-_\s]/g, '_');
    for (const keyword of SENSITIVE_NAME_KEYWORDS) {
      if (lower.includes(keyword)) return keyword;
    }
    return null;
  }

  // ── Main Extraction ──
  const elements = [];
  const pixelRegions = [];
  let elementCount = 0;

  /**
   * Walk the DOM tree and collect visible, relevant elements.
   */
  function extractElements() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (elementCount >= MAX_ELEMENTS) return NodeFilter.FILTER_REJECT;
          if (!RELEVANT_TAGS.has(node.tagName)) return NodeFilter.FILTER_SKIP;
          if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      if (elementCount >= MAX_ELEMENTS) break;

      const rect = node.getBoundingClientRect();
      if (!intersectsViewport(rect)) continue;

      const entry = buildElementEntry(node, rect);
      if (entry) {
        elements.push(entry);
        elementCount++;

        // Track pixel-based regions separately
        if (entry.isPixelContent) {
          pixelRegions.push({
            index: elements.length - 1,
            tag: entry.tag,
            src: entry.src || null,
            alt: entry.alt || '',
            bbox: entry.bbox,
            area: entry.bbox.width * entry.bbox.height,
          });
        }
      }
    }
  }

  /**
   * Build a structured entry for a single DOM element.
   */
  function buildElementEntry(el, rect) {
    const tag = el.tagName;
    const isInput = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
    const isPixel = PIXEL_TAGS.has(tag);

    const entry = {
      tag: tag.toLowerCase(),
      bbox: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      isPixelContent: isPixel,
    };

    // Text content (only for text-bearing elements)
    if (!isPixel) {
      const text = getDirectText(el);
      if (text) entry.text = text;
    }

    // Role & interaction
    const role = el.getAttribute('role');
    if (role) entry.role = role;

    // Stable identifier (prefer data-testid, then id)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-id');
    if (testId) entry.testId = testId;
    if (el.id) entry.id = el.id;

    // Input-specific attributes
    if (isInput) {
      const inputType = el.type || 'text';
      entry.inputType = inputType;
      entry.isSensitiveType = SENSITIVE_INPUT_TYPES.has(inputType);

      const name = el.name;
      if (name) {
        entry.name = name;
        entry.sensitiveNameMatch = matchesSensitiveKeyword(name);
      }

      const autocomplete = el.getAttribute('autocomplete');
      if (autocomplete) {
        entry.autocomplete = autocomplete;
        entry.isSensitiveAutocomplete = SENSITIVE_AUTOCOMPLETE.has(autocomplete);
      }

      const placeholder = el.placeholder;
      if (placeholder) entry.placeholder = placeholder;

      // Capture the current value (will be sanitized later if PII)
      const value = el.value;
      if (value) entry.value = value.slice(0, TEXT_MAX_LENGTH);

      // Associated label
      const label = findLabel(el);
      if (label) entry.label = label;

      // Mark as definitely sensitive if password type
      if (inputType === 'password') {
        entry.definitelySensitive = true;
      }
    }

    // Link href (for context, not the full URL)
    if (tag === 'A' && el.href) {
      entry.href = el.href.slice(0, 300);
    }

    // Image attributes
    if (tag === 'IMG') {
      entry.src = el.src ? el.src.slice(0, 300) : '';
      entry.alt = el.alt || '';
      entry.naturalWidth = el.naturalWidth;
      entry.naturalHeight = el.naturalHeight;
    }

    // Canvas dimensions
    if (tag === 'CANVAS') {
      entry.canvasWidth = el.width;
      entry.canvasHeight = el.height;
    }

    return entry;
  }

  // ── Execute ──
  const startTime = performance.now();
  extractElements();
  const extractionTimeMs = Math.round(performance.now() - startTime);

  return {
    viewportInfo,
    elements,
    pixelRegions,
    stats: {
      totalExtracted: elements.length,
      pixelRegionCount: pixelRegions.length,
      extractionTimeMs,
    },
  };
})();
