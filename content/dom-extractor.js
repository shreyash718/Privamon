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
  const MAX_ELEMENTS = 4000;      // Safety cap (supports dense data tables and enterprise dashboards)
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
    'last_name', 'full_name', 'username', 'user_name', 'user_id', 'userid',
    'roll_no', 'rollno', 'enrollment', 'student_id', 'login'
  ];

  // Container tags that act as structural layout wrappers
  const CONTAINER_TAGS = new Set([
    'DIV', 'HEADER', 'FOOTER', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV',
    'FORM', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'OL', 'DL', 'DETAILS'
  ]);

  // Block-level child tags that indicate a container should NOT extract their text
  const CHILD_BLOCK_TAGS = new Set([
    'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH',
    'FORM', 'HEADER', 'FOOTER', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'NAV',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'BLOCKQUOTE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA'
  ]);

  /**
   * Checks if an element is a structural container with child block elements.
   */
  function isStructuralContainer(el) {
    if (el.tagName === 'TABLE' || el.tagName === 'THEAD' || el.tagName === 'TBODY' || el.tagName === 'TFOOT' || el.tagName === 'TR') {
      return true;
    }
    if (!CONTAINER_TAGS.has(el.tagName)) return false;
    for (let i = 0; i < el.children.length; i++) {
      if (CHILD_BLOCK_TAGS.has(el.children[i].tagName)) {
        return true;
      }
    }
    return false;
  }

  // ── Viewport Info ──
  let viewportWidth = window.innerWidth;
  let viewportHeight = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  let offsetLeft = 0;
  let offsetTop = 0;

  if (window.visualViewport) {
    viewportWidth = window.visualViewport.width;
    viewportHeight = window.visualViewport.height;
    offsetLeft = window.visualViewport.offsetLeft;
    offsetTop = window.visualViewport.offsetTop;
  }

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

    // Reject elements that are explicitly marked as hidden by the page.
    // This covers WhatsApp Web chat list behind media viewer (aria-hidden="true"),
    // React portals with inert attribute, and standard HTML hidden attribute.
    // NOTE: We use the explicit hidden attribute check instead of a broad modal
    // containment check, because apps like WhatsApp Web may render the media
    // viewer image in a separate DOM subtree (portal, sibling, or canvas)
    // that is NOT a descendant of the first div[role="dialog"] found.
    if (el.closest && el.closest('[aria-hidden="true"], [inert], [hidden]')) {
      return false;
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
   * Find table column header for a table cell using geometric alignment and DataTables awareness.
   */
  function findTableColumnHeader(el) {
    const cell = el.closest('td, th');
    if (!cell) return '';
    const table = cell.closest('table');
    if (!table) return '';

    // Search thead row: direct, or inside DataTables scroll wrappers
    let headerRow = table.querySelector('thead tr');
    if (!headerRow) {
      const dtWrapper = table.closest('.dataTables_scroll') || table.closest('.dataTables_wrapper');
      if (dtWrapper) {
        headerRow = dtWrapper.querySelector('.dataTables_scrollHead thead tr') || dtWrapper.querySelector('thead tr');
      }
    }
    if (!headerRow) {
      const prevTable = table.previousElementSibling?.tagName === 'TABLE' ? table.previousElementSibling : null;
      if (prevTable) headerRow = prevTable.querySelector('thead tr');
    }
    if (!headerRow) {
      headerRow = table.querySelector('tr');
    }
    if (!headerRow || !headerRow.children || headerRow.children.length === 0) return '';

    // 1. Precise Geometric Horizontal Center Match (handles missing header cells, offsets, and colspans)
    try {
      const cellRect = cell.getBoundingClientRect();
      if (cellRect.width > 0) {
        const cellCenterX = cellRect.left + cellRect.width / 2;
        for (let i = 0; i < headerRow.children.length; i++) {
          const th = headerRow.children[i];
          const thRect = th.getBoundingClientRect();
          if (cellCenterX >= thRect.left - 4 && cellCenterX <= thRect.right + 4) {
            const text = th.textContent.trim().slice(0, 100);
            if (text) return text;
          }
        }
      }
    } catch (e) {
      // Fall through to index-based lookup
    }

    // 2. Index-based fallback
    const cellIndex = cell.cellIndex;
    if (typeof cellIndex === 'number' && cellIndex >= 0 && headerRow.children[cellIndex]) {
      return headerRow.children[cellIndex].textContent.trim().slice(0, 100);
    }
    return '';
  }

  /**
   * Universal context label resolver for inputs, table cells, and text nodes.
   */
  function findContextLabel(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      return findLabel(el);
    }

    // Table cell column header
    const colHeader = findTableColumnHeader(el);
    if (colHeader) return colHeader;

    // Preceding label/dt/th
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'DT' || prev.tagName === 'TH')) {
      return prev.textContent.trim().slice(0, 100);
    }

    const dt = el.closest('dl')?.querySelector('dt');
    if (dt) return dt.textContent.trim().slice(0, 100);

    return el.getAttribute('aria-label') || el.getAttribute('title') || '';
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
          const regionId = `region_${pixelRegions.length + 1}`;
          pixelRegions.push({
            regionId,
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
    let isPixel = PIXEL_TAGS.has(tag);
    if (!isPixel && (el.getAttribute('role') === 'img' || (el.style && el.style.backgroundImage && el.style.backgroundImage.includes('url(')))) {
      isPixel = true;
    }

    const entry = {
      tag: tag.toLowerCase(),
      bbox: {
        x: Math.round(rect.left - offsetLeft),
        y: Math.round(rect.top - offsetTop),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      isPixelContent: isPixel,
    };

    // Check if this is a layout container holding child block elements
    const isContainer = isStructuralContainer(el);
    entry.isContainer = isContainer;
    entry.isHeader = (tag === 'TH');

    // Text content (only for text-bearing leaf elements, never containers)
    if (!isPixel && !isContainer) {
      const rangeMapper = (typeof Privamon !== 'undefined' && Privamon.DOMRangeMapper)
                       || (typeof window !== 'undefined' && window.Privamon && window.Privamon.DOMRangeMapper)
                       || (typeof globalThis !== 'undefined' && globalThis.Privamon && globalThis.Privamon.DOMRangeMapper);

      if (rangeMapper) {
        const res = rangeMapper.extractTextAndTokens(el, offsetLeft, offsetTop);
        if (res.text) {
          entry.text = res.text.slice(0, TEXT_MAX_LENGTH);
          entry.tokens = res.tokens;
        }
      } else {
        const text = getDirectText(el);
        if (text) entry.text = text;
      }
    }

    // Role & interaction
    const role = el.getAttribute('role');
    if (role) entry.role = role;

    // Stable identifier (prefer data-testid, then id)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-id');
    if (testId) entry.testId = testId;
    if (el.id) entry.id = el.id;
    if (el.className) entry.className = String(el.className);

    // Associated label / table column / preceding context (for all elements)
    const label = findContextLabel(el);
    if (label) entry.label = label;

    // Input-specific attributes
    if (isInput) {
      const inputType = el.type || 'text';
      entry.inputType = inputType;
      entry.isSensitiveType = SENSITIVE_INPUT_TYPES.has(inputType);

      const name = el.name;
      if (name) entry.name = name;

      const placeholder = el.placeholder;
      if (placeholder) entry.placeholder = placeholder;

      entry.sensitiveNameMatch = matchesSensitiveKeyword(name)
        || matchesSensitiveKeyword(el.id)
        || matchesSensitiveKeyword(placeholder)
        || matchesSensitiveKeyword(entry.label);

      const autocomplete = el.getAttribute('autocomplete');
      if (autocomplete) {
        entry.autocomplete = autocomplete;
        entry.isSensitiveAutocomplete = SENSITIVE_AUTOCOMPLETE.has(autocomplete);
      }

      // Capture the current value (will be sanitized later if PII)
      const value = el.value;
      if (value) {
        entry.value = value.slice(0, TEXT_MAX_LENGTH);
        entry.tokens = [{
          id: `dom_input_${elements.length + 1}`,
          text: entry.value,
          start: 0,
          end: entry.value.length,
          bbox: entry.bbox,
          boxes: [entry.bbox],
          nodeId: entry.id || entry.testId || null
        }];
      }

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
