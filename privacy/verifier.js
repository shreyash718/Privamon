/**
 * Privamon — Redaction Verifier
 *
 * Implements strict post-redaction pixel auditing:
 *   - Re-inspects every redacted bounding box directly via getImageData
 *   - Verifies that all pixels within the bounding box are strictly opaque black (R=0, G=0, B=0, A=255)
 *   - Expands dirty boxes by 25% in each direction and re-fills with #000000
 *   - Caps expansions at 3 retries; logs audit warnings if verification fails
 *   - Tracks reRedactedCount and verificationPassed
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.Verifier = (() => {
  'use strict';

  const MAX_EXPANSION_RETRIES = 3;
  const EXPANSION_FACTOR = 0.25; // 25% overall size expansion (12.5% on each side)

  /**
   * Checks whether a rectangular region on a canvas 2D context contains ONLY opaque black pixels.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @returns {boolean} true if 100% opaque black, false otherwise
   */
  function isRegionCleanBlack(ctx, x, y, width, height) {
    if (width <= 0 || height <= 0) return true;

    const data = ctx.getImageData(x, y, width, height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0 || data[i + 3] !== 255) {
        return false;
      }
    }
    return true;
  }

  /**
   * Verifies all redacted bounding boxes on the sanitized canvas.
   * Expands and re-fills any region where original pixel data survives.
   *
   * @param {HTMLCanvasElement} canvas - The canvas containing the redacted screenshot
   * @param {CanvasRenderingContext2D} ctx - Context of the canvas
   * @param {Array<Object>} redactedRegions - List of regions that were redacted
   * @returns {Object} { verified, verificationPassed, reRedactedCount, warnings, sanitizedDataUrl }
   */
  function verify(canvas, ctx, redactedRegions = []) {
    const warnings = [];
    let reRedactedCount = 0;
    let anyExpanded = false;

    for (let idx = 0; idx < redactedRegions.length; idx++) {
      const region = redactedRegions[idx];
      let { x, y, width, height } = region.bbox;

      // Clamp initial coordinates
      x = Math.max(0, Math.min(Math.round(x), canvas.width - 1));
      y = Math.max(0, Math.min(Math.round(y), canvas.height - 1));
      width = Math.min(Math.round(width), canvas.width - x);
      height = Math.min(Math.round(height), canvas.height - y);

      if (width <= 0 || height <= 0) continue;

      let clean = isRegionCleanBlack(ctx, x, y, width, height);

      if (!clean) {
        reRedactedCount++;
        anyExpanded = true;
        let retries = 0;

        while (!clean && retries < MAX_EXPANSION_RETRIES) {
          retries++;

          // Expand 25% in each direction
          const deltaW = width * (EXPANSION_FACTOR / 2);
          const deltaH = height * (EXPANSION_FACTOR / 2);

          x = Math.max(0, Math.round(x - deltaW));
          y = Math.max(0, Math.round(y - deltaH));
          width = Math.min(canvas.width - x, Math.round(width * (1 + EXPANSION_FACTOR)));
          height = Math.min(canvas.height - y, Math.round(height * (1 + EXPANSION_FACTOR)));

          // Re-fill expanded bounding box
          ctx.fillStyle = '#000000';
          ctx.fillRect(x, y, width, height);

          clean = isRegionCleanBlack(ctx, x, y, width, height);
        }

        if (!clean) {
          warnings.push(`box #${idx + 1} (${region.type || 'PII'}) failed verification after ${MAX_EXPANSION_RETRIES} expansions`);
        } else {
          // Update region bbox with expanded clean dimensions
          region.bbox = { x, y, width, height };
        }
      }
    }

    const verificationPassed = (warnings.length === 0);

    return {
      verified: verificationPassed,
      verificationPassed,
      reRedactedCount,
      warnings,
      sanitizedDataUrl: anyExpanded ? canvas.toDataURL('image/png') : null
    };
  }

  return {
    verify,
    isRegionCleanBlack
  };
})();
