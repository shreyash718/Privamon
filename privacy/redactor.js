/**
 * Privamon — Redactor
 *
 * Canvas-based redaction: draws opaque black rectangles over sensitive regions.
 *
 * Principles:
 *   - Only redact identified PII regions
 *   - Preserve all non-sensitive visual context
 *   - Use opaque fill (not blur — blur is reversible)
 *   - Configurable padding to prevent edge leakage
 *   - Maximum privacy with minimum visual information loss
 */
var Privamon = Privamon || {};

Privamon.Redactor = (() => {
  'use strict';

  // Default padding (screenshot pixels) around each bbox to prevent leakage
  const DEFAULT_PADDING = 4;

  // Redaction fill color
  const REDACT_COLOR = '#000000';

  /**
   * Redact sensitive regions on a screenshot.
   *
   * @param {string} screenshotDataUrl - The raw screenshot as a data URL
   * @param {Array} detections - Detections with .bbox in screenshot pixel coordinates
   * @param {Object} options
   * @param {number} [options.padding=4] - Padding in px around each bbox
   * @param {string} [options.fillColor='#000000'] - Redaction fill color
   * @returns {Promise<Object>} { sanitizedDataUrl, redactedRegions }
   */
  async function redact(screenshotDataUrl, detections, options = {}) {
    const padding = options.padding ?? DEFAULT_PADDING;
    const fillColor = options.fillColor || REDACT_COLOR;

    // Load the screenshot into an Image
    const img = await loadImage(screenshotDataUrl);

    // Create canvas at screenshot's native resolution
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');

    // Draw the original screenshot
    ctx.drawImage(img, 0, 0);

    // Apply redaction to each detection bbox
    ctx.fillStyle = fillColor;
    const redactedRegions = [];

    for (const detection of detections) {
      if (!detection.bbox && (!detection.boxes || detection.boxes.length === 0)) continue;

      const targetBoxes = (detection.boxes && detection.boxes.length > 0) ? detection.boxes : [detection.bbox];

      for (const box of targetBoxes) {
        if (!box) continue;
        const { x, y, width, height } = box;

        // Apply padding, clamped to canvas bounds
        const rx = Math.max(0, x - padding);
        const ry = Math.max(0, y - padding);
        const rw = Math.min(canvas.width - rx, width + 2 * padding);
        const rh = Math.min(canvas.height - ry, height + 2 * padding);

        if (rw <= 0 || rh <= 0) continue;

        ctx.fillRect(rx, ry, rw, rh);

        redactedRegions.push({
          type: detection.type,
          text: detection.text || '',
          source: detection.source || 'unknown',
          tokens: detection.tokens || [],
          confidence: detection.confidence,
          bbox: { x: rx, y: ry, width: rw, height: rh },
          originalBbox: box,
          boxes: detection.boxes || [box],
        });
      }
    }

    // Export sanitized screenshot
    const sanitizedDataUrl = canvas.toDataURL('image/png');

    return {
      sanitizedDataUrl,
      redactedRegions,
      dimensions: { width: canvas.width, height: canvas.height },
    };
  }

  /**
   * Load an image from a data URL.
   * @param {string} dataUrl
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error('Failed to load screenshot image'));
      img.src = dataUrl;
    });
  }

  /**
   * Extract a rectangular region from the screenshot as a separate data URL.
   * Useful for OCR/Vision on specific regions.
   *
   * @param {string} screenshotDataUrl
   * @param {Object} bbox - { x, y, width, height } in screenshot pixels
   * @returns {Promise<string>} Region as data URL
   */
  async function extractRegion(screenshotDataUrl, bbox) {
    const img = await loadImage(screenshotDataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = bbox.width;
    canvas.height = bbox.height;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(
      img,
      bbox.x, bbox.y, bbox.width, bbox.height,
      0, 0, bbox.width, bbox.height
    );

    return canvas.toDataURL('image/png');
  }

  return { redact, extractRegion, loadImage };
})();
