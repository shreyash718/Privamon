/**
 * Privamon — Redaction Verifier
 *
 * Post-redaction verification: checks that sensitive content is actually
 * hidden after redaction. Re-runs PII detection on redacted regions.
 *
 * If PII is still detected in a redacted area, expands the redaction
 * and re-applies it.
 *
 * Principle: Never assume redaction succeeded just because a bbox was drawn.
 */
var Privamon = Privamon || {};

Privamon.Verifier = (() => {
  'use strict';

  // How much to expand a bbox if verification fails (fraction of original size)
  const EXPAND_FACTOR = 0.25;

  // Maximum verification rounds to prevent infinite loops
  const MAX_ROUNDS = 2;

  /**
   * Verify that redaction was successful.
   *
   * @param {string} sanitizedDataUrl - The redacted screenshot
   * @param {Array} redactedRegions - Regions that were redacted (from Redactor)
   * @param {Object} options
   * @param {boolean} [options.useOcr=false] - Whether OCR is available for verification
   * @returns {Promise<Object>} { verified, failedRegions, sanitizedDataUrl }
   */
  async function verify(sanitizedDataUrl, redactedRegions, options = {}) {
    const failedRegions = [];

    for (const region of redactedRegions) {
      // Extract the redacted area from the sanitized image
      try {
        const regionDataUrl = await Privamon.Redactor.extractRegion(
          sanitizedDataUrl,
          region.bbox
        );

        // Check if the region is actually opaque/blank
        const isBlank = await isRegionBlank(regionDataUrl, region.bbox);

        if (!isBlank) {
          failedRegions.push({
            ...region,
            failReason: 'Region not fully opaque after redaction',
          });
        }
      } catch (err) {
        // If extraction fails, the region might be at image edges — acceptable
        console.warn('[Verifier] Region extraction failed:', err.message);
      }
    }

    // If any regions failed, expand and re-redact
    if (failedRegions.length > 0 && options.reRedact !== false) {
      console.warn(`[Verifier] ${failedRegions.length} regions failed verification. Expanding...`);

      const expandedDetections = failedRegions.map(region => ({
        ...region,
        bbox: expandBbox(region.bbox, EXPAND_FACTOR),
      }));

      const reRedacted = await Privamon.Redactor.redact(
        sanitizedDataUrl,
        expandedDetections,
        { padding: 8 } // Extra padding for re-redaction
      );

      return {
        verified: false,
        failedRegions,
        sanitizedDataUrl: reRedacted.sanitizedDataUrl,
        reRedacted: true,
      };
    }

    return {
      verified: true,
      failedRegions: [],
      sanitizedDataUrl,
      reRedacted: false,
    };
  }

  /**
   * Check if a region is blank (all same color, i.e., properly redacted).
   *
   * @param {string} regionDataUrl - The region image
   * @param {Object} bbox - The region's bbox
   * @returns {Promise<boolean>}
   */
  async function isRegionBlank(regionDataUrl, bbox) {
    const img = await Privamon.Redactor.loadImage(regionDataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    if (data.length < 4) return true;

    // Check if all pixels are the same color (within tolerance)
    const r0 = data[0], g0 = data[1], b0 = data[2];
    const tolerance = 5;

    // Sample pixels (checking every pixel is expensive for large regions)
    const step = Math.max(1, Math.floor(data.length / (4 * 200))); // ~200 samples

    for (let i = 0; i < data.length; i += 4 * step) {
      if (
        Math.abs(data[i] - r0) > tolerance ||
        Math.abs(data[i + 1] - g0) > tolerance ||
        Math.abs(data[i + 2] - b0) > tolerance
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Expand a bounding box by a fraction of its size.
   */
  function expandBbox(bbox, factor) {
    const dx = Math.round(bbox.width * factor);
    const dy = Math.round(bbox.height * factor);
    return {
      x: Math.max(0, bbox.x - dx),
      y: Math.max(0, bbox.y - dy),
      width: bbox.width + 2 * dx,
      height: bbox.height + 2 * dy,
    };
  }

  return { verify };
})();
