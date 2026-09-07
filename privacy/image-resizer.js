/**
 * Privamon — Pre-Transmission Screenshot Downscaler
 *
 * Runs after Stage 8 (Verification) and before server transmission.
 * Shrinks the sanitized screenshot enough to cut network transfer time
 * and server-side VLM visual-token latency, without compromising 12–14px UI text legibility.
 *
 * Key Design Principles:
 * 1. Post-Verification Only: Runs strictly on the verified, redacted canvas.
 * 2. Distinct Output: Returns downscaled image for the server; the full-resolution
 *    original remains untouched for the local user dashboard.
 * 3. DPR Normalization First: Normalizes Retina / high-DPI screenshots (2x/3x)
 *    to 1x CSS pixel dimensions before applying the long-edge cap.
 * 4. Aspect-Ratio Preserving Cap: Caps the long edge at 1152px default (never upscales).
 * 5. Cross-Engine Resampling: Uses createImageBitmap(resizeQuality: 'high') with
 *    fallback to destination canvas ctx.imageSmoothingQuality = 'high' (Firefox accepts
 *    resizeQuality but ignores it, falling back to internal defaults).
 * 6. Resilient Fallback: Any unexpected downscale error safely falls back to the full-res
 *    verified screenshot so transmission never breaks.
 */
var Privamon = (typeof window !== 'undefined' && window.Privamon)
            || (typeof globalThis !== 'undefined' && globalThis.Privamon)
            || (typeof self !== 'undefined' && self.Privamon)
            || {};
if (typeof window !== 'undefined') window.Privamon = Privamon;
if (typeof globalThis !== 'undefined') globalThis.Privamon = Privamon;
if (typeof self !== 'undefined') self.Privamon = Privamon;

Privamon.ImageResizer = (() => {
  'use strict';

  // Configurable Defaults
  const DEFAULT_MAX_SERVER_LONG_EDGE = 1152;
  const DEFAULT_FORMAT = 'image/png';
  const DEFAULT_WEBP_QUALITY = 0.85;
  const DEFAULT_RESIZE_QUALITY = 'high';

  /**
   * Creates a canvas matching target dimensions (OffscreenCanvas or HTMLCanvasElement).
   */
  function createCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(width, height);
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    }
    throw new Error('No Canvas environment available for downscaling');
  }

  /**
   * Converts a canvas to a data URL string.
   */
  async function canvasToDataUrl(canvas, format = DEFAULT_FORMAT, quality = DEFAULT_WEBP_QUALITY) {
    if (typeof canvas.toDataURL === 'function') {
      return canvas.toDataURL(format, quality);
    }
    if (typeof canvas.convertToBlob === 'function') {
      const blob = await canvas.convertToBlob({ type: format, quality });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read canvas blob as data URL'));
        reader.readAsDataURL(blob);
      });
    }
    throw new Error('Canvas conversion to data URL not supported in this environment');
  }

  /**
   * Converts a canvas to a raw Blob (for fast zero-base64 HTTP payload delivery if needed).
   */
  async function canvasToBlob(canvas, format = DEFAULT_FORMAT, quality = DEFAULT_WEBP_QUALITY) {
    if (typeof canvas.convertToBlob === 'function') {
      return await canvas.convertToBlob({ type: format, quality });
    }
    if (typeof canvas.toBlob === 'function') {
      return new Promise(resolve => canvas.toBlob(resolve, format, quality));
    }
    return null;
  }

  /**
   * Normalizes Retina / high-DPI display pixels to 1x CSS layout dimensions.
   *
   * @param {HTMLCanvasElement|OffscreenCanvas} sourceCanvas
   * @param {number} devicePixelRatio
   * @returns {Promise<HTMLCanvasElement|OffscreenCanvas>}
   */
  async function normalizeDPR(sourceCanvas, devicePixelRatio = 1) {
    if (!devicePixelRatio || devicePixelRatio <= 1) {
      return sourceCanvas; // Already 1x CSS or sub-1x, no DPR reduction needed
    }

    const origW = sourceCanvas.width;
    const origH = sourceCanvas.height;
    const targetW = Math.max(1, Math.round(origW / devicePixelRatio));
    const targetH = Math.max(1, Math.round(origH / devicePixelRatio));

    // High-quality resampling with Firefox parity fallback
    // NOTE: Firefox accepts createImageBitmap resizeQuality option but silently ignores it.
    // Explicitly setting imageSmoothingEnabled and imageSmoothingQuality on destination context
    // guarantees high-quality bicubic interpolation across both Chromium and Gecko engines.
    const outCanvas = createCanvas(targetW, targetH);
    const ctx = outCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = DEFAULT_RESIZE_QUALITY;

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(sourceCanvas, {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: DEFAULT_RESIZE_QUALITY,
        });
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        if (typeof bitmap.close === 'function') bitmap.close();
        return outCanvas;
      } catch (e) {
        console.warn('[ImageResizer] createImageBitmap DPR resize failed, falling back to ctx.drawImage:', e.message);
      }
    }

    ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
    return outCanvas;
  }

  /**
   * Caps the long edge of the canvas at maxLongEdge, strictly preserving aspect ratio.
   * Never upscales if the canvas long edge is already <= maxLongEdge.
   *
   * @param {HTMLCanvasElement|OffscreenCanvas} sourceCanvas
   * @param {Object} [options={}]
   * @param {number} [options.maxLongEdge=1152]
   * @param {string} [options.quality='high']
   * @returns {Promise<HTMLCanvasElement|OffscreenCanvas>}
   */
  async function resizeForServer(sourceCanvas, {
    maxLongEdge = DEFAULT_MAX_SERVER_LONG_EDGE,
    quality = DEFAULT_RESIZE_QUALITY,
  } = {}) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const longEdge = Math.max(width, height);

    if (longEdge <= maxLongEdge) {
      return sourceCanvas; // Already small enough — never upscale!
    }

    const scale = maxLongEdge / longEdge;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const outCanvas = createCanvas(targetW, targetH);
    const ctx = outCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = quality;

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(sourceCanvas, {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: quality,
        });
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        if (typeof bitmap.close === 'function') bitmap.close();
        return outCanvas;
      } catch (e) {
        console.warn('[ImageResizer] createImageBitmap server resize failed, falling back to ctx.drawImage:', e.message);
      }
    }

    ctx.drawImage(sourceCanvas, 0, 0, targetW, targetH);
    return outCanvas;
  }

  /**
   * Primary pipeline function:
   * 1. DPR normalization (2x/3x -> 1x CSS)
   * 2. Long edge capping (1152px default, preserving aspect ratio, never upscaling)
   * 3. Encoding (PNG default or WebP @ 0.85)
   * 4. Telemetry measurement & logging
   * 5. Safe error fallback to full-res original if anything fails
   *
   * @param {HTMLCanvasElement|OffscreenCanvas} verifiedCanvas - Already-redacted, already-verified canvas
   * @param {number} [devicePixelRatio=1] - From viewport telemetry
   * @param {Object} [options={}] - Custom overrides { maxLongEdge, format, webpQuality }
   * @returns {Promise<Object>} { serverCanvas, serverDataUrl, serverBlob, metadata }
   */
  async function prepareServerScreenshot(verifiedCanvas, devicePixelRatio = 1, options = {}) {
    const maxLongEdge = options.maxLongEdge || DEFAULT_MAX_SERVER_LONG_EDGE;
    const format = options.format || DEFAULT_FORMAT;
    const webpQuality = options.webpQuality || DEFAULT_WEBP_QUALITY;
    let origW = 0;
    let origH = 0;

    try {
      origW = verifiedCanvas.width || 0;
      origH = verifiedCanvas.height || 0;

      // Step 1: Normalize DPR
      const dprCanvas = await normalizeDPR(verifiedCanvas, devicePixelRatio);
      const dprW = dprCanvas.width;
      const dprH = dprCanvas.height;

      // Step 2: Cap long edge at maxLongEdge (never upscale)
      const serverCanvas = await resizeForServer(dprCanvas, {
        maxLongEdge,
        quality: DEFAULT_RESIZE_QUALITY
      });
      const finalW = serverCanvas.width;
      const finalH = serverCanvas.height;

      // Step 3: Convert to data URL & optional raw blob
      const serverDataUrl = await canvasToDataUrl(serverCanvas, format, webpQuality);
      let serverBlob = null;
      try {
        serverBlob = await canvasToBlob(serverCanvas, format, webpQuality);
      } catch (bErr) { /* non-critical */ }

      // Estimate byte sizes from base64 length (~0.75 ratio)
      const origEstimatedBytes = Math.round(origW * origH * 0.4); // typical compressed PNG heuristic
      const serverBytes = serverBlob ? serverBlob.size : Math.round(serverDataUrl.length * 0.75);
      const origKb = (origEstimatedBytes / 1024).toFixed(1);
      const serverKb = (serverBytes / 1024).toFixed(1);
      const areaReduction = Math.round((1 - (finalW * finalH) / (origW * origH)) * 100);

      console.log(
        `[ImageResizer] Original: ${origW}x${origH} -> DPR normalized (DPR=${devicePixelRatio}): ${dprW}x${dprH} -> Server: ${finalW}x${finalH} ` +
        `(~${serverKb} KB, ${format}, area reduction: -${areaReduction}%)`
      );

      return {
        serverCanvas,
        serverDataUrl,
        serverBlob,
        metadata: {
          originalDimensions: { width: origW, height: origH },
          dprNormalizedDimensions: { width: dprW, height: dprH },
          serverDimensions: { width: finalW, height: finalH },
          devicePixelRatio,
          maxLongEdge,
          format,
          serverBytes,
          areaReductionPercent: areaReduction,
          resampled: origW !== finalW || origH !== finalH
        }
      };
    } catch (err) {
      // Graceful fallback: transmission must never fail due to an image resize error
      console.warn('[ImageResizer] Downscaling encountered an error; falling back to full-resolution screenshot:', err.message);
      let fallbackDataUrl = '';
      try {
        fallbackDataUrl = await canvasToDataUrl(verifiedCanvas, DEFAULT_FORMAT);
      } catch (e) {
        console.error('[ImageResizer] Fallback data URL generation failed:', e.message);
      }

      return {
        serverCanvas: verifiedCanvas,
        serverDataUrl: fallbackDataUrl,
        serverBlob: null,
        metadata: {
          originalDimensions: { width: origW, height: origH },
          serverDimensions: { width: origW, height: origH },
          error: err.message,
          resampled: false,
          fallbackUsed: true
        }
      };
    }
  }

  /**
   * Calibration Harness Utility (Dev/Test Tooling ONLY — NOT in production hot path).
   * Generates candidate downscaled images at several long-edge sizes for empirical text legibility review.
   *
   * @param {HTMLCanvasElement|OffscreenCanvas} sourceCanvas
   * @param {number} devicePixelRatio
   * @param {number[]} [candidateSizes=[1536, 1152, 896, 640]]
   * @param {Object} [options={}]
   * @returns {Promise<Array<Object>>}
   */
  async function generateCalibrationSet(
    sourceCanvas,
    devicePixelRatio = 1,
    candidateSizes = [1536, 1152, 896, 640],
    options = {}
  ) {
    const dprCanvas = await normalizeDPR(sourceCanvas, devicePixelRatio);
    const results = [];

    for (const size of candidateSizes) {
      const resized = await resizeForServer(dprCanvas, { maxLongEdge: size });
      const dataUrl = await canvasToDataUrl(resized, options.format || DEFAULT_FORMAT, options.webpQuality);
      let blobSize = Math.round(dataUrl.length * 0.75);
      try {
        const blob = await canvasToBlob(resized, options.format || DEFAULT_FORMAT, options.webpQuality);
        if (blob) blobSize = blob.size;
      } catch (e) {}

      results.push({
        targetLongEdge: size,
        dimensions: { width: resized.width, height: resized.height },
        byteSize: blobSize,
        kilobytes: (blobSize / 1024).toFixed(1),
        dataUrl,
        canvas: resized
      });
    }

    return results;
  }

  return {
    DEFAULT_MAX_SERVER_LONG_EDGE,
    DEFAULT_FORMAT,
    DEFAULT_WEBP_QUALITY,
    DEFAULT_RESIZE_QUALITY,
    normalizeDPR,
    resizeForServer,
    canvasToDataUrl,
    canvasToBlob,
    prepareServerScreenshot,
    generateCalibrationSet
  };
})();
