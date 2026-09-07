/**
 * Privamon — Canvas Redactor
 *
 * Implements client-side visual redaction by rasterizing opaque black rectangles (#000000)
 * over all confirmed sensitive bounding boxes on a clean offscreen canvas.
 *
 * Principles:
 *   - Creates a fresh dedicated canvas so the original screenshot is preserved for side-by-side UI
 *   - Solid fill only: blur/pixelate is strictly prohibited (reversible via deconvolution)
 *   - Only items with explicit decision === 'REDACT' are drawn
 *   - Exports to Data URL once all boxes are rendered for maximum throughput
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.Redactor = (() => {
  'use strict';

  const REDACT_FILL_COLOR = '#000000';
  const DEFAULT_SAFETY_PADDING = 2; // px padding to prevent font antialiasing bleed

  /**
   * Loads an image from a data URL into an HTMLImageElement.
   */
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image for redaction'));
      img.src = dataUrl;
    });
  }

  /**
   * Redacts sensitive regions onto a new clean canvas.
   *
   * @param {string} screenshotDataUrl - The raw screenshot data URL
   * @param {Array<Object>} candidates - DetectionCandidate array (only decision === 'REDACT' are drawn)
   * @param {Object} [options={}] - Options { padding }
   * @returns {Promise<Object>} { canvas, ctx, sanitizedDataUrl, redactedRegions, dimensions }
   */
  async function redact(screenshotDataUrl, candidates = [], options = {}) {
    const padding = options.padding ?? DEFAULT_SAFETY_PADDING;
    const img = await loadImage(screenshotDataUrl);

    // Create a new canvas at native screenshot resolution
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Draw the clean base screenshot
    ctx.drawImage(img, 0, 0);

    ctx.fillStyle = REDACT_FILL_COLOR;
    const redactedRegions = [];

    // Filter only candidates confirmed for redaction
    const redactList = candidates.filter(c => c && c.decision === 'REDACT' && c.bbox);

    for (const candidate of redactList) {
      const boxesToDraw = (candidate.boxes && candidate.boxes.length > 0)
        ? candidate.boxes
        : [candidate.bbox];

      for (const box of boxesToDraw) {
        if (!box || box.width <= 0 || box.height <= 0) continue;

        // Apply safety padding clamped to canvas boundaries
        const rx = Math.max(0, Math.round(box.x - padding));
        const ry = Math.max(0, Math.round(box.y - padding));
        const rw = Math.min(canvas.width - rx, Math.round(box.width + 2 * padding));
        const rh = Math.min(canvas.height - ry, Math.round(box.height + 2 * padding));

        if (rw <= 0 || rh <= 0) continue;

        ctx.fillRect(rx, ry, rw, rh);

        redactedRegions.push({
          ...candidate,
          bbox: { x: rx, y: ry, width: rw, height: rh },
          originalBbox: { ...box }
        });
      }
    }

    // Export single PNG Data URL after all boxes are rendered
    const sanitizedDataUrl = canvas.toDataURL('image/png');

    return {
      canvas,
      ctx,
      sanitizedDataUrl,
      redactedRegions,
      dimensions: { width: canvas.width, height: canvas.height }
    };
  }

  /**
   * Crops a region from a screenshot onto an offscreen canvas.
   */
  async function extractRegion(screenshotDataUrl, bbox) {
    const img = await loadImage(screenshotDataUrl);
    const rx = Math.max(0, Math.round(bbox.x));
    const ry = Math.max(0, Math.round(bbox.y));
    const rw = Math.max(1, Math.min(img.width - rx, Math.round(bbox.width)));
    const rh = Math.max(1, Math.min(img.height - ry, Math.round(bbox.height)));

    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
    return canvas.toDataURL('image/png');
  }

  return {
    redact,
    extractRegion,
    loadImage,
    REDACT_FILL_COLOR
  };
})();
